import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ConfigError } from './errors.js';
import { sha256 } from './lock.js';
import { isWired, mergeWiring, parseConfig, serialize, stripWiring } from './wiring.js';
import {
  RULES_ID,
  handWired,
  hasBlock,
  mergeBlock,
  mergeInstructions,
  parseInstructions,
  stripBlock,
  stripInstructions,
} from './rules-wiring.js';

const EDITED = 'was edited after install';
const FOREIGN = 'exists and was not installed by forgeflow';

function diskHash(root, path) {
  const full = join(root, path);
  return existsSync(full) ? sha256(readFileSync(full)) : null;
}

export function planInstall(root, files, recorded) {
  const known = new Map(recorded.map((entry) => [entry.path, entry.sha256]));

  const actions = files.map(({ path, content }) => {
    const have = diskHash(root, path);
    if (have === null) return { type: 'create', path, content };
    if (have === sha256(content)) return { type: 'skip', path, content };
    if (!known.has(path)) return { type: 'conflict', path, content, reason: FOREIGN };
    if (known.get(path) !== have) return { type: 'conflict', path, content, reason: EDITED };
    return { type: 'update', path, content };
  });

  const rendered = new Set(files.map((file) => file.path));
  for (const entry of recorded) {
    if (rendered.has(entry.path)) continue;
    const have = diskHash(root, entry.path);
    if (have === null) continue;
    actions.push(
      have === entry.sha256
        ? { type: 'delete', path: entry.path }
        : { type: 'keep', path: entry.path, reason: EDITED }
    );
  }
  return actions;
}

export function planRemove(root, recorded) {
  return recorded.map((entry) => {
    const have = diskHash(root, entry.path);
    if (have === null) return { type: 'missing', path: entry.path };
    if (have === entry.sha256) return { type: 'delete', path: entry.path };
    return { type: 'keep', path: entry.path, reason: EDITED };
  });
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Returns the parsed harness config, or undefined when the file does not exist.
function readConfig(root, path) {
  const full = join(root, path);
  return existsSync(full) ? parseConfig(readFileSync(full, 'utf8'), path) : undefined;
}

// previous is the lockfile's wiring record for this target, if there is one.
export function planWire(root, wiring, previous) {
  const current = readConfig(root, wiring.path);
  const merged = mergeWiring(current, wiring);
  const type = current !== undefined && same(current, merged) ? 'skip' : 'wire';
  const created = current === undefined ? true : (previous?.created ?? false);
  return {
    action: { type, path: wiring.path, content: serialize(merged) },
    record: { path: wiring.path, created },
  };
}

// wiring is the adapter's wiring; without it there is nothing of ours to find.
export function planUnwire(root, record, wiring) {
  const { path } = record;
  if (!wiring) return { type: 'skip', path };
  const current = readConfig(root, path);
  if (current === undefined) return { type: 'missing', path };
  const stripped = stripWiring(current, wiring);
  if (same(stripped, current)) return { type: 'skip', path };
  if (record.created && same(stripped, wiring.skeleton)) return { type: 'delete', path };
  return { type: 'unwire', path, content: serialize(stripped) };
}

export function wiringState(root, wiring) {
  try {
    const current = readConfig(root, wiring.path);
    return current !== undefined && isWired(current, wiring) ? 'ok' : 'missing';
  } catch {
    return 'unreadable';
  }
}

// A user file that is a symbolic link is edited through the link, so the link
// survives. Returns the path to read and write, relative to root.
function throughLink(root, path) {
  const full = join(root, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return path;
  }
  if (!stat.isSymbolicLink()) return path;
  const refuse = (problem) =>
    new ConfigError(`${path} is ${problem}. forgeflow will not modify it.`);
  let target;
  try {
    target = realpathSync(full);
  } catch {
    throw refuse('a broken symbolic link');
  }
  const inside = relative(realpathSync(root), target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw refuse(`a symbolic link to a file outside ${root}`);
  }
  return inside.split(sep).join('/');
}

function readText(root, path) {
  const full = join(root, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
}

// The file's next text, and whether nothing but forgeflow's skeleton is left.
function nextRulesText(wiring, current, rules) {
  if (wiring.kind === 'block') {
    if (rules.length > 0) {
      return { text: mergeBlock(current, wiring.block(rules), wiring.path), bare: false };
    }
    const text = stripBlock(current, wiring.path);
    return { text, bare: text.replace(/^﻿/, '').trim() === '' };
  }
  const config =
    current === undefined ? undefined : parseInstructions(current, wiring.path, wiring.entry);
  const next =
    rules.length > 0 ? mergeInstructions(config, wiring) : stripInstructions(config, wiring.entry);
  // An unchanged config keeps its text, so the user's formatting survives.
  const text = config !== undefined && same(next, config) ? current : serialize(next);
  return { text, bare: same(next, wiring.skeleton) };
}

// A config forgeflow cannot use is still fine when the user has put the entry
// in by hand. Returns the path of that file, or undefined.
function wiredByHand(root, wiring, path, current) {
  if (wiring.kind !== 'json') return undefined;
  if (current !== undefined) {
    try {
      parseInstructions(current, wiring.path, wiring.entry);
      return undefined;
    } catch (error) {
      if (handWired(current, wiring.entry)) return path;
      throw error;
    }
  }
  const other = readText(root, wiring.alternative);
  if (other === undefined) return undefined;
  if (handWired(other, wiring.entry)) return wiring.alternative;
  throw new ConfigError(
    `${wiring.alternative} exists and ${wiring.path} does not. forgeflow will not create a ` +
      `second OpenCode config: add ${JSON.stringify(wiring.entry)} to its "instructions" list ` +
      `in ${wiring.alternative} by hand, and re-run.`
  );
}

// rules is every rule the target will have after the operation: [{ name, applies }].
// An empty list takes forgeflow's part out again. previous is the lockfile record.
export function planRulesWiring(root, wiring, rules, previous) {
  const path = throughLink(root, wiring.path);
  const current = readText(root, path);
  const row = (type, extra = {}) => ({ id: RULES_ID, type, path, ...extra });

  if (rules.length > 0) {
    const byHand = wiredByHand(root, wiring, path, current);
    if (byHand) return { action: { id: RULES_ID, type: 'skip', path: byHand }, record: null };
    const { text } = nextRulesText(wiring, current, rules);
    const created = current === undefined ? true : (previous?.created ?? false);
    return {
      action: row(text === current ? 'skip' : 'wire', { content: text }),
      record: { path: wiring.path, created },
    };
  }

  if (current === undefined) return { action: row('missing'), record: null };
  const { text, bare } = nextRulesText(wiring, current, rules);
  if (text === current) return { action: row('skip'), record: null };
  const ours = previous?.created && bare && path === wiring.path;
  return { action: ours ? row('delete') : row('unwire', { content: text }), record: null };
}

export function rulesState(root, wiring) {
  try {
    const current = readText(root, throughLink(root, wiring.path));
    if (current === undefined) return 'missing';
    if (wiring.kind === 'block') return hasBlock(current, wiring.path) ? 'ok' : 'missing';
    const config = parseInstructions(current, wiring.path, wiring.entry);
    return config.instructions?.includes(wiring.entry) ? 'ok' : 'missing';
  } catch {
    return 'unreadable';
  }
}
