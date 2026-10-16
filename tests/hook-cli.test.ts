import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli';
import { agentMd, capture, tmpDir, writeTree } from './helpers';
import { hookTree, runtimeTree } from './hook-helpers';

let catalogDir;
let cwd;
let home;

function run(...argv) {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { cwd, home, stdout, stderr, catalogDir });
  return { code, out: stdout.text, err: stderr.text };
}

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), {
    'agents/alpha.md': agentMd('alpha', 'stage: review\n'),
    ...runtimeTree(),
    ...hookTree('g1', '[shell, write]'),
    ...hookTree('g2', '[stop]'),
  });
  cwd = tmpDir();
  home = tmpDir();
});

describe('list and info', () => {
  it('lists hooks with their events and hides the runtime', () => {
    const { code, out } = run('list');
    expect(code).toBe(0);
    expect(out).toMatch(/^Quality gates\n {2}g1\s+Gate g1\.$/m);
    expect(out).toContain('3 items.');
    expect(out).not.toMatch(/runtime|Runs gates/);
  });

  it('filters to hooks', () => {
    const { out } = run('list', '--type', 'hook', '--json');
    const rows = JSON.parse(out);
    expect(rows.map((row) => row.id)).toEqual(['hook:g1', 'hook:g2']);
    expect(rows[0].events).toEqual(['shell', 'write']);
    expect(run('list', '--type', 'runtime').code).toBe(2);
  });

  it('shows a hook', () => {
    const { code, out } = run('info', 'g1');
    expect(code).toBe(0);
    expect(out).toContain('hook:g1');
    expect(out).toMatch(/events:\s+shell, write/);
    expect(out).toMatch(/requires:\s+runtime:hooks/);
  });

  it('mentions --hooks in the usage text', () => {
    expect(run('--help').out).toContain('wishforge add --hooks --target');
  });
});

describe('add --hooks', () => {
  it('installs every gate and reports the wiring', () => {
    const { code, out } = run('add', '--hooks', '--target', 'claude');
    expect(code).toBe(0);
    expect(out).toMatch(/create\s+\.claude\/wishforge\/gates\/g1\.mjs/);
    expect(out).toMatch(/create\s+\.claude\/wishforge\/gates\/g2\.mjs/);
    expect(out).toMatch(/wired\s+\.claude\/settings\.json/);
    expect(existsSync(join(cwd, '.claude/settings.json'))).toBe(true);
  });

  it('combines with named items and a flow-less install', () => {
    expect(run('add', 'alpha', '--hooks', '--target', 'cursor').code).toBe(0);
    expect(existsSync(join(cwd, '.cursor/agents/alpha.md'))).toBe(true);
    expect(existsSync(join(cwd, '.cursor/hooks.json'))).toBe(true);
  });

  it('exits 2 for --global with a gate', () => {
    const { code, err } = run('add', 'g1', '--target', 'claude', '--global');
    expect(code).toBe(2);
    expect(err).toContain('per project');
  });

  it('exits 1 and names a config it cannot parse', () => {
    writeTree(cwd, { '.claude/settings.json': '{ broken' });
    const { code, err } = run('add', 'g1', '--target', 'claude', '--force');
    expect(code).toBe(1);
    expect(err).toContain('.claude/settings.json');
    expect(err).toContain('is not valid JSON');
    expect(readFileSync(join(cwd, '.claude/settings.json'), 'utf8')).toBe('{ broken');
  });

  it('reports the unwiring on remove', () => {
    writeTree(cwd, { '.claude/settings.json': '{"model":"opus"}' });
    run('add', 'g1', '--target', 'claude');
    const { code, out } = run('remove', 'g1', '--target', 'claude');
    expect(code).toBe(0);
    expect(out).toMatch(/unwired\s+\.claude\/settings\.json/);
    expect(JSON.parse(readFileSync(join(cwd, '.claude/settings.json'), 'utf8'))).toEqual({
      model: 'opus',
    });
  });
});

describe('status and doctor', () => {
  it('shows the wiring state', () => {
    run('add', 'g1', '--target', 'claude,opencode');
    const { out } = run('status');
    expect(out).toMatch(/wiring ok\s+\.claude\/settings\.json/);
    expect(out.match(/wiring/g)).toHaveLength(1);
  });

  it('passes doctor on a clean install and notes Codex trust', () => {
    run('add', 'g1', '--target', 'claude,codex');
    const { code, out } = run('doctor');
    expect(code).toBe(0);
    expect(out).toMatch(/ok\s+project install matches lockfile/);
    expect(out).toMatch(/ok\s+codex hooks need trusting \(.*\/hooks.*\)/);
  });

  it('does not mention Codex trust when Codex has no gates', () => {
    run('add', 'g1', '--target', 'claude');
    expect(run('doctor').out).not.toContain('codex hooks');
  });

  it('fails doctor when the wiring is gone or unreadable', () => {
    run('add', 'g1', '--target', 'claude');
    writeFileSync(join(cwd, '.claude/settings.json'), '{}');
    const gone = run('doctor');
    expect(gone.code).toBe(1);
    expect(gone.out).toContain('[claude] hook wiring in .claude/settings.json is missing');

    writeFileSync(join(cwd, '.claude/settings.json'), '{ broken');
    expect(run('doctor').out).toContain('is unreadable');
    expect(run('status').out).toMatch(/wiring unreadable\s+\.claude\/settings\.json/);
  });
});
