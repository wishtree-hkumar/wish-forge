import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { ConflictError, UsageError } from '../src/errors.js';
import { lockPath, readLock } from '../src/lock.js';
import { add, remove, status, update } from '../src/ops.js';
import { agentMd, skillMd, tmpDir, writeTree } from './helpers.js';

const tree = {
  'agents/alpha.md': agentMd('alpha'),
  'agents/beta.md': agentMd('beta'),
  'skills/flow/SKILL.md': skillMd('flow', 'requires: [agent:alpha, agent:beta]\n'),
};

let catalog;
let cwd;
let home;
const ctx = (overrides = {}) => ({
  catalog,
  version: '0.1.0',
  scope: 'project',
  cwd,
  home,
  force: false,
  dryRun: false,
  ...overrides,
});
const at = (path) => join(cwd, path);
const types = (result) => result.plans.flatMap((plan) => plan.actions.map((action) => action.type));

beforeEach(() => {
  catalog = loadCatalog(writeTree(tmpDir(), tree));
  cwd = tmpDir();
  home = tmpDir();
});

describe('add', () => {
  it('installs an item with its requirements and records them', () => {
    const result = add(ctx(), ['flow'], ['cursor']);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({ target: 'cursor', root: cwd });
    expect(result.plans[0].actions.map((action) => [action.id, action.type, action.path])).toEqual([
      ['agent:alpha', 'create', '.cursor/agents/alpha.md'],
      ['agent:beta', 'create', '.cursor/agents/beta.md'],
      ['skill:flow', 'create', '.cursor/skills/flow/SKILL.md'],
    ]);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toContain('Body of alpha.');

    const { items } = readLock(cwd).targets.cursor;
    expect(items['skill:flow'].explicit).toBe(true);
    expect(items['agent:alpha'].explicit).toBe(false);
    expect(items['agent:alpha'].files).toEqual([
      { path: '.cursor/agents/alpha.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  it('is idempotent', () => {
    add(ctx(), ['flow'], ['cursor']);
    expect(types(add(ctx(), ['flow'], ['cursor']))).toEqual(['skip', 'skip', 'skip']);
  });

  it('keeps an item explicit when a later add pulls it in as a requirement', () => {
    add(ctx(), ['alpha'], ['cursor']);
    add(ctx(), ['flow'], ['cursor']);
    expect(readLock(cwd).targets.cursor.items['agent:alpha'].explicit).toBe(true);
  });

  it('writes nothing on a dry run', () => {
    expect(types(add(ctx({ dryRun: true }), ['alpha'], ['cursor']))).toEqual(['create']);
    expect(existsSync(at('.cursor'))).toBe(false);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('refuses to overwrite a file it did not install, then does so with force', () => {
    writeTree(cwd, { '.cursor/agents/alpha.md': 'mine' });
    let error;
    try {
      add(ctx(), ['alpha'], ['cursor']);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.conflicts).toEqual([
      {
        target: 'cursor',
        path: '.cursor/agents/alpha.md',
        reason: 'exists and was not installed by forgeflow',
      },
    ]);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toBe('mine');

    add(ctx({ force: true }), ['alpha'], ['cursor']);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toContain('Body of alpha.');
  });

  it('writes to no target when one target has a conflict', () => {
    writeTree(cwd, { '.codex/agents/alpha.toml': 'mine' });
    expect(() => add(ctx(), ['alpha'], ['cursor', 'codex'])).toThrow(ConflictError);
    expect(existsSync(at('.cursor'))).toBe(false);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('adopts identical files left by an interrupted run', () => {
    add(ctx(), ['flow'], ['cursor']);
    rmSync(lockPath(cwd));
    expect(types(add(ctx(), ['flow'], ['cursor']))).toEqual(['skip', 'skip', 'skip']);
    expect(Object.keys(readLock(cwd).targets.cursor.items)).toHaveLength(3);
  });

  it('installs globally under home, with OpenCode in its config directory', () => {
    add(ctx({ scope: 'global' }), ['alpha'], ['opencode', 'claude']);
    expect(existsSync(join(home, '.config/opencode/agents/alpha.md'))).toBe(true);
    expect(existsSync(join(home, '.claude/agents/alpha.md'))).toBe(true);
    expect(existsSync(lockPath(home))).toBe(true);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('rejects an unknown item and an unknown target', () => {
    expect(() => add(ctx(), ['ghost'], ['cursor'])).toThrow(UsageError);
    expect(() => add(ctx(), ['alpha'], ['vim'])).toThrow('unknown target "vim"');
  });
});

describe('update', () => {
  const newer = () => loadCatalog(writeTree(tmpDir(), { ...tree, 'agents/alpha.md': agentMd('alpha').replace('Body', 'New body') }));

  it('rewrites unedited files from the current catalog', () => {
    add(ctx(), ['flow'], ['cursor']);
    const result = update(ctx({ catalog: newer() }), [], undefined);
    expect(types(result)).toEqual(['update', 'skip', 'skip']);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toContain('New body of alpha.');
    expect(readLock(cwd).targets.cursor.items['agent:alpha'].explicit).toBe(false);
  });

  it('reports a conflict for an edited file and overwrites it with force', () => {
    add(ctx(), ['alpha'], ['cursor']);
    writeFileSync(at('.cursor/agents/alpha.md'), 'my edit');

    expect(() => update(ctx({ catalog: newer() }), [], undefined)).toThrow(ConflictError);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toBe('my edit');

    update(ctx({ catalog: newer(), force: true }), [], undefined);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toContain('New body of alpha.');
  });

  it('covers every installed target when none is given, or only the named one', () => {
    add(ctx(), ['alpha'], ['cursor', 'claude']);
    const all = update(ctx({ catalog: newer() }), [], undefined);
    expect(all.plans.map((plan) => plan.target).sort()).toEqual(['claude', 'cursor']);

    const one = update(ctx(), [], ['claude']);
    expect(one.plans.map((plan) => plan.target)).toEqual(['claude']);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toContain('New body of alpha.');
  });

  it('rejects an item that is not installed', () => {
    add(ctx(), ['alpha'], ['cursor']);
    expect(() => update(ctx(), ['beta'], ['cursor'])).toThrow('agent:beta is not installed for cursor');
  });

  it('skips and reports an installed item the catalog no longer has', () => {
    add(ctx(), ['alpha', 'beta'], ['cursor']);
    const smaller = loadCatalog(writeTree(tmpDir(), { 'agents/alpha.md': agentMd('alpha') }));
    const result = update(ctx({ catalog: smaller }), [], undefined);
    expect(result.skipped).toEqual([{ target: 'cursor', id: 'agent:beta' }]);
    expect(existsSync(at('.cursor/agents/beta.md'))).toBe(true);
  });
});

describe('remove', () => {
  it('removes an item, its now-unneeded requirements, the lockfile and empty directories', () => {
    add(ctx(), ['flow'], ['cursor']);
    const result = remove(ctx(), ['flow'], ['cursor']);
    expect(types(result)).toEqual(['delete', 'delete', 'delete']);
    expect(existsSync(at('.cursor'))).toBe(false);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('keeps a requirement the user installed explicitly', () => {
    add(ctx(), ['alpha'], ['cursor']);
    add(ctx(), ['flow'], ['cursor']);
    remove(ctx(), ['flow'], ['cursor']);
    expect(Object.keys(readLock(cwd).targets.cursor.items)).toEqual(['agent:alpha']);
    expect(existsSync(at('.cursor/agents/alpha.md'))).toBe(true);
    expect(existsSync(at('.cursor/agents/beta.md'))).toBe(false);
  });

  it('refuses to remove an item another installed item requires', () => {
    add(ctx(), ['flow'], ['cursor']);
    expect(() => remove(ctx(), ['alpha'], ['cursor'])).toThrow(
      'cannot remove agent:alpha: skill:flow requires it'
    );
    expect(existsSync(at('.cursor/agents/alpha.md'))).toBe(true);
  });

  it('leaves an edited file in place, drops its record, and deletes it with force', () => {
    add(ctx(), ['alpha', 'beta'], ['cursor']);
    writeFileSync(at('.cursor/agents/alpha.md'), 'my edit');

    const result = remove(ctx(), ['alpha'], ['cursor']);
    expect(result.plans[0].actions).toEqual([
      { id: 'agent:alpha', type: 'keep', path: '.cursor/agents/alpha.md', reason: 'was edited after install' },
    ]);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toBe('my edit');
    expect(Object.keys(readLock(cwd).targets.cursor.items)).toEqual(['agent:beta']);

    writeFileSync(at('.cursor/agents/beta.md'), 'my edit');
    remove(ctx({ force: true }), ['beta'], ['cursor']);
    expect(existsSync(at('.cursor/agents/beta.md'))).toBe(false);
  });

  it('succeeds when the file was already deleted by hand', () => {
    add(ctx(), ['alpha'], ['cursor']);
    rmSync(at('.cursor/agents/alpha.md'));
    expect(types(remove(ctx(), ['alpha'], ['cursor']))).toEqual(['missing']);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('touches only the named target', () => {
    add(ctx(), ['alpha'], ['cursor', 'claude']);
    remove(ctx(), ['alpha'], ['cursor']);
    expect(existsSync(at('.cursor'))).toBe(false);
    expect(existsSync(at('.claude/agents/alpha.md'))).toBe(true);
    expect(Object.keys(readLock(cwd).targets)).toEqual(['claude']);
  });

  it('writes nothing on a dry run', () => {
    add(ctx(), ['alpha'], ['cursor']);
    expect(types(remove(ctx({ dryRun: true }), ['alpha'], ['cursor']))).toEqual(['delete']);
    expect(existsSync(at('.cursor/agents/alpha.md'))).toBe(true);
    expect(existsSync(lockPath(cwd))).toBe(true);
  });

  it('rejects an item that is not installed', () => {
    expect(() => remove(ctx(), ['alpha'], ['cursor'])).toThrow('agent:alpha is not installed for cursor');
  });

  it('removes by full id an installed item the catalog no longer has', () => {
    add(ctx(), ['beta'], ['cursor']);
    const smaller = loadCatalog(writeTree(tmpDir(), { 'agents/alpha.md': agentMd('alpha') }));
    remove(ctx({ catalog: smaller }), ['agent:beta'], ['cursor']);
    expect(existsSync(at('.cursor'))).toBe(false);
  });
});

describe('status', () => {
  it('reports ok, edited and missing files per target', () => {
    add(ctx(), ['flow'], ['cursor']);
    writeFileSync(at('.cursor/agents/alpha.md'), 'my edit');
    rmSync(at('.cursor/agents/beta.md'));

    const [cursor] = status(ctx());
    expect(cursor.target).toBe('cursor');
    expect(cursor.items.map((entry) => [entry.id, entry.explicit, entry.files[0].state])).toEqual([
      ['agent:alpha', false, 'edited'],
      ['agent:beta', false, 'missing'],
      ['skill:flow', true, 'ok'],
    ]);
  });

  it('returns an empty list when nothing is installed', () => {
    expect(status(ctx())).toEqual([]);
  });
});
