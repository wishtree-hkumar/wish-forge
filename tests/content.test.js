import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { main } from '../src/cli.js';
import { capture, tmpDir } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const agents = [...catalog.values()].filter((item) => item.type === 'agent');

const EXPECTED = [
  ['requirement-analyst', 'requirement', 'read-only', 'balanced'],
  ['analyzer', 'analyze', 'read-only', 'strong'],
  ['planner', 'plan', 'read-only', 'strong'],
  ['architect', 'architect', 'read-only', 'strong'],
  ['builder', 'build', 'write', 'balanced'],
  ['tester', 'test', 'write', 'balanced'],
  ['fixer', 'fix', 'write', 'balanced'],
  ['reviewer', 'review', 'read-only', 'strong'],
  ['release-gate', 'release_gate', 'read-only', 'balanced'],
  ['deployer', 'deploy', 'write', 'balanced'],
  ['feedback', 'feedback', 'read-only', 'fast'],
];
const SECTIONS = ['Role', 'Inputs', 'Procedure', 'Output', 'Limits'];
const HARNESS_TOOL =
  /`(Edit|Write|Read|Grep|Glob|Bash|Task|MultiEdit|TodoWrite|apply_patch|str_replace)`|\b(apply_patch|MultiEdit|TodoWrite|str_replace)\b/;

describe('flow agents', () => {
  it('are exactly the eleven the spec lists', () => {
    expect(agents.map((agent) => agent.name).sort()).toEqual(EXPECTED.map(([name]) => name).sort());
  });

  it.each(EXPECTED)('%s has stage %s, access %s, tier %s', (name, stage, access, modelTier) => {
    expect(catalog.get(`agent:${name}`)).toMatchObject({ stage, access, modelTier, requires: [] });
  });

  it.each(EXPECTED)('%s has the five sections in order', (name) => {
    const headings = [...catalog.get(`agent:${name}`).body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(SECTIONS);
  });

  it.each(EXPECTED)('%s names no harness-specific tool', (name) => {
    expect(catalog.get(`agent:${name}`).body).not.toMatch(HARNESS_TOOL);
  });

  it.each([
    ['tester', ['VERDICT: PASS', 'VERDICT: FAIL']],
    ['reviewer', ['VERDICT: APPROVE', 'VERDICT: CHANGES_REQUESTED']],
    ['release-gate', ['VERDICT: GO', 'VERDICT: NO_GO']],
  ])('%s defines its verdict lines', (name, verdicts) => {
    for (const verdict of verdicts) expect(catalog.get(`agent:${name}`).body).toContain(verdict);
  });

  it('read-only agents are told not to modify files', () => {
    for (const agent of agents.filter((entry) => entry.access === 'read-only')) {
      expect(agent.body, agent.name).toMatch(/do not (create, )?(modify|change|edit)/i);
    }
  });
});

const QUICK = ['requirement-analyst', 'planner', 'builder', 'tester', 'fixer', 'reviewer', 'release-gate'];
const FULL = EXPECTED.map(([name]) => name);

describe('flow skills', () => {
  it.each([
    ['forge-quick', QUICK],
    ['forge-full', FULL],
  ])('%s requires exactly the agents it names', (name, expected) => {
    const flow = catalog.get(`skill:${name}`);
    expect(flow.userInvocableOnly).toBe(true);
    expect([...flow.requires].sort()).toEqual(expected.map((agent) => `agent:${agent}`).sort());

    const named = agents.map((agent) => agent.name).filter((agent) => flow.body.includes(`\`${agent}\``));
    expect(named.sort()).toEqual([...expected].sort());
  });

  it.each(['forge-quick', 'forge-full'])('%s states the control rules', (name) => {
    const { body } = catalog.get(`skill:${name}`);
    expect(body).toContain('at most 3 fix attempts');
    expect(body).toContain('at most 2 times');
    expect(body).toContain('VERDICT: NO_GO');
    expect(body).toContain('09-approval.md');
    expect(body).toContain('state.md');
    expect(body).toMatch(/forgeflow add/);
    expect(body).not.toMatch(HARNESS_TOOL);
  });

  it('forge-full runs the twelve stages in order', () => {
    const { body } = catalog.get('skill:forge-full');
    const stages = [
      'REQUIREMENT',
      'ANALYZE',
      'PLAN',
      'ARCHITECT',
      'BUILD',
      'TEST',
      'FIX',
      'REVIEW',
      'RELEASE_GATE',
      'HUMAN_APPROVAL',
      'DEPLOY',
      'FEEDBACK',
    ];
    const positions = stages.map((stage) => body.indexOf(`**${stage}**`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('forge-quick runs the six phases in order and does not deploy', () => {
    const { body } = catalog.get('skill:forge-quick');
    const positions = ['DEFINE', 'PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SHIP'].map((phase) =>
      body.indexOf(`**${phase}**`)
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(body).toContain('does not deploy');
  });
});

describe('installing the real catalog', () => {
  const install = (flow, targets) => {
    const cwd = tmpDir();
    const io = { cwd, home: tmpDir(), stdout: capture(), stderr: capture() };
    const code = main(['add', '--flow', flow, '--target', targets], io);
    return { cwd, code, err: io.stderr.text };
  };

  it('installs the full flow into all four harnesses', () => {
    const { cwd, code, err } = install('full', 'claude,codex,opencode,cursor');
    expect(err).toBe('');
    expect(code).toBe(0);

    for (const dir of ['.claude/agents', '.codex/agents', '.opencode/agents', '.cursor/agents']) {
      expect(readdirSync(join(cwd, dir)), dir).toHaveLength(11);
    }
    for (const dir of ['.claude/skills', '.agents/skills', '.opencode/skills', '.cursor/skills']) {
      expect(existsSync(join(cwd, dir, 'forge-full/SKILL.md')), dir).toBe(true);
    }
    for (const file of readdirSync(join(cwd, '.codex/agents'))) {
      const parsed = parseToml(readFileSync(join(cwd, '.codex/agents', file), 'utf8'));
      expect(parsed.name, file).toBe(file.replace(/\.toml$/, ''));
      expect(parsed.developer_instructions, file).toContain('## Role');
    }
  });

  it('installs only the seven quick-flow agents for the quick flow', () => {
    const { cwd, code } = install('quick', 'cursor');
    expect(code).toBe(0);
    expect(readdirSync(join(cwd, '.cursor/agents')).sort()).toEqual(QUICK.map((name) => `${name}.md`).sort());
  });
});
