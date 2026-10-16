import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluate,
  findRun,
  loadConfig,
  matchesGlob,
  normalize,
  parsePatch,
  respond,
  selfProtect,
  toRelative,
} from '../catalog/runtime/hooks/runtime.mjs';
import { tmpDir, writeTree } from './helpers';

const ROOT = '/work/app';

describe('toRelative', () => {
  it('makes project paths relative with forward slashes', () => {
    expect(toRelative(ROOT, '/work/app/src/a.js')).toBe('src/a.js');
    expect(toRelative(ROOT, 'src/a.js')).toBe('src/a.js');
  });

  it('resolves a relative path against the payload cwd', () => {
    expect(toRelative(ROOT, 'a.js', '/work/app/packages/api')).toBe('packages/api/a.js');
  });

  it('keeps a path outside the project absolute', () => {
    expect(toRelative(ROOT, '/etc/hosts')).toBe('/etc/hosts');
    expect(toRelative(ROOT, '../other/a.js')).toBe('/work/other/a.js');
  });
});

describe('parsePatch', () => {
  it('returns one entry per file with its added lines', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.js',
      '+const a = 1;',
      '+const b = 2;',
      '*** Update File: src/old.js',
      '@@ context',
      '-const gone = 0;',
      '+const kept = 3;',
      ' unchanged',
      '*** Delete File: src/dead.js',
      '*** End Patch',
    ].join('\n');
    expect(parsePatch(patch)).toEqual([
      { path: 'src/new.js', content: 'const a = 1;\nconst b = 2;' },
      { path: 'src/old.js', content: 'const kept = 3;' },
      { path: 'src/dead.js', content: '' },
    ]);
  });

  it('treats a move target as a written file', () => {
    const patch = '*** Update File: a.js\n*** Move to: b.js\n+moved';
    expect(parsePatch(patch).map((file) => file.path)).toEqual(['a.js', 'b.js']);
    expect(parsePatch(patch)[1].content).toBe('moved');
  });

  it('returns nothing for text that is not a patch, or not text', () => {
    expect(parsePatch('ls -la')).toEqual([]);
    expect(parsePatch(undefined)).toEqual([]);
  });
});

describe('matchesGlob', () => {
  it.each([
    ['.env', '.env', true],
    ['config/.env', '.env', true],
    ['.env.local', '.env.*', true],
    ['.envrc', '.env.*', false],
    ['certs/server.pem', '*.pem', true],
    ['server.pem.txt', '*.pem', false],
    ['migrations/001.sql', 'migrations/**', true],
    ['db/migrations/001.sql', 'migrations/**', false],
    ['db/migrations/001.sql', '**/migrations/**', true],
    ['migrations/a/b.sql', 'migrations/*.sql', false],
    ['src/a.js', 'src/?.js', true],
    ['src/ab.js', 'src/?.js', false],
    ['a+b.txt', 'a+b.txt', true],
    ['package-lock.json', 'package-lock.json', true],
    ['sub/package-lock.json', 'package-lock.json', true],
  ])('%s against %s is %s', (path, glob, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected);
  });
});

describe('loadConfig', () => {
  it('returns empty lists when there is no config file', () => {
    expect(loadConfig(tmpDir())).toEqual({
      config: { releaseCommands: [], protectedPaths: [], secretAllow: [], testCommands: [] },
      warnings: [],
    });
  });

  it('compiles patterns case-insensitively and keeps globs as text', () => {
    const root = writeTree(tmpDir(), {
      '.wishforge/config.json': JSON.stringify({
        releaseCommands: ['\\bmake\\s+deploy\\b'],
        protectedPaths: ['migrations/**'],
      }),
    });
    const { config, warnings } = loadConfig(root);
    expect(warnings).toEqual([]);
    expect(config.releaseCommands[0].test('MAKE deploy')).toBe(true);
    expect(config.protectedPaths).toEqual(['migrations/**']);
  });

  it('ignores bad entries one by one and warns about each', () => {
    const root = writeTree(tmpDir(), {
      '.wishforge/config.json': JSON.stringify({
        releaseCommands: ['ok', '(unclosed', 7],
        protectedPaths: 'not-a-list',
        testCommands: ['fine'],
      }),
    });
    const { config, warnings } = loadConfig(root);
    expect(config.releaseCommands).toHaveLength(1);
    expect(config.protectedPaths).toEqual([]);
    expect(config.testCommands).toHaveLength(1);
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toContain('releaseCommands[1]');
    expect(warnings.join('\n')).toContain('releaseCommands[2]');
    expect(warnings.join('\n')).toContain('"protectedPaths"');
  });

  it('ignores a config that is not a JSON object', () => {
    for (const text of ['{ broken', '[]']) {
      const root = writeTree(tmpDir(), { '.wishforge/config.json': text });
      const { config, warnings } = loadConfig(root);
      expect(config.releaseCommands).toEqual([]);
      expect(warnings).toHaveLength(1);
    }
  });
});

describe('findRun', () => {
  const NOW = Date.UTC(2026, 9, 13, 12);
  const runIn = (root, name, state, ageHours = 0) => {
    const dir = join(root, '.wishforge/runs', name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.md');
    writeFileSync(file, state);
    const when = new Date(NOW - ageHours * 3600 * 1000);
    utimesSync(file, when, when);
    return dir;
  };

  it('returns null when there are no runs', () => {
    expect(findRun(tmpDir(), NOW)).toBeNull();
  });

  it('finds a running run and reads its fields', () => {
    const root = tmpDir();
    const dir = runIn(
      root,
      '20261013-add-login',
      'mode: full\ncurrent stage: BUILD\nstatus: running\n'
    );
    expect(findRun(root, NOW)).toEqual({
      dir,
      name: '20261013-add-login',
      status: 'running',
      stage: 'BUILD',
      approved: false,
    });
  });

  it.each([
    ['plain', 'status: waiting for user'],
    ['bulleted', '- status: waiting for user'],
    ['backticked key and value', '- `status:` `waiting for user`'],
    ['backticked line', '`status: waiting for user`'],
    ['bold key', '**status:** waiting for user'],
    ['capitalised', 'Status: Waiting for user'],
  ])('reads a %s status line', (_label, line) => {
    const root = tmpDir();
    runIn(root, 'r', `mode: quick\n${line}\ncurrent stage: SHIP\n`);
    expect(findRun(root, NOW)).toMatchObject({ status: 'waiting for user', stage: 'SHIP' });
  });

  it.each(['complete', 'stopped: tests failed', ''])('ignores a run with status "%s"', (status) => {
    const root = tmpDir();
    runIn(root, 'r', `status: ${status}\n`);
    expect(findRun(root, NOW)).toBeNull();
  });

  it('ignores a run idle for more than 24 hours', () => {
    const root = tmpDir();
    runIn(root, 'old', 'status: running\n', 25);
    expect(findRun(root, NOW)).toBeNull();
    runIn(root, 'recent', 'status: running\n', 23);
    expect(findRun(root, NOW).name).toBe('recent');
  });

  it('prefers the most recently updated active run', () => {
    const root = tmpDir();
    runIn(root, 'a-older', 'status: running\n', 5);
    runIn(root, 'b-newer', 'status: running\n', 1);
    runIn(root, 'c-done', 'status: complete\n', 0);
    expect(findRun(root, NOW).name).toBe('b-newer');
  });

  it('reports approval only for a decision: approved line', () => {
    const root = tmpDir();
    const dir = runIn(root, 'r', 'status: running\n');
    writeFileSync(join(dir, '09-approval.md'), 'The user said maybe.\n');
    expect(findRun(root, NOW).approved).toBe(false);
    writeFileSync(join(dir, '09-approval.md'), 'decision: approved\ndate: today\n');
    expect(findRun(root, NOW).approved).toBe(true);
  });

  it('skips run folders without a readable state.md', () => {
    const root = tmpDir();
    mkdirSync(join(root, '.wishforge/runs/empty'), { recursive: true });
    writeTree(root, { '.wishforge/runs/stray.txt': 'x' });
    expect(findRun(root, NOW)).toBeNull();
  });
});

describe('selfProtect', () => {
  const root = writeTree(tmpDir(), { '.claude/wishforge/run.mjs': '' });
  const write = (path) => selfProtect({ kind: 'write', path, content: '' }, root);
  const shell = (command) => selfProtect({ kind: 'shell', command }, root);

  it('blocks writes to wishforge hook files, config and lockfile', () => {
    for (const path of [
      '.claude/wishforge/run.mjs',
      '.cursor/wishforge/gates/secret-guard.mjs',
      '.wishforge/config.json',
      '.wishforge/lock.json',
    ]) {
      expect(write(path), path).toContain('is protected');
    }
  });

  it('blocks the wiring file only for a harness that has gates installed', () => {
    expect(write('.claude/settings.json')).toContain('is protected');
    expect(write('.cursor/hooks.json')).toBeUndefined();
    expect(write('.claude/settings.local.json')).toBeUndefined();
  });

  it('allows ordinary writes', () => {
    expect(write('src/a.js')).toBeUndefined();
    expect(write('.wishforge/runs/r/state.md')).toBeUndefined();
    expect(write('.claude/agents/reviewer.md')).toBeUndefined();
  });

  it('blocks shell commands that touch the runner or remove gates', () => {
    expect(shell('rm -rf .claude/wishforge/gates')).toContain('is protected');
    expect(shell('echo "" > .codex/wishforge/run.mjs')).toContain('is protected');
    expect(shell('npx wishforge remove approval-gate --target claude')).toContain('is protected');
  });

  it('allows other shell commands, including other wishforge commands', () => {
    expect(shell('npm test')).toBeUndefined();
    expect(shell('wishforge status')).toBeUndefined();
    expect(shell('wishforge list && git remote remove origin')).toBeUndefined();
  });
});

describe('normalize', () => {
  const claude = (tool, input, extra = {}) =>
    normalize(
      'claude',
      { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: ROOT, ...extra },
      ROOT
    );

  it('maps Claude Code tools', () => {
    expect(claude('Bash', { command: 'npm test' })).toEqual([
      { kind: 'shell', command: 'npm test' },
    ]);
    expect(claude('Write', { file_path: '/work/app/a.js', content: 'x' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'x' },
    ]);
    expect(claude('Edit', { file_path: 'a.js', old_string: 'o', new_string: 'n' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'n' },
    ]);
    expect(
      claude('MultiEdit', {
        file_path: 'a.js',
        edits: [{ new_string: 'one' }, { new_string: 'two' }],
      })
    ).toEqual([{ kind: 'write', path: 'a.js', content: 'one\ntwo' }]);
    expect(claude('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'cell' })).toEqual([
      { kind: 'write', path: 'n.ipynb', content: 'cell' },
    ]);
  });

  it('maps Claude Code and Codex prompts and stops', () => {
    for (const harness of ['claude', 'codex']) {
      expect(
        normalize(harness, { hook_event_name: 'UserPromptSubmit', prompt: 'approve' }, ROOT)
      ).toEqual([{ kind: 'prompt', text: 'approve' }]);
      expect(normalize(harness, { hook_event_name: 'Stop' }, ROOT)).toEqual([{ kind: 'stop' }]);
      expect(normalize(harness, { hook_event_name: 'Stop', stop_hook_active: true }, ROOT)).toEqual(
        []
      );
    }
  });

  it('maps Codex apply_patch to one write per file', () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: '*** Add File: a.js\n+one\n*** Update File: b.js\n+two' },
      cwd: '/work/app/pkg',
    };
    expect(normalize('codex', payload, ROOT)).toEqual([
      { kind: 'write', path: 'pkg/a.js', content: 'one' },
      { kind: 'write', path: 'pkg/b.js', content: 'two' },
    ]);
  });

  it('maps Codex Bash and file_path tools like Claude Code', () => {
    const base = { hook_event_name: 'PreToolUse', cwd: ROOT };
    expect(
      normalize('codex', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' } }, ROOT)
    ).toEqual([{ kind: 'shell', command: 'ls' }]);
    expect(
      normalize(
        'codex',
        { ...base, tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x' } },
        ROOT
      )
    ).toEqual([{ kind: 'write', path: 'a.js', content: 'x' }]);
  });

  it('maps Cursor events', () => {
    const pre = (tool, input) =>
      normalize(
        'cursor',
        { hook_event_name: 'preToolUse', tool_name: tool, tool_input: input, cwd: ROOT },
        ROOT
      );
    expect(pre('Shell', { command: 'git push' })).toEqual([{ kind: 'shell', command: 'git push' }]);
    expect(pre('Write', { file_path: '/work/app/a.js', content: 'x' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'x' },
    ]);
    expect(pre('StrReplace', { file_path: 'a.js', new_string: 'n' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'n' },
    ]);
    expect(pre('Delete', { file_path: '.env' })).toEqual([
      { kind: 'write', path: '.env', content: '' },
    ]);
    expect(
      normalize('cursor', { hook_event_name: 'beforeSubmitPrompt', prompt: 'hi' }, ROOT)
    ).toEqual([{ kind: 'prompt', text: 'hi' }]);
    expect(normalize('cursor', { hook_event_name: 'stop', loop_count: 0 }, ROOT)).toEqual([
      { kind: 'stop' },
    ]);
    expect(normalize('cursor', { hook_event_name: 'stop', loop_count: 1 }, ROOT)).toEqual([]);
  });

  it('maps OpenCode plugin calls', () => {
    const tool = (name, args) => normalize('opencode', { hook: 'tool', tool: name, args }, ROOT);
    expect(tool('bash', { command: 'ls' })).toEqual([{ kind: 'shell', command: 'ls' }]);
    expect(tool('write', { filePath: '/work/app/a.js', content: 'x' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'x' },
    ]);
    expect(tool('edit', { filePath: 'a.js', oldString: 'o', newString: 'n' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'n' },
    ]);
    expect(tool('patch', { patchText: '*** Add File: a.js\n+one' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'one' },
    ]);
    expect(normalize('opencode', { hook: 'prompt', text: 'approve' }, ROOT)).toEqual([
      { kind: 'prompt', text: 'approve' },
    ]);
  });

  it.each([
    ['an unknown harness', 'vim', { hook_event_name: 'PreToolUse' }],
    ['an unknown event', 'claude', { hook_event_name: 'Notification' }],
    [
      'an unknown tool',
      'claude',
      { hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'x' } },
    ],
    ['a missing tool_input', 'claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }],
    [
      'a non-string command',
      'claude',
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 7 } },
    ],
    ['an empty payload', 'cursor', {}],
    ['a null payload', 'codex', null],
    ['a read tool', 'opencode', { hook: 'tool', tool: 'read', args: { filePath: 'a.js' } }],
  ])('produces no events for %s', (_label, harness, payload) => {
    expect(normalize(harness, payload, ROOT)).toEqual([]);
  });
});

describe('evaluate', () => {
  const root = tmpDir();
  const shellPayload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  };
  const gate = (name, check) => ({ name, check });
  const run = (gates, payload: object = shellPayload) =>
    evaluate({ harness: 'claude', payload, root, gates });

  it('allows when no gate objects', () => {
    const result = run([gate('a', () => undefined)]);
    expect(result.block).toBeUndefined();
    expect(result.notes).toEqual([]);
  });

  it('stops at the first block', () => {
    const calls = [];
    const result = run([
      gate('a', () => ({ note: 'first' })),
      gate('b', () => ({ block: 'no' })),
      gate('c', () => calls.push('c')),
    ]);
    expect(result.block).toBe('no');
    expect(calls).toEqual([]);
  });

  it('collects notes from every gate', () => {
    const result = run([gate('a', () => ({ note: 'one' })), gate('b', () => ({ note: 'two' }))]);
    expect(result.notes).toEqual(['one', 'two']);
  });

  it('skips a gate that throws and keeps going', () => {
    const result = run([
      gate('bad', () => {
        throw new Error('boom');
      }),
      gate('good', () => ({ note: 'still ran' })),
    ]);
    expect(result.block).toBeUndefined();
    expect(result.notes).toEqual(['still ran']);
    expect(result.warnings.join('\n')).toContain('gate bad failed (boom)');
  });

  it('checks self-protection before any gate', () => {
    const calls = [];
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(root, '.wishforge/config.json'), content: '{}' },
    };
    const result = run([gate('a', () => calls.push('a'))], payload);
    expect(result.block).toContain('is protected');
    expect(calls).toEqual([]);
  });

  it('gives gates the context they need', () => {
    let seen;
    run([gate('a', (event, ctx) => void (seen = { event, ctx }))]);
    expect(seen.event).toEqual({ kind: 'shell', command: 'npm test' });
    expect(seen.ctx).toMatchObject({ root, harness: 'claude', run: null });
    expect(seen.ctx.config.releaseCommands).toEqual([]);
    expect(seen.ctx.matchesGlob('a.pem', '*.pem')).toBe(true);
    expect(typeof seen.ctx.now).toBe('number');
    seen.ctx.state.set({ dirty: true });
    expect(seen.ctx.state.get()).toEqual({ dirty: true });
    seen.ctx.state.set({});
  });

  it('reports config problems as warnings', () => {
    const bad = writeTree(tmpDir(), { '.wishforge/config.json': '{ broken' });
    const result = evaluate({ harness: 'claude', payload: shellPayload, root: bad, gates: [] });
    expect(result.warnings).toHaveLength(1);
  });
});

describe('respond', () => {
  const pre = { hook_event_name: 'PreToolUse' };
  const result = (overrides) => ({
    events: [{ kind: 'shell', command: 'x' }],
    notes: [],
    warnings: [],
    ...overrides,
  });

  it('allows silently when there is nothing to say', () => {
    for (const harness of ['claude', 'codex', 'cursor']) {
      expect(respond(harness, pre, result({}))).toEqual({ code: 0, stdout: '', stderr: '' });
    }
  });

  it('blocks Claude Code and Codex with exit 2 and the reason on stderr', () => {
    for (const harness of ['claude', 'codex']) {
      expect(respond(harness, pre, result({ block: 'no' }))).toEqual({
        code: 2,
        stdout: '',
        stderr: 'no',
      });
    }
  });

  it('blocks Cursor with exit 2 and a deny decision', () => {
    const out = respond('cursor', { hook_event_name: 'preToolUse' }, result({ block: 'no' }));
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout)).toEqual({
      permission: 'deny',
      user_message: 'no',
      agent_message: 'no',
    });
  });

  it('delivers a note to Claude Code and Codex as additional context', () => {
    const out = respond('claude', pre, result({ notes: ['one', 'two'] }));
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'one\ntwo' },
    });
  });

  it('delivers a note on stop as the stop nudge', () => {
    const stop = result({ events: [{ kind: 'stop' }], notes: ['run the tests'] });
    expect(JSON.parse(respond('codex', { hook_event_name: 'Stop' }, stop).stdout)).toEqual({
      decision: 'block',
      reason: 'run the tests',
    });
    expect(JSON.parse(respond('cursor', { hook_event_name: 'stop' }, stop).stdout)).toEqual({
      followup_message: 'run the tests',
    });
  });

  it('drops notes Cursor cannot deliver', () => {
    expect(respond('cursor', { hook_event_name: 'preToolUse' }, result({ notes: ['x'] }))).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('shows warnings only with a prompt, never on tool calls or stop', () => {
    const warned = { warnings: ['config is broken'] };
    expect(respond('claude', pre, result(warned)).stdout).toBe('');
    expect(
      respond(
        'claude',
        { hook_event_name: 'Stop' },
        result({ ...warned, events: [{ kind: 'stop' }] })
      ).stdout
    ).toBe('');
    const prompt = respond(
      'claude',
      { hook_event_name: 'UserPromptSubmit' },
      result({ ...warned, events: [{ kind: 'prompt', text: 'hi' }], notes: ['recorded'] })
    );
    expect(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext).toBe(
      'recorded\nconfig is broken'
    );
  });
});
