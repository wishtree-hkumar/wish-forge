import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { adapters } from '../src/adapters/index.js';
import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { capture, tmpDir } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const agents = [...catalog.values()].filter((item) => item.type === 'agent');
const specialists = agents.filter((agent) => agent.stage === undefined).map((agent) => agent.name);
const joining = agents.filter((agent) => agent.joins === 'review').map((agent) => agent.name);
const ORDER = [
  'security-reviewer',
  'performance-reviewer',
  'database-reviewer',
  'accessibility-reviewer',
];
const FLOWS = ['forge-quick', 'forge-full'];
const body = (flow) => catalog.get(`skill:${flow}`).body;

describe('flow skills and review specialists', () => {
  it('the catalog marks exactly the four review specialists', () => {
    expect([...joining].sort()).toEqual([...ORDER].sort());
  });

  it.each(FLOWS)('%s names exactly the agents that join review, in order', (flow) => {
    const named = specialists.filter((agent) => body(flow).includes(`\`${agent}\``));
    expect(named.sort()).toEqual([...joining].sort());

    const positions = ORDER.map((agent) => body(flow).indexOf(`\`${agent}\``));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it.each(FLOWS)('%s does not require any specialist', (flow) => {
    const required = catalog.get(`skill:${flow}`).requires;
    expect(required.filter((id) => specialists.includes(id.replace('agent:', '')))).toEqual([]);
  });

  it.each(FLOWS)('%s says how to find, run and record them', (flow) => {
    for (const phrase of [
      '## Review specialists',
      '`{{agents-dir}}`',
      '`{{global-agents-dir}}`',
      'with any extension',
      '`07-review-<agent name>.md`',
      'Do not mention it',
      '`security-reviewer: APPROVE`',
      'Collect every verdict before you apply rule 3',
    ]) {
      expect(body(flow), phrase).toContain(phrase);
    }
  });

  it.each(FLOWS)('%s returns to BUILD when any reviewer requests changes', (flow) => {
    expect(body(flow)).toContain('or from any review specialist that ran');
    expect(body(flow)).toContain('the findings of everyone who requested changes');
    expect(body(flow)).toContain('at most 2 times, counting rounds, not reviewers');
  });

  it.each(FLOWS)('%s fails closed on an installed specialist it cannot use', (flow) => {
    expect(body(flow)).toContain('cannot be delegated to or returns no verdict line');
    expect(body(flow)).toContain('Never treat a missing verdict as a pass');
  });

  it.each(FLOWS)('%s shows every review verdict when it asks for approval', (flow) => {
    expect(body(flow)).toContain("each review verdict, the reviewer's and every specialist's");
  });

  it.each(FLOWS)('%s still stops when a flow agent is missing', (flow) => {
    expect(body(flow)).toContain('If a subagent that a');
    expect(body(flow)).toContain('The review specialists are optional');
  });

  it('release-gate requires every specialist report to approve', () => {
    const gate = catalog.get('agent:release-gate').body;
    expect(gate).toContain('every `07-review-*.md`');
    expect(gate).toContain('each of them must end in `VERDICT: APPROVE` too');
  });
});

const TARGETS = Object.keys(adapters);
const SKILL_DIRS = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  opencode: '.opencode/skills',
  cursor: '.cursor/skills',
};

function cli(io, ...argv) {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { ...io, stdout, stderr });
  return { code, err: stderr.text };
}

describe('installing specialists from the real catalog', () => {
  it('installs all ten into all four harnesses, and removes one', () => {
    const io = { cwd: tmpDir(), home: tmpDir() };
    expect(cli(io, 'add', '--specialists', '--target', TARGETS.join(','))).toEqual({
      code: 0,
      err: '',
    });

    for (const target of TARGETS) {
      const dir = join(io.cwd, adapters[target].agentDirs.project);
      const names = readdirSync(dir).map((file) => file.replace(/\.(md|toml)$/, ''));
      expect(names.sort(), target).toEqual([...specialists].sort());
    }
    for (const file of readdirSync(join(io.cwd, '.codex/agents'))) {
      const parsed = parseToml(readFileSync(join(io.cwd, '.codex/agents', file), 'utf8'));
      expect(parsed.developer_instructions, file).toContain('## Role');
    }
    const refactorer = parseToml(
      readFileSync(join(io.cwd, '.codex/agents/refactorer.toml'), 'utf8')
    );
    expect(refactorer.sandbox_mode).toBe('workspace-write');

    expect(cli(io, 'remove', 'security-reviewer', '--target', 'cursor').code).toBe(0);
    expect(existsSync(join(io.cwd, '.cursor/agents/security-reviewer.md'))).toBe(false);
    expect(readdirSync(join(io.cwd, '.cursor/agents'))).toHaveLength(9);
    expect(existsSync(join(io.cwd, '.claude/agents/security-reviewer.md'))).toBe(true);
  });

  it('a flow on its own installs no specialist', () => {
    const io = { cwd: tmpDir(), home: tmpDir() };
    expect(cli(io, 'add', '--flow', 'full', '--target', 'claude').code).toBe(0);
    const installed = readdirSync(join(io.cwd, '.claude/agents'));
    for (const name of specialists) expect(installed).not.toContain(`${name}.md`);
  });

  it.each(FLOWS)('%s installed for every harness names only its own folders', (flow) => {
    const io = { cwd: tmpDir(), home: tmpDir() };
    const mode = flow.replace('forge-', '');
    expect(cli(io, 'add', '--flow', mode, '--target', TARGETS.join(',')).code).toBe(0);

    for (const target of TARGETS) {
      const text = readFileSync(join(io.cwd, SKILL_DIRS[target], flow, 'SKILL.md'), 'utf8');
      const { project, global } = adapters[target].agentDirs;
      expect(text, target).toContain(`\`${project}\``);
      expect(text, target).toContain(`\`${global}\``);
      expect(text, target).not.toContain('{{');
      for (const other of TARGETS.filter((name) => name !== target)) {
        expect(text, `${target} names ${other}`).not.toContain(adapters[other].agentDirs.project);
      }
    }
  });

  it('a globally installed OpenCode flow still names both OpenCode folders', () => {
    const io = { cwd: tmpDir(), home: tmpDir() };
    expect(cli(io, 'add', '--flow', 'quick', '--target', 'opencode', '--global').code).toBe(0);
    const text = readFileSync(
      join(io.home, '.config/opencode/skills/forge-quick/SKILL.md'),
      'utf8'
    );
    expect(text).toContain('`.opencode/agents`');
    expect(text).toContain('`~/.config/opencode/agents`');
  });
});
