import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LockError } from '../src/errors.js';
import { lockPath, readLock, sha256, writeLock } from '../src/lock.js';
import { tmpDir, writeTree } from './helpers.js';

const entry = { explicit: true, files: [{ path: 'a.md', sha256: 'abc' }] };

describe('lockfile', () => {
  it('hashes strings and buffers the same way', () => {
    expect(sha256('abc')).toBe(sha256(Buffer.from('abc')));
    expect(sha256('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns an empty lock when the file is missing', () => {
    expect(readLock(tmpDir())).toEqual({ version: 1, forgeflow: null, targets: {} });
  });

  it('round-trips and stamps the forgeflow version', () => {
    const base = tmpDir();
    writeLock(base, { version: 1, targets: { cursor: { items: { 'agent:a': entry } } } }, '0.1.0');
    expect(readLock(base)).toEqual({
      version: 1,
      forgeflow: '0.1.0',
      targets: { cursor: { items: { 'agent:a': entry } } },
    });
    expect(readFileSync(lockPath(base), 'utf8').endsWith('}\n')).toBe(true);
  });

  it('drops empty targets and deletes the file when nothing is installed', () => {
    const base = tmpDir();
    const lock = {
      version: 1,
      targets: { cursor: { items: { 'agent:a': entry } }, codex: { items: {} } },
    };
    writeLock(base, lock, '0.1.0');
    expect(Object.keys(readLock(base).targets)).toEqual(['cursor']);

    writeLock(base, { version: 1, targets: { cursor: { items: {} } } }, '0.1.0');
    expect(existsSync(lockPath(base))).toBe(false);
  });

  it('refuses invalid JSON and leaves the file alone', () => {
    const base = writeTree(tmpDir(), { '.forgeflow/lock.json': '{ broken' });
    expect(() => readLock(base)).toThrow(LockError);
    expect(() => readLock(base)).toThrow('is not valid JSON');
    expect(readFileSync(lockPath(base), 'utf8')).toBe('{ broken');
  });

  it('refuses a lockfile from another format version', () => {
    const base = writeTree(tmpDir(), { '.forgeflow/lock.json': '{"version":2,"targets":{}}' });
    expect(() => readLock(base)).toThrow('unsupported format (version 2)');
  });
});

describe('lockfile validation', () => {
  const lockWith = (targets) =>
    writeTree(tmpDir(), { '.forgeflow/lock.json': JSON.stringify({ version: 1, targets }) });
  const withPath = (path) =>
    lockWith({
      cursor: { items: { 'agent:a': { explicit: true, files: [{ path, sha256: 'abc' }] } } },
    });

  it.each(['../outside.txt', '.cursor/../../outside.txt', '/etc/passwd', 'C:\\x', 'a\\..\\b', ''])(
    'refuses the unsafe file path %j',
    (path) => {
      expect(() => readLock(withPath(path))).toThrow(LockError);
      expect(() => readLock(withPath(path))).toThrow('unsafe file path');
    }
  );

  it('accepts ordinary relative paths', () => {
    expect(() => readLock(withPath('.cursor/agents/a.md'))).not.toThrow();
  });

  it.each([
    ['a target without items', { cursor: {} }],
    ['targets as a list', []],
    ['an item without files', { cursor: { items: { 'agent:a': { explicit: true } } } }],
    [
      'a file without a hash',
      { cursor: { items: { 'agent:a': { explicit: true, files: [{ path: 'a.md' }] } } } },
    ],
  ])('refuses %s', (_label, targets) => {
    expect(() => readLock(lockWith(targets))).toThrow(LockError);
  });
});
