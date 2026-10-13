import { existsSync, readdirSync } from 'node:fs';
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

const GATE = 'export function check() {}\n';
const HOOK = '---\nname: g1\ndescription: Guards.\nevents: [write]\n---\nGuards writes.\n';
const RUNTIME = '---\nname: hooks\ndescription: Runs gates.\n---\nThe runner.\n';

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), {
    'agents/alpha.md': agentMd('alpha', 'stage: review\n'),
    'agents/beta.md': agentMd('beta'),
    'agents/gamma.md': agentMd('gamma', 'joins: review\n'),
    'skills/forge-quick/SKILL.md': skillMd('forge-quick', 'requires: [agent:alpha]\n'),
    'hooks/g1/HOOK.md': HOOK,
    'hooks/g1/gate.mjs': GATE,
    'runtime/hooks/RUNTIME.md': RUNTIME,
    'runtime/hooks/run.mjs': '// run\n',
    'runtime/hooks/runtime.mjs': '// runtime\n',
    'runtime/hooks/opencode-plugin.js': '// plugin\n',
  });
  cwd = tmpDir();
  home = tmpDir();
});

describe('list and info', () => {
  it('labels an agent with no stage as a specialist', () => {
    const lines = run('list').out.trim().split('\n');
    expect(lines.find((line) => line.startsWith('agent:alpha'))).toMatch(/^agent:alpha\s+review\s/);
    expect(lines.find((line) => line.startsWith('agent:beta'))).toMatch(
      /^agent:beta\s+specialist\s+read-only\s+Does beta things\.$/
    );
    expect(lines.find((line) => line.startsWith('skill:forge-quick'))).toMatch(
      /^skill:forge-quick\s+-\s+-\s/
    );
  });

  it('includes joins in JSON output only where it is set', () => {
    const rows = JSON.parse(run('list', '--type', 'agent', '--json').out);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(byName.gamma.joins).toBe('review');
    expect('joins' in byName.alpha).toBe(false);
    expect('joins' in byName.beta).toBe(false);
  });

  it('shows joins in info', () => {
    expect(run('info', 'gamma').out).toMatch(/^joins:\s+review$/m);
    expect(run('info', 'beta').out).not.toContain('joins');
  });

  it('mentions --specialists in the usage text', () => {
    expect(run('--help').out).toContain('forgeflow add --specialists --target');
  });
});

describe('add --specialists', () => {
  it('installs exactly the agents that have no stage', () => {
    const { code, err } = run('add', '--specialists', '--target', 'cursor');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(readdirSync(join(cwd, '.cursor/agents')).sort()).toEqual(['beta.md', 'gamma.md']);
  });

  it('combines with a flow and a named item', () => {
    const { code } = run('add', '--specialists', '--flow', 'quick', '--target', 'claude');
    expect(code).toBe(0);
    expect(readdirSync(join(cwd, '.claude/agents')).sort()).toEqual([
      'alpha.md',
      'beta.md',
      'gamma.md',
    ]);
    expect(existsSync(join(cwd, '.claude/skills/forge-quick/SKILL.md'))).toBe(true);
  });

  it('installs for the user with --global', () => {
    expect(run('add', '--specialists', '--target', 'claude', '--global').code).toBe(0);
    expect(readdirSync(join(home, '.claude/agents')).sort()).toEqual(['beta.md', 'gamma.md']);
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });

  it('installs nothing when combined with gates and --global', () => {
    const { code, err } = run('add', '--specialists', '--hooks', '--target', 'claude', '--global');
    expect(code).not.toBe(0);
    expect(err).toMatch(/global/i);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('is offered when add is given nothing to install', () => {
    const { code, err } = run('add', '--target', 'cursor');
    expect(code).toBe(2);
    expect(err).toContain('--specialists');
  });
});
