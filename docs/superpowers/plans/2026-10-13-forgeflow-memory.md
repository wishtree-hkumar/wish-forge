# forgeflow Session Memory Implementation Plan (phase 4a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a project a small memory (shared lessons, a mechanical session record, a handoff note) that each harness loads into a new or compacted session by itself.

**Architecture:** One new hook item, `session-memory`, built on the phase 2 runtime, which gains two event kinds (`start`, `compact`) and two gate results (`context`, `tell`). The gate keeps `.forgeflow/local/session.json` and `session.md` current on every write and prompt, and returns a memory block at session start. OpenCode has no session-start hook, so the memory files are loaded through `opencode.json` `instructions`; phase 3b's single-entry handling is generalized to a set of entries derived from what is installed. Two skills tell the agent how to write a lesson and a handoff note.

**Tech Stack:** Node 20+ ESM JavaScript, `yaml` (only runtime dependency), `vitest`, `oxlint`, `prettier`, `smol-toml` (dev). Shipped hook code uses only `node:` built-ins.

**Spec:** `docs/superpowers/specs/2026-10-13-forgeflow-memory-design.md`

## Global Constraints

- Node 20+, ESM, no new runtime or dev dependency.
- Commit messages are a plain subject plus optional body. Never add `Co-Authored-By` or any other trailer.
- Shipped hook code (`catalog/runtime/hooks/*`, `catalog/hooks/*/gate.mjs`) imports only `node:` built-ins and has no shebang.
- A hook must never stop the harness: recording failures are swallowed, a throwing gate is skipped, the runner exits 1 on its own failure.
- Memory files: `.forgeflow/memory/lessons.md` (shared); `.forgeflow/local/session.json`, `.forgeflow/local/session.md`, `.forgeflow/local/handoff.md` (personal); `.forgeflow/local/.gitignore` holds exactly `*` and a newline.
- Record limits: 30 files, 3 prompts, 300 characters per prompt, a new session after 2 idle hours when no session id is known.
- Block limits: lessons 3,000 characters, handoff 1,500, recent activity 1,200; handoff and activity left out when older than 7 days.
- Session start is wired for `startup`, `clear` and `compact`, never `resume`.
- OpenCode entries: `.opencode/forgeflow/rules/*.md` (any rule installed), `.forgeflow/memory/*.md` and `.forgeflow/local/*.md` (`session-memory` installed).
- `forgeflow add --hooks` installs hooks without a `group`; `--memory` installs every item with `group: memory`.
- forgeflow never deletes a memory file.
- Run `npx vitest run` (whole suite) before each commit; it must be green.
- `catalog/**/*.md` and `docs/` are not formatted by prettier; everything else is.

## Review Focus

Inputs the spec implies and a person is likely to hit. Each has a test in the task named.

1. A prompt that contains a credential, or a multi-line prompt, or a very long one: stored redacted, on one line, cut to 300 characters. (Task 5)
2. A corrupt, empty or hand-edited `session.json`, and a project where `.forgeflow/local` cannot be written: the hook must carry on and never block the tool call. (Task 5)
3. A project that installed gates before this phase: its config lacks the session-start entry until `forgeflow update`, and `status` must say so. (Task 3)
4. OpenCode with rules and memory both installed, then one kind removed: the other kind's `instructions` entries must stay. (Task 4)
5. A session resumed, and a second harness opened on the same project: no duplicate block on resume, and the record rotates instead of mixing two sessions. (Tasks 2 and 5)

---

### Task 1: `group`, the new event names, and `--memory`

**Files:**
- Modify: `src/catalog.js`, `src/cli.js`
- Test: `tests/memory-catalog.test.js` (create)

**Interfaces:**
- Consumes: `loadCatalog`, `main`, test helpers `runtimeTree`, `agentMd`, `skillMd`, `ruleMd`.
- Produces:
  - `EVENTS` is `['shell', 'write', 'prompt', 'stop', 'start', 'compact']`.
  - Hook and skill items carry `group` (`'memory'` or `undefined`).
  - `forgeflow add --memory`; `--hooks` skips hooks that have a group; `group` in `info` and `list --json`.

- [ ] **Step 1: Write `tests/memory-catalog.test.js`**

`tests/memory-catalog.test.js`:

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/memory-catalog.test.js`
Expected: FAIL. `EVENTS` has four entries, a hook with `start` is rejected, `group` is an unknown field, and `--memory` is an unknown option.

- [ ] **Step 3: Implement in `src/catalog.js`**

Change `EVENTS` to:

```js
export const EVENTS = ['shell', 'write', 'prompt', 'stop', 'start', 'compact'];
```

Add beside `JOINS`:

```js
const GROUPS = ['memory'];
```

In `FIELDS`, change the `skill` and `hook` entries to:

```js
  skill: ['name', 'description', 'user-invocable-only', 'group', 'requires'],
  hook: ['name', 'description', 'events', 'group', 'requires'],
```

In `buildItem`, add as the last line of the `else if (type === 'skill')` block and of the `else if (type === 'hook')` block:

```js
    // Items in a group are installed together by a bundle flag such as --memory.
    item.group = oneOf(source, data, 'group', GROUPS, false);
```

- [ ] **Step 4: Implement in `src/cli.js`**

In `USAGE`, add after the `forgeflow add --specialists …` line:

```
  forgeflow add --memory --target <t>[,<t>...]
```

and after the `--specialists installs…` line:

```
--memory installs session memory: a hook and two skills. Per project only.
```

In `OPTIONS`, add after `specialists`:

```js
  memory: { type: 'boolean' },
```

In the `list` case, add `group` to the JSON row (destructuring and object, after `joins`). In the `info` case, add after the `['joins', item.joins],` row:

```js
        ['group', item.group],
```

In the `add` case, replace the body of `if (values.hooks) { … }` with:

```js
        // A hook in a group belongs to that group's bundle, not to the gates.
        const gates = [...catalog.values()].filter(
          (item) => item.type === 'hook' && item.group === undefined
        );
        wanted.push(...gates.map((item) => item.id).sort());
```

add after the `if (values.specialists) { … }` block:

```js
      if (values.memory) {
        const memory = [...catalog.values()].filter((item) => item.group === 'memory');
        wanted.push(...memory.map((item) => item.id).sort());
      }
```

and change the usage error below it to:

```js
        throw new UsageError(
          'name at least one item, or use --flow quick|full, --hooks, --specialists or --memory.'
        );
```

- [ ] **Step 5: Run the test, then the suite**

Run: `npx vitest run tests/memory-catalog.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures. If an older test asserts the previous four-name event list in an error message, update that expectation to the six names.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src tests
git add src tests
git commit -m "Add item groups, the session start and compact events, and --memory"
```

---

### Task 2: Session events, context and tell in the hook runtime

**Files:**
- Modify: `catalog/runtime/hooks/runtime.mjs`, `catalog/runtime/hooks/opencode-plugin.js`
- Test: `tests/memory-runtime.test.js` (create)

**Interfaces:**
- Consumes: `normalize`, `evaluate`, `respond` from the runtime; `add` from `src/ops.js` for the plugin test.
- Produces:
  - `normalize` returns `{ kind: 'start', source }` and `{ kind: 'compact' }` events.
  - `evaluate` returns `{ events, block?, notes, contexts, tells, warnings }`; `ctx.session` is the session id or `''`.
  - A gate may return `{ context }` and `{ tell }`.
  - `respond` delivers them per the spec's table 5.4.
  - The OpenCode plugin passes `session` in every payload and handles `experimental.session.compacting`.

- [ ] **Step 1: Write `tests/memory-runtime.test.js`**

`tests/memory-runtime.test.js`:

```js
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

const result = (extra) => ({ events: [], notes: [], contexts: [], tells: [], warnings: [], ...extra });
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
    const out = respond('cursor', { hook_event_name: 'sessionStart' }, result({ ...start, contexts: ['one'] }));
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
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'o-9' }, { args: { command: 'ls' } });
    await hooks['chat.message']({ sessionID: 'o-9' }, { parts: [{ type: 'text', text: 'hi' }] });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/memory-runtime.test.js`
Expected: FAIL. Session start and compaction produce no events, `ctx.session` is `undefined`, `contexts` and `tells` are missing from the result, `respond` returns nothing for a start, and the plugin has no `experimental.session.compacting` hook.

- [ ] **Step 3: Translate the new events in `runtime.mjs`**

Add after the `OPENCODE_WRITE_TOOLS` line:

```js
// A resumed or forked session already holds what its first start was given.
const START_SOURCES = new Set(['startup', 'clear', 'compact']);
```

In `normalize`, in the `if (harness === 'claude' || harness === 'codex') {` block, add as its first statement:

```js
    if (event === 'SessionStart') {
      const source = text(data.source) || 'startup';
      return START_SOURCES.has(source) ? [{ kind: 'start', source }] : [];
    }
```

in the `if (harness === 'cursor') {` block, add as its first statements:

```js
    if (event === 'sessionStart') return [{ kind: 'start', source: 'startup' }];
    if (event === 'preCompact') return [{ kind: 'compact' }];
```

and in the `if (harness === 'opencode') {` block, add as its first statement:

```js
    if (data.hook === 'compact') return [{ kind: 'compact' }];
```

- [ ] **Step 4: Collect contexts and messages in `evaluate`**

Replace the `evaluate` function with:

```js
export function evaluate({ harness, payload, root, gates, now = Date.now() }) {
  const events = normalize(harness, payload, root);
  const { config, warnings } = loadConfig(root);
  const said = { notes: [], contexts: [], tells: [] };
  const runs = findRuns(root, now);
  const ctx = {
    root,
    harness,
    config,
    run: runs[0] ?? null,
    runs,
    state: stateStore(root),
    // Claude Code and Codex send session_id, Cursor conversation_id, the OpenCode plugin session.
    session: text(payload?.session_id) || text(payload?.conversation_id) || text(payload?.session),
    now,
    matchesGlob,
  };

  for (const event of events) {
    const guard = selfProtect(event, root);
    if (guard) return { events, block: guard, ...said, warnings };
    for (const gate of gates) {
      let result;
      try {
        result = gate.check(event, ctx);
      } catch (error) {
        warnings.push(`forgeflow: gate ${gate.name} failed (${error.message}) and was skipped.`);
        continue;
      }
      if (result?.block) return { events, block: result.block, ...said, warnings };
      if (result?.note) said.notes.push(result.note);
      // context is background for the model; tell is a message for the person.
      if (result?.context) said.contexts.push(result.context);
      if (result?.tell) said.tells.push(result.tell);
    }
  }
  return { events, ...said, warnings };
}
```

- [ ] **Step 5: Deliver them in `respond`**

Replace the `respond` function with:

```js
export function respond(harness, payload, { events, block, notes, contexts = [], tells = [], warnings }) {
  const allow = { code: 0, stdout: '', stderr: '' };
  const has = (kind) => events.some((event) => event.kind === kind);
  const isStop = has('stop');
  // Warnings ride along with a prompt only: on tool calls they would repeat
  // constantly, and on stop they would keep the turn from ending.
  const message = [...notes, ...(has('prompt') ? warnings : [])].join('\n');
  // Context is delivered only as a session starts; anywhere else it is dropped.
  const added = [...(has('start') ? contexts : []), message].filter(Boolean).join('\n\n');

  if (harness === 'cursor') {
    if (block) {
      const deny = { permission: 'deny', user_message: block, agent_message: block };
      return { code: 2, stdout: JSON.stringify(deny), stderr: block };
    }
    if (has('start') && added) {
      return { ...allow, stdout: JSON.stringify({ additional_context: added }) };
    }
    // Cursor's compaction hook can show the person a message and nothing more.
    if (has('compact') && tells.length > 0) {
      return { ...allow, stdout: JSON.stringify({ user_message: tells.join('\n') }) };
    }
    if (isStop && message)
      return { ...allow, stdout: JSON.stringify({ followup_message: message }) };
    return allow;
  }

  if (block) return { code: 2, stdout: '', stderr: block };
  if (isStop) {
    return message
      ? { ...allow, stdout: JSON.stringify({ decision: 'block', reason: message }) }
      : allow;
  }
  if (!added) return allow;
  const context = { hookEventName: payload?.hook_event_name, additionalContext: added };
  return { ...allow, stdout: JSON.stringify({ hookSpecificOutput: context }) };
}
```

- [ ] **Step 6: Handle compaction in `opencode-plugin.js`**

Replace everything from `const check = (payload) => {` to the end of the file with:

```js
  const evaluate = (payload) => {
    try {
      return runtime.evaluate({ harness: 'opencode', payload, root, gates });
    } catch {
      return {}; // fail open
    }
  };
  const check = (payload) => {
    const result = evaluate(payload);
    if (result.block) throw new Error(result.block);
  };

  return {
    'tool.execute.before': async (input, output) => {
      check({ hook: 'tool', tool: input?.tool, args: output?.args, session: input?.sessionID });
    },
    'chat.message': async (input, output) => {
      const parts = Array.isArray(output?.parts) ? output.parts : [];
      const text = parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      check({ hook: 'prompt', text, session: input?.sessionID });
    },
    // The only place OpenCode lets a plugin add to what survives compaction.
    'experimental.session.compacting': async (input, output) => {
      const result = evaluate({ hook: 'compact', session: input?.sessionID });
      if (Array.isArray(output?.context)) output.context.push(...(result.contexts ?? []));
    },
  };
};
```

Also change the first comment line of the file to:

```js
// OpenCode plugin: runs forgeflow hooks before tool calls, on user messages and before compaction.
```

- [ ] **Step 7: Run the test, then the suite**

Run: `npx vitest run tests/memory-runtime.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures. `tests/runtime.test.js` and `tests/hook-e2e.test.js` still pass: notes, blocks and stop nudges are delivered exactly as before.

- [ ] **Step 8: Commit**

```bash
npx prettier --write catalog/runtime tests
git add catalog/runtime tests
git commit -m "Add session start and compaction events to the hook runtime"
```

---

### Task 3: Wire the session events

**Files:**
- Modify: `src/adapters/shared.js`, `src/adapters/cursor.js`, `tests/hook-adapters.test.js`
- Test: `tests/memory-wiring.test.js` (create)

**Interfaces:**
- Consumes: `commandWiring` in `src/adapters/shared.js`; `mergeWiring`, `isWired`; `main`.
- Produces: `claude.wiring.entries` and `codex.wiring.entries` gain `SessionStart` with matcher `startup|clear|compact`; `cursor.wiring.entries` gains `sessionStart` and `preCompact`. Nothing else about wiring changes.

- [ ] **Step 1: Write `tests/memory-wiring.test.js`**

`tests/memory-wiring.test.js`:

```js
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
    ['claude', claude, 'node "$CLAUDE_PROJECT_DIR/.claude/forgeflow/run.mjs" claude'],
    ['codex', codex, 'node "$(git rev-parse --show-toplevel)/.codex/forgeflow/run.mjs" codex'],
  ])('%s starts the runner when a session starts, clears or is compacted', (_name, adapter, command) => {
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
  });

  it('cursor starts the runner on session start and before compaction', () => {
    const entry = { command: 'node .cursor/forgeflow/run.mjs cursor', timeout: 10 };
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/memory-wiring.test.js`
Expected: FAIL. The entries lack `SessionStart`, `sessionStart` and `preCompact`; in the upgrade tests `status` reports `wiring ok` at once and `update` reports the config unchanged.

- [ ] **Step 3: Add the entries**

`src/adapters/shared.js`: in `commandWiring`, change the `entries` object to:

```js
    entries: {
      PreToolUse: { matcher, hooks: [handler] },
      UserPromptSubmit: { hooks: [handler] },
      Stop: { hooks: [handler] },
      // Not resume: a resumed session already holds what its first start was given.
      SessionStart: { matcher: 'startup|clear|compact', hooks: [handler] },
    },
```

`src/adapters/cursor.js`: change the `entries` line of `wiring` to:

```js
  entries: {
    preToolUse: entry,
    beforeSubmitPrompt: entry,
    stop: entry,
    sessionStart: entry,
    preCompact: entry,
  },
```

- [ ] **Step 4: Update the phase 2 expectations in `tests/hook-adapters.test.js`**

In the `wiring details` block:

1. Rename `claude wires three events into settings.json` to `claude wires four events into settings.json`, and add this property to the expected object after `Stop`:

```js
      SessionStart: { matcher: 'startup|clear|compact', hooks: [handler] },
```

2. Rename `codex wires three events into hooks.json and finds the repo root itself` to begin `codex wires four events`, and change the expected key list to `['PreToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart']`.

3. Rename `cursor wires three events into a versioned hooks.json` to begin `cursor wires five events`, and change the expected entries to:

```js
    expect(wiring.entries).toEqual({
      preToolUse: entry,
      beforeSubmitPrompt: entry,
      stop: entry,
      sessionStart: entry,
      preCompact: entry,
    });
```

- [ ] **Step 5: Run the tests, then the suite**

Run: `npx vitest run tests/memory-wiring.test.js tests/hook-adapters.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures. Any other phase 2 test that compares a whole generated hook config builds its expectation from `wiring.entries`, so it follows the change.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src tests
git add src tests
git commit -m "Wire session start and compaction into the harness configs"
```

---

### Task 4: A set of OpenCode `instructions` entries

**Files:**
- Modify: `src/rules-wiring.js`, `src/plan.js`, `src/ops.js`, `src/adapters/opencode.js`, `tests/rules-wiring.test.js`, `tests/rule-review.test.js`
- Test: `tests/memory-instructions.test.js` (create)

**Interfaces:**
- Consumes: phase 3b's `planRulesWiring`, `rulesState`, `mergeInstructions`, `stripInstructions`, `parseInstructions`, `handWired`.
- Produces (these replace the phase 3b signatures):
  - `opencode.rulesWiring(scope, ids = []) → { kind: 'json', path, alternative, entries, known, skeleton }`. `entries` are the ones wanted for the installed `ids`; `known` is every entry forgeflow ever adds at that scope.
  - `mergeInstructions(config | undefined, { entries, known, skeleton }) → object`
  - `stripInstructions(config, known) → object`
  - `parseInstructions(text, path, entries) → object`
  - `foundEntries(text, candidates) → string[]`
  - `handWired(text, entries) → boolean`
  - `planRulesWiring` treats a JSON wiring as active when `wiring.entries.length > 0`, and a block wiring when `rules.length > 0`.
  - `ops` passes the ids installed after the operation to `adapter.rulesWiring(scope, ids)`, and replans on every install or removal for a target that has a record or wants entries.
  - `codex.rulesWiring(scope)` is unchanged and ignores the second argument.

- [ ] **Step 1: Write `tests/memory-instructions.test.js`**

`tests/memory-instructions.test.js`:

```js
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
    expect(mergeInstructions({ instructions: ['a.md'] }, { entries: MEMORY, known, skeleton })).toEqual(
      { instructions: ['a.md', ...MEMORY] }
    );
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
    expect(stripInstructions({ instructions: [RULES, 'a.md', ...MEMORY], model: 'x' }, known)).toEqual({
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
    expect(run('add', 'session-memory', '--target', 'opencode').out).toMatch(/wired\s+opencode\.json/);
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/memory-instructions.test.js`
Expected: FAIL. `foundEntries` is not exported, `rulesWiring` returns `entry` and no `entries`, and installing `session-memory` for OpenCode writes no `opencode.json`.

- [ ] **Step 3: Generalize the functions in `src/rules-wiring.js`**

Replace `parseInstructions`, `handWired`, `mergeInstructions` and `stripInstructions` (keep `plainJson` as it is) with:

```js
const quoted = (entries) => entries.map((entry) => JSON.stringify(entry)).join(' and ');

export function parseInstructions(text, path, entries) {
  const refuse = (problem) =>
    new ConfigError(
      `${path} ${problem}. forgeflow will not modify it: fix the file, ` +
        `or add ${quoted(entries)} to its "instructions" list by hand, and re-run.`
    );
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw refuse(`is not valid JSON (${error.message})`);
  }
  if (!isObject(config)) throw refuse('must contain a JSON object');
  const list = config.instructions;
  if (list !== undefined && !(Array.isArray(list) && list.every((e) => typeof e === 'string'))) {
    throw refuse('has an "instructions" value that is not a list of strings');
  }
  return config;
}

// Which of the candidates a config forgeflow will not edit (it has comments,
// or is a .jsonc file) really holds in its "instructions" list.
export function foundEntries(text, candidates) {
  try {
    const config = JSON.parse(plainJson(text));
    const list = isObject(config) && Array.isArray(config.instructions) ? config.instructions : [];
    return candidates.filter((candidate) => list.includes(candidate));
  } catch {
    return [];
  }
}

export function handWired(text, entries) {
  return entries.length > 0 && foundEntries(text, entries).length === entries.length;
}

// entries are the ones wanted now; known is every entry forgeflow ever adds.
// Wanted entries stay where they are, missing ones go last, and forgeflow's own
// entries that are no longer wanted are dropped.
export function mergeInstructions(config, { entries, known, skeleton }) {
  const base = clone(config ?? skeleton);
  const kept = (base.instructions ?? []).filter(
    (existing) => !known.includes(existing) || entries.includes(existing)
  );
  base.instructions = [...kept, ...entries.filter((entry) => !kept.includes(entry))];
  return base;
}

export function stripInstructions(config, known) {
  const base = clone(config);
  if (!Array.isArray(base.instructions)) return base;
  const rest = base.instructions.filter((existing) => !known.includes(existing));
  if (rest.length === base.instructions.length) return base;
  if (rest.length > 0) base.instructions = rest;
  else delete base.instructions;
  return base;
}
```

- [ ] **Step 4: Update the phase 3b tests for the new signatures**

`tests/rules-wiring.test.js`:

- change `const wiring = { entry: ENTRY, skeleton: { $schema: 'https://opencode.ai/config.json' } };` to `const wiring = { entries: [ENTRY], known: [ENTRY], skeleton: { $schema: 'https://opencode.ai/config.json' } };`
- change every `stripInstructions(<config>, ENTRY)` to `stripInstructions(<config>, [ENTRY])`
- change every `parseInstructions(<text>, J, ENTRY)` to `parseInstructions(<text>, J, [ENTRY])`
- change every `handWired(<text>, ENTRY)` to `handWired(<text>, [ENTRY])`

`tests/rule-review.test.js`: change every `handWired(text, ENTRY)` to `handWired(text, [ENTRY])`.

- [ ] **Step 5: Describe the wanted entries in `src/adapters/opencode.js`**

Replace the `rulesWiring` function and the comment above it with:

```js
const MEMORY_HOOK = 'hook:session-memory';

// OpenCode loads every file its "instructions" list names. Which entries
// forgeflow wants there depends on what is installed: ids is every item the
// target will have after the operation.
export function rulesWiring(scope, ids = []) {
  const rules =
    scope === 'global'
      ? '~/.config/opencode/forgeflow/rules/*.md'
      : '.opencode/forgeflow/rules/*.md';
  // Hooks are per project, so memory is too.
  const memory = scope === 'global' ? [] : ['.forgeflow/memory/*.md', '.forgeflow/local/*.md'];
  const entries = [];
  if (ids.some((id) => id.startsWith('rule:'))) entries.push(rules);
  if (ids.includes(MEMORY_HOOK)) entries.push(...memory);
  return {
    kind: 'json',
    path: 'opencode.json',
    alternative: 'opencode.jsonc',
    entries,
    known: [rules, ...memory],
    skeleton: { $schema: 'https://opencode.ai/config.json' },
  };
}
```

- [ ] **Step 6: Use the set in `src/plan.js`**

Add `foundEntries` to the import from `./rules-wiring.js`.

Replace `takeOut` with:

```js
const takeOut = (entries) =>
  `remove ${entries.map((entry) => JSON.stringify(entry)).join(' and ')} from its "instructions" list`;
```

In `parses`, `wiredByHand` and `rulesState`, replace every `wiring.entry` passed to `parseInstructions` or `handWired` with `wiring.entries`. In `wiredByHand`, replace `add ${JSON.stringify(wiring.entry)} to its "instructions" list` with:

```js
      `second OpenCode config: add ${wiring.entries.map((entry) => JSON.stringify(entry)).join(' and ')} to its "instructions" list ` +
```

Replace `uneditable` with:

```js
// The config forgeflow cannot edit, if that is the state of things: the file
// to name, whether every wanted entry is in it, and which of forgeflow's
// entries it holds at all.
function uneditable(root, wiring, path, current) {
  if (wiring.kind !== 'json') return undefined;
  const describe = (file, text) => ({
    file,
    wired: handWired(text, wiring.entries),
    left: foundEntries(text, wiring.known),
  });
  if (current !== undefined) return parses(wiring, current) ? undefined : describe(path, current);
  const other = readText(root, wiring.alternative);
  return other === undefined ? undefined : describe(wiring.alternative, other);
}
```

Replace `nextRulesText` with:

```js
// The file's next text, and whether nothing but forgeflow's skeleton is left.
function nextRulesText(wiring, current, rules, active) {
  if (wiring.kind === 'block') {
    if (active) {
      return { text: mergeBlock(current, wiring.block(rules), wiring.path), bare: false };
    }
    const text = stripBlock(current, wiring.path);
    return { text, bare: text.replace(/^﻿/, '').trim() === '' };
  }
  const config =
    current === undefined ? undefined : parseInstructions(current, wiring.path, wiring.entries);
  const next = active
    ? mergeInstructions(config, wiring)
    : stripInstructions(config, wiring.known);
  // An unchanged config keeps its text, so the user's formatting survives.
  const text = config !== undefined && same(next, config) ? current : serialize(next);
  return { text, bare: same(next, wiring.skeleton) };
}
```

In `planRulesWiring`:

1. Replace the comment above it with:

```js
// rules is every rule the target will have after the operation: [{ name, applies }].
// The wiring is active while something wants it: a rule for the AGENTS.md
// block, a wanted entry for OpenCode. When it is not active, forgeflow's part
// is taken out again. previous is the lockfile record. removing is true when
// the operation takes items away: a config that cannot be edited then never
// stops it.
```

2. Add as the first line of the function body:

```js
  const active = wiring.kind === 'json' ? wiring.entries.length > 0 : rules.length > 0;
```

3. Change `if (rules.length > 0) {` to `if (active) {`.
4. Change both calls `nextRulesText(wiring, current, rules)` to `nextRulesText(wiring, current, rules, active)`.
5. In the branch for a removal with an uneditable config, replace the `const action = stuck.wired ? … : …;` statement with:

```js
    const action =
      stuck.left.length > 0
        ? row('manual', { path: stuck.file, reason: takeOut(stuck.left) })
        : row('skip', { path: stuck.file });
```

In `rulesState`, replace the last two lines of the `try` block with:

```js
    const config = parseInstructions(current, wiring.path, wiring.entries);
    const list = config.instructions ?? [];
    return wiring.entries.every((entry) => list.includes(entry)) ? 'ok' : 'missing';
```

- [ ] **Step 7: Pass the installed ids in `src/ops.js`**

In `install`, replace the block from `let rules;` to `return { target, root, items, after, rules };` with:

```js
    let rules;
    const ids = [...new Set([...Object.keys(installed), ...entries.map(({ item }) => item.id)])];
    const rulesWiring = adapter.rulesWiring?.(ctx.scope, ids);
    const ruleIds = ids.filter(isRuleId);
    const record = lock.targets[target]?.rules;
    const wanted = rulesWiring?.kind === 'json' ? rulesWiring.entries.length > 0 : ruleIds.length > 0;
    if (rulesWiring && (wanted || record)) {
      const planned = planRulesWiring(root, rulesWiring, describeRules(ctx.catalog, ruleIds), record);
      after.push(planned.action);
      rules = planned.record;
    }
    return { target, root, items, after, rules };
```

In `remove`, replace the block from `let rules;` to `return { target, root, items, before, rules };` with:

```js
    let rules;
    const record = lock.targets[target]?.rules;
    if (record) {
      const staying = Object.keys(installed).filter((id) => !going.has(id));
      const rulesWiring = adapter.rulesWiring?.(ctx.scope, staying);
      rules = null;
      if (rulesWiring) {
        const planned = planRulesWiring(
          root,
          rulesWiring,
          describeRules(ctx.catalog, staying.filter(isRuleId)),
          record,
          { removing: true }
        );
        before.push(planned.action);
        rules = planned.record;
      }
    }
    return { target, root, items, before, rules };
```

In `status`, change the call `adapter.rulesWiring(ctx.scope)` to `adapter.rulesWiring(ctx.scope, Object.keys(items))`.

- [ ] **Step 8: Run the tests, then the suite**

Run: `npx vitest run tests/memory-instructions.test.js tests/rules-wiring.test.js tests/rule-ops.test.js tests/rule-review.test.js tests/rule-cli.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures.

- [ ] **Step 9: Commit**

```bash
npx prettier --write src tests
git add src tests
git commit -m "Derive the OpenCode instructions entries from what is installed"
```

---

### Task 5: The `session-memory` hook

**Files:**
- Create: `catalog/hooks/session-memory/HOOK.md`, `catalog/hooks/session-memory/gate.mjs`
- Modify: `catalog/hooks/secret-guard/gate.mjs`, `tests/hook-content.test.js`
- Test: `tests/session-memory.test.js` (create), `tests/session-memory-e2e.test.js` (create)

**Interfaces:**
- Consumes: the `start` and `compact` events, `ctx.session`, and the `context` and `tell` results (Task 2); the wiring (Task 3); the OpenCode entries (Task 4); `ctx.run` and `ctx.now` from phase 2.
- Produces:
  - `hook:session-memory` with `group: memory` and events `start`, `compact`, `write`, `prompt`.
  - `check(event, ctx)` and `SECRET_PATTERNS` exported from `catalog/hooks/session-memory/gate.mjs`.
  - `PATTERNS` exported from `catalog/hooks/secret-guard/gate.mjs` (it was module-private).
  - Files written under the project: `.forgeflow/local/session.json`, `.forgeflow/local/session.md`, `.forgeflow/local/.gitignore`.

- [ ] **Step 1: Write `tests/session-memory.test.js`**

`tests/session-memory.test.js`:

```js
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATTERNS } from '../catalog/hooks/secret-guard/gate.mjs';
import { SECRET_PATTERNS, check } from '../catalog/hooks/session-memory/gate.mjs';
import { tmpDir, writeTree } from './helpers.js';

const T0 = Date.parse('2026-10-13T09:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ctx = (root, extra = {}) => ({
  root,
  harness: 'claude',
  session: 's-1',
  now: T0,
  run: null,
  runs: [],
  config: {},
  ...extra,
});
const write = (path) => ({ kind: 'write', path, content: 'x' });
const prompt = (text) => ({ kind: 'prompt', text });
const record = (root) => JSON.parse(readFileSync(join(root, '.forgeflow/local/session.json'), 'utf8'));
const readable = (root) => readFileSync(join(root, '.forgeflow/local/session.md'), 'utf8');
const age = (root, path, ms) => {
  const when = new Date(T0 - ms);
  utimesSync(join(root, path), when, when);
};
// Built from pieces so this file never contains a literal credential.
const SAMPLES = [
  ['AKIA', 'ABCDEFGHIJKLMNOP'],
  ['ghp_', 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2'],
  ['xoxb-', '1234567890-abcdefghij'],
  ['sk_live_', 'aB3dE5gH7jK9mN1pQ2'],
  ['sk-ant-', 'aB3dE5gH7jK9mN1pQ2rS4t'],
  ['sk-proj-', 'aB3dE5gH7jK9mN1pQ2rS4tU6'],
  ['-----BEGIN RSA PRIVATE ', 'KEY-----'],
].map((pieces) => pieces.join(''));

describe('recording', () => {
  it('starts a record on the first write and makes the folder ignore itself', () => {
    const root = tmpDir();
    writeTree(root, { '.git/HEAD': 'ref: refs/heads/feature/x\n' });
    expect(check(write('src/a.js'), ctx(root))).toBeUndefined();

    expect(record(root)).toEqual({
      current: {
        id: 's-1',
        harness: 'claude',
        started: '2026-10-13T09:00:00.000Z',
        updated: '2026-10-13T09:00:00.000Z',
        branch: 'feature/x',
        files: ['src/a.js'],
        prompts: [],
      },
      previous: null,
    });
    expect(readFileSync(join(root, '.forgeflow/local/.gitignore'), 'utf8')).toBe('*\n');
  });

  it('adds files once, in order, and moves the last-active time', () => {
    const root = tmpDir();
    check(write('src/a.js'), ctx(root));
    check(write('src/b.js'), ctx(root, { now: T0 + MINUTE }));
    check(write('src/a.js'), ctx(root, { now: T0 + 2 * MINUTE }));
    expect(record(root).current).toMatchObject({
      started: '2026-10-13T09:00:00.000Z',
      updated: '2026-10-13T09:02:00.000Z',
      files: ['src/a.js', 'src/b.js'],
    });
  });

  it('keeps at most 30 files, dropping the oldest', () => {
    const root = tmpDir();
    for (let i = 1; i <= 32; i += 1) check(write(`src/f${i}.js`), ctx(root));
    const { files } = record(root).current;
    expect(files).toHaveLength(30);
    expect(files[0]).toBe('src/f3.js');
    expect(files[29]).toBe('src/f32.js');
  });

  it('skips forgeflow files and paths outside the project', () => {
    const root = tmpDir();
    for (const path of ['.forgeflow/runs/r/state.md', '/etc/hosts', 'C:/Users/x/a.js']) {
      check(write(path), ctx(root));
    }
    expect(existsSync(join(root, '.forgeflow/local/session.json'))).toBe(false);
  });

  it('keeps the last three prompts, on one line, cut to 300 characters', () => {
    const root = tmpDir();
    for (const text of ['one', 'two\n\n  spread over\tlines', 'three', `four ${'x'.repeat(400)}`]) {
      check(prompt(text), ctx(root));
    }
    const { prompts } = record(root).current;
    expect(prompts.slice(0, 2)).toEqual(['two spread over lines', 'three']);
    expect(prompts[2]).toHaveLength(300);
    expect(prompts[2].startsWith('four xxx')).toBe(true);
  });

  it.each(['approve', 'Approved', ' approve. ', '', '   '])('does not record %j', (text) => {
    const root = tmpDir();
    check(prompt(text), ctx(root));
    expect(existsSync(join(root, '.forgeflow/local/session.json'))).toBe(false);
  });

  it.each(SAMPLES)('replaces a credential in a prompt before storing it (%#)', (secret) => {
    const root = tmpDir();
    check(prompt(`use ${secret} for the deploy, then ${secret} again`), ctx(root));
    const text = readFileSync(join(root, '.forgeflow/local/session.json'), 'utf8');
    expect(text).not.toContain(secret);
    expect(record(root).current.prompts).toEqual([
      'use [redacted] for the deploy, then [redacted] again',
    ]);
    expect(readable(root)).not.toContain(secret);
  });

  it('redacts before cutting, so a credential at the limit is not stored in part', () => {
    const root = tmpDir();
    check(prompt(`${'x'.repeat(290)} ${SAMPLES[1]}`), ctx(root));
    expect(record(root).current.prompts[0].endsWith('[redacted]')).toBe(true);
  });

  it('uses the same patterns as secret-guard', () => {
    expect(SECRET_PATTERNS.map((pattern) => pattern.source)).toEqual(
      PATTERNS.map(([, pattern]) => pattern.source)
    );
  });

  it('leaves the branch empty when HEAD is not a plain branch reference', () => {
    const detached = tmpDir();
    writeTree(detached, { '.git/HEAD': '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n' });
    check(write('a.js'), ctx(detached));
    expect(record(detached).current.branch).toBe('');

    const worktree = tmpDir();
    writeTree(worktree, { '.git': 'gitdir: /elsewhere/.git/worktrees/x\n' });
    check(write('a.js'), ctx(worktree));
    expect(record(worktree).current.branch).toBe('');
  });
});

describe('sessions', () => {
  it('starts a new session when the id changes, keeping one previous', () => {
    const root = tmpDir();
    check(write('src/a.js'), ctx(root));
    check(write('src/b.js'), ctx(root, { session: 's-2', harness: 'codex', now: T0 + HOUR }));
    check(write('src/c.js'), ctx(root, { session: 's-3', now: T0 + 2 * HOUR }));

    const { current, previous } = record(root);
    expect(current).toMatchObject({ id: 's-3', files: ['src/c.js'] });
    expect(previous).toMatchObject({ id: 's-2', harness: 'codex', files: ['src/b.js'] });
  });

  it('without an id, starts a new session only after two idle hours', () => {
    const root = tmpDir();
    const anon = (now) => ctx(root, { session: '', now });
    check(write('src/a.js'), anon(T0));
    check(write('src/b.js'), anon(T0 + 2 * HOUR));
    expect(record(root).current.files).toEqual(['src/a.js', 'src/b.js']);

    check(write('src/c.js'), anon(T0 + 4 * HOUR + MINUTE));
    expect(record(root)).toMatchObject({
      current: { files: ['src/c.js'] },
      previous: { files: ['src/a.js', 'src/b.js'] },
    });
  });

  it('does not let an empty session push out the previous one', () => {
    const root = tmpDir();
    check(write('src/a.js'), ctx(root));
    check(write('src/b.js'), ctx(root, { session: 's-2' }));
    writeFileSync(
      join(root, '.forgeflow/local/session.json'),
      JSON.stringify({ ...record(root), current: { ...record(root).current, files: [], prompts: [] } })
    );
    check(write('src/c.js'), ctx(root, { session: 's-3' }));
    expect(record(root).previous).toMatchObject({ id: 's-1', files: ['src/a.js'] });
  });

  it.each([
    ['not JSON', '{ nope'],
    ['empty', ''],
    ['the wrong shape', '{"current":{"files":"x"}}'],
    ['a list', '[]'],
  ])('replaces a record that is %s', (_case, text) => {
    const root = tmpDir();
    writeTree(root, { '.forgeflow/local/session.json': text });
    expect(check(write('src/a.js'), ctx(root))).toBeUndefined();
    expect(record(root)).toMatchObject({ current: { files: ['src/a.js'] }, previous: null });
  });

  it('carries on when the folder cannot be written', () => {
    const root = tmpDir();
    writeTree(root, { '.forgeflow/local': 'a file where the folder should be' });
    expect(check(write('src/a.js'), ctx(root))).toBeUndefined();
    expect(check(prompt('hello'), ctx(root))).toBeUndefined();
  });

  it('writes a readable copy of both sessions', () => {
    const root = tmpDir();
    writeTree(root, { '.git/HEAD': 'ref: refs/heads/main\n' });
    check(write('src/a.js'), ctx(root));
    check(prompt('add a retry'), ctx(root, { now: T0 + 40 * MINUTE }));
    check(write('src/z.js'), ctx(root, { session: 's-2', harness: 'cursor', now: T0 + DAY }));

    expect(readable(root)).toBe(
      [
        '# Recent activity',
        '',
        '## This session',
        'Started 2026-10-14 09:00 UTC, last active 2026-10-14 09:00 UTC, in cursor, on branch main.',
        '',
        'Files changed:',
        '- src/z.js',
        '',
        '## Previous session',
        'Started 2026-10-13 09:00 UTC, last active 2026-10-13 09:40 UTC, in claude, on branch main.',
        '',
        'Files changed:',
        '- src/a.js',
        '',
        'Prompts:',
        '- add a retry',
        '',
      ].join('\n')
    );
  });
});

const LESSONS =
  '# Project lessons\n\nOne line per lesson.\n\n- (2026-10-01) Run tests with npm test.\n';
const start = (source = 'startup') => ({ kind: 'start', source });
const block = (root, extra, source) => check(start(source), ctx(root, extra))?.context;

describe('the memory block', () => {
  it('is nothing when the project has no memory', () => {
    expect(check(start(), ctx(tmpDir()))).toBeUndefined();
  });

  it('holds the lessons without their title line', () => {
    const root = tmpDir();
    writeTree(root, { '.forgeflow/memory/lessons.md': LESSONS });
    expect(block(root)).toBe(
      '# forgeflow memory\n\n## Project lessons\nOne line per lesson.\n\n- (2026-10-01) Run tests with npm test.'
    );
  });

  it('adds a recent handoff note with the time it was written', () => {
    const root = tmpDir();
    writeTree(root, { '.forgeflow/local/handoff.md': '## Done\n- the retry\n' });
    age(root, '.forgeflow/local/handoff.md', 2 * DAY);
    expect(block(root)).toBe(
      '# forgeflow memory\n\n## Handoff note (written 2026-10-11 09:00 UTC)\n## Done\n- the retry'
    );
  });

  it('leaves out a handoff note and a session older than seven days', () => {
    const root = tmpDir();
    writeTree(root, { '.forgeflow/local/handoff.md': 'old note\n' });
    age(root, '.forgeflow/local/handoff.md', 8 * DAY);
    check(write('src/a.js'), ctx(root, { now: T0 - 8 * DAY }));
    expect(check(start(), ctx(root, { session: 's-2' }))).toBeUndefined();
  });

  it('shows the last session to a new one, and the current session after compaction', () => {
    const root = tmpDir();
    check(write('src/old.js'), ctx(root, { now: T0 - DAY }));
    check(prompt('fix the parser'), ctx(root, { now: T0 - DAY }));

    const fresh = block(root, { session: 's-2' });
    expect(fresh).toContain('## Recent activity (last session)\nStarted 2026-10-12 09:00 UTC');
    expect(fresh).toContain('- src/old.js');
    expect(fresh).toContain('- fix the parser');

    check(write('src/new.js'), ctx(root, { session: 's-2' }));
    const again = block(root, { session: 's-2' });
    expect(again).toContain('(last session)');
    expect(again).toContain('- src/old.js');
    expect(again).not.toContain('src/new.js');

    const compacted = block(root, { session: 's-2' }, 'compact');
    expect(compacted).toContain('## Recent activity (this session so far)');
    expect(compacted).toContain('- src/new.js');
    expect(compacted).not.toContain('src/old.js');
  });

  it('names a flow run in progress', () => {
    const run = { name: '20261013-0900-add-login', stage: 'BUILD', status: 'running' };
    expect(block(tmpDir(), { run })).toBe(
      '# forgeflow memory\n\n## Flow run in progress\n20261013-0900-add-login: stage BUILD, status running. ' +
        'Its files are in .forgeflow/runs/20261013-0900-add-login.'
    );
  });

  it('cuts a long section at a line end and says where the rest is', () => {
    const root = tmpDir();
    const many = Array.from({ length: 200 }, (_, i) => `- (2026-10-01) lesson number ${i}`).join('\n');
    writeTree(root, { '.forgeflow/memory/lessons.md': `# Project lessons\n\n${many}\n` });
    const text = block(root);
    expect(text.length).toBeLessThan(3200);
    expect(text.endsWith('\n(cut: read .forgeflow/memory/lessons.md for the rest)')).toBe(true);
    expect(text).toMatch(/- \(2026-10-01\) lesson number \d+\n\(cut:/);
  });

  it('puts the sections in a fixed order', () => {
    const root = tmpDir();
    writeTree(root, {
      '.forgeflow/memory/lessons.md': LESSONS,
      '.forgeflow/local/handoff.md': 'note\n',
    });
    age(root, '.forgeflow/local/handoff.md', HOUR);
    check(write('src/a.js'), ctx(root, { now: T0 - HOUR }));
    const run = { name: 'r', stage: '', status: 'waiting for user' };
    const text = block(root, { session: 's-2', run });
    const at = ['## Project lessons', '## Handoff note', '## Recent activity', '## Flow run'].map(
      (heading) => text.indexOf(heading)
    );
    expect(at.every((index) => index > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(text).toContain('r: stage unknown, status waiting for user.');
  });
});

describe('compaction', () => {
  it('tells a Cursor user how to get the agent back on track', () => {
    const result = check({ kind: 'compact' }, ctx(tmpDir(), { harness: 'cursor' }));
    expect(result.tell).toContain('.forgeflow/local/session.md');
    expect(result.tell).toContain('.forgeflow/local/handoff.md');
    expect(result.context).toBeUndefined();
  });

  it('gives OpenCode the current session for its compaction prompt', () => {
    const root = tmpDir();
    const open = (extra) => ctx(root, { harness: 'opencode', ...extra });
    expect(check({ kind: 'compact' }, open())).toBeUndefined();
    check(write('src/a.js'), open());
    const { context } = check({ kind: 'compact' }, open());
    expect(context).toContain('## Recent activity (this session so far)');
    expect(context).toContain('- src/a.js');
  });

  it('does nothing on Claude Code and Codex, which restore at the next session start', () => {
    const root = tmpDir();
    mkdirSync(join(root, 'src'), { recursive: true });
    for (const harness of ['claude', 'codex']) {
      expect(check({ kind: 'compact' }, ctx(root, { harness }))).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/session-memory.test.js`
Expected: FAIL, the file errors with `Cannot find module '../catalog/hooks/session-memory/gate.mjs'`.

- [ ] **Step 3: Export the patterns from `catalog/hooks/secret-guard/gate.mjs`**

Change `const PATTERNS = [` to:

```js
// Exported so session-memory's copy can be checked against it.
export const PATTERNS = [
```

- [ ] **Step 4: Write `catalog/hooks/session-memory/HOOK.md`**

`catalog/hooks/session-memory/HOOK.md`:

```markdown
---
name: session-memory
description: Keeps a local record of what each session changed and was asked, and gives a new or compacted session the project's lessons, handoff note and last activity. It never blocks.
events: [start, compact, write, prompt]
group: memory
---
As the agent works, this records the files it writes and your last three prompts in `.forgeflow/local/session.json` and a readable copy, `session.md`. That folder ignores itself, so nothing in it is committed. Credentials in a prompt are replaced with `[redacted]` before it is stored.

When a session starts, it adds one block to the model's context: the shared lessons in `.forgeflow/memory/lessons.md`, the handoff note if it is less than a week old, what the last session did, and any flow run in progress. On Claude Code and Codex the block is added again after a compaction, with what the current session has done so far.

Cursor cannot add context after a compaction, so there it tells you which files to point the agent at. OpenCode has no session-start hook: the memory files are listed in `opencode.json` instead, and the record is added to the compaction prompt.

Install it with the two commands that write the handoff note and the lessons: `forgeflow add --memory --target <harness>`.
```

- [ ] **Step 5: Write `catalog/hooks/session-memory/gate.mjs`**

`catalog/hooks/session-memory/gate.mjs`:

```js
// forgeflow session-memory: keeps a record of what a session changed and was
// asked, and gives a new or compacted session the project's memory. It only
// records and informs; it never blocks.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The patterns secret-guard blocks on. A gate may import nothing from another
// gate, so the list is repeated here; a test keeps the two identical.
export const SECRET_PATTERNS = [
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\b[sr]k_live_[A-Za-z0-9]{16,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
];

const HOUR = 60 * 60 * 1000;
const IDLE = 2 * HOUR;
const STALE = 7 * 24 * HOUR;
const MAX_FILES = 30;
const MAX_PROMPTS = 3;
const PROMPT_CHARS = 300;
const LIMITS = { lessons: 3000, handoff: 1500, activity: 1200 };

const LOCAL = '.forgeflow/local';
const LESSONS = '.forgeflow/memory/lessons.md';
const HANDOFF = `${LOCAL}/handoff.md`;
const RECORD = `${LOCAL}/session.json`;
const READABLE = `${LOCAL}/session.md`;
// An approval is the approval gate's business and says nothing about the work.
const APPROVAL = /^approved?[\s.!]*$/i;
const CURSOR_TELL =
  'forgeflow: this conversation is being compacted. If the agent loses its place, ' +
  `ask it to read ${READABLE} and ${HANDOFF}.`;

const stamp = (iso) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function redact(text) {
  return SECRET_PATTERNS.reduce(
    (out, pattern) => out.replace(new RegExp(pattern.source, 'g'), '[redacted]'),
    text
  );
}

// Redacted first, so a credential at the cut is never stored in part.
const tidy = (text) => redact(text).replace(/\s+/g, ' ').trim().slice(0, PROMPT_CHARS);

const isSession = (value) =>
  typeof value === 'object' &&
  value !== null &&
  typeof value.started === 'string' &&
  typeof value.updated === 'string' &&
  Array.isArray(value.files) &&
  Array.isArray(value.prompts);

function readRecord(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, RECORD), 'utf8'));
    if (isSession(raw?.current)) {
      return { current: raw.current, previous: isSession(raw.previous) ? raw.previous : null };
    }
  } catch {
    // a missing or damaged record is replaced
  }
  return { current: null, previous: null };
}

function branchOf(root) {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
    return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? '';
  } catch {
    return ''; // no repository, or a worktree
  }
}

// The record with a current session that this event belongs to. A new session
// begins when the harness's session id changes, or, when it sends none, after
// two idle hours.
function touch({ current, previous }, ctx) {
  const now = new Date(ctx.now).toISOString();
  const same =
    current !== null &&
    (ctx.session ? current.id === ctx.session : ctx.now - Date.parse(current.updated) <= IDLE);
  if (same) {
    const next = { ...current, harness: ctx.harness, updated: now, branch: branchOf(ctx.root) };
    return { current: next, previous };
  }
  const fresh = {
    id: ctx.session,
    harness: ctx.harness,
    started: now,
    updated: now,
    branch: branchOf(ctx.root),
    files: [],
    prompts: [],
  };
  // A session that did nothing is not worth remembering in place of one that did.
  const worked = current !== null && (current.files.length > 0 || current.prompts.length > 0);
  return { current: fresh, previous: worked ? current : previous };
}

function lines(session) {
  const where = session.branch ? `, on branch ${session.branch}` : '';
  const out = [
    `Started ${stamp(session.started)}, last active ${stamp(session.updated)}, ` +
      `in ${session.harness || 'an unknown harness'}${where}.`,
  ];
  if (session.files.length > 0) out.push('', 'Files changed:', ...session.files.map((f) => `- ${f}`));
  if (session.prompts.length > 0) out.push('', 'Prompts:', ...session.prompts.map((p) => `- ${p}`));
  return out.join('\n');
}

function readable({ current, previous }) {
  const parts = ['# Recent activity'];
  if (current) parts.push(`## This session\n${lines(current)}`);
  if (previous) parts.push(`## Previous session\n${lines(previous)}`);
  return `${parts.join('\n\n')}\n`;
}

function save(root, record) {
  try {
    mkdirSync(join(root, LOCAL), { recursive: true });
    // The folder ignores itself, so the project's own .gitignore is never edited.
    const ignore = join(root, LOCAL, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
    // Written whole and renamed: two tool calls at once must not leave half a file.
    const tmp = join(root, `${RECORD}.tmp-${process.pid}`);
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, join(root, RECORD));
    writeFileSync(join(root, READABLE), readable(record));
  } catch {
    // recording is best effort and must never stop the agent
  }
}

function readText(root, path) {
  try {
    const text = readFileSync(join(root, path), 'utf8').trim();
    return text ? { text, modified: statSync(join(root, path)).mtimeMs } : null;
  } catch {
    return null;
  }
}

function clip(text, limit, path) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const end = cut.lastIndexOf('\n');
  return `${end > 0 ? cut.slice(0, end) : cut}\n(cut: read ${path} for the rest)`;
}

const activity = (title, session) =>
  `## Recent activity (${title})\n${clip(lines(session), LIMITS.activity, READABLE)}`;

function memoryBlock(ctx, source) {
  const { root, now } = ctx;
  const parts = [];

  const lessons = readText(root, LESSONS);
  if (lessons) {
    const body = lessons.text.replace(/^# .*\n+/, '');
    if (body) parts.push(`## Project lessons\n${clip(body, LIMITS.lessons, LESSONS)}`);
  }

  const handoff = readText(root, HANDOFF);
  if (handoff && now - handoff.modified <= STALE) {
    const written = stamp(new Date(handoff.modified).toISOString());
    parts.push(`## Handoff note (written ${written})\n${clip(handoff.text, LIMITS.handoff, HANDOFF)}`);
  }

  const { current, previous } = readRecord(root);
  const compacted = source === 'compact';
  // To a new session the record's current session is the last one, unless
  // this session has already written to it.
  const mine = current !== null && ctx.session !== '' && current.id === ctx.session;
  const shown = compacted || !mine ? current : previous;
  const worked = shown && (shown.files.length > 0 || shown.prompts.length > 0);
  if (worked && now - Date.parse(shown.updated) <= STALE) {
    parts.push(activity(compacted ? 'this session so far' : 'last session', shown));
  }

  if (ctx.run) {
    const { name, stage, status } = ctx.run;
    parts.push(
      `## Flow run in progress\n${name}: stage ${stage || 'unknown'}, status ${status}. ` +
        `Its files are in .forgeflow/runs/${name}.`
    );
  }
  return parts.length > 0 ? `# forgeflow memory\n\n${parts.join('\n\n')}` : '';
}

const outside = (path) =>
  path.startsWith('.forgeflow/') || path.startsWith('/') || /^[A-Za-z]:/.test(path);

export function check(event, ctx) {
  if (event.kind === 'write') {
    if (outside(event.path)) return undefined;
    const record = touch(readRecord(ctx.root), ctx);
    const { files } = record.current;
    if (!files.includes(event.path)) {
      record.current.files = [...files, event.path].slice(-MAX_FILES);
    }
    save(ctx.root, record);
    return undefined;
  }

  if (event.kind === 'prompt') {
    const text = tidy(event.text);
    if (!text || APPROVAL.test(text)) return undefined;
    const record = touch(readRecord(ctx.root), ctx);
    record.current.prompts = [...record.current.prompts, text].slice(-MAX_PROMPTS);
    save(ctx.root, record);
    return undefined;
  }

  if (event.kind === 'start') {
    const block = memoryBlock(ctx, event.source);
    return block ? { context: block } : undefined;
  }

  if (event.kind === 'compact') {
    // Claude Code and Codex get the block again at the session start that
    // follows compaction. These two cannot do that.
    if (ctx.harness === 'cursor') return { tell: CURSOR_TELL };
    if (ctx.harness === 'opencode') {
      const { current } = readRecord(ctx.root);
      return current ? { context: activity('this session so far', current) } : undefined;
    }
  }
  return undefined;
}
```

- [ ] **Step 6: Update the gate count in `tests/hook-content.test.js`**

Replace the test `ships exactly four gates and one runtime` with:

```js
  it('ships exactly four gates, one memory hook and one runtime', () => {
    const hooks = [...catalog.values()].filter((item) => item.type === 'hook');
    expect(hooks.filter((hook) => hook.group === undefined)).toHaveLength(4);
    expect(hooks.filter((hook) => hook.group === 'memory').map((hook) => hook.name)).toEqual([
      'session-memory',
    ]);
    const types = [...catalog.values()].map((item) => item.type);
    expect(types.filter((type) => type === 'runtime')).toHaveLength(1);
  });

  it('session-memory handles the session events and imports only node built-ins', () => {
    const hook = catalog.get('hook:session-memory');
    expect(hook.events).toEqual(['start', 'compact', 'write', 'prompt']);
    expect(hook.requires).toEqual(['runtime:hooks']);
    expect(hook.gate).toContain('export function check(event, ctx)');
    const imports = [...hook.gate.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.every((specifier) => specifier.startsWith('node:'))).toBe(true);
  });
```

- [ ] **Step 7: Run the unit tests**

Run: `npx vitest run tests/session-memory.test.js tests/hook-content.test.js`
Expected: PASS, no failures.

- [ ] **Step 8: Write `tests/session-memory-e2e.test.js`**

`tests/session-memory-e2e.test.js`:

```js
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { add, remove } from '../src/ops.js';
import { tmpDir, writeTree } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const DIRS = { claude: '.claude', codex: '.codex', cursor: '.cursor' };
const TOKEN = ['ghp_', 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2'].join('');
const LESSONS = '# Project lessons\n\n- (2026-10-01) Run tests with npm test.\n';

function project(targets, items = ['session-memory']) {
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
  add(ctx, items, targets);
  return cwd;
}

function fire(cwd, harness, payload) {
  const runner = join(cwd, DIRS[harness], 'forgeflow/run.mjs');
  const result = spawnSync(process.execPath, [runner, harness], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const record = (cwd) =>
  JSON.parse(readFileSync(join(cwd, '.forgeflow/local/session.json'), 'utf8'));
const writeTool = (cwd, session, path) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: join(cwd, path), content: 'x' },
  cwd,
  session_id: session,
});
const QUIET = { code: 0, out: '', err: '' };

describe.each(['claude', 'codex'])('installed runner on %s', (harness) => {
  it('records writes and prompts without a word, and redacts a credential', () => {
    const cwd = project([harness]);
    expect(fire(cwd, harness, writeTool(cwd, 's-1', 'src/a.js'))).toEqual(QUIET);
    expect(
      fire(cwd, harness, {
        hook_event_name: 'UserPromptSubmit',
        prompt: `deploy with ${TOKEN}`,
        session_id: 's-1',
      })
    ).toEqual(QUIET);

    expect(record(cwd).current).toMatchObject({
      id: 's-1',
      harness,
      files: ['src/a.js'],
      prompts: ['deploy with [redacted]'],
    });
    expect(readFileSync(join(cwd, '.forgeflow/local/.gitignore'), 'utf8')).toBe('*\n');
    expect(readFileSync(join(cwd, '.forgeflow/local/session.md'), 'utf8')).toContain('- src/a.js');
  });

  it('gives a new session the lessons and the last session, and a resumed one nothing', () => {
    const cwd = project([harness]);
    writeTree(cwd, { '.forgeflow/memory/lessons.md': LESSONS });
    fire(cwd, harness, writeTool(cwd, 's-1', 'src/a.js'));

    const started = fire(cwd, harness, {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 's-2',
    });
    expect(started.code).toBe(0);
    const { hookSpecificOutput } = JSON.parse(started.out);
    expect(hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(hookSpecificOutput.additionalContext).toContain('# forgeflow memory');
    expect(hookSpecificOutput.additionalContext).toContain('Run tests with npm test.');
    expect(hookSpecificOutput.additionalContext).toContain('## Recent activity (last session)');
    expect(hookSpecificOutput.additionalContext).toContain('- src/a.js');

    expect(
      fire(cwd, harness, { hook_event_name: 'SessionStart', source: 'resume', session_id: 's-2' })
    ).toEqual(QUIET);
  });

  it('gives the session its own activity back after compaction', () => {
    const cwd = project([harness]);
    fire(cwd, harness, writeTool(cwd, 's-1', 'src/a.js'));
    const { out } = fire(cwd, harness, {
      hook_event_name: 'SessionStart',
      source: 'compact',
      session_id: 's-1',
    });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain(
      '## Recent activity (this session so far)'
    );
  });

  it('says nothing to a new session in a project with no memory yet', () => {
    const cwd = project([harness]);
    expect(
      fire(cwd, harness, { hook_event_name: 'SessionStart', source: 'startup', session_id: 's-1' })
    ).toEqual(QUIET);
  });

  it('never fails a tool call when the record cannot be written or is damaged', () => {
    const blocked = project([harness]);
    writeTree(blocked, { '.forgeflow/local': 'not a folder' });
    expect(fire(blocked, harness, writeTool(blocked, 's-1', 'src/a.js'))).toEqual(QUIET);

    const damaged = project([harness]);
    writeTree(damaged, { '.forgeflow/local/session.json': '{ half' });
    expect(fire(damaged, harness, writeTool(damaged, 's-1', 'src/a.js'))).toEqual(QUIET);
    expect(record(damaged).current.files).toEqual(['src/a.js']);
  });
});

describe('installed runner on Cursor', () => {
  it('adds the memory at session start in its own field', () => {
    const cwd = project(['cursor']);
    writeTree(cwd, { '.forgeflow/memory/lessons.md': LESSONS });
    const { code, out } = fire(cwd, 'cursor', {
      hook_event_name: 'sessionStart',
      session_id: 'c-1',
    });
    expect(code).toBe(0);
    expect(JSON.parse(out).additional_context).toContain('Run tests with npm test.');
  });

  it('records under the conversation id and tells the person on compaction', () => {
    const cwd = project(['cursor']);
    fire(cwd, 'cursor', {
      hook_event_name: 'preToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(cwd, 'src/a.js'), content: 'x' },
      conversation_id: 'c-1',
    });
    expect(record(cwd).current).toMatchObject({ id: 'c-1', harness: 'cursor', files: ['src/a.js'] });

    const { out } = fire(cwd, 'cursor', { hook_event_name: 'preCompact', trigger: 'auto' });
    expect(JSON.parse(out).user_message).toContain('.forgeflow/local/session.md');
  });
});

describe('OpenCode', () => {
  it('lists the memory files in opencode.json and adds the record to the compaction prompt', async () => {
    const cwd = project(['opencode']);
    expect(JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8')).instructions).toEqual([
      '.forgeflow/memory/*.md',
      '.forgeflow/local/*.md',
    ]);

    const url = pathToFileURL(join(cwd, '.opencode/plugins/forgeflow.js')).href;
    const hooks = await (await import(url)).ForgeflowGates({ directory: cwd });
    await hooks['tool.execute.before'](
      { tool: 'write', sessionID: 'o-1' },
      { args: { filePath: join(cwd, 'src/a.js'), content: 'x' } }
    );
    await hooks['chat.message']({ sessionID: 'o-1' }, { parts: [{ type: 'text', text: 'add a test' }] });
    expect(record(cwd).current).toMatchObject({
      id: 'o-1',
      harness: 'opencode',
      files: ['src/a.js'],
      prompts: ['add a test'],
    });

    const output = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 'o-1' }, output);
    expect(output.context).toHaveLength(1);
    expect(output.context[0]).toContain('- src/a.js');
  });
});

describe('beside the gates', () => {
  it('does not weaken a gate: a blocked write is still blocked, and not recorded', () => {
    const cwd = project(['claude'], ['session-memory', 'protected-paths']);
    const blocked = fire(cwd, 'claude', writeTool(cwd, 's-1', '.env'));
    expect(blocked.code).toBe(2);
    expect(existsSync(join(cwd, '.forgeflow/local/session.json'))).toBe(false);
  });

  it('leaves the memory files in place when it is removed', () => {
    const cwd = project(['claude']);
    writeTree(cwd, { '.forgeflow/memory/lessons.md': LESSONS });
    fire(cwd, 'claude', writeTool(cwd, 's-1', 'src/a.js'));

    const ctx = { catalog, version: '0.1.0', scope: 'project', cwd, home: tmpDir(), force: false };
    remove({ ...ctx, dryRun: false }, ['session-memory'], ['claude']);

    expect(existsSync(join(cwd, '.claude'))).toBe(false);
    expect(readFileSync(join(cwd, '.forgeflow/memory/lessons.md'), 'utf8')).toBe(LESSONS);
    expect(record(cwd).current.files).toEqual(['src/a.js']);
  });
});
```

- [ ] **Step 9: Run the end-to-end tests, then the suite**

Run: `npx vitest run tests/session-memory-e2e.test.js`
Expected: PASS, no failures. If "a blocked write is … not recorded" fails because `session-memory` runs before `protected-paths` (gates run in file-name order, and `protected-paths` sorts first, so it should pass), do not reorder gates: report it as a finding.

Run: `npx vitest run`
Expected: PASS, no failures.

Run: `npm run lint`
Expected: exit 0, no warnings.

- [ ] **Step 10: Commit**

```bash
npx prettier --write catalog/hooks tests
git add catalog tests
git commit -m "Add the session-memory hook"
```

---

### Task 6: The `forge-lesson` and `forge-handoff` skills

**Files:**
- Create: `catalog/skills/forge-lesson/SKILL.md`, `catalog/skills/forge-handoff/SKILL.md`
- Test: `tests/memory-content.test.js` (create)

**Interfaces:**
- Consumes: `group` (Task 1), `--memory` (Task 1), the hook (Task 5), the OpenCode entries (Task 4).
- Produces: `skill:forge-lesson` and `skill:forge-handoff`, both with `group: memory` and not user-invocable-only. The agent writes `.forgeflow/memory/lessons.md` and `.forgeflow/local/handoff.md` by following them.

- [ ] **Step 1: Write `tests/memory-content.test.js`**

`tests/memory-content.test.js`:

```js
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { capture, tmpDir } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const body = (name) => catalog.get(`skill:${name}`).body;
const HARNESS_TOOL =
  /`(Edit|Write|Read|Grep|Glob|Bash|Task|MultiEdit|TodoWrite|apply_patch|str_replace)`|\b(apply_patch|MultiEdit|TodoWrite|str_replace)\b/;

describe('the memory group', () => {
  it('is the hook and the two skills', () => {
    const group = [...catalog.values()].filter((item) => item.group === 'memory');
    expect(group.map((item) => item.id).sort()).toEqual([
      'hook:session-memory',
      'skill:forge-handoff',
      'skill:forge-lesson',
    ]);
  });

  it.each(['forge-lesson', 'forge-handoff'])('%s may be followed without being asked', (name) => {
    const skill = catalog.get(`skill:${name}`);
    expect(skill.userInvocableOnly).toBe(false);
    expect(skill.requires).toEqual([]);
    expect(skill.description).toMatch(/\bUse when\b/);
    expect(skill.body).not.toMatch(HARNESS_TOOL);
  });
});

describe('forge-lesson', () => {
  it.each([
    '`.forgeflow/memory/lessons.md`',
    '# Project lessons',
    'When the user corrects you about this project',
    '- (YYYY-MM-DD)',
    'At most 200 characters',
    'will still be true next month',
    'not a secret',
    'replace that line',
    'more than 50 lessons',
    'Tell the user the exact line',
  ])('says: %s', (phrase) => {
    expect(body('forge-lesson')).toContain(phrase);
  });
});

describe('forge-handoff', () => {
  it.each([
    '`.forgeflow/local/handoff.md`',
    '`.forgeflow/local/.gitignore`',
    'the single line `*`',
    'at most 40 lines',
    '## Done',
    '## In progress',
    '## Next',
    '## Decisions',
    '## Open questions',
    'not what was intended',
    'Replace the whole note',
    'No secrets',
  ])('says: %s', (phrase) => {
    expect(body('forge-handoff')).toContain(phrase);
  });
});

describe('installing memory from the real catalog', () => {
  const io = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture() };
  const code = main(['add', '--memory', '--target', 'claude,codex,opencode,cursor'], io);
  const has = (path) => existsSync(join(io.cwd, path));
  const json = (path) => JSON.parse(readFileSync(join(io.cwd, path), 'utf8'));

  it('installs the hook and both skills for every harness', () => {
    expect(io.stderr.text).toBe('');
    expect(code).toBe(0);
    for (const dir of ['.claude', '.codex', '.cursor', '.opencode']) {
      expect(has(`${dir}/forgeflow/gates/session-memory.mjs`), dir).toBe(true);
    }
    for (const dir of ['.claude/skills', '.agents/skills', '.cursor/skills', '.opencode/skills']) {
      expect(readdirSync(join(io.cwd, dir)).sort(), dir).toEqual(['forge-handoff', 'forge-lesson']);
    }
  });

  it('wires the session events and the OpenCode entries', () => {
    expect(json('.claude/settings.json').hooks.SessionStart).toHaveLength(1);
    expect(json('.codex/hooks.json').hooks.SessionStart).toHaveLength(1);
    expect(Object.keys(json('.cursor/hooks.json').hooks)).toContain('sessionStart');
    expect(json('opencode.json').instructions).toEqual([
      '.forgeflow/memory/*.md',
      '.forgeflow/local/*.md',
    ]);
    expect(has('AGENTS.md')).toBe(false);
  });

  it('is not part of --hooks', () => {
    const other = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture() };
    expect(main(['add', '--hooks', '--target', 'claude'], other)).toBe(0);
    expect(readdirSync(join(other.cwd, '.claude/forgeflow/gates')).sort()).toEqual([
      'approval-gate.mjs',
      'protected-paths.mjs',
      'secret-guard.mjs',
      'test-reminder.mjs',
    ]);
  });

  it('removes cleanly and leaves no forgeflow file behind', () => {
    const removal = { ...io, stdout: capture(), stderr: capture() };
    const ids = ['session-memory', 'forge-handoff', 'forge-lesson'];
    expect(main(['remove', ...ids, '--target', 'claude,codex,opencode,cursor'], removal)).toBe(0);
    for (const path of ['.claude', '.codex', '.cursor', '.opencode', '.agents', 'opencode.json']) {
      expect(has(path), path).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/memory-content.test.js`
Expected: FAIL. The memory group holds only the hook, both skills are `undefined`, and the install lacks the skill folders.

- [ ] **Step 3: Write `catalog/skills/forge-lesson/SKILL.md`**

`catalog/skills/forge-lesson/SKILL.md`:

````markdown
---
name: forge-lesson
description: Add one durable fact about this project to the shared lessons file. Use when the user corrects you about the project, when you find something a later session will need to know, or when the user asks you to remember something about the project.
group: memory
---
# forgeflow: record a lesson

A lesson is one fact about this project that a later session, or a teammate's session, needs and could not easily work out again. Lessons live in `.forgeflow/memory/lessons.md`. That file is committed and is given to every new session.

## Is it a lesson?

Record it only if every one of these is true:

- It is about this project, not general knowledge about a language or a tool.
- It will still be true next month. The state of a task, a branch or a bug in progress is not a lesson.
- It is not a secret, a credential or personal data.
- It is not one person's preference, unless the user says the team works that way.
- It is not already in the file, in the project's documentation or in its coding standards.

If it fails any of these, do not record it. If the user asked you to, tell them which one it failed.

## Steps

1. Read `.forgeflow/memory/lessons.md`. If it does not exist, create it with exactly this header:

   ```
   # Project lessons

   One line per lesson: a fact about this project that a later session needs.
   When the user corrects you about this project, or you find such a fact, add
   a line here and tell the user. Keep it to durable facts, not task status.
   ```

2. If an existing lesson says the opposite of the new one, or the same thing less well, replace that line instead of adding another.
3. Otherwise add one line at the end, in this form: `- (YYYY-MM-DD) The fact, in one sentence.` Use today's date. At most 200 characters. Say what to do, and why when the reason is not obvious.
4. If the file now has more than 50 lessons, merge duplicates and remove lessons that are no longer true. Check a lesson against the code before you remove it.
5. Tell the user the exact line you added or changed, and any line you removed.

## Limits

- One lesson per fact. Do not turn a session's notes into a batch of lessons.
- Change another lesson only to merge or correct it as the steps describe.
- Never copy anything from a secrets file, an environment file or a credential into the lessons.
````

- [ ] **Step 4: Write `catalog/skills/forge-handoff/SKILL.md`**

`catalog/skills/forge-handoff/SKILL.md`:

````markdown
---
name: forge-handoff
description: Write a handoff note for the next session - what is done, what is in progress and what comes next. Use when the user asks for a handoff, before stopping work that is unfinished, or when told the conversation is being compacted.
group: memory
---
# forgeflow: write a handoff note

The note is for whoever continues this work in a new session that has none of this conversation. It is saved as `.forgeflow/local/handoff.md`, which is not committed, and is given to the next session if it is less than a week old.

## Steps

1. If `.forgeflow/local/.gitignore` does not exist, create it containing the single line `*`.
2. Establish what actually happened. Look at the files changed in this session with the project's version control, at the tests that were run and their results, and at what the user decided.
3. Replace `.forgeflow/local/handoff.md` with a note of at most 40 lines, under the headings below. Leave out a heading that has nothing under it.
4. Tell the user the note is saved, and repeat its "Next" section in a line or two.

## The note

```
## Done
## In progress
## Next
## Decisions
## Open questions
```

- **Done**: what is finished, and how it was verified. If it was not verified, say so.
- **In progress**: what was started and not finished: the exact file, what is missing, and whether the tests pass right now.
- **Next**: the next steps in order. Make the first one specific enough to start on without asking.
- **Decisions**: choices that were made and why, above all the user's, and anything that was tried and did not work.
- **Open questions**: what the user still has to decide.

## Rules

- State what was done or decided, not what was intended. If something was not run, say it was not run.
- Name files, commands and branches exactly.
- No secrets, tokens or personal data.
- Replace the whole note. Do not append to the old one.
- A durable fact about the project belongs in `.forgeflow/memory/lessons.md`, not here.
````

- [ ] **Step 5: Run the tests, then the suite**

Run: `npx vitest run tests/memory-content.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures.

Run: `node bin/forgeflow.js doctor`
Expected: a line reading `catalog is valid (42 items)`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write tests
git add catalog tests
git commit -m "Add the forge-lesson and forge-handoff skills"
```

---

### Task 7: Documentation and manual checks

**Files:**
- Modify: `README.md`, `docs/verification.md`
- Test: `tests/memory-docs.test.js` (create)

**Interfaces:**
- Consumes: the real catalog.
- Produces: user documentation. No code changes.

- [ ] **Step 1: Write `tests/memory-docs.test.js`**

`tests/memory-docs.test.js`:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

describe('README', () => {
  const readme = read('README.md');

  it('explains session memory, how to install it and what it stores', () => {
    for (const phrase of [
      '## Session memory',
      'forgeflow add --memory --target',
      '`session-memory`',
      '`forge-handoff`',
      '`forge-lesson`',
      '.forgeflow/memory/lessons.md',
      '.forgeflow/local/session.md',
      '.forgeflow/local/handoff.md',
    ]) {
      expect(readme, phrase).toContain(phrase);
    }
  });

  it('states the limits a user needs before relying on it', () => {
    for (const phrase of [
      'last three prompts',
      '[redacted]',
      'Cursor cannot',
      'forgeflow update',
      'never deletes',
      'per project',
    ]) {
      expect(readme, phrase).toContain(phrase);
    }
  });

  it('says --hooks means the quality gates only', () => {
    expect(readme).toContain('`--hooks` installs the four quality gates');
  });
});

describe('verification checklist', () => {
  const checks = read('docs/verification.md');

  it('keeps the earlier checks and adds the memory ones', () => {
    for (const number of [1, 24, 31, 40, 41, 50]) {
      expect(checks, `check ${number}`).toMatch(new RegExp(`^\\| ${number} \\|`, 'm'));
    }
    expect(checks).toContain('## Session memory');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/memory-docs.test.js`
Expected: FAIL. The README has no "Session memory" section and the checklist stops at check 40.

- [ ] **Step 3: Edit `README.md`**

1. In the code block under "## Use", add after the `forgeflow add common typescript …` line:

```
forgeflow add --memory --target claude           # session memory
```

2. Insert this section immediately before the line `## Quality gates`:

````markdown
## Session memory

A new session starts cold, and a long one forgets its plan when the harness compacts it. Session memory gives the project three small files that the harness loads by itself.

```bash
forgeflow add --memory --target claude,codex
```

That installs one hook and two commands:

| Item | Does |
| --- | --- |
| `session-memory` | Records what each session changes and is asked, and gives a new or compacted session the project's memory |
| `forge-lesson` | Has the agent add one durable project fact to the lessons file. The agent also does this on its own when you correct it, and tells you |
| `forge-handoff` | Has the agent write a note for the next session: done, in progress, next, decisions, open questions |

| File | Written by | Committed | Holds |
| --- | --- | --- | --- |
| `.forgeflow/memory/lessons.md` | the agent | yes | One line per lesson, shared with your team |
| `.forgeflow/local/session.md` | the hook | no | When the last two sessions ran, their branch, the files they changed and your last three prompts in each |
| `.forgeflow/local/handoff.md` | the agent, when you run `forge-handoff` | no | The handoff note |

`.forgeflow/local/` ignores itself with its own `.gitignore`, so nothing in it is committed and your `.gitignore` is not edited. forgeflow never deletes these files: removing the items leaves your memory where it is.

At session start the model receives the lessons, the handoff note and the last session's record, each capped in size, plus any flow run in progress. The handoff note and the record are skipped once they are a week old.

| Target | At session start | After compaction |
| --- | --- | --- |
| `claude` | a hook adds the memory | the hook adds it again, with this session's activity |
| `codex` | a hook adds the memory | as Claude Code |
| `cursor` | a hook adds the memory | Cursor cannot add context here, so you are told which files to point the agent at |
| `opencode` | the files are listed in `opencode.json` `instructions` | the record is added to the compaction prompt |

### What session memory does not do

- It is per project. Hooks are installed per project, so there is no user-level memory.
- The model receives the memory. Nothing makes it act on it.
- Your last three prompts in each of the last two sessions are stored in `.forgeflow/local/` in readable form. Text that looks like a credential is replaced with `[redacted]`, but a secret that matches no known pattern is stored as typed.
- A lesson can be wrong or go out of date. The lessons file is committed, so additions show up in review, and anyone can edit it.
- A file changed by a shell command is not in the record: only the agent's own file writes are.
- Two sessions open at once in one project share the one record and take turns in it.
- If you installed quality gates before session memory existed, run `forgeflow update` once so the harness config gains the session-start entry. Until then `forgeflow status` shows the wiring as missing.
````

3. Under "## Quality gates", after the line that shows `forgeflow add --hooks --target claude` (inside or just below its code block), add the sentence:

```markdown
`--hooks` installs the four quality gates. Session memory is also built on hooks, but is installed with `--memory`.
```

- [ ] **Step 4: Append to `docs/verification.md`**

Add at the end of the file:

```markdown

## Session memory

Install it in the same scratch repository:

    forgeflow add --memory --target <harness>

On Codex, run `/hooks` and trust the project hooks again: the hook config changed.

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 41 | The harness starts with no warning about the hook config, the plugin or `opencode.json` | | | | |
| 42 | Ask the agent to edit a file. Afterwards `.forgeflow/local/session.md` lists that file and your prompt | | | | |
| 43 | `git status` shows nothing under `.forgeflow/local/` | | | | |
| 44 | Start a new session and ask "what was I working on here last time?" The answer names the file and the prompt without the agent reading any file | | | | |
| 45 | Tell the agent something it got wrong about the project ("we use pnpm here, not npm"). It adds one line to `.forgeflow/memory/lessons.md` and tells you | | | | |
| 46 | Run `forge-handoff`. `.forgeflow/local/handoff.md` is written, and a new session can say what is next | | | | |
| 47 | Compact the conversation, then ask which files this session changed. The answer is right (Cursor: a message tells you which files to point the agent at) | | | | |
| 48 | Resume an earlier session. No second memory block is added (Claude Code and Codex) | | | | |

Check 42 shows whether the hook fires with a session id on that harness. Check 44 is the one that shows the memory reaches the model.

Two more checks test assumptions the automated tests cannot confirm:

| # | Check | Harness |
|---|---|---|
| 49 | With `.forgeflow/memory/` empty or absent, OpenCode starts with no warning about an `instructions` entry that matches no file | OpenCode |
| 50 | In check 42, a file written by a subagent appears in the same session's record, not a new one | Claude Code, Codex, Cursor |

If check 50 fails on a harness, subagent work starts a new record there and pushes the main session's record into "previous": record it in the README.
```

- [ ] **Step 5: Format, lint and run everything**

Run: `npx prettier --write README.md tests/memory-docs.test.js`

Run: `npx vitest run`
Expected: PASS, no failures.

Run: `npm run lint`
Expected: exit 0, no warnings.

Run: `npx prettier --check README.md src tests bin catalog/runtime catalog/hooks`
Expected: `All matched files use Prettier code style!`

Run: `node bin/forgeflow.js doctor`
Expected: `catalog is valid (42 items)`.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/verification.md tests/memory-docs.test.js
git commit -m "Document session memory and add its manual checks"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| 2. Success criteria 1, 3 | 2, 3, 4, 5 |
| 2. Success criteria 2, 4, 5 | 5 |
| 2. Success criteria 6, 7 | 3, 4, 6 |
| 3. Files | 5 (record), 6 (lessons, handoff) |
| 4.1 `group` | 1 |
| 4.2 The skills | 6 |
| 5.1 Events, 5.2 Results and context | 1, 2 |
| 5.3 Wiring | 3 |
| 5.4 Translating and responding | 2 |
| 5.5 OpenCode loading | 4 |
| 6. The `session-memory` hook | 5 |
| 7. CLI | 1 |
| 8. Limits | 7 (README) |
| 9. Error handling | 1, 4, 5 |
| 10. Testing | every task; manual checks in 7 |
