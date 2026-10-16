import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const specialists = [...catalog.values()].filter(
  (item) => item.type === 'agent' && item.stage === undefined
);

// name, access, model tier, joins
const EXPECTED = [
  ['security-reviewer', 'read-only', 'strong', 'review'],
  ['performance-reviewer', 'read-only', 'strong', 'review'],
  ['database-reviewer', 'read-only', 'strong', 'review'],
  ['accessibility-reviewer', 'read-only', 'balanced', 'review'],
  ['standards-reviewer', 'read-only', 'balanced', 'review'],
  ['api-designer', 'read-only', 'strong', undefined],
  ['test-strategist', 'read-only', 'balanced', undefined],
  ['dependency-auditor', 'read-only', 'balanced', undefined],
  ['debugger', 'read-only', 'strong', undefined],
  ['docs-writer', 'write', 'balanced', undefined],
  ['refactorer', 'write', 'balanced', undefined],
  ['mapper', 'read-only', 'strong', undefined],
];
const REVIEWERS = EXPECTED.filter(([, , , joins]) => joins === 'review').map(([name]) => name);
const SECTIONS = ['Role', 'Inputs', 'Procedure', 'Output', 'Limits'];
const HARNESS_TOOL =
  /`(Edit|Write|Read|Grep|Glob|Bash|Task|MultiEdit|TodoWrite|apply_patch|str_replace)`|\b(apply_patch|MultiEdit|TodoWrite|str_replace)\b/;
const body = (name) => catalog.get(`agent:${name}`).body;

describe('specialist agents', () => {
  it('are exactly the ones the spec lists', () => {
    expect(specialists.map((agent) => agent.name).sort()).toEqual(
      EXPECTED.map(([name]) => name).sort()
    );
  });

  it.each(EXPECTED)('%s has access %s, tier %s, joins %s', (name, access, modelTier, joins) => {
    const agent = catalog.get(`agent:${name}`);
    expect(agent).toMatchObject({ access, modelTier, requires: [] });
    expect(agent.joins).toBe(joins);
  });

  it.each(EXPECTED)('%s has the five sections in order', (name) => {
    const headings = [...body(name).matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(SECTIONS);
  });

  it.each(EXPECTED)('%s names no harness-specific tool', (name) => {
    expect(body(name)).not.toMatch(HARNESS_TOOL);
  });

  it.each(EXPECTED)('%s says when to use it, within the description limit', (name) => {
    const { description } = catalog.get(`agent:${name}`);
    expect(description).toMatch(/\bUse\b/);
    expect(description.length).toBeLessThanOrEqual(300);
  });

  it('every read-only specialist is told not to modify files', () => {
    for (const agent of specialists.filter((entry) => entry.access === 'read-only')) {
      expect(agent.body, agent.name).toContain('Do not modify any file.');
    }
  });
});

describe('review specialists', () => {
  it.each(REVIEWERS)('%s gives a verdict the flows can read', (name) => {
    expect(body(name)).toContain(
      'End your reply with exactly one line: `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`.'
    );
    expect(body(name)).toContain('Request changes if there is any blocker or major finding.');
  });

  it.each(REVIEWERS)('%s uses the reviewer severities', (name) => {
    for (const severity of ['blocker', 'major', 'minor', 'note']) {
      expect(body(name)).toContain(severity);
    }
  });

  it.each(REVIEWERS)('%s approves a change outside its subject and says so', (name) => {
    expect(body(name)).toContain(
      'If the change does not touch your subject, say so in one line and end with `VERDICT: APPROVE`.'
    );
  });

  it.each(REVIEWERS)('%s does not approve a change it could not see', (name) => {
    expect(body(name)).toContain(
      'If you could not see the full change, say so and do not approve.'
    );
  });

  it.each(REVIEWERS)('%s reads the same run files as the reviewer', (name) => {
    for (const file of ['01-requirement.md', '03-plan.md', '05-build.md', '06-test.md']) {
      expect(body(name)).toContain(file);
    }
  });
});

describe('the other specialists', () => {
  const OTHERS = EXPECTED.filter(([, , , joins]) => joins === undefined).map(([name]) => name);

  it('only docs-writer and refactorer can change files', () => {
    const writers = specialists.filter((agent) => agent.access === 'write');
    expect(writers.map((agent) => agent.name).sort()).toEqual(['docs-writer', 'refactorer']);
  });

  it.each(OTHERS)(
    '%s gives no verdict line, so a flow cannot mistake it for a reviewer',
    (name) => {
      expect(body(name)).not.toContain('VERDICT:');
    }
  );

  it.each([
    ['api-designer', ['**Open questions**', '**Compatibility**', '**Errors**']],
    ['test-strategist', ['**Cases**', '**Gaps**', '**Not worth testing**']],
    ['dependency-auditor', ['Do not install, upgrade or remove', '**Could not check**']],
    ['debugger', ['**Root cause**', '**Evidence**', 'Do not apply the fix']],
    ['docs-writer', ['Do not change executable code', 'by reading the code']],
    ['refactorer', ['before and after', 'stop and report', 'Do not add features']],
  ])('%s states its contract', (name, phrases) => {
    for (const phrase of phrases) expect(body(name), phrase).toContain(phrase);
  });
});
