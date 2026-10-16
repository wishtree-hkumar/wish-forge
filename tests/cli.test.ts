import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { agentMd, capture, skillMd, tmpDir, writeTree } from './helpers.js';

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
    'agents/beta.md': agentMd('beta'),
    'skills/forge-quick/SKILL.md': skillMd('forge-quick', 'requires: [agent:alpha]\n'),
    'skills/forge-full/SKILL.md': skillMd('forge-full', 'requires: [agent:alpha, agent:beta]\n'),
  });
  cwd = tmpDir();
  home = tmpDir();
});

describe('general', () => {
  it('prints usage for --help and exits 0', () => {
    const { code, out } = run('--help');
    expect(code).toBe(0);
    expect(out).toContain('wishforge add <id...> --target');
  });

  it('prints the version', () => {
    expect(run('--version')).toMatchObject({ code: 0, out: '0.1.0\n' });
  });

  it('exits 2 with usage on stderr when no command is given', () => {
    const { code, err } = run();
    expect(code).toBe(2);
    expect(err).toContain('Usage:');
  });

  it('exits 2 for an unknown command or flag', () => {
    expect(run('launch')).toMatchObject({ code: 2 });
    expect(run('launch').err).toContain('unknown command "launch"');
    expect(run('list', '--bogus').code).toBe(2);
  });

  it('exits 1 and names the file when the catalog is invalid', () => {
    writeTree(catalogDir, { 'agents/bad.md': 'no frontmatter' });
    const { code, err } = run('list');
    expect(code).toBe(1);
    expect(err).toContain('agents/bad.md');
  });
});

describe('list and info', () => {
  it('lists every item under its kind, with stage and access', () => {
    const { code, out } = run('list');
    expect(code).toBe(0);
    expect(out).toMatch(/^Flow agents\n {2}alpha\s+REVIEW\s+read-only\s+Does alpha things\.$/m);
    expect(out).toMatch(/^ {2}forge-full\s+Runs forge-full\.$/m);
    expect(out).toContain('4 items.');
  });

  it('filters by type and prints JSON', () => {
    const { out } = run('list', '--type', 'skill', '--json');
    expect(JSON.parse(out).map((entry) => entry.id)).toEqual([
      'skill:forge-full',
      'skill:forge-quick',
    ]);
    expect(run('list', '--type', 'bogus').code).toBe(2);
  });

  it('shows one item', () => {
    const { code, out } = run('info', 'forge-full');
    expect(code).toBe(0);
    expect(out).toContain('skill:forge-full');
    expect(out).toContain('requires:     agent:alpha, agent:beta');
    expect(run('info').code).toBe(2);
    expect(run('info', 'ghost').code).toBe(2);
  });
});

describe('add', () => {
  it('installs an agent and reports what it wrote', () => {
    const { code, out } = run('add', 'alpha', '--target', 'cursor');
    expect(code).toBe(0);
    expect(out).toContain('cursor');
    expect(out).toMatch(/create\s+\.cursor\/agents\/alpha\.md/);
    expect(existsSync(join(cwd, '.cursor/agents/alpha.md'))).toBe(true);
  });

  it('installs a flow to several targets', () => {
    const { code } = run('add', '--flow', 'quick', '--target', 'claude,codex');
    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.claude/skills/forge-quick/SKILL.md'))).toBe(true);
    expect(existsSync(join(cwd, '.claude/agents/alpha.md'))).toBe(true);
    expect(existsSync(join(cwd, '.agents/skills/forge-quick/SKILL.md'))).toBe(true);
    expect(existsSync(join(cwd, '.codex/agents/alpha.toml'))).toBe(true);
  });

  it('collapses repeated targets and ignores a trailing comma', () => {
    const { code, out } = run('add', 'alpha', '--target', 'cursor,cursor,');
    expect(code).toBe(0);
    expect(out.match(/create/g)).toHaveLength(1);
  });

  it('exits 2 for a missing, empty or unknown target', () => {
    expect(run('add', 'alpha').err).toContain('--target is required');
    expect(run('add', 'alpha').code).toBe(2);
    expect(run('add', 'alpha', '--target', ',').code).toBe(2);
    expect(run('add', 'alpha', '--target', 'vim').err).toContain('unknown target "vim"');
    expect(existsSync(join(cwd, '.wishforge'))).toBe(false);
  });

  it('exits 2 when no item is named or the flow is unknown', () => {
    expect(run('add', '--target', 'cursor').err).toContain('name at least one item');
    expect(run('add', '--flow', 'turbo', '--target', 'cursor').err).toContain(
      '--flow must be quick or full'
    );
    expect(run('add', 'ghost', '--target', 'cursor').code).toBe(2);
  });

  it('exits 1 on a conflict, lists the file, and writes nothing', () => {
    writeTree(cwd, { '.cursor/agents/alpha.md': 'mine' });
    const { code, err } = run('add', 'alpha', 'beta', '--target', 'cursor');
    expect(code).toBe(1);
    expect(err).toContain('[cursor] .cursor/agents/alpha.md');
    expect(err).toContain('--force');
    expect(existsSync(join(cwd, '.cursor/agents/beta.md'))).toBe(false);

    expect(run('add', 'alpha', '--target', 'cursor', '--force').code).toBe(0);
    expect(readFileSync(join(cwd, '.cursor/agents/alpha.md'), 'utf8')).toContain('Body of alpha.');
  });

  it('writes nothing on --dry-run and says so', () => {
    const { code, out } = run('add', 'alpha', '--target', 'cursor', '--dry-run');
    expect(code).toBe(0);
    expect(out).toContain('Dry run');
    expect(existsSync(join(cwd, '.cursor'))).toBe(false);
  });

  it('installs under home with --global', () => {
    expect(run('add', 'alpha', '--target', 'claude', '--global').code).toBe(0);
    expect(existsSync(join(home, '.claude/agents/alpha.md'))).toBe(true);
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });
});

describe('remove, update and status', () => {
  it('removes what add installed', () => {
    run('add', '--flow', 'full', '--target', 'cursor');
    const { code, out } = run('remove', 'forge-full', '--target', 'cursor');
    expect(code).toBe(0);
    expect(out.match(/delete/g)).toHaveLength(3);
    expect(existsSync(join(cwd, '.cursor'))).toBe(false);
  });

  it('exits 2 when remove has no item, no target, or a required item', () => {
    run('add', '--flow', 'quick', '--target', 'cursor');
    expect(run('remove', '--target', 'cursor').code).toBe(2);
    expect(run('remove', 'alpha').code).toBe(2);
    const blocked = run('remove', 'alpha', '--target', 'cursor');
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain('skill:forge-quick requires it');
  });

  it('reports kept files when removing an edited item', () => {
    run('add', 'alpha', '--target', 'cursor');
    writeFileSync(join(cwd, '.cursor/agents/alpha.md'), 'my edit');
    const { code, out } = run('remove', 'alpha', '--target', 'cursor');
    expect(code).toBe(0);
    expect(out).toMatch(/kept\s+\.cursor\/agents\/alpha\.md\s+\(was edited after install\)/);
  });

  it('updates all installed targets without --target', () => {
    run('add', 'alpha', '--target', 'cursor,claude');
    writeTree(catalogDir, { 'agents/alpha.md': agentMd('alpha').replace('Body', 'New body') });
    const { code, out } = run('update');
    expect(code).toBe(0);
    expect(out.match(/update/g)).toHaveLength(2);
    expect(readFileSync(join(cwd, '.claude/agents/alpha.md'), 'utf8')).toContain('New body');
  });

  it('says so when there is nothing to update', () => {
    expect(run('update')).toMatchObject({ code: 0, out: 'Nothing is installed here.\n' });
  });

  it('shows installed items and flags edited files', () => {
    run('add', '--flow', 'quick', '--target', 'cursor');
    writeFileSync(join(cwd, '.cursor/agents/alpha.md'), 'my edit');
    const { code, out } = run('status');
    expect(code).toBe(0);
    expect(out).toMatch(/agent:alpha\s+\(required\)/);
    expect(out).toMatch(/edited\s+\.cursor\/agents\/alpha\.md/);
    expect(out).toMatch(/ok\s+\.cursor\/skills\/forge-quick\/SKILL\.md/);
    expect(run('status', '--global').out).toBe('Nothing is installed here.\n');
  });
});

describe('doctor', () => {
  it('passes on a clean install', () => {
    run('add', 'alpha', '--target', 'cursor');
    const { code, out } = run('doctor');
    expect(code).toBe(0);
    expect(out).toMatch(/ok\s+catalog is valid \(4 items\)/);
    expect(out).toMatch(/ok\s+Node\.js >= 20/);
  });

  it('exits 1 when an installed file was edited', () => {
    run('add', 'alpha', '--target', 'cursor');
    writeFileSync(join(cwd, '.cursor/agents/alpha.md'), 'my edit');
    const { code, out } = run('doctor');
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL\s+project install matches lockfile/);
    expect(out).toContain('.cursor/agents/alpha.md is edited');
  });

  it('exits 1 when the catalog is invalid', () => {
    writeTree(catalogDir, { 'agents/bad.md': 'no frontmatter' });
    const { code, out } = run('doctor');
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL\s+catalog is valid/);
  });
});
