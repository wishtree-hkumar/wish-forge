import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const ALWAYS = new Set(['create', 'update', 'delete']);
const WITH_FORCE = new Set(['conflict', 'keep']);

function touchesDisk(action, force) {
  return ALWAYS.has(action.type) || (force && WITH_FORCE.has(action.type));
}

export function checkWritable(root, actions, force = false) {
  for (const action of actions) {
    if (!touchesDisk(action, force)) continue;
    let dir = dirname(join(root, action.path));
    while (!existsSync(dir)) dir = dirname(dir);
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      throw new Error(`no write permission for ${dir}`);
    }
  }
}

function writeAtomic(full, content) {
  mkdirSync(dirname(full), { recursive: true });
  const tmp = `${full}.forgeflow-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, full);
}

function removeAndPrune(root, path) {
  rmSync(join(root, path), { force: true });
  let dir = dirname(join(root, path));
  while (dir !== root && dir.startsWith(root) && readdirSync(dir).length === 0) {
    rmdirSync(dir);
    dir = dirname(dir);
  }
}

export function applyActions(root, actions, force = false) {
  for (const action of actions) {
    if (!touchesDisk(action, force)) continue;
    if (action.content !== undefined) writeAtomic(join(root, action.path), action.content);
    else removeAndPrune(root, action.path);
  }
}
