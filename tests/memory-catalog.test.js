import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EVENTS, loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { CatalogError } from '../src/errors.js';
import { agentMd, capture, ruleMd, skillMd, tmpDir, writeTree } from './helpers.js';
import { runtimeTree } from './hook-helpers.js';

const hook = (name, extra = '') => ({
  [`hooks/${name}/HOOK.md`]: `---\nname: ${name}\ndescription: Hook ${name}.\nevents: [start, compact, write]\n${extra}---\nAbout ${name}.\n`,
  [`hooks/${name}/gate.mjs`]: 'export function check() {}\n',
});
const load = (tree) => loadCatalog(writeTree(tmpDir(), { ...runtimeTree(), ...tree }));

describe('events', () => {
  it('include session start and compaction', () => {
    expect(EVENTS).toEqual(['shell', 'write', 'prompt', 'stop', 'start', 'compact']);
    expect(load(hook('mem')).get('hook:mem').events).toEqual(['start', 'compact', 'write']);
  });

  it('are still checked', () => {
    const bad = hook('mem');
    bad['hooks/mem/HOOK.md'] = bad['hooks/mem/HOOK.md'].replace('start,', 'end,');
    expect(() => load(bad)).toThrow(
      'field "events" must be a non-empty list of: shell, write, prompt, stop, start, compact'
    );
  });
});

describe('group', () => {
  it('is carried on a hook and on a skill', () => {
    const catalog = load({
      ...hook('mem', 'group: memory\n'),
      ...hook('gate'),
      'skills/note/SKILL.md': skillMd('note', 'group: memory\n'),
      'skills/plain/SKILL.md': skillMd('plain'),
    });
    expect(catalog.get('hook:mem').group).toBe('memory');
    expect(catalog.get('skill:note').group).toBe('memory');
    expect(catalog.get('hook:gate').group).toBeUndefined();
    expect(catalog.get('skill:plain').group).toBeUndefined();
  });

  it.each([
    ['another value', hook('mem', 'group: gates\n'), 'field "group" must be one of: memory'],
    [
      'an agent',
      { 'agents/a.md': agentMd('a', 'group: memory\n') },
      'agents/a.md: unknown field "group"',
    ],
    [
      'a rule',
      { 'rules/r.md': ruleMd('r', 'group: memory\n') },
      'rules/r.md: unknown field "group"',
    ],
  ])('is rejected on %s', (_case, tree, message) => {
    expect(() => load(tree)).toThrow(CatalogError);
    expect(() => load(tree)).toThrow(message);
  });
});

describe('cli', () => {
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
      ...hook('mem', 'group: memory\n'),
      ...hook('gate'),
      'skills/note/SKILL.md': skillMd('note', 'group: memory\n'),
      'skills/plain/SKILL.md': skillMd('plain'),
    });
    cwd = tmpDir();
    home = tmpDir();
  });

  it('--memory installs every item in the memory group, and nothing else', () => {
    const { code, err } = run('add', '--memory', '--target', 'claude');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(readdirSync(join(cwd, '.claude/forgeflow/gates'))).toEqual(['mem.mjs']);
    expect(readdirSync(join(cwd, '.claude/skills'))).toEqual(['note']);
  });

  it('--hooks installs the gates and leaves the memory hook out', () => {
    expect(run('add', '--hooks', '--target', 'claude').code).toBe(0);
    expect(readdirSync(join(cwd, '.claude/forgeflow/gates'))).toEqual(['gate.mjs']);
    expect(existsSync(join(cwd, '.claude/skills'))).toBe(false);
  });

  it('--memory is refused with --global, because it includes a hook', () => {
    const { code, err } = run('add', '--memory', '--target', 'claude', '--global');
    expect(code).toBe(2);
    expect(err).toMatch(/global/i);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('shows the group in info and in JSON', () => {
    expect(run('info', 'mem').out).toMatch(/^group:\s+memory$/m);
    expect(run('info', 'gate').out).not.toContain('group');
    const rows = JSON.parse(run('list', '--json').out);
    expect(rows.find((row) => row.id === 'skill:note').group).toBe('memory');
    expect('group' in rows.find((row) => row.id === 'hook:gate')).toBe(false);
  });

  it('is mentioned in the usage text and offered when add has nothing to install', () => {
    expect(run('--help').out).toContain('forgeflow add --memory --target');
    expect(run('add', '--target', 'claude').err).toContain('--memory');
  });
});
