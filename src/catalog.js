import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError } from './errors.js';
import { parseFrontmatter } from './frontmatter.js';
import { PLACEHOLDERS, unknownPlaceholders } from './placeholders.js';
import { RUNTIME_ID } from './wiring.js';

export const STAGES = [
  'requirement',
  'analyze',
  'plan',
  'architect',
  'build',
  'test',
  'fix',
  'review',
  'release_gate',
  'human_approval',
  'deploy',
  'feedback',
];
export const EVENTS = ['shell', 'write', 'prompt', 'stop'];
const ACCESS = ['read-only', 'write'];
const TIERS = ['fast', 'balanced', 'strong'];
const JOINS = ['review'];
const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const RUNTIME_SOURCES = ['run.mjs', 'runtime.mjs', 'opencode-plugin.js'];
const FIELDS = {
  agent: ['name', 'description', 'stage', 'access', 'model-tier', 'joins', 'requires'],
  rule: ['name', 'description', 'paths', 'requires'],
  skill: ['name', 'description', 'user-invocable-only', 'requires'],
  hook: ['name', 'description', 'events', 'requires'],
  runtime: ['name', 'description'],
};

function fail(source, problem) {
  throw new CatalogError(`${source}: ${problem}`);
}

function oneOf(source, data, field, allowed, required) {
  const value = data[field];
  if (value === undefined && !required) return undefined;
  if (!allowed.includes(value)) {
    fail(source, `field "${field}" must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function buildItem(type, expectedName, text, source) {
  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (error) {
    fail(source, error.message);
  }
  const { data, body } = parsed;

  for (const field of Object.keys(data)) {
    if (!FIELDS[type].includes(field)) {
      fail(source, `unknown field "${field}" (allowed: ${FIELDS[type].join(', ')})`);
    }
  }
  if (typeof data.name !== 'string' || !NAME_RE.test(data.name)) {
    fail(source, `field "name" is required and must match ${NAME_RE}`);
  }
  if (data.name !== expectedName) {
    const container = type === 'agent' || type === 'rule' ? 'file' : 'folder';
    fail(source, `field "name" (${data.name}) must equal the ${container} name (${expectedName})`);
  }
  const description = data.description;
  if (typeof description !== 'string' || description.length < 1 || description.length > 1024) {
    fail(source, 'field "description" is required and must be 1-1024 characters');
  }
  const requires = data.requires ?? [];
  if (!Array.isArray(requires) || requires.some((entry) => typeof entry !== 'string')) {
    fail(source, 'field "requires" must be a list of item ids');
  }
  if (!body) fail(source, 'body is empty');

  const item = {
    id: `${type}:${data.name}`,
    type,
    name: data.name,
    description,
    requires: [...requires],
    body,
    files: [],
    source,
  };
  if (type === 'agent') {
    item.stage = oneOf(source, data, 'stage', STAGES, false);
    item.access = oneOf(source, data, 'access', ACCESS, true);
    item.modelTier = oneOf(source, data, 'model-tier', TIERS, false) ?? 'balanced';
    // An agent that joins a stage is called by the flows when it is installed.
    item.joins = oneOf(source, data, 'joins', JOINS, false);
    if (item.joins !== undefined) {
      if (item.stage !== undefined) {
        fail(source, 'field "joins" is not allowed on an agent that has a stage');
      }
      if (item.access !== 'read-only') fail(source, 'field "joins" requires access: read-only');
    }
  } else if (type === 'skill') {
    const flag = data['user-invocable-only'] ?? false;
    if (typeof flag !== 'boolean')
      fail(source, 'field "user-invocable-only" must be true or false');
    item.userInvocableOnly = flag;
    const unknown = unknownPlaceholders(body);
    if (unknown.length > 0) {
      fail(
        source,
        `unknown placeholder ${unknown.join(', ')} (allowed: ${PLACEHOLDERS.join(', ')})`
      );
    }
  } else if (type === 'hook') {
    const events = data.events;
    const valid =
      Array.isArray(events) && events.length > 0 && events.every((event) => EVENTS.includes(event));
    if (!valid) fail(source, `field "events" must be a non-empty list of: ${EVENTS.join(', ')}`);
    item.events = events;
    if (!item.requires.includes(RUNTIME_ID)) item.requires.push(RUNTIME_ID);
  } else if (type === 'rule') {
    const { paths } = data;
    if (paths !== undefined) {
      const valid =
        Array.isArray(paths) &&
        paths.length > 0 &&
        paths.every((pattern) => typeof pattern === 'string' && pattern.trim() !== '');
      if (!valid) fail(source, 'field "paths" must be a non-empty list of file patterns');
      // Absent means the rule applies to all work.
      item.paths = [...paths];
    }
  }
  return item;
}

function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(join(dir, entry.name), rel) : [rel];
    });
}

function folders(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// Reads <dir>/<name>/<main> and returns the built item, or fails if the main file is missing.
function folderItem(type, kind, dir, name, main) {
  const path = join(dir, name, main);
  if (!existsSync(path)) fail(`${kind}/${name}`, `missing ${main}`);
  return buildItem(type, name, readFileSync(path, 'utf8'), `${kind}/${name}/${main}`);
}

function checkRequires(items) {
  for (const item of items.values()) {
    for (const dep of item.requires) {
      if (!items.has(dep)) fail(item.source, `"requires" names unknown item "${dep}"`);
    }
  }
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const loop = [...trail.slice(trail.indexOf(id)), id].join(' → ');
      fail(items.get(id).source, `"requires" forms a cycle: ${loop}`);
    }
    state.set(id, 'visiting');
    for (const dep of items.get(id).requires) visit(dep, [...trail, id]);
    state.set(id, 'done');
  };
  for (const id of items.keys()) visit(id, []);
}

export function loadCatalog(dir) {
  const items = new Map();

  // Agents and rules are single files; the file name is the item name.
  for (const [type, kind] of [
    ['agent', 'agents'],
    ['rule', 'rules'],
  ]) {
    const folder = join(dir, kind);
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder).sort()) {
      if (!file.endsWith('.md')) continue;
      const text = readFileSync(join(folder, file), 'utf8');
      const item = buildItem(type, file.slice(0, -3), text, `${kind}/${file}`);
      items.set(item.id, item);
    }
  }

  const skillsDir = join(dir, 'skills');
  for (const name of folders(skillsDir)) {
    const item = folderItem('skill', 'skills', skillsDir, name, 'SKILL.md');
    const folder = join(skillsDir, name);
    item.files = listFiles(folder)
      .filter((rel) => rel !== 'SKILL.md')
      .map((rel) => ({ path: rel, content: readFileSync(join(folder, rel)) }));
    items.set(item.id, item);
  }

  const hooksDir = join(dir, 'hooks');
  for (const name of folders(hooksDir)) {
    const item = folderItem('hook', 'hooks', hooksDir, name, 'HOOK.md');
    const gate = join(hooksDir, name, 'gate.mjs');
    if (!existsSync(gate)) fail(`hooks/${name}`, 'missing gate.mjs');
    item.gate = readFileSync(gate, 'utf8');
    items.set(item.id, item);
  }

  const runtimeDir = join(dir, 'runtime');
  for (const name of folders(runtimeDir)) {
    const item = folderItem('runtime', 'runtime', runtimeDir, name, 'RUNTIME.md');
    if (item.id !== RUNTIME_ID)
      fail(item.source, `field "name" (${name}) must equal the folder name (hooks)`);
    item.sources = {};
    for (const file of RUNTIME_SOURCES) {
      const path = join(runtimeDir, name, file);
      if (!existsSync(path)) fail(`runtime/${name}`, `missing ${file}`);
      item.sources[file] = readFileSync(path, 'utf8');
    }
    items.set(item.id, item);
  }

  checkRequires(items);
  return items;
}
