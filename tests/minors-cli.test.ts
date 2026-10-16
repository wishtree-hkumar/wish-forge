import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli';
import { agentMd, capture, skillMd, tmpDir, writeTree } from './helpers';
import { hookTree, runtimeTree } from './hook-helpers';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

describe('a closed output pipe', () => {
  it('ends the command quietly, without a stack trace', async () => {
    const child = spawn(process.execPath, [BIN, 'list'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    let err = '';
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    const code = await new Promise((done) => child.on('close', done));
    expect(err).toBe('');
    expect(code).toBe(0);
  });
});

let catalogDir;
let cwd;
let home;
const run = (...argv) => {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { cwd, home, stdout, stderr, catalogDir });
  return { code, out: stdout.text, err: stderr.text };
};

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), {
    ...runtimeTree(),
    ...hookTree('guard'),
    'agents/alpha.md': agentMd('alpha', 'stage: review\n'),
    'agents/beta.md': agentMd('beta'),
    'agents/gamma.md': agentMd('gamma'),
    'skills/forge-quick/SKILL.md': skillMd('forge-quick', 'requires: [agent:alpha]\n'),
  });
  cwd = tmpDir();
  home = tmpDir();
});

describe('the hidden runtime item', () => {
  it('cannot be added by name', () => {
    const { code, err } = run('add', 'runtime:hooks', '--target', 'claude');
    expect(code).toBe(2);
    expect(err).toContain('runtime:hooks is installed with the quality gates that need it');
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });
});

describe('the last item removed', () => {
  it('leaves no empty .wishforge folder behind', () => {
    run('add', 'beta', '--target', 'cursor');
    expect(run('remove', 'beta', '--target', 'cursor').code).toBe(0);
    expect(existsSync(join(cwd, '.wishforge'))).toBe(false);
  });

  it('keeps a .wishforge folder that holds anything else', () => {
    run('add', 'beta', '--target', 'cursor');
    writeTree(cwd, { '.wishforge/runs/r/state.md': 'status: complete\n' });
    run('remove', 'beta', '--target', 'cursor');
    expect(existsSync(join(cwd, '.wishforge/runs/r/state.md'))).toBe(true);
  });
});

describe('bundle flags on remove', () => {
  it('--specialists removes every installed specialist and nothing else', () => {
    run('add', '--specialists', 'alpha', '--target', 'cursor');
    const { code, out } = run('remove', '--specialists', '--target', 'cursor');
    expect(code).toBe(0);
    expect(out).toMatch(/delete\s+\.cursor\/agents\/beta\.md/);
    expect(existsSync(join(cwd, '.cursor/agents/alpha.md'))).toBe(true);
    expect(existsSync(join(cwd, '.cursor/agents/gamma.md'))).toBe(false);
  });

  it('removes only the members that are installed', () => {
    run('add', 'beta', '--target', 'cursor');
    expect(run('remove', '--specialists', '--target', 'cursor').code).toBe(0);
    expect(existsSync(join(cwd, '.cursor/agents'))).toBe(false);
  });

  it('--hooks and --flow remove what they installed', () => {
    run('add', '--hooks', '--flow', 'quick', '--target', 'claude');
    expect(run('remove', '--hooks', '--flow', 'quick', '--target', 'claude').code).toBe(0);
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });

  it('says so when none of the members is installed', () => {
    const { code, err } = run('remove', '--specialists', '--target', 'cursor');
    expect(code).toBe(2);
    expect(err).toContain('nothing named by --specialists is installed for cursor');
  });
});

describe('bundle flags on update', () => {
  it('are refused, since update without names updates everything', () => {
    run('add', 'beta', '--target', 'cursor');
    const { code, err } = run('update', '--specialists');
    expect(code).toBe(2);
    expect(err).toContain('update takes item names');
  });
});

describe('the home folder', () => {
  it('is not treated as a project, since global installs live there', () => {
    home = cwd;
    for (const argv of [
      ['add', 'beta', '--target', 'cursor'],
      ['remove', 'beta', '--target', 'cursor'],
      ['update'],
    ]) {
      const { code, err } = run(...argv);
      expect(code, argv.join(' ')).toBe(2);
      expect(err).toContain('this is your home folder');
    }
    expect(run('add', 'beta', '--target', 'claude', '--global').code).toBe(0);
  });
});

describe('a harness config wishforge cannot read', () => {
  it('says that deleting a file that holds nothing of yours also works', () => {
    run('add', 'guard', '--target', 'claude');
    writeTree(cwd, { '.claude/settings.json': '{ broken' });
    const { code, err } = run('remove', 'guard', '--target', 'claude');
    expect(code).toBe(1);
    expect(err).toContain('If the file holds nothing you need, deleting it also works.');
  });
});
