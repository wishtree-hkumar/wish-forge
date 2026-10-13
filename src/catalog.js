import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError } from './errors.js';
import { parseFrontmatter } from './frontmatter.js';

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
const ACCESS = ['read-only', 'write'];
const TIERS = ['fast', 'balanced', 'strong'];
const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const FIELDS = {
  agent: ['name', 'description', 'stage', 'access', 'model-tier', 'requires'],
  skill: ['name', 'description', 'user-invocable-only', 'requires'],
};

function fail(source, problem) {
  throw new CatalogError(`${source}: ${problem}`);
}

function oneOf(source, data, field, allowed, required) {
  const value = data[field];
  if (value === undefined && !required) return undefined;
  if (!allowed.includes(value))
    fail(source, `field "${field}" must be one of: ${allowed.join(', ')}`);
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
    const container = type === 'agent' ? 'file' : 'folder';
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
    requires,
    body,
    files: [],
    source,
  };
  if (type === 'agent') {
    item.stage = oneOf(source, data, 'stage', STAGES, false);
    item.access = oneOf(source, data, 'access', ACCESS, true);
    item.modelTier = oneOf(source, data, 'model-tier', TIERS, false) ?? 'balanced';
  } else {
    const flag = data['user-invocable-only'] ?? false;
    if (typeof flag !== 'boolean')
      fail(source, 'field "user-invocable-only" must be true or false');
    item.userInvocableOnly = flag;
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

  const agentsDir = join(dir, 'agents');
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).sort()) {
      if (!file.endsWith('.md')) continue;
      const text = readFileSync(join(agentsDir, file), 'utf8');
      const item = buildItem('agent', file.slice(0, -3), text, `agents/${file}`);
      items.set(item.id, item);
    }
  }

  const skillsDir = join(dir, 'skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = join(skillsDir, entry.name);
      const main = join(folder, 'SKILL.md');
      if (!existsSync(main)) fail(`skills/${entry.name}`, 'missing SKILL.md');
      const source = `skills/${entry.name}/SKILL.md`;
      const item = buildItem('skill', entry.name, readFileSync(main, 'utf8'), source);
      item.files = listFiles(folder)
        .filter((rel) => rel !== 'SKILL.md')
        .map((rel) => ({ path: rel, content: readFileSync(join(folder, rel)) }));
      items.set(item.id, item);
    }
  }

  checkRequires(items);
  return items;
}
