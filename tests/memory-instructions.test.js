import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as opencode from '../src/adapters/opencode.js';
import { main } from '../src/cli.js';
import { readLock } from '../src/lock.js';
import {
  foundEntries,
  handWired,
  mergeInstructions,
  stripInstructions,
} from '../src/rules-wiring.js';
import { capture, ruleMd, tmpDir, writeTree } from './helpers.js';
import { hookTree, runtimeTree } from './hook-helpers.js';

const RULES = '.opencode/forgeflow/rules/*.md';
const MEMORY = ['.forgeflow/memory/*.md', '.forgeflow/local/*.md'];
const known = [RULES, ...MEMORY];
const skeleton = { $schema: 'https://opencode.ai/config.json' };

describe('opencode.rulesWiring', () => {
  it.each([
    ['nothing', [], []],
    ['a rule', ['rule:common', 'agent:x'], [RULES]],
    ['session memory', ['hook:session-memory', 'runtime:hooks'], MEMORY],
    ['both', ['rule:common', 'hook:session-memory'], [RULES, ...MEMORY]],
    ['another hook', ['hook:secret-guard'], []],
  ])('wants the entries for %s', (_case, ids, entries) => {
    const wiring = opencode.rulesWiring('project', ids);
    expect(wiring.entries).toEqual(entries);
    expect(wiring.known).toEqual(known);
    expect(wiring).toMatchObject({ kind: 'json', path: 'opencode.json', skeleton });
  });

  it('wants only the rules entry at global scope', () => {
    const wiring = opencode.rulesWiring('global', ['rule:common', 'hook:session-memory']);
    expect(wiring.entries).toEqual(['~/.config/opencode/forgeflow/rules/*.md']);
    expect(wiring.known).toEqual(['~/.config/opencode/forgeflow/rules/*.md']);
  });

  it('wants nothing when called without ids', () => {
    expect(opencode.rulesWiring('project').entries).toEqual([]);
  });
});

describe('mergeInstructions with several entries', () => {
  it('adds the wanted ones after the user entries', () => {
    expect(
      mergeInstructions({ instructions: ['a.md'] }, { entries: MEMORY, known, skeleton })
    ).toEqual({ instructions: ['a.md', ...MEMORY] });
  });

  it('keeps wanted entries where they are and appends the missing ones', () => {
    const config = { instructions: [RULES, 'a.md'] };
    expect(mergeInstructions(config, { entries: [RULES, ...MEMORY], known, skeleton })).toEqual({
      instructions: [RULES, 'a.md', ...MEMORY],
    });
  });

  it('drops its own entries that are no longer wanted', () => {
    const config = { instructions: ['a.md', RULES, ...MEMORY] };
    expect(mergeInstructions(config, { entries: [RULES], known, skeleton })).toEqual({
      instructions: ['a.md', RULES],
    });
  });

  it('is idempotent', () => {
    const wiring = { entries: [RULES, ...MEMORY], known, skeleton };
    const once = mergeInstructions(undefined, wiring);
    expect(once).toEqual({ ...skeleton, instructions: [RULES, ...MEMORY] });
    expect(mergeInstructions(once, wiring)).toEqual(once);
  });
});

describe('stripInstructions with several entries', () => {
  it('removes every forgeflow entry and nothing else', () => {
    expect(
      stripInstructions({ instructions: [RULES, 'a.md', ...MEMORY], model: 'x' }, known)
    ).toEqual({
      instructions: ['a.md'],
      model: 'x',
    });
    expect(stripInstructions({ ...skeleton, instructions: MEMORY }, known)).toEqual(skeleton);
  });
});

describe('hand-wired entries', () => {
  const text = `{\n  // mine\n  "instructions": ["${RULES}", "${MEMORY[0]}"]\n}\n`;

  it('finds which of the candidates are present', () => {
    expect(foundEntries(text, known)).toEqual([RULES, MEMORY[0]]);
    expect(foundEntries('{ not json', known)).toEqual([]);
  });

  it('counts as wired only when every wanted entry is present', () => {
    expect(handWired(text, [RULES])).toBe(true);
    expect(handWired(text, [RULES, MEMORY[0]])).toBe(true);
    expect(handWired(text, [RULES, ...MEMORY])).toBe(false);
    expect(handWired(text, [])).toBe(false);
  });
});

describe('install and remove', () => {
  let catalogDir;
  let cwd;
  let home;
  const run = (...argv) => {
    const stdout = capture();
    const stderr = capture();
    const code = main(argv, { cwd, home, stdout, stderr, catalogDir });
    return { code, out: stdout.text, err: stderr.text };
  };
  const instructions = () =>
    JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8')).instructions;

  beforeEach(() => {
    catalogDir = writeTree(tmpDir(), {
      ...runtimeTree(),
      ...hookTree('session-memory', '[start, compact, write, prompt]'),
      ...hookTree('guard'),
      'rules/common.md': ruleMd('common'),
    });
    cwd = tmpDir();
    home = tmpDir();
  });

  it('adds the memory entries, then the rules entry, and removes each kind alone', () => {
    expect(run('add', 'session-memory', '--target', 'opencode').out).toMatch(
      /wired\s+opencode\.json/
    );
    expect(instructions()).toEqual(MEMORY);
    expect(readLock(cwd).targets.opencode.rules).toEqual({ path: 'opencode.json', created: true });

    run('add', 'common', '--target', 'opencode');
    expect(instructions()).toEqual([...MEMORY, RULES]);

    expect(run('remove', 'session-memory', '--target', 'opencode').out).toMatch(
      /wired\s+opencode\.json/
    );
    expect(instructions()).toEqual([RULES]);

    expect(run('remove', 'common', '--target', 'opencode').out).toMatch(/delete\s+opencode\.json/);
    expect(existsSync(join(cwd, 'opencode.json'))).toBe(false);
  });

  it('keeps the memory entries when the last rule is removed', () => {
    writeFileSync(join(cwd, 'opencode.json'), '{\n  "instructions": [\n    "a.md"\n  ]\n}\n');
    run('add', 'common', 'session-memory', '--target', 'opencode');
    expect(instructions()).toEqual(['a.md', RULES, ...MEMORY]);

    run('remove', 'common', '--target', 'opencode');
    expect(instructions()).toEqual(['a.md', ...MEMORY]);
    expect(run('status').out).toMatch(/rules ok\s+opencode\.json/);

    run('remove', 'session-memory', '--target', 'opencode');
    expect(readFileSync(join(cwd, 'opencode.json'), 'utf8')).toBe(
      '{\n  "instructions": [\n    "a.md"\n  ]\n}\n'
    );
  });

  it('does not touch opencode.json for a gate that needs no entries', () => {
    const { code, out } = run('add', 'guard', '--target', 'opencode');
    expect(code).toBe(0);
    expect(out).not.toContain('opencode.json');
    expect(existsSync(join(cwd, 'opencode.json'))).toBe(false);
    expect(readLock(cwd).targets.opencode.rules).toBeUndefined();
  });

  it('reports a missing entry when one of several was taken out by hand', () => {
    run('add', 'common', 'session-memory', '--target', 'opencode');
    writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({ instructions: [RULES, MEMORY[0]] }));
    expect(run('status').out).toMatch(/rules missing\s+opencode\.json/);
    expect(run('update').out).toMatch(/wired\s+opencode\.json/);
    expect(instructions()).toEqual([RULES, MEMORY[0], MEMORY[1]]);
  });

  it('asks for every wanted entry when the config cannot be edited', () => {
    writeFileSync(join(cwd, 'opencode.jsonc'), '{\n  // mine\n}\n');
    const { code, err } = run('add', 'common', 'session-memory', '--target', 'opencode');
    expect(code).toBe(1);
    expect(err).toContain(`"${RULES}" and "${MEMORY[0]}" and "${MEMORY[1]}"`);

    writeFileSync(
      join(cwd, 'opencode.jsonc'),
      `{\n  // mine\n  "instructions": ["${RULES}", "${MEMORY[0]}", "${MEMORY[1]}"]\n}\n`
    );
    expect(run('add', 'common', 'session-memory', '--target', 'opencode').out).toMatch(
      /by hand\s+opencode\.jsonc/
    );

    const removed = run('remove', 'common', 'session-memory', '--target', 'opencode');
    expect(removed.code).toBe(0);
    expect(removed.out).toContain(`remove "${RULES}" and "${MEMORY[0]}" and "${MEMORY[1]}"`);
  });

  it('leaves Codex alone: memory needs no AGENTS.md block', () => {
    expect(run('add', 'session-memory', '--target', 'codex').code).toBe(0);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
  });
});
