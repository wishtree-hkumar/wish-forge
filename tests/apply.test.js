import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyActions, checkWritable } from '../src/apply.js';
import { tmpDir, writeTree } from './helpers.js';

const read = (root, path) => readFileSync(join(root, path), 'utf8');

describe('applyActions', () => {
  it('writes create and update actions, making directories', () => {
    const root = writeTree(tmpDir(), { 'a/old.md': 'old' });
    applyActions(root, [
      { type: 'create', path: 'a/b/new.md', content: 'new' },
      { type: 'update', path: 'a/old.md', content: 'updated' },
    ]);
    expect(read(root, 'a/b/new.md')).toBe('new');
    expect(read(root, 'a/old.md')).toBe('updated');
    expect(readdirSync(join(root, 'a'))).toEqual(['b', 'old.md']);
  });

  it('writes Buffer content byte for byte', () => {
    const root = tmpDir();
    applyActions(root, [{ type: 'create', path: 'bin.dat', content: Buffer.from([0, 255]) }]);
    expect(readFileSync(join(root, 'bin.dat'))).toEqual(Buffer.from([0, 255]));
  });

  it('leaves skip, missing, conflict and keep alone without force', () => {
    const root = writeTree(tmpDir(), { 'c.md': 'theirs', 'k.md': 'edited' });
    applyActions(root, [
      { type: 'skip', path: 's.md', content: 'x' },
      { type: 'missing', path: 'm.md' },
      { type: 'conflict', path: 'c.md', content: 'ours', reason: 'r' },
      { type: 'keep', path: 'k.md', reason: 'r' },
    ]);
    expect(read(root, 'c.md')).toBe('theirs');
    expect(read(root, 'k.md')).toBe('edited');
    expect(existsSync(join(root, 's.md'))).toBe(false);
  });

  it('overwrites conflicts and deletes kept files with force', () => {
    const root = writeTree(tmpDir(), { 'c.md': 'theirs', 'k.md': 'edited' });
    const actions = [
      { type: 'conflict', path: 'c.md', content: 'ours', reason: 'r' },
      { type: 'keep', path: 'k.md', reason: 'r' },
    ];
    applyActions(root, actions, true);
    expect(read(root, 'c.md')).toBe('ours');
    expect(existsSync(join(root, 'k.md'))).toBe(false);
  });

  it('deletes a file and prunes directories that become empty', () => {
    const root = writeTree(tmpDir(), { 'a/b/one.md': '1', 'a/keep.md': 'k' });
    applyActions(root, [{ type: 'delete', path: 'a/b/one.md' }]);
    expect(existsSync(join(root, 'a/b'))).toBe(false);
    expect(read(root, 'a/keep.md')).toBe('k');
  });

  it('never removes the root itself', () => {
    const root = writeTree(tmpDir(), { 'only.md': '1' });
    applyActions(root, [{ type: 'delete', path: 'only.md' }]);
    expect(existsSync(root)).toBe(true);
  });
});

describe('checkWritable', () => {
  const asUser = process.getuid?.() !== 0;

  it('passes when the nearest existing directory is writable', () => {
    const root = tmpDir();
    expect(() =>
      checkWritable(root, [{ type: 'create', path: 'x/y/z.md', content: '' }])
    ).not.toThrow();
  });

  it.skipIf(!asUser)('throws when the directory cannot be written', () => {
    const root = writeTree(tmpDir(), { 'locked/a.md': 'x' });
    chmodSync(join(root, 'locked'), 0o555);
    try {
      const action = { type: 'create', path: 'locked/new.md', content: '' };
      expect(() => checkWritable(root, [action])).toThrow('no write permission for');
      expect(() => checkWritable(root, [{ ...action, type: 'skip' }])).not.toThrow();
    } finally {
      chmodSync(join(root, 'locked'), 0o755);
    }
  });
});
