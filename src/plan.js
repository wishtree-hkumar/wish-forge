import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './lock.js';
import { isWired, mergeWiring, parseConfig, serialize, stripWiring } from './wiring.js';

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
