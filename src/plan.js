import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ConfigError } from './errors.js';
import { sha256 } from './lock.js';
import { isWired, mergeWiring, parseConfig, serialize, stripWiring } from './wiring.js';
import {
  RULES_ID,
  foundEntries,
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
function nextRulesText(wiring, current, rules, active) {
  if (wiring.kind === 'block') {
    if (active) {
      return { text: mergeBlock(current, wiring.block(rules), wiring.path), bare: false };
    }
    const text = stripBlock(current, wiring.path);
    return { text, bare: text.replace(/^﻿/, '').trim() === '' };
  }
  const config =
    current === undefined ? undefined : parseInstructions(current, wiring.path, wiring.entries);
  const next = active ? mergeInstructions(config, wiring) : stripInstructions(config, wiring.known);
  // An unchanged config keeps its text, so the user's formatting survives.
  const text = config !== undefined && same(next, config) ? current : serialize(next);
  return { text, bare: same(next, wiring.skeleton) };
}

const BY_HAND = 'forgeflow leaves this file alone; the entry is already there';
const takeOut = (entries) =>
  `remove ${entries.map((entry) => JSON.stringify(entry)).join(' and ')} from its "instructions" list`;

function parses(wiring, text) {
  try {
    parseInstructions(text, wiring.path, wiring.entries);
    return true;
  } catch {
    return false;
  }
}

// A config forgeflow will not edit is still fine when the user has put the
// entry in by hand. Returns the path of that file, or undefined when forgeflow
// can edit the config itself. Throws when neither holds.
function wiredByHand(root, wiring, path, current) {
  if (wiring.kind !== 'json') return undefined;
  if (current !== undefined) {
    if (parses(wiring, current)) return undefined;
    if (handWired(current, wiring.entries)) return path;
    return parseInstructions(current, wiring.path, wiring.entries);
  }
  const other = readText(root, wiring.alternative);
  if (other === undefined) return undefined;
  if (handWired(other, wiring.entries)) return wiring.alternative;
  throw new ConfigError(
    `${wiring.alternative} exists and ${wiring.path} does not. forgeflow will not create a ` +
      `second OpenCode config: add ${wiring.entries.map((entry) => JSON.stringify(entry)).join(' and ')} to its "instructions" list ` +
      `in ${wiring.alternative} by hand, and re-run.`
  );
}

// The config forgeflow cannot edit, if that is the state of things: the file
// to name, whether every wanted entry is in it, and which of forgeflow's
// entries it holds at all.
function uneditable(root, wiring, path, current) {
  if (wiring.kind !== 'json') return undefined;
  const describe = (file, text) => ({
    file,
    wired: handWired(text, wiring.entries),
    left: foundEntries(text, wiring.known),
  });
  if (current !== undefined) return parses(wiring, current) ? undefined : describe(path, current);
  const other = readText(root, wiring.alternative);
  return other === undefined ? undefined : describe(wiring.alternative, other);
}

// rules is every rule the target will have after the operation: [{ name, applies }].
// The wiring is active while something wants it: a rule for the AGENTS.md
// block, a wanted entry for OpenCode. When it is not active, forgeflow's part
// is taken out again. previous is the lockfile record. removing is true when
// the operation takes items away: a config that cannot be edited then never
// stops it.
export function planRulesWiring(root, wiring, rules, previous, { removing = false } = {}) {
  const path = throughLink(root, wiring.path);
  const current = readText(root, path);
  const row = (type, extra = {}) => ({ id: RULES_ID, type, path, ...extra });
  const active = wiring.kind === 'json' ? wiring.entries.length > 0 : rules.length > 0;

  if (active) {
    const stuck = removing ? uneditable(root, wiring, path, current) : undefined;
    if (stuck && !stuck.wired)
      return { action: row('skip', { path: stuck.file }), record: previous };
    const byHand = wiredByHand(root, wiring, path, current);
    if (byHand) {
      return {
        action: row('manual', { path: byHand, reason: BY_HAND }),
        record: { path: byHand, created: false, manual: true },
      };
    }
    const { text } = nextRulesText(wiring, current, rules, active);
    const created = current === undefined ? true : (previous?.created ?? false);
    return {
      action: row(text === current ? 'skip' : 'wire', { content: text }),
      record: { path: wiring.path, created },
    };
  }

  const stuck = uneditable(root, wiring, path, current);
  if (stuck) {
    const action =
      stuck.left.length > 0
        ? row('manual', { path: stuck.file, reason: takeOut(stuck.left) })
        : row('skip', { path: stuck.file });
    return { action, record: null };
  }
  if (current === undefined) return { action: row('missing'), record: null };
  const { text, bare } = nextRulesText(wiring, current, rules, active);
  if (text === current) return { action: row('skip'), record: null };
  const ours = previous?.created && bare && path === wiring.path;
  return { action: ours ? row('delete') : row('unwire', { content: text }), record: null };
}

export function rulesState(root, wiring) {
  try {
    const path = throughLink(root, wiring.path);
    const current = readText(root, path);
    const stuck = uneditable(root, wiring, path, current);
    if (stuck) return stuck.wired ? 'ok' : 'unreadable';
    if (current === undefined) return 'missing';
    if (wiring.kind === 'block') return hasBlock(current, wiring.path) ? 'ok' : 'missing';
    const config = parseInstructions(current, wiring.path, wiring.entries);
    const list = config.instructions ?? [];
    return wiring.entries.every((entry) => list.includes(entry)) ? 'ok' : 'missing';
  } catch {
    return 'unreadable';
  }
}
