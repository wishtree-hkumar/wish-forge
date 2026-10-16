import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/lock';
import { planInstall, planRemove } from '../src/plan';
import { tmpDir, writeTree } from './helpers';

const file = { path: 'dir/a.md', content: 'new' };
const types = (actions) => actions.map((action) => [action.type, action.path]);

describe('planInstall', () => {
  it('creates a file that is absent', () => {
    expect(planInstall(tmpDir(), [file], [])).toEqual([{ type: 'create', ...file }]);
  });

  it('re-creates a recorded file that was deleted by hand', () => {
    const recorded = [{ path: 'dir/a.md', sha256: sha256('old') }];
    expect(types(planInstall(tmpDir(), [file], recorded))).toEqual([['create', 'dir/a.md']]);
  });

  it('skips a file that is already identical, recorded or not', () => {
    const root = writeTree(tmpDir(), { 'dir/a.md': 'new' });
    expect(types(planInstall(root, [file], []))).toEqual([['skip', 'dir/a.md']]);
    const recorded = [{ path: 'dir/a.md', sha256: sha256('new') }];
    expect(types(planInstall(root, [file], recorded))).toEqual([['skip', 'dir/a.md']]);
  });

  it('updates an unedited recorded file whose content changed', () => {
    const root = writeTree(tmpDir(), { 'dir/a.md': 'old' });
    const recorded = [{ path: 'dir/a.md', sha256: sha256('old') }];
    expect(planInstall(root, [file], recorded)).toEqual([{ type: 'update', ...file }]);
  });

  it('reports a conflict for a recorded file the user edited', () => {
    const root = writeTree(tmpDir(), { 'dir/a.md': 'edited' });
    const recorded = [{ path: 'dir/a.md', sha256: sha256('old') }];
    expect(planInstall(root, [file], recorded)).toEqual([
      { type: 'conflict', ...file, reason: 'was edited after install' },
    ]);
  });

  it('reports a conflict for a file wishforge did not install', () => {
    const root = writeTree(tmpDir(), { 'dir/a.md': 'theirs' });
    expect(planInstall(root, [file], [])).toEqual([
      { type: 'conflict', ...file, reason: 'exists and was not installed by wishforge' },
    ]);
  });

  it('deletes an unedited recorded file that is no longer rendered', () => {
    const root = writeTree(tmpDir(), { 'dir/a.md': 'new', 'dir/gone.md': 'old' });
    const recorded = [
      { path: 'dir/a.md', sha256: sha256('new') },
      { path: 'dir/gone.md', sha256: sha256('old') },
    ];
    expect(types(planInstall(root, [file], recorded))).toEqual([
      ['skip', 'dir/a.md'],
      ['delete', 'dir/gone.md'],
    ]);
  });

  it('keeps an edited recorded file that is no longer rendered', () => {
    const root = writeTree(tmpDir(), { 'dir/gone.md': 'edited' });
    const recorded = [{ path: 'dir/gone.md', sha256: sha256('old') }];
    expect(planInstall(root, [], recorded)).toEqual([
      { type: 'keep', path: 'dir/gone.md', reason: 'was edited after install' },
    ]);
  });

  it('ignores a recorded file that is no longer rendered and already gone', () => {
    expect(planInstall(tmpDir(), [], [{ path: 'dir/gone.md', sha256: 'x' }])).toEqual([]);
  });

  it('hashes Buffer content', () => {
    const root = writeTree(tmpDir(), { 'bin.dat': Buffer.from([0, 255]) });
    const binary = { path: 'bin.dat', content: Buffer.from([0, 255]) };
    expect(types(planInstall(root, [binary], []))).toEqual([['skip', 'bin.dat']]);
  });
});

describe('planRemove', () => {
  it('classifies recorded files as delete, keep or missing', () => {
    const root = writeTree(tmpDir(), { 'same.md': 'old', 'edited.md': 'changed' });
    const recorded = ['same.md', 'edited.md', 'gone.md'].map((path) => ({
      path,
      sha256: sha256('old'),
    }));
    expect(planRemove(root, recorded)).toEqual([
      { type: 'delete', path: 'same.md' },
      { type: 'keep', path: 'edited.md', reason: 'was edited after install' },
      { type: 'missing', path: 'gone.md' },
    ]);
  });
});
