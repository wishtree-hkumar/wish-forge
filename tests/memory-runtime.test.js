import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluate, normalize, respond } from '../catalog/runtime/hooks/runtime.mjs';
import { loadCatalog } from '../src/catalog.js';
import { add } from '../src/ops.js';
import { tmpDir } from './helpers.js';

const ROOT = '/work/app';
const ALLOW = { code: 0, stdout: '', stderr: '' };

describe('normalize', () => {
  it.each(['claude', 'codex'])('%s: turns a session start into a start event', (harness) => {
    for (const source of ['startup', 'clear', 'compact']) {
      expect(normalize(harness, { hook_event_name: 'SessionStart', source }, ROOT)).toEqual([
        { kind: 'start', source },
      ]);
    }
    expect(normalize(harness, { hook_event_name: 'SessionStart' }, ROOT)).toEqual([
      { kind: 'start', source: 'startup' },
    ]);
  });

  it.each(['claude', 'codex'])('%s: ignores a resumed or forked session', (harness) => {
    for (const source of ['resume', 'fork', 'something-new']) {
      expect(normalize(harness, { hook_event_name: 'SessionStart', source }, ROOT)).toEqual([]);
    }
  });

  it('cursor: session start and compaction', () => {
    expect(normalize('cursor', { hook_event_name: 'sessionStart' }, ROOT)).toEqual([
      { kind: 'start', source: 'startup' },
    ]);
    expect(normalize('cursor', { hook_event_name: 'preCompact', trigger: 'auto' }, ROOT)).toEqual([
      { kind: 'compact' },
    ]);
  });

  it('opencode: compaction', () => {
    expect(normalize('opencode', { hook: 'compact' }, ROOT)).toEqual([{ kind: 'compact' }]);
  });
});

const gate = (check) => ({ name: 'probe', check });
const run = (harness, payload, check) =>
  evaluate({ harness, payload, root: tmpDir(), gates: [gate(check)], now: 1000 });

describe('evaluate', () => {
  it.each([
    ['claude', { hook_event_name: 'SessionStart', session_id: 's-1' }, 's-1'],
    ['cursor', { hook_event_name: 'sessionStart', conversation_id: 'c-1' }, 'c-1'],
    ['opencode', { hook: 'compact', session: 'o-1' }, 'o-1'],
    ['claude', { hook_event_name: 'SessionStart' }, ''],
    ['claude', { hook_event_name: 'SessionStart', session_id: 7 }, ''],
  ])('%s: gives the gate the session id', (harness, payload, expected) => {
    let seen;
    run(harness, payload, (_event, ctx) => {
      seen = ctx.session;
    });
    expect(seen).toBe(expected);
  });

  it('collects context and messages for the person beside notes', () => {
    const result = run('claude', { hook_event_name: 'SessionStart' }, () => ({
      context: 'memory',
      tell: 'hello',
      note: 'nudge',
    }));
    expect(result).toMatchObject({ contexts: ['memory'], tells: ['hello'], notes: ['nudge'] });
    expect(result.block).toBeUndefined();
  });

  it('returns empty lists when a gate blocks or nothing is said', () => {
    const blocked = run(
      'claude',
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      () => ({ block: 'no' })
    );
    expect(blocked).toMatchObject({ block: 'no', contexts: [], tells: [] });
    expect(run('claude', { hook_event_name: 'SessionStart' }, () => undefined)).toMatchObject({
      contexts: [],
      tells: [],
    });
  });
});

const result = (extra) => ({
  events: [],
  notes: [],
  contexts: [],
  tells: [],
  warnings: [],
  ...extra,
});
const start = { events: [{ kind: 'start', source: 'startup' }] };

describe('respond', () => {
  it.each(['claude', 'codex'])('%s: adds context to a starting session', (harness) => {
    const payload = { hook_event_name: 'SessionStart' };
    const out = respond(harness, payload, result({ ...start, contexts: ['one', 'two'] }));
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'one\n\ntwo' },
    });
  });

  it('cursor: adds context to a starting session in its own field', () => {
    const out = respond(
      'cursor',
      { hook_event_name: 'sessionStart' },
      result({ ...start, contexts: ['one'] })
    );
    expect(JSON.parse(out.stdout)).toEqual({ additional_context: 'one' });
  });

  it('says nothing when a starting session has no context', () => {
    for (const harness of ['claude', 'codex', 'cursor']) {
      expect(respond(harness, { hook_event_name: 'SessionStart' }, result(start))).toEqual(ALLOW);
    }
  });

  it('cursor: shows the person a message on compaction, and drops context there', () => {
    const compact = { events: [{ kind: 'compact' }] };
    const out = respond(
      'cursor',
      { hook_event_name: 'preCompact' },
      result({ ...compact, tells: ['saved'], contexts: ['ignored'] })
    );
    expect(JSON.parse(out.stdout)).toEqual({ user_message: 'saved' });
    expect(respond('cursor', { hook_event_name: 'preCompact' }, result(compact))).toEqual(ALLOW);
  });

  it('drops context returned on any other event', () => {
    const write = { events: [{ kind: 'write', path: 'a.js', content: '' }], contexts: ['x'] };
    expect(respond('claude', { hook_event_name: 'PreToolUse' }, result(write))).toEqual(ALLOW);
    expect(respond('cursor', { hook_event_name: 'preToolUse' }, result(write))).toEqual(ALLOW);
  });

  it('drops a message for the person where the harness cannot show one', () => {
    expect(
      respond('claude', { hook_event_name: 'SessionStart' }, result({ ...start, tells: ['x'] }))
    ).toEqual(ALLOW);
  });

  it('still works for a result from before contexts existed', () => {
    const old = { events: [{ kind: 'stop' }], notes: ['run the tests'], warnings: [] };
    expect(JSON.parse(respond('claude', { hook_event_name: 'Stop' }, old).stdout)).toEqual({
      decision: 'block',
      reason: 'run the tests',
    });
  });
});

describe('OpenCode plugin', () => {
  const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));

  async function plugin(probe) {
    const cwd = tmpDir();
    const ctx = {
      catalog,
      version: '0.1.0',
      scope: 'project',
      cwd,
      home: tmpDir(),
      force: false,
      dryRun: false,
    };
    add(ctx, ['protected-paths'], ['opencode']);
    writeFileSync(join(cwd, '.opencode/forgeflow/gates/zz-probe.mjs'), probe);
    const url = pathToFileURL(join(cwd, '.opencode/plugins/forgeflow.js')).href;
    return (await import(url)).ForgeflowGates({ directory: cwd });
  }

  it('adds a gate context to the compaction prompt, with the session id', async () => {
    const hooks = await plugin(
      "export function check(event, ctx) {\n  if (event.kind === 'compact') return { context: `kept for ${ctx.session}` };\n}\n"
    );
    const output = { context: ['existing'] };
    await hooks['experimental.session.compacting']({ sessionID: 'o-9' }, output);
    expect(output.context).toEqual(['existing', 'kept for o-9']);
  });

  it('leaves compaction alone when a gate throws or the output has no list', async () => {
    const hooks = await plugin("export function check() {\n  throw new Error('boom');\n}\n");
    const output = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 'o-9' }, output);
    expect(output.context).toEqual([]);
    await expect(hooks['experimental.session.compacting']({}, {})).resolves.toBeUndefined();
  });

  it('passes the session id on prompts and tool calls', async () => {
    const hooks = await plugin(
      "export function check(event, ctx) {\n  if (ctx.session !== 'o-9') return { block: `no session: ${ctx.session}` };\n}\n"
    );
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'o-9' },
      { args: { command: 'ls' } }
    );
    await hooks['chat.message']({ sessionID: 'o-9' }, { parts: [{ type: 'text', text: 'hi' }] });
  });
});
