import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog';
import { main } from '../src/cli';
import { capture, tmpDir } from './helpers';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const mapper = catalog.get('agent:mapper');
const skill = catalog.get('skill:forge-map');
const SECTIONS = [
  'Purpose',
  'Stack',
  'Commands',
  'Layout',
  'Entry points',
  'Where things live',
  'Conventions',
  'Configuration',
  'Do not touch',
  'Not determined',
];
const HARNESS_TOOL =
  /`(Edit|Write|Read|Grep|Glob|Bash|Task|MultiEdit|TodoWrite|apply_patch|str_replace)`|\b(apply_patch|MultiEdit|TodoWrite|str_replace)\b/;

describe('mapper', () => {
  it('is a read-only agent on the strong tier with no stage', () => {
    expect(mapper).toMatchObject({ access: 'read-only', modelTier: 'strong', requires: [] });
    expect(mapper.stage).toBeUndefined();
    expect(mapper.joins).toBeUndefined();
  });

  it('names every map section, in order, inside its output form', () => {
    // Listed as bullets, so the map's headings are not taken for the agent's own sections.
    const at = SECTIONS.map((name) => mapper.body.indexOf(`\n- \`## ${name}\`\n`));
    expect(at.every((index) => index > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(mapper.body).toContain('It starts at the line `# Project map`');
  });

  it.each([
    'Do not modify any file.',
    'Do not run them',
    'Purpose, Commands and Layout are always present',
    'at most 3,200 bytes',
    'names only',
    'top two levels',
    'then keep its wording',
    'Reply with the map and nothing else',
    'No opinions, plans or recommendations',
  ])('says: %s', (phrase) => {
    expect(mapper.body).toContain(phrase);
  });
});

describe('forge-map', () => {
  it('is started only by a person, belongs to memory and requires the agent', () => {
    expect(skill).toMatchObject({
      userInvocableOnly: true,
      group: 'memory',
      requires: ['agent:mapper', 'hook:session-memory'],
    });
    expect(skill.body).not.toMatch(HARNESS_TOOL);
  });

  it.each([
    '`.wishforge/memory/map.md`',
    'Delegate to `mapper`',
    'as the existing map',
    'Generated YYYY-MM-DD at commit <short hash> by forge-map. Check it against the code before relying on it.',
    'leave out `at commit <short hash>`',
    'over 3,200 bytes',
    'ask `mapper` once to shorten it',
    'Do not write or correct the map yourself',
    'wishforge add --memory --target',
    'reviewed and committed',
    'Not determined',
  ])('says: %s', (phrase) => {
    expect(skill.body).toContain(phrase);
  });
});

describe('installing from the real catalog', () => {
  const run = (io, ...argv) => main(argv, { ...io, stdout: capture(), stderr: capture() });
  const agents = (io) => readdirSync(join(io.cwd, '.claude/agents'));

  it('--memory brings the command and its agent', () => {
    const io = { cwd: tmpDir(), home: tmpDir() };
    expect(run(io, 'add', '--memory', '--target', 'claude')).toBe(0);
    expect(existsSync(join(io.cwd, '.claude/skills/forge-map/SKILL.md'))).toBe(true);
    expect(agents(io)).toEqual(['mapper.md']);
  });

  it('removing the command sweeps an agent that came only with it', () => {
    const io = { cwd: tmpDir(), home: tmpDir() };
    run(io, 'add', 'forge-map', '--target', 'claude');
    expect(run(io, 'remove', 'forge-map', '--target', 'claude')).toBe(0);
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false);
  });

  it('removing the command keeps an agent the user installed by name', () => {
    const io = { cwd: tmpDir(), home: tmpDir() };
    run(io, 'add', 'mapper', '--target', 'claude');
    run(io, 'add', 'forge-map', '--target', 'claude');
    expect(run(io, 'remove', 'forge-map', '--target', 'claude')).toBe(0);
    expect(agents(io)).toEqual(['mapper.md']);
  });

  it('removing the command keeps an agent installed with the specialists', () => {
    const io = { cwd: tmpDir(), home: tmpDir() };
    run(io, 'add', '--specialists', '--target', 'claude');
    run(io, 'add', '--memory', '--target', 'claude');
    expect(run(io, 'remove', 'forge-map', '--target', 'claude')).toBe(0);
    expect(agents(io)).toContain('mapper.md');
  });
});
