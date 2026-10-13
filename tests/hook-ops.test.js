import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as claudeAdapter from '../src/adapters/claude.js';
import * as cursorAdapter from '../src/adapters/cursor.js';
import { loadCatalog } from '../src/catalog.js';
import { ConfigError, LockError, UsageError } from '../src/errors.js';
import { lockPath, readLock } from '../src/lock.js';
import { add, remove, status, update } from '../src/ops.js';
import { isWired } from '../src/wiring.js';
import { agentMd, tmpDir, writeTree } from './helpers.js';
import { hookTree, runtimeTree } from './hook-helpers.js';

const RUNTIME = 'runtime:hooks';
const tree = {
  'agents/alpha.md': agentMd('alpha'),
  ...runtimeTree(),
  ...hookTree('g1'),
  ...hookTree('g2'),
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
const json = (path) => JSON.parse(readFileSync(at(path), 'utf8'));
const rows = (result) => result.plans[0].actions.map((action) => [action.id, action.type, action.path]);
const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: './my-hook.sh' }] };
const userSettings = { permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [mine] } };

beforeEach(() => {
  catalog = loadCatalog(writeTree(tmpDir(), tree));
  cwd = tmpDir();
  home = tmpDir();
});

describe('adding a gate', () => {
  it('installs the gate, the runner and the wiring, and records them', () => {
    const result = add(ctx(), ['g1'], ['claude']);
    expect(rows(result)).toEqual([
      [RUNTIME, 'create', '.claude/forgeflow/run.mjs'],
      [RUNTIME, 'create', '.claude/forgeflow/runtime.mjs'],
      ['hook:g1', 'create', '.claude/forgeflow/gates/g1.mjs'],
      [RUNTIME, 'wire', '.claude/settings.json'],
    ]);
    expect(readFileSync(at('.claude/forgeflow/gates/g1.mjs'), 'utf8')).toBe(
      '// managed by forgeflow: hook:g1@0.1.0\nexport function check() {}\n// g1\n'
    );
    expect(isWired(json('.claude/settings.json'), claudeAdapter.wiring)).toBe(true);

    const { items } = readLock(cwd).targets.claude;
    expect(items['hook:g1'].explicit).toBe(true);
    expect(items[RUNTIME].explicit).toBe(false);
    expect(items[RUNTIME].wiring).toEqual({ path: '.claude/settings.json', created: true });
    expect(items['hook:g1'].wiring).toBeUndefined();
  });

  it('merges into an existing config and keeps everything in it', () => {
    writeTree(cwd, { '.claude/settings.json': JSON.stringify(userSettings) });
    add(ctx(), ['g1'], ['claude']);
    const settings = json('.claude/settings.json');
    expect(settings.permissions).toEqual(userSettings.permissions);
    expect(settings.hooks.PreToolUse[0]).toEqual(mine);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(readLock(cwd).targets.claude.items[RUNTIME].wiring.created).toBe(false);
  });

  it('leaves the wiring alone when a second gate is added', () => {
    add(ctx(), ['g1'], ['claude']);
    const before = readFileSync(at('.claude/settings.json'), 'utf8');
    const result = add(ctx(), ['g2'], ['claude']);
    expect(rows(result).at(-1)).toEqual([RUNTIME, 'skip', '.claude/settings.json']);
    expect(readFileSync(at('.claude/settings.json'), 'utf8')).toBe(before);
    expect(readLock(cwd).targets.claude.items[RUNTIME].wiring.created).toBe(true);
  });

  it('restores wiring the user deleted, on update', () => {
    add(ctx(), ['g1'], ['claude']);
    writeFileSync(at('.claude/settings.json'), '{}');
    const result = update(ctx(), [], undefined);
    expect(rows(result).at(-1)).toEqual([RUNTIME, 'wire', '.claude/settings.json']);
    expect(isWired(json('.claude/settings.json'), claudeAdapter.wiring)).toBe(true);
  });

  it('creates a versioned hooks.json for Cursor', () => {
    add(ctx(), ['g1'], ['cursor']);
    const config = json('.cursor/hooks.json');
    expect(config.version).toBe(1);
    expect(isWired(config, cursorAdapter.wiring)).toBe(true);
    expect(existsSync(at('.cursor/forgeflow/run.mjs'))).toBe(true);
  });

  it('installs a plugin and no config wiring for OpenCode', () => {
    const result = add(ctx(), ['g1'], ['opencode']);
    expect(rows(result)).toEqual([
      [RUNTIME, 'create', '.opencode/forgeflow/runtime.mjs'],
      [RUNTIME, 'create', '.opencode/plugins/forgeflow.js'],
      ['hook:g1', 'create', '.opencode/forgeflow/gates/g1.mjs'],
    ]);
    expect(readLock(cwd).targets.opencode.items[RUNTIME].wiring).toBeUndefined();
  });

  it('does not wire when only agents are installed', () => {
    add(ctx(), ['alpha'], ['claude']);
    expect(existsSync(at('.claude/settings.json'))).toBe(false);
    expect(existsSync(at('.claude/forgeflow'))).toBe(false);
  });

  it('writes nothing on a dry run', () => {
    const result = add(ctx({ dryRun: true }), ['g1'], ['claude']);
    expect(rows(result).at(-1)).toEqual([RUNTIME, 'wire', '.claude/settings.json']);
    expect(existsSync(at('.claude'))).toBe(false);
  });

  it.each([
    ['invalid JSON', '{ broken'],
    ['a list', '[]'],
    ['a wrong hooks shape', '{"hooks":[]}'],
  ])('refuses a config that is %s and writes to no target, even with force', (_label, text) => {
    writeTree(cwd, { '.claude/settings.json': text });
    for (const force of [false, true]) {
      expect(() => add(ctx({ force }), ['g1'], ['cursor', 'claude'])).toThrow(ConfigError);
      expect(() => add(ctx({ force }), ['g1'], ['cursor', 'claude'])).toThrow('.claude/settings.json');
    }
    expect(readFileSync(at('.claude/settings.json'), 'utf8')).toBe(text);
    expect(existsSync(at('.cursor'))).toBe(false);
    expect(existsSync(at('.claude/forgeflow'))).toBe(false);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('refuses to install gates globally', () => {
    expect(() => add(ctx({ scope: 'global' }), ['g1'], ['claude'])).toThrow(UsageError);
    expect(() => add(ctx({ scope: 'global' }), ['g1'], ['claude'])).toThrow('per project');
    expect(existsSync(join(home, '.claude'))).toBe(false);
    add(ctx({ scope: 'global' }), ['alpha'], ['claude']);
    expect(existsSync(join(home, '.claude/agents/alpha.md'))).toBe(true);
  });
});

describe('removing a gate', () => {
  it('keeps the runner and wiring while another gate remains', () => {
    add(ctx(), ['g1', 'g2'], ['claude']);
    const result = remove(ctx(), ['g1'], ['claude']);
    expect(rows(result)).toEqual([['hook:g1', 'delete', '.claude/forgeflow/gates/g1.mjs']]);
    expect(existsSync(at('.claude/forgeflow/run.mjs'))).toBe(true);
    expect(isWired(json('.claude/settings.json'), claudeAdapter.wiring)).toBe(true);
  });

  it('removes the runner, the wiring and a config file it created with the last gate', () => {
    add(ctx(), ['g1'], ['claude']);
    const result = remove(ctx(), ['g1'], ['claude']);
    expect(rows(result)[0]).toEqual([RUNTIME, 'delete', '.claude/settings.json']);
    expect(existsSync(at('.claude'))).toBe(false);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('leaves the user config exactly as it was before the install', () => {
    writeTree(cwd, { '.claude/settings.json': JSON.stringify(userSettings) });
    add(ctx(), ['g1'], ['claude']);
    const result = remove(ctx(), ['g1'], ['claude']);
    expect(rows(result)[0]).toEqual([RUNTIME, 'unwire', '.claude/settings.json']);
    expect(json('.claude/settings.json')).toEqual(userSettings);
    expect(existsSync(at('.claude/forgeflow'))).toBe(false);
  });

  it('keeps a created config the user has since added to', () => {
    add(ctx(), ['g1'], ['claude']);
    const settings = json('.claude/settings.json');
    settings.model = 'opus';
    writeFileSync(at('.claude/settings.json'), JSON.stringify(settings));
    remove(ctx(), ['g1'], ['claude']);
    expect(json('.claude/settings.json')).toEqual({ model: 'opus' });
  });

  it('deletes a Cursor hooks.json it created', () => {
    add(ctx(), ['g1'], ['cursor']);
    remove(ctx(), ['g1'], ['cursor']);
    expect(existsSync(at('.cursor'))).toBe(false);
  });

  it('succeeds when the user already deleted the config', () => {
    add(ctx(), ['g1'], ['claude']);
    writeFileSync(at('.claude/settings.json'), '{}');
    expect(rows(remove(ctx(), ['g1'], ['claude']))[0]).toEqual([RUNTIME, 'skip', '.claude/settings.json']);
    expect(json('.claude/settings.json')).toEqual({});
  });

  it('refuses to remove the runtime while a gate needs it', () => {
    add(ctx(), ['g1'], ['claude']);
    expect(() => remove(ctx(), [RUNTIME], ['claude'])).toThrow('hook:g1 requires it');
  });

  it('writes nothing on a dry run', () => {
    add(ctx(), ['g1'], ['claude']);
    const before = readFileSync(at('.claude/settings.json'), 'utf8');
    remove(ctx({ dryRun: true }), ['g1'], ['claude']);
    expect(readFileSync(at('.claude/settings.json'), 'utf8')).toBe(before);
    expect(existsSync(at('.claude/forgeflow/gates/g1.mjs'))).toBe(true);
  });
});

describe('status', () => {
  it('reports wiring per target', () => {
    add(ctx(), ['g1'], ['claude', 'opencode']);
    add(ctx(), ['alpha'], ['cursor']);
    const byTarget = Object.fromEntries(status(ctx()).map((entry) => [entry.target, entry.wiring]));
    expect(byTarget).toEqual({
      claude: { path: '.claude/settings.json', state: 'ok' },
      opencode: null,
      cursor: null,
    });
  });

  it('reports wiring the user removed or broke', () => {
    add(ctx(), ['g1'], ['claude']);
    writeFileSync(at('.claude/settings.json'), '{}');
    expect(status(ctx())[0].wiring.state).toBe('missing');
    writeFileSync(at('.claude/settings.json'), '{ broken');
    expect(status(ctx())[0].wiring.state).toBe('unreadable');
  });
});

describe('lockfile wiring record', () => {
  const tamper = (wiring) => {
    add(ctx(), ['g1'], ['claude']);
    const lock = JSON.parse(readFileSync(lockPath(cwd), 'utf8'));
    lock.targets.claude.items[RUNTIME].wiring = wiring;
    writeFileSync(lockPath(cwd), JSON.stringify(lock));
  };

  it.each([
    ['a path outside the project', { path: '../settings.json', created: true }],
    ['an absolute path', { path: '/etc/settings.json', created: true }],
    ['a missing created flag', { path: '.claude/settings.json' }],
    ['a non-object', 'yes'],
  ])('refuses %s', (_label, wiring) => {
    tamper(wiring);
    expect(() => readLock(cwd)).toThrow(LockError);
  });
});
