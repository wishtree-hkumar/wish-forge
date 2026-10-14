import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as cursor from '../src/adapters/cursor.js';
import { main } from '../src/cli.js';
import { capture, tmpDir, writeTree } from './helpers.js';
import { hookTree, runtimeTree } from './hook-helpers.js';

describe('wiring entries', () => {
  it.each([
    ['claude', claude, 'node "$CLAUDE_PROJECT_DIR/.claude/wishforge/run.mjs" claude'],
    ['codex', codex, 'node "$(git rev-parse --show-toplevel)/.codex/wishforge/run.mjs" codex'],
  ])(
    '%s starts the runner when a session starts, clears or is compacted',
    (_name, adapter, command) => {
      expect(Object.keys(adapter.wiring.entries)).toEqual([
        'PreToolUse',
        'UserPromptSubmit',
        'Stop',
        'SessionStart',
      ]);
      expect(adapter.wiring.entries.SessionStart).toEqual({
        matcher: 'startup|clear|compact',
        hooks: [{ type: 'command', command, timeout: 10 }],
      });
    }
  );

  it('cursor starts the runner on session start and before compaction', () => {
    const entry = { command: 'node .cursor/wishforge/run.mjs cursor', timeout: 10 };
    expect(cursor.wiring.entries).toEqual({
      preToolUse: entry,
      beforeSubmitPrompt: entry,
      stop: entry,
      sessionStart: entry,
      preCompact: entry,
    });
  });
});

describe('a project wired before session events existed', () => {
  let catalogDir;
  let cwd;
  let home;
  const run = (...argv) => {
    const stdout = capture();
    const stderr = capture();
    const code = main(argv, { cwd, home, stdout, stderr, catalogDir });
    return { code, out: stdout.text, err: stderr.text };
  };
  const config = (path) => JSON.parse(readFileSync(join(cwd, path), 'utf8'));
  const mine = { hooks: [{ type: 'command', command: 'echo mine' }] };

  beforeEach(() => {
    catalogDir = writeTree(tmpDir(), { ...runtimeTree(), ...hookTree('guard') });
    cwd = tmpDir();
    home = tmpDir();
  });

  it('reports the wiring as missing until update adds the new entry, keeping the user hook', () => {
    run('add', 'guard', '--target', 'claude');
    const old = config('.claude/settings.json');
    old.hooks.SessionStart = [mine];
    writeFileSync(join(cwd, '.claude/settings.json'), JSON.stringify(old, null, 2));

    expect(run('status').out).toMatch(/wiring missing\s+\.claude\/settings\.json/);
    expect(run('doctor').code).toBe(1);

    expect(run('update').out).toMatch(/wired\s+\.claude\/settings\.json/);
    expect(config('.claude/settings.json').hooks.SessionStart).toEqual([
      mine,
      claude.wiring.entries.SessionStart,
    ]);
    expect(run('status').out).toMatch(/wiring ok\s+\.claude\/settings\.json/);

    run('remove', 'guard', '--target', 'claude');
    expect(config('.claude/settings.json')).toEqual({ hooks: { SessionStart: [mine] } });
  });

  it('upgrades a Cursor config the same way', () => {
    run('add', 'guard', '--target', 'cursor');
    const old = config('.cursor/hooks.json');
    delete old.hooks.sessionStart;
    delete old.hooks.preCompact;
    writeFileSync(join(cwd, '.cursor/hooks.json'), JSON.stringify(old, null, 2));

    expect(run('status').out).toMatch(/wiring missing/);
    expect(run('update').out).toMatch(/wired\s+\.cursor\/hooks\.json/);
    expect(Object.keys(config('.cursor/hooks.json').hooks)).toEqual([
      'preToolUse',
      'beforeSubmitPrompt',
      'stop',
      'sessionStart',
      'preCompact',
    ]);
  });
});
