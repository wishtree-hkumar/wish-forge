import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LockError } from './errors.js';

export const LOCK_VERSION = 1;

export function lockPath(base) {
  return join(base, '.forgeflow', 'lock.json');
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function readLock(base) {
  const path = lockPath(base);
  if (!existsSync(path)) return { version: LOCK_VERSION, forgeflow: null, targets: {} };

  let lock;
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new LockError(`${path} is not valid JSON (${error.message}). Fix or delete it, then re-run.`);
  }
  if (lock?.version !== LOCK_VERSION || typeof lock.targets !== 'object' || lock.targets === null) {
    throw new LockError(
      `${path} has an unsupported format (version ${lock?.version}). ` +
        `This forgeflow reads version ${LOCK_VERSION}. Upgrade forgeflow or delete the file.`
    );
  }
  return lock;
}

export function writeLock(base, lock, version) {
  const path = lockPath(base);
  const targets = Object.fromEntries(
    Object.entries(lock.targets).filter(([, target]) => Object.keys(target.items).length > 0)
  );
  if (Object.keys(targets).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const data = { version: LOCK_VERSION, forgeflow: version, targets };
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}
