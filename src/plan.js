import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ConfigError } from './errors.js';
import { sha256 } from './lock.js';
import { isBare, isWired, mergeWiring, parseConfig, serialize, stripWiring } from './wiring.js';
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
const FOREIGN = 'exists and was not installed by wishforge';

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
  const text = readText(root, path);
  return text === undefined ? undefined : parseConfig(text, path);
}

// previous is the lockfile's wiring record for this target, if there is one.
export function planWire(root, wiring, previous) {
  // A config that is a symbolic link is edited through it, so the link stays.
  const path = throughLink(root, wiring.path);
  const current = readConfig(root, path);
  const merged = mergeWiring(current, wiring);
  const type = current !== undefined && same(current, merged) ? 'skip' : 'wire';
  const created = current === undefined ? true : (previous?.created ?? false);
  return {
    action: { type, path, content: serialize(merged) },
    record: { path: wiring.path, created },
  };
}

// wiring is the adapter's wiring; without it there is nothing of ours to find.
export function planUnwire(root, record, wiring) {
  if (!wiring) return { type: 'skip', path: record.path };
  // Removal is never stopped by the link: a broken one has nothing to strip, and
  // a file outside the project is left for the person, who is told what to take out.
  const link = linkOf(root, record.path);
  if (link.kind === 'broken') return { type: 'missing', path: record.path };
  if (link.kind === 'outside') {
    const reason = `take out the hook entries that run ${wiring.runner}`;
    return { type: 'manual', path: record.path, reason };
  }
  const { path } = link;
  const current = readConfig(root, path);
  if (current === undefined) return { type: 'missing', path };
  const stripped = stripWiring(current, wiring);
  if (same(stripped, current)) return { type: 'skip', path };
  const ours = record.created && path === record.path && isBare(stripped, wiring.skeleton);
  if (ours) return { type: 'delete', path };
  return { type: 'unwire', path, content: serialize(stripped) };
}

export function wiringState(root, wiring) {
  try {
    const link = linkOf(root, wiring.path);
    if (link.kind === 'broken') return 'missing';
    const current = readConfig(root, throughLink(root, wiring.path));
    return current !== undefined && isWired(current, wiring) ? 'ok' : 'missing';
  } catch {
    return 'unreadable';
  }
}

// A user file that is a symbolic link is edited through the link, so the link
// survives. Returns the path to read and write, relative to root.
// What a path is: a plain path, a link inside the project (with its target),
// a link to a file outside the project, or a link that leads nowhere.
function linkOf(root, path) {
  const full = join(root, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return { kind: 'plain', path };
  }
  if (!stat.isSymbolicLink()) return { kind: 'plain', path };
  let target;
  try {
    target = realpathSync(full);
  } catch {
    return { kind: 'broken', path };
  }
  const inside = relative(realpathSync(root), target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return { kind: 'outside', path };
  }
  return { kind: 'inside', path: inside.split(sep).join('/') };
}

function throughLink(root, path) {
  const link = linkOf(root, path);
  const refuse = (problem, next = '') =>
    new ConfigError(`${path} is ${problem}. wishforge will not modify it${next}.`);
  if (link.kind === 'broken') throw refuse('a broken symbolic link');
  if (link.kind === 'outside') {
    throw refuse(
      'a symbolic link to a file outside the project',
      ': wishforge edits only files inside the project. Replace the link with a regular file, ' +
        'or point it at a file inside the project'
    );
  }
  return link.path;
}

function readText(root, path) {
  const full = join(root, path);
  if (!existsSync(full)) return undefined;
  try {
    return readFileSync(full, 'utf8');
  } catch (error) {
    throw new ConfigError(
      `${path} cannot be read (${error.code ?? error.message}). wishforge will not change it: ` +
        'make it a readable file, or remove it, and re-run.'
    );
  }
}

// The text of a config that is a link to a file outside the project, or
// undefined when it is not one. Dotfile managers often keep configs that way.
function outsideText(root, path) {
  const full = join(root, path);
  try {
    if (!lstatSync(full).isSymbolicLink()) return undefined;
    const target = realpathSync(full);
    const inside = relative(realpathSync(root), target);
    if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) return undefined;
    return readFileSync(target, 'utf8');
  } catch {
    return undefined;
  }
}

// The file's next text, and whether nothing but wishforge's skeleton is left.
function nextRulesText(wiring, current, rules, active) {
  if (wiring.kind === 'block') {
    if (active) {
      return { text: mergeBlock(current, wiring.block(rules), wiring.path), bare: false };
    }
    const text = stripBlock(current, wiring.path);
    return { text, bare: text.replace(/^\uFEFF/, '').trim() === '' };
  }
  const config =
    current === undefined ? undefined : parseInstructions(current, wiring.path, wiring.entries);
  const next = active ? mergeInstructions(config, wiring) : stripInstructions(config, wiring.known);
  // An unchanged config keeps its text, so the user's formatting survives.
  const text = config !== undefined && same(next, config) ? current : serialize(next);
  return { text, bare: same(next, wiring.skeleton) };
}

const BY_HAND = 'wishforge leaves this file alone; the entry is already there';
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

// A config wishforge will not edit is still fine when the user has put the
// entry in by hand. Returns the path of that file, or undefined when wishforge
// can edit the config itself. Throws when neither holds.
function wiredByHand(root, wiring, path, current) {
  if (wiring.kind !== 'json') return undefined;
  // Only the entries that are not there yet are asked for.
  const missing = (text) => {
    const found = foundEntries(text, wiring.entries);
    return wiring.entries.filter((entry) => !found.includes(entry));
  };
  if (current !== undefined) {
    if (parses(wiring, current)) return undefined;
    if (handWired(current, wiring.entries)) return path;
    return parseInstructions(current, wiring.path, missing(current));
  }
  const other = readText(root, wiring.alternative);
  if (other === undefined) return undefined;
  if (handWired(other, wiring.entries)) return wiring.alternative;
  const wanted = missing(other)
    .map((entry) => JSON.stringify(entry))
    .join(' and ');
  throw new ConfigError(
    `${wiring.alternative} exists and ${wiring.path} does not. wishforge will not create a ` +
      `second OpenCode config: add ${wanted} to its "instructions" list ` +
      `in ${wiring.alternative} by hand, and re-run.`
  );
}

// The config wishforge cannot edit, if that is the state of things: the file
// to name, whether every wanted entry is in it, and which of wishforge's
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
// block, a wanted entry for OpenCode. When it is not active, wishforge's part
// is taken out again. previous is the lockfile record. removing is true when
// the operation takes items away: a config that cannot be edited then never
// stops it.
export function planRulesWiring(root, wiring, rules, previous, { removing = false } = {}) {
  const active = wiring.kind === 'json' ? wiring.entries.length > 0 : rules.length > 0;
  const linked = wiring.kind === 'json' ? outsideText(root, wiring.path) : undefined;
  if (linked !== undefined) return planOutside(wiring, linked, active, previous, removing);
  const path = throughLink(root, wiring.path);
  const current = readText(root, path);
  const row = (type, extra = {}) => ({ id: RULES_ID, type, path, ...extra });

  if (active) {
    const stuck = uneditable(root, wiring, path, current);
    if (removing && stuck && !stuck.wired) {
      return { action: row('skip', { path: stuck.file }), record: previous };
    }
    const byHand = wiredByHand(root, wiring, path, current);
    if (byHand) {
      // Entries of wishforge's that are in the file and no longer wanted stay
      // there until the person takes them out: say which.
      const extra = stuck.left.filter((entry) => !wiring.entries.includes(entry));
      const reason = extra.length > 0 ? takeOut(extra) : BY_HAND;
      return {
        action: row('manual', { path: byHand, reason }),
        record: { path: byHand, created: false, manual: true },
      };
    }
    const { text } = nextRulesText(wiring, current, rules, active);
    const created = current === undefined ? true : (previous?.created ?? false);
    return {
      // A removal that leaves something wanted updates the file; it does not wire it.
      action: row(text === current ? 'skip' : removing ? 'rewire' : 'wire', { content: text }),
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

// An OpenCode config linked from outside the project is never edited: it can
// only be wired by hand, and taken apart by hand.
function planOutside(wiring, text, active, previous, removing) {
  const path = wiring.path;
  const row = (type, extra = {}) => ({ id: RULES_ID, type, path, ...extra });
  const left = foundEntries(text, wiring.known);
  if (!active) {
    const action = left.length > 0 ? row('manual', { reason: takeOut(left) }) : row('skip');
    return { action, record: null };
  }
  if (handWired(text, wiring.entries)) {
    const extra = left.filter((entry) => !wiring.entries.includes(entry));
    return {
      action: row('manual', { reason: extra.length > 0 ? takeOut(extra) : BY_HAND }),
      record: { path, created: false, manual: true },
    };
  }
  if (removing) return { action: row('skip'), record: previous };
  const missing = wiring.entries
    .filter((entry) => !left.includes(entry))
    .map((entry) => JSON.stringify(entry))
    .join(' and ');
  throw new ConfigError(
    `${path} is a symbolic link to a file outside the project. wishforge will not edit it: ` +
      `add ${missing} to its "instructions" list by hand, and re-run.`
  );
}

export function rulesState(root, wiring) {
  const linked = wiring.kind === 'json' ? outsideText(root, wiring.path) : undefined;
  // It was read: lacking the entries makes it missing, not unreadable.
  if (linked !== undefined) return handWired(linked, wiring.entries) ? 'ok' : 'missing';
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
