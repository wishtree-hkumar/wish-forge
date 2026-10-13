import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';

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
