import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Action, ActionType } from './types';

// wire and unwire rewrite a harness config with only wishforge's entries
// changed, so they are never conflicts and do not depend on force.
const ALWAYS = new Set<ActionType>(['create', 'update', 'delete', 'wire', 'rewire', 'unwire']);
const WITH_FORCE = new Set<ActionType>(['conflict', 'keep']);

function touchesDisk(action: Action, force: boolean): boolean {
  return ALWAYS.has(action.type) || (force && WITH_FORCE.has(action.type));
}

export function checkWritable(root: string, actions: Action[], force = false): void {
  for (const action of actions) {
    if (!touchesDisk(action, force)) continue;
    let dir = dirname(join(root, action.path));
    while (!existsSync(dir)) dir = dirname(dir);
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory`);
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      throw new Error(`no write permission for ${dir}`);
    }
  }
}

function writeAtomic(full: string, content: string | Buffer): void {
  mkdirSync(dirname(full), { recursive: true });
  const tmp = `${full}.wishforge-tmp-${process.pid}`;
  // A file being replaced keeps its permissions: a harness config may hold secrets.
  let mode: number | undefined;
  try {
    mode = statSync(full).mode & 0o7777;
  } catch {
    // a new file gets the default mode
  }
  writeFileSync(tmp, content, mode === undefined ? {} : { mode });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, full);
}

function removeAndPrune(root: string, path: string): void {
  rmSync(join(root, path), { force: true });
  let dir = dirname(join(root, path));
  // Pruning is tidying, not part of the delete: never fail on it, never unlink a symlink.
  try {
    while (dir !== root && dir.startsWith(root) && !lstatSync(dir).isSymbolicLink()) {
      if (readdirSync(dir).length > 0) break;
      rmdirSync(dir);
      dir = dirname(dir);
    }
  } catch {
    // leave the directory in place
  }
}

export function applyActions(root: string, actions: Action[], force = false): void {
  for (const action of actions) {
    if (!touchesDisk(action, force)) continue;
    if (action.content !== undefined) writeAtomic(join(root, action.path), action.content);
    else removeAndPrune(root, action.path);
  }
}
