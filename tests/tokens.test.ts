import { readFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import * as codex from '../src/adapters/codex';
import { main } from '../src/cli';
import { MEMORY_LIMITS } from '../src/tokens';
import { agentMd, capture, ruleMd, skillMd, tmpDir, writeTree } from './helpers';
import { hookTree, runtimeTree } from './hook-helpers';

let catalogDir;
let cwd;
let home;
const run = (argv, stdout = capture()) => {
  const stderr = capture();
  const code = main(argv, { cwd, home, stdout, stderr, catalogDir });
  return { code, out: stdout.text, err: stderr.text };
};
const rows = (...argv) => JSON.parse(run(['tokens', '--json', ...argv]).out);
const row = (list, target, label) =>
  list.find((entry) => entry.target === target && entry.label.startsWith(label));

const AGENT_BODY = 'x'.repeat(400);
const RULE_BODY = '# R\n\n- y';

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), {
    ...runtimeTree(),
    'agents/builder.md': agentMd('builder', 'stage: build\n').replace(
      'Body of builder.',
      AGENT_BODY
    ),
    'skills/flow/SKILL.md': skillMd(
      'flow',
      'user-invocable-only: true\nrequires: [agent:builder]\n'
    ),
    'skills/note/SKILL.md': skillMd('note'),
    'rules/common.md': ruleMd('common').replace('# common\n\n- A rule of common.', RULE_BODY),
    'rules/ts.md': ruleMd('ts', 'paths:\n  - "**/*.ts"\n').replace(
      '# ts\n\n- A rule of ts.',
      RULE_BODY
    ),
    ...hookTree('guard'),
    'hooks/session-memory/HOOK.md':
      '---\nname: session-memory\ndescription: Memory.\nevents: [start]\ngroup: memory\n---\nx\n',
    'hooks/session-memory/gate.mjs': 'export function check() {}\n',
  });
  cwd = tmpDir();
  home = tmpDir();
});

const install = (targets) =>
  run(['add', 'flow', 'note', 'common', 'ts', 'guard', '--target', targets]);

describe('every harness', () => {
  it.each(['claude', 'codex', 'opencode', 'cursor'])(
    '%s: lists agents and offered skills every session, and bodies when used',
    (target) => {
      install(target);
      const list = rows();
      const builder = 'builder'.length + 'Does builder things.'.length;
      expect(row(list, target, 'agent list')).toMatchObject({
        section: 'every session',
        label: 'agent list (1 agent)',
        chars: builder,
      });
      expect(row(list, target, 'builder agent')).toMatchObject({
        section: 'when used',
        chars: AGENT_BODY.length,
      });
      expect(row(list, target, 'flow')).toMatchObject({ section: 'when used' });
      expect(row(list, target, 'quality gates')).toMatchObject({ section: 'when used' });
      expect(list.every((entry) => entry.tokens === Math.round(entry.chars / 4))).toBe(true);
    }
  );

  it.each([
    ['claude', 'skill list (1 of 2 skills)'],
    ['cursor', 'skill list (1 of 2 skills)'],
    ['opencode', 'skill list (1 of 2 skills)'],
    ['codex', 'skill list (2 skills)'],
  ])('%s: offers the model only skills it may start itself', (target, label) => {
    install(target);
    expect(row(rows(), target, 'skill list').label).toBe(label);
  });
});

describe('rules', () => {
  it('Claude Code and Cursor load an always rule every session and a scoped one on its files', () => {
    install('claude,cursor');
    const list = rows();
    for (const target of ['claude', 'cursor']) {
      expect(row(list, target, 'rules: common')).toMatchObject({
        section: 'every session',
        chars: RULE_BODY.length,
      });
      expect(row(list, target, 'rules: ts')).toMatchObject({
        section: 'when used',
        label: 'rules: ts (on *.ts)',
      });
    }
  });

  it('Codex loads the AGENTS.md block every session and a pack when it is read', () => {
    install('codex');
    const list = rows();
    const block = codex.rulesWiring('project').block([
      { name: 'common', applies: 'all work' },
      { name: 'ts', applies: 'files matching `**/*.ts`' },
    ]);
    expect(row(list, 'codex', 'AGENTS.md rules block')).toMatchObject({
      section: 'every session',
      chars: block.length,
    });
    expect(row(list, 'codex', 'rules: ts')).toMatchObject({
      section: 'when used',
      label: 'rules: ts (when read)',
    });
  });

  it('OpenCode loads every pack every session', () => {
    install('opencode');
    const list = rows();
    for (const name of ['common', 'ts']) {
      expect(row(list, 'opencode', `rules: ${name}`).section).toBe('every session');
    }
  });
});

describe('session memory', () => {
  const lessons = `# Project lessons\n\n${'- (2026-10-01) a lesson\n'.repeat(5)}`;

  it('estimates the block a new session would get now', () => {
    run(['add', 'session-memory', '--target', 'claude']);
    writeTree(cwd, { '.wishforge/memory/lessons.md': lessons });
    const memory = row(rows(), 'claude', 'memory block');
    expect(memory.section).toBe('every session');
    expect(memory.chars).toBeGreaterThan(5 * 24);
    expect(memory.chars).toBeLessThan(5 * 24 + 500);
  });

  it('leaves out a stale handoff note and caps each part and the whole', () => {
    run(['add', 'session-memory', '--target', 'claude']);
    const huge = 'z'.repeat(50000);
    writeTree(cwd, {
      '.wishforge/memory/lessons.md': `# Project lessons\n\n${huge}\n`,
      '.wishforge/memory/map.md': `# Project map\n\n${huge}\n`,
      '.wishforge/local/handoff.md': huge,
    });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(cwd, '.wishforge/local/handoff.md'), old, old);
    const memory = row(rows(), 'claude', 'memory block');
    const { lessons: l, map: m } = MEMORY_LIMITS.parts;
    expect(memory.chars).toBeGreaterThanOrEqual(l + m);
    expect(memory.chars).toBeLessThan(l + m + 600);
    expect(memory.chars).toBeLessThanOrEqual(MEMORY_LIMITS.block);
  });

  it('on OpenCode counts the memory files as they are', () => {
    run(['add', 'session-memory', '--target', 'opencode']);
    writeTree(cwd, {
      '.wishforge/memory/lessons.md': lessons,
      '.wishforge/local/handoff.md': 'abc',
    });
    expect(row(rows(), 'opencode', 'memory files')).toMatchObject({
      section: 'every session',
      chars: lessons.length + 3,
    });
  });

  it('mirrors the limits of the shipped hook', () => {
    const gate = readFileSync(
      fileURLToPath(new URL('../catalog/hooks/session-memory/gate.mjs', import.meta.url)),
      'utf8'
    );
    const limits =
      /const LIMITS = \{ lessons: (\d+), map: (\d+), handoff: (\d+), activity: (\d+) \}/.exec(gate);
    expect(MEMORY_LIMITS.parts).toEqual({
      lessons: Number(limits[1]),
      map: Number(limits[2]),
      handoff: Number(limits[3]),
      activity: Number(limits[4]),
    });
    expect(MEMORY_LIMITS.block).toBe(Number(/const MAX_BLOCK = (\d+);/.exec(gate)[1]));
    expect(MEMORY_LIMITS.staleDays).toBe(
      Number(/const STALE = (\d+) \* 24 \* HOUR;/.exec(gate)[1])
    );
  });
});

describe('the command', () => {
  it('prints sections, totals and the note on estimates', () => {
    install('claude');
    const { code, out } = run(['tokens']);
    expect(code).toBe(0);
    expect(out).toMatch(/^claude {2}\(/m);
    expect(out).toMatch(/^ {2}Every session\s+~ tokens$/m);
    expect(out).toMatch(/^ {4}agent list \(1 agent\)\s+\d+$/m);
    expect(out).toMatch(/^ {4}total\s+~[\d,]+$/m);
    expect(out).toMatch(/^ {2}When used$/m);
    expect(out).toContain('Estimates at about 4 characters per token.');
  });

  it('limits to --target and says when nothing is installed', () => {
    install('claude,codex');
    expect(new Set(rows('--target', 'codex').map((entry) => entry.target))).toEqual(
      new Set(['codex'])
    );
    cwd = tmpDir();
    expect(run(['tokens']).out).toBe('Nothing is installed here.\n');
  });

  it('reports global installs with --global', () => {
    run(['add', 'builder', '--target', 'claude', '--global']);
    expect(row(rows('--global'), 'claude', 'agent list')).toBeDefined();
  });

  it('measures an item that left the catalog from its files', () => {
    install('claude');
    rmSync(join(catalogDir, 'skills/note'), { recursive: true });
    const gone = row(rows(), 'claude', 'skill:note');
    expect(gone).toMatchObject({
      section: 'when used',
      label: 'skill:note (no longer in the catalog)',
    });
    expect(gone.chars).toBeGreaterThan(0);
  });

  it('fits a terminal', () => {
    install('claude');
    const out = capture();
    out.isTTY = true;
    out.columns = 40;
    run(['tokens'], out);
    expect(out.text.split('\n').every((line) => line.length <= 40)).toBe(true);
  });
});

describe('the real catalog', () => {
  it('estimates a full install on all four harnesses', () => {
    catalogDir = fileURLToPath(new URL('../catalog', import.meta.url));
    run([
      'add',
      '--flow',
      'full',
      '--memory',
      'common',
      'typescript',
      '--target',
      'claude,codex,opencode,cursor',
    ]);
    const out = capture();
    out.isTTY = true;
    out.columns = 100;
    const { code } = run(['tokens'], out);
    expect(code).toBe(0);
    for (const target of ['claude', 'codex', 'opencode', 'cursor']) {
      expect(out.text).toMatch(new RegExp(`^${target} {2}\\(`, 'm'));
    }
    expect(out.text.split('\n').every((line) => line.length <= 100)).toBe(true);
  });
});
