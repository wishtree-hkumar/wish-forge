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

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// The lockfile is shared input (teams commit it), so its paths are not trusted:
// a path that leaves the install root could make remove or update delete anything.
function isSafePath(path) {
  if (typeof path !== 'string' || path === '' || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split('/').includes('..');
}

function validate(path, lock) {
  const malformed = (what) =>
    new LockError(`${path} is malformed: ${what}. Fix or delete it, then re-run.`);
  if (!isObject(lock.targets)) throw malformed('"targets" must be an object');
  for (const [target, entry] of Object.entries(lock.targets)) {
    if (!isObject(entry) || !isObject(entry.items))
      throw malformed(`target "${target}" has no items`);
    for (const [id, item] of Object.entries(entry.items)) {
      if (!isObject(item) || !Array.isArray(item.files)) throw malformed(`${id} has no files list`);
      for (const file of item.files) {
        if (!isSafePath(file?.path)) {
          throw new LockError(
            `${path} contains an unsafe file path (${JSON.stringify(file?.path)}) for ${id}. ` +
              'Paths must be relative and stay inside the install directory. Fix or delete the lockfile.'
          );
        }
        if (typeof file.sha256 !== 'string') throw malformed(`${id} has a file without a sha256`);
      }
    }
  }
}

export function readLock(base) {
  const path = lockPath(base);
  if (!existsSync(path)) return { version: LOCK_VERSION, forgeflow: null, targets: {} };

  let lock;
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new LockError(
      `${path} is not valid JSON (${error.message}). Fix or delete it, then re-run.`
    );
  }
  if (lock?.version !== LOCK_VERSION) {
    throw new LockError(
      `${path} has an unsupported format (version ${lock?.version}). ` +
        `This forgeflow reads version ${LOCK_VERSION}. Upgrade forgeflow or delete the file.`
    );
  }
  validate(path, lock);
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
