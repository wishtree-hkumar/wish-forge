import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { check as protectedPaths } from '../catalog/hooks/protected-paths/gate.mjs';
import { check as testReminder } from '../catalog/hooks/test-reminder/gate.mjs';
import { evaluate, matchesGlob } from '../catalog/runtime/hooks/runtime.mjs';
import { main } from '../src/cli';
import { capture, tmpDir, writeTree } from './helpers';
import { hookTree, runtimeTree } from './hook-helpers';

let catalogDir;
let cwd;
const run = (...argv) => {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { cwd, home: tmpDir(), stdout, stderr, catalogDir });
  return { code, out: stdout.text, err: stderr.text };
};
const json = (path) => JSON.parse(readFileSync(join(cwd, path), 'utf8'));

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), { ...runtimeTree(), ...hookTree('guard') });
  cwd = tmpDir();
});

describe('a harness config that is a symbolic link', () => {
  it('is edited through the link, which stays', () => {
    writeTree(cwd, { 'config/claude.json': '{\n  "model": "x"\n}\n' });
    writeTree(cwd, { '.claude/.keep': '' });
    symlinkSync('../config/claude.json', join(cwd, '.claude/settings.json'));

    const { code, out } = run('add', 'guard', '--target', 'claude');
    expect(code).toBe(0);
    expect(out).toMatch(/wired\s+config\/claude\.json/);
    expect(lstatSync(join(cwd, '.claude/settings.json')).isSymbolicLink()).toBe(true);
    expect(json('config/claude.json').hooks.PreToolUse).toHaveLength(1);
    expect(run('status').out).toMatch(/wiring ok/);

    expect(run('remove', 'guard', '--target', 'claude').code).toBe(0);
    expect(lstatSync(join(cwd, '.claude/settings.json')).isSymbolicLink()).toBe(true);
    expect(json('config/claude.json')).toEqual({ model: 'x' });
  });
});

describe('a Cursor hooks file the user wrote without a hooks key', () => {
  it('gets no empty hooks object left behind on removal', () => {
    writeTree(cwd, { '.cursor/hooks.json': '{\n  "version": 1\n}\n' });
    run('add', 'guard', '--target', 'cursor');
    expect(json('.cursor/hooks.json').hooks.preToolUse).toHaveLength(1);
    run('remove', 'guard', '--target', 'cursor');
    expect(json('.cursor/hooks.json')).toEqual({ version: 1 });
  });

  it('still deletes a hooks file wishforge created', () => {
    run('add', 'guard', '--target', 'cursor');
    run('remove', 'guard', '--target', 'cursor');
    expect(existsSync(join(cwd, '.cursor/hooks.json'))).toBe(false);
  });
});

describe('protected-paths defaults', () => {
  const ctx = { config: { protectedPaths: [] }, matchesGlob };
  const blocked = (path) =>
    Boolean(protectedPaths({ kind: 'write', path, content: '' }, ctx)?.block);

  it.each([
    '.env.local.example',
    'config/.env.production.sample',
    'web/.env.development.template',
    '.env.example',
    'id_rsa.pub',
    '.ssh/id_ed25519.pub',
  ])('lets the agent write the template or public file %s', (path) => {
    expect(blocked(path)).toBe(false);
  });

  it.each([
    '.env',
    '.env.local',
    '.envrc',
    'web/.envrc',
    'id_rsa',
    '.ssh/id_ed25519',
    'deploy/id_ecdsa',
    'id_dsa',
    'tls/server.key',
    'certs/a.pem',
  ])('protects %s', (path) => {
    expect(blocked(path)).toBe(true);
  });
});

describe('test-reminder', () => {
  const ctxFor = (session, store = { value: {} }) => ({
    config: { testCommands: [] },
    session,
    state: { get: () => store.value, set: (value) => (store.value = value) },
  });
  const edit = { kind: 'write' as const, path: 'src/a.js', content: 'x' };
  const stop = { kind: 'stop' as const };
  const shell = (command) => ({ kind: 'shell' as const, command });

  it.each([
    'cat jest.config.js',
    'npm install jest',
    'pnpm add -D vitest',
    'yarn add --dev jest',
    'grep -r pytest README.md',
    'vim vitest.config.ts',
    'ls tests/',
    'echo "run go test later"',
  ])('does not count %j as a test run', (command) => {
    const ctx = ctxFor('s-1');
    testReminder(edit, ctx);
    testReminder(shell(command), ctx);
    expect(testReminder(stop, ctx)?.note).toContain('test-reminder');
  });

  it.each([
    'npm test',
    'npm run test -- --watch=false',
    'npx vitest run',
    'cd web && npm run test',
    'CI=1 jest --ci',
    'python -m pytest -q',
    'uv run pytest tests/',
    'poetry run pytest',
    './node_modules/.bin/jest',
    'pnpm exec vitest',
    'yarn jest',
    'bundle exec rspec',
    'go test ./...',
    'cargo test',
    'dotnet test',
    'mvn -q test',
    'make test',
  ])('counts %j as a test run', (command) => {
    const ctx = ctxFor('s-1');
    testReminder(edit, ctx);
    testReminder(shell(command), ctx);
    expect(testReminder(stop, ctx)).toBeUndefined();
  });

  it('starts fresh in a new session', () => {
    const store = { value: {} };
    testReminder(edit, ctxFor('s-1', store));
    expect(testReminder(stop, ctxFor('s-2', store))).toBeUndefined();
  });
});

describe('gate state', () => {
  it('is kept inside the project, in the folder that ignores itself', () => {
    const root = tmpDir();
    const gate = {
      name: 'probe',
      check: (_event, ctx) => {
        ctx.state.set({ seen: true });
        return undefined;
      },
    };
    evaluate({
      harness: 'claude',
      payload: { hook_event_name: 'Stop' },
      root,
      gates: [gate],
    });
    expect(
      JSON.parse(readFileSync(join(root, '.wishforge/local/gate-state.json'), 'utf8'))
    ).toEqual({
      seen: true,
    });
    expect(readFileSync(join(root, '.wishforge/local/.gitignore'), 'utf8')).toBe('*\n');
  });

  it('never fails a hook when it cannot be written', () => {
    const root = tmpDir();
    writeFileSync(join(root, '.wishforge'), 'a file');
    const gate = { name: 'probe', check: (_event, ctx) => ctx.state.set({ x: 1 }) };
    const result = evaluate({
      harness: 'claude',
      payload: { hook_event_name: 'Stop' },
      root,
      gates: [gate],
    });
    expect(result.warnings).toEqual([]);
  });
});
