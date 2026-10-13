# forgeflow quality-gate hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four installable quality gates (`approval-gate`, `secret-guard`, `protected-paths`, `test-reminder`) that the harness enforces through hooks in Claude Code, Codex, Cursor and OpenCode.

**Architecture:** Gates are a new catalog item type. A dependency-free runner shipped into each project translates harness hook input into four neutral events and calls each installed gate. The installer copies runner and gates as whole files and merges one fixed set of entries into the harness's hook config, tracked in the lockfile.

**Tech Stack:** Node 20+, ESM JavaScript, `vitest`, `oxlint`, `prettier`. Shipped hook code uses only `node:` built-ins.

**Spec:** `docs/superpowers/specs/2026-10-13-forgeflow-hooks-design.md` (builds on `2026-10-13-forgeflow-core-design.md`)

## Global Constraints

- Shipped code (`catalog/runtime/hooks/*`, every `catalog/hooks/*/gate.mjs`) imports only `node:` built-ins and has no shebang line (a marker comment is prepended at install).
- Gates never import the runtime; helpers reach them through `ctx`.
- Runtime item id is exactly `runtime:hooks`. Hook ids are `hook:<name>`.
- forgeflow's wiring entries are recognized by the substring `forgeflow/run.mjs`.
- A harness config that cannot be parsed, or has the wrong shape, is never written, with or without `--force`.
- Hooks install at project scope only.
- Runner failures exit 1 (fail open). A block is exit 2.
- Hook commands use a 10-second timeout.
- Exit codes unchanged: 0 success, 1 conflict or failed check, 2 usage error.
- Test files never contain a literal credential: build sample secrets by string concatenation.
- Git commits: subject plus optional body only. Never add `Co-Authored-By` or any other trailer.
- Run all commands from `/home/hkumar/Documents/ADLC/forgeflow`.

## Review Focus

1. **A user's existing hook entries on the same event** (their own `PreToolUse` handler): install keeps them first and untouched; remove leaves the file's data exactly as it was before install. Tested in Task 1 and Task 6.
2. **A `state.md` the model formatted loosely** (`- status: running`, `` `status:` `waiting for user` ``, `**status:** running`): the run is still found. Tested in Task 3.
3. **Relative and absolute paths, and paths outside the project** in write events: a relative `file_path` resolves against the payload's `cwd`; an outside path stays absolute and does not crash a gate. Tested in Task 3.
4. **Typing `approve` when nothing is waiting** (no run, a running run, an already approved run): the prompt passes and no file is written. Tested in Task 4.
5. **Malformed hook input** (empty stdin, non-JSON, unknown tool, missing `tool_input`): the runner exits without blocking. Tested in Task 3 and Task 8.

## File Structure

| File | Responsibility |
|---|---|
| `src/wiring.js` (new) | Pure parse, merge, strip and check of forgeflow's entries in a hook config |
| `src/errors.js` | Adds `ConfigError` |
| `src/catalog.js` | Loads `hook` items and the `runtime:hooks` item |
| `src/resolve.js` | Bare names may resolve to hooks |
| `src/adapters/shared.js` | `stamp`, `hookFiles`, `commandWiring` |
| `src/adapters/{claude,codex,cursor,opencode}.js` | Render hook and runtime items; export `wiring` |
| `src/plan.js` | `planWire`, `planUnwire` |
| `src/apply.js` | Applies `wire` and `unwire` |
| `src/lock.js` | Validates the `wiring` field |
| `src/ops.js` | Wires on install, unwires on remove, refuses `--global`, reports wiring in `status` |
| `src/doctor.js`, `src/cli.js` | `--hooks`, `--type hook`, wiring status and checks |
| `catalog/runtime/hooks/{RUNTIME.md,runtime.mjs,run.mjs,opencode-plugin.js}` (new) | The shipped runner |
| `catalog/hooks/<name>/{HOOK.md,gate.mjs}` (new, four) | The gates |
| `catalog/skills/forge-*/SKILL.md`, `catalog/agents/deployer.md` | Approval step uses the typed `approve` |
| `tests/hook-helpers.js` (new) | Fixture trees for hook catalogs |
| `tests/{wiring,hook-catalog,runtime,gates,hook-adapters,hook-ops,hook-cli,hook-e2e,hook-content}.test.js` (new) | One per unit |

---

### Task 1: Wiring merge and strip

**Files:**
- Create: `src/wiring.js`
- Modify: `src/errors.js` (full replacement below)
- Test: `tests/wiring.test.js`

**Interfaces:**
- Produces: `ConfigError` (in `src/errors.js`).
- Produces: `RUNTIME_ID = 'runtime:hooks'`.
- Produces: `parseConfig(text, path) → object` (throws `ConfigError` naming `path`).
- Produces: `mergeWiring(config: object|undefined, wiring) → object`; `stripWiring(config, skeleton = {}) → object`; `isWired(config, wiring) → boolean`; `serialize(config) → string`.
- `wiring`: `{ path: string, skeleton: object, entries: { [event]: object } }`.
- None of these functions mutates its arguments or touches the filesystem.

- [ ] **Step 1: Write the failing test**

`tests/wiring.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { isWired, mergeWiring, parseConfig, serialize, stripWiring } from '../src/wiring.js';

const handler = { type: 'command', command: 'node "$X/.claude/forgeflow/run.mjs" claude', timeout: 10 };
const claude = {
  path: '.claude/settings.json',
  skeleton: {},
  entries: {
    PreToolUse: { matcher: 'Bash|Write', hooks: [handler] },
    Stop: { hooks: [handler] },
  },
};
const cursor = {
  path: '.cursor/hooks.json',
  skeleton: { version: 1, hooks: {} },
  entries: { preToolUse: { command: 'node .cursor/forgeflow/run.mjs cursor', timeout: 10 } },
};
const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: './my-hook.sh' }] };

describe('mergeWiring', () => {
  it('builds a config from the skeleton when there is none', () => {
    expect(mergeWiring(undefined, claude)).toEqual({
      hooks: { PreToolUse: [claude.entries.PreToolUse], Stop: [claude.entries.Stop] },
    });
    expect(mergeWiring(undefined, cursor)).toEqual({
      version: 1,
      hooks: { preToolUse: [cursor.entries.preToolUse] },
    });
  });

  it('keeps every other key and the user entries, in order, with ours last', () => {
    const config = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { PreToolUse: [mine], SessionStart: [mine] },
      model: 'opus',
    };
    const merged = mergeWiring(config, claude);
    expect(Object.keys(merged)).toEqual(['permissions', 'hooks', 'model']);
    expect(merged.permissions).toEqual(config.permissions);
    expect(merged.hooks.PreToolUse).toEqual([mine, claude.entries.PreToolUse]);
    expect(merged.hooks.SessionStart).toEqual([mine]);
    expect(merged.hooks.Stop).toEqual([claude.entries.Stop]);
  });

  it('is idempotent', () => {
    const once = mergeWiring({ hooks: { PreToolUse: [mine] } }, claude);
    expect(mergeWiring(once, claude)).toEqual(once);
  });

  it('replaces an older forgeflow entry instead of adding a second one', () => {
    const old = { hooks: [{ type: 'command', command: 'node old/.claude/forgeflow/run.mjs claude' }] };
    const merged = mergeWiring({ hooks: { PreToolUse: [old, mine], Notification: [old] } }, claude);
    expect(merged.hooks.PreToolUse).toEqual([mine, claude.entries.PreToolUse]);
    expect(merged.hooks.Notification).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const config = { hooks: { PreToolUse: [mine] } };
    const before = JSON.stringify(config);
    mergeWiring(config, claude);
    expect(JSON.stringify(config)).toBe(before);
    expect(JSON.stringify(claude.skeleton)).toBe('{}');
  });
});

describe('stripWiring', () => {
  it('returns the user data exactly as it was before the merge', () => {
    const original = { permissions: { allow: [] }, hooks: { PreToolUse: [mine], Other: [] } };
    expect(stripWiring(mergeWiring(original, claude))).toEqual(original);
  });

  it('removes the hooks key when only our entries were in it', () => {
    expect(stripWiring(mergeWiring({ model: 'opus' }, claude))).toEqual({ model: 'opus' });
    expect(stripWiring(mergeWiring(undefined, claude), claude.skeleton)).toEqual({});
  });

  it('keeps an empty hooks object the skeleton had', () => {
    expect(stripWiring(mergeWiring(undefined, cursor), cursor.skeleton)).toEqual(cursor.skeleton);
  });

  it('leaves a config without our entries unchanged', () => {
    const config = { hooks: { PreToolUse: [mine] } };
    expect(stripWiring(config)).toEqual(config);
    expect(stripWiring({ a: 1 })).toEqual({ a: 1 });
    expect(stripWiring({ hooks: {} })).toEqual({ hooks: {} });
  });
});

describe('isWired', () => {
  it('is true only when every wired event has the exact entry', () => {
    const merged = mergeWiring({ hooks: { PreToolUse: [mine] } }, claude);
    expect(isWired(merged, claude)).toBe(true);
    expect(isWired({ hooks: { PreToolUse: [claude.entries.PreToolUse] } }, claude)).toBe(false);
    expect(isWired({}, claude)).toBe(false);
    const changed = mergeWiring(undefined, claude);
    changed.hooks.Stop[0].hooks[0].timeout = 99;
    expect(isWired(changed, claude)).toBe(false);
  });
});

describe('parseConfig', () => {
  it('parses a valid config', () => {
    expect(parseConfig('{"hooks":{"Stop":[]}}', 'a.json')).toEqual({ hooks: { Stop: [] } });
    expect(parseConfig('{}', 'a.json')).toEqual({});
  });

  it.each([
    ['invalid JSON', '{ broken', 'is not valid JSON'],
    ['a list', '[]', 'must contain a JSON object'],
    ['a string', '"x"', 'must contain a JSON object'],
    ['hooks as a list', '{"hooks":[]}', '"hooks" value that is not an object'],
    ['an event that is not a list', '{"hooks":{"Stop":{}}}', '"hooks.Stop" value that is not a list'],
  ])('refuses %s and names the file', (_label, text, message) => {
    expect(() => parseConfig(text, '.claude/settings.json')).toThrow(ConfigError);
    expect(() => parseConfig(text, '.claude/settings.json')).toThrow(message);
    expect(() => parseConfig(text, '.claude/settings.json')).toThrow('.claude/settings.json');
  });
});

describe('serialize', () => {
  it('uses two-space indentation and a trailing newline', () => {
    expect(serialize({ a: { b: 1 } })).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/wiring.test.js`
Expected: FAIL, cannot resolve `../src/wiring.js`.

- [ ] **Step 3: Write `src/errors.js`**

```js
export class CatalogError extends Error {}
export class UsageError extends Error {}
export class LockError extends Error {}
export class ConfigError extends Error {}

export class ConflictError extends Error {
  // conflicts: [{ target, path, reason }]
  constructor(conflicts) {
    super(`${conflicts.length} file(s) would be overwritten`);
    this.conflicts = conflicts;
  }
}
```

- [ ] **Step 4: Write `src/wiring.js`**

```js
import { ConfigError } from './errors.js';

export const RUNTIME_ID = 'runtime:hooks';

// Any hook entry that runs this path is forgeflow's. Everything else is the user's.
const OURS = 'forgeflow/run.mjs';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isOurs = (element) => JSON.stringify(element).includes(OURS);
const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function parseConfig(text, path) {
  const refuse = (problem) =>
    new ConfigError(`${path} ${problem}. forgeflow will not modify it: fix the file and re-run.`);
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw refuse(`is not valid JSON (${error.message})`);
  }
  if (!isObject(config)) throw refuse('must contain a JSON object');
  if (config.hooks !== undefined) {
    if (!isObject(config.hooks)) throw refuse('has a "hooks" value that is not an object');
    for (const [event, list] of Object.entries(config.hooks)) {
      if (!Array.isArray(list)) throw refuse(`has a "hooks.${event}" value that is not a list`);
    }
  }
  return config;
}

// Drops our elements. A list we emptied is removed; a list the user left empty stays.
function withoutOurs(hooks) {
  const kept = {};
  for (const [event, list] of Object.entries(hooks)) {
    const rest = list.filter((element) => !isOurs(element));
    if (rest.length > 0 || rest.length === list.length) kept[event] = rest;
  }
  return kept;
}

export function mergeWiring(config, wiring) {
  const base = clone(config ?? wiring.skeleton);
  const hooks = withoutOurs(base.hooks ?? {});
  for (const [event, entry] of Object.entries(wiring.entries)) {
    hooks[event] = [...(hooks[event] ?? []), clone(entry)];
  }
  return { ...base, hooks };
}

export function stripWiring(config, skeleton = {}) {
  const base = clone(config);
  if (base.hooks === undefined) return base;
  const hooks = withoutOurs(base.hooks);
  const emptiedByUs = Object.keys(hooks).length === 0 && Object.keys(base.hooks).length > 0;
  if (emptiedByUs && !('hooks' in skeleton)) delete base.hooks;
  else base.hooks = hooks;
  return base;
}

export function isWired(config, wiring) {
  return Object.entries(wiring.entries).every(([event, entry]) =>
    (config.hooks?.[event] ?? []).some((element) => same(element, entry))
  );
}

export function serialize(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/wiring.test.js`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/errors.js src/wiring.js tests/wiring.test.js
git commit -m "Add hook config wiring merge and strip"
```

---

### Task 2: Catalog loads hooks and the runtime

**Files:**
- Modify: `src/catalog.js`, `src/resolve.js` (full replacements below)
- Create: `tests/hook-helpers.js`
- Test: `tests/hook-catalog.test.js`

**Interfaces:**
- Consumes: `parseFrontmatter`, `CatalogError`.
- Produces: `loadCatalog` also returns
  - hook items: `{ id: 'hook:<name>', type: 'hook', name, description, events: string[], requires: [..., 'runtime:hooks'], body, gate: string, files: [], source }`;
  - the runtime item: `{ id: 'runtime:hooks', type: 'runtime', name: 'hooks', description, requires: [], body, sources: { 'run.mjs', 'runtime.mjs', 'opencode-plugin.js' }, files: [], source }`.
- Produces: `EVENTS = ['shell', 'write', 'prompt', 'stop']`.
- Produces: `findId` resolves a bare name among `agent`, `skill`, `hook`.
- Produces test helpers `runtimeTree()` and `hookTree(name, events?)`, each returning a `{ path: content }` tree for `writeTree`.

- [ ] **Step 1: Write `tests/hook-helpers.js`**

```js
export function runtimeTree() {
  return {
    'runtime/hooks/RUNTIME.md': '---\nname: hooks\ndescription: Hook runner.\n---\nRuns gates.\n',
    'runtime/hooks/run.mjs': '// run\n',
    'runtime/hooks/runtime.mjs': '// runtime\n',
    'runtime/hooks/opencode-plugin.js': '// plugin\n',
  };
}

export function hookTree(name, events = '[shell]') {
  return {
    [`hooks/${name}/HOOK.md`]: `---\nname: ${name}\ndescription: Gate ${name}.\nevents: ${events}\n---\nAbout ${name}.\n`,
    [`hooks/${name}/gate.mjs`]: `export function check() {}\n// ${name}\n`,
  };
}
```

- [ ] **Step 2: Write the failing test**

`tests/hook-catalog.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { CatalogError } from '../src/errors.js';
import { findId } from '../src/resolve.js';
import { agentMd, tmpDir, writeTree } from './helpers.js';
import { hookTree, runtimeTree } from './hook-helpers.js';

const load = (tree) => loadCatalog(writeTree(tmpDir(), tree));

describe('hook items', () => {
  it('loads a hook with its gate source and requires the runtime', () => {
    const catalog = load({ ...runtimeTree(), ...hookTree('guard', '[shell, write]') });
    expect(catalog.get('hook:guard')).toMatchObject({
      type: 'hook',
      name: 'guard',
      description: 'Gate guard.',
      events: ['shell', 'write'],
      requires: ['runtime:hooks'],
      body: 'About guard.',
      gate: 'export function check() {}\n// guard\n',
      files: [],
      source: 'hooks/guard/HOOK.md',
    });
  });

  it('does not list the runtime twice when a hook already requires it', () => {
    const tree = { ...runtimeTree(), ...hookTree('guard') };
    tree['hooks/guard/HOOK.md'] = tree['hooks/guard/HOOK.md'].replace(
      'events:',
      'requires: [runtime:hooks]\nevents:'
    );
    expect(load(tree).get('hook:guard').requires).toEqual(['runtime:hooks']);
  });

  it('loads the runtime item with its three sources', () => {
    const runtime = load(runtimeTree()).get('runtime:hooks');
    expect(runtime).toMatchObject({
      type: 'runtime',
      name: 'hooks',
      description: 'Hook runner.',
      requires: [],
      sources: {
        'run.mjs': '// run\n',
        'runtime.mjs': '// runtime\n',
        'opencode-plugin.js': '// plugin\n',
      },
    });
  });

  it('resolves a bare hook name', () => {
    const catalog = load({ ...runtimeTree(), ...hookTree('guard') });
    expect(findId(catalog, 'guard')).toBe('hook:guard');
  });

  it('reports a name shared by an agent and a hook as ambiguous', () => {
    const catalog = load({ ...runtimeTree(), ...hookTree('twin'), 'agents/twin.md': agentMd('twin') });
    expect(() => findId(catalog, 'twin')).toThrow('use agent:twin or hook:twin');
  });

  const withHook = (edit) => {
    const tree = { ...runtimeTree(), ...hookTree('guard') };
    edit(tree);
    return tree;
  };
  const invalid = [
    ['a hook without gate.mjs', withHook((t) => delete t['hooks/guard/gate.mjs']), 'hooks/guard: missing gate.mjs'],
    ['a hook without HOOK.md', withHook((t) => delete t['hooks/guard/HOOK.md']), 'hooks/guard: missing HOOK.md'],
    [
      'a hook without events',
      withHook((t) => (t['hooks/guard/HOOK.md'] = t['hooks/guard/HOOK.md'].replace('events: [shell]\n', ''))),
      'field "events"',
    ],
    [
      'an empty events list',
      withHook((t) => (t['hooks/guard/HOOK.md'] = t['hooks/guard/HOOK.md'].replace('[shell]', '[]'))),
      'field "events"',
    ],
    [
      'an unknown event',
      withHook((t) => (t['hooks/guard/HOOK.md'] = t['hooks/guard/HOOK.md'].replace('[shell]', '[shell, click]'))),
      'field "events"',
    ],
    [
      'an agent field on a hook',
      withHook((t) => (t['hooks/guard/HOOK.md'] = t['hooks/guard/HOOK.md'].replace('events:', 'access: write\nevents:'))),
      'unknown field "access"',
    ],
    ['a hook name that differs from its folder', { ...runtimeTree(), ...renamed() }, 'must equal the folder name (other)'],
    ['a hook with no runtime in the catalog', hookTree('guard'), 'unknown item "runtime:hooks"'],
    [
      'a runtime missing a source file',
      withHook((t) => delete t['runtime/hooks/run.mjs']),
      'runtime/hooks: missing run.mjs',
    ],
    [
      'a runtime not named hooks',
      withHook((t) => (t['runtime/hooks/RUNTIME.md'] = t['runtime/hooks/RUNTIME.md'].replace('name: hooks', 'name: other'))),
      'must equal the folder name (hooks)',
    ],
  ];

  function renamed() {
    const tree = hookTree('guard');
    return {
      'hooks/other/HOOK.md': tree['hooks/guard/HOOK.md'],
      'hooks/other/gate.mjs': tree['hooks/guard/gate.mjs'],
    };
  }

  it.each(invalid)('rejects %s', (_label, tree, message) => {
    expect(() => load(tree)).toThrow(CatalogError);
    expect(() => load(tree)).toThrow(message);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/hook-catalog.test.js`
Expected: FAIL. The first test fails because `catalog.get('hook:guard')` is undefined.

- [ ] **Step 4: Write `src/resolve.js`**

```js
import { UsageError } from './errors.js';

const TYPES = ['agent', 'skill', 'hook'];
const unknown = (ref) =>
  new UsageError(`unknown item "${ref}". Run "forgeflow list" to see available items.`);

export function findId(catalog, ref) {
  if (ref.includes(':')) {
    if (catalog.has(ref)) return ref;
    throw unknown(ref);
  }
  const matches = TYPES.map((type) => `${type}:${ref}`).filter((id) => catalog.has(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new UsageError(`"${ref}" is ambiguous: use ${matches.join(' or ')}.`);
  }
  throw unknown(ref);
}

export function resolve(catalog, refs) {
  const explicit = new Set(refs.map((ref) => findId(catalog, ref)));
  const order = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of catalog.get(id).requires) visit(dep);
    order.push(id);
  };
  for (const id of explicit) visit(id);
  return order.map((id) => ({ item: catalog.get(id), explicit: explicit.has(id) }));
}
```

- [ ] **Step 5: Write `src/catalog.js`**

```js
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError } from './errors.js';
import { parseFrontmatter } from './frontmatter.js';
import { RUNTIME_ID } from './wiring.js';

export const STAGES = [
  'requirement',
  'analyze',
  'plan',
  'architect',
  'build',
  'test',
  'fix',
  'review',
  'release_gate',
  'human_approval',
  'deploy',
  'feedback',
];
export const EVENTS = ['shell', 'write', 'prompt', 'stop'];
const ACCESS = ['read-only', 'write'];
const TIERS = ['fast', 'balanced', 'strong'];
const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const RUNTIME_SOURCES = ['run.mjs', 'runtime.mjs', 'opencode-plugin.js'];
const FIELDS = {
  agent: ['name', 'description', 'stage', 'access', 'model-tier', 'requires'],
  skill: ['name', 'description', 'user-invocable-only', 'requires'],
  hook: ['name', 'description', 'events', 'requires'],
  runtime: ['name', 'description'],
};

function fail(source, problem) {
  throw new CatalogError(`${source}: ${problem}`);
}

function oneOf(source, data, field, allowed, required) {
  const value = data[field];
  if (value === undefined && !required) return undefined;
  if (!allowed.includes(value)) {
    fail(source, `field "${field}" must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function buildItem(type, expectedName, text, source) {
  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (error) {
    fail(source, error.message);
  }
  const { data, body } = parsed;

  for (const field of Object.keys(data)) {
    if (!FIELDS[type].includes(field)) {
      fail(source, `unknown field "${field}" (allowed: ${FIELDS[type].join(', ')})`);
    }
  }
  if (typeof data.name !== 'string' || !NAME_RE.test(data.name)) {
    fail(source, `field "name" is required and must match ${NAME_RE}`);
  }
  if (data.name !== expectedName) {
    const container = type === 'agent' ? 'file' : 'folder';
    fail(source, `field "name" (${data.name}) must equal the ${container} name (${expectedName})`);
  }
  const description = data.description;
  if (typeof description !== 'string' || description.length < 1 || description.length > 1024) {
    fail(source, 'field "description" is required and must be 1-1024 characters');
  }
  const requires = data.requires ?? [];
  if (!Array.isArray(requires) || requires.some((entry) => typeof entry !== 'string')) {
    fail(source, 'field "requires" must be a list of item ids');
  }
  if (!body) fail(source, 'body is empty');

  const item = {
    id: `${type}:${data.name}`,
    type,
    name: data.name,
    description,
    requires: [...requires],
    body,
    files: [],
    source,
  };
  if (type === 'agent') {
    item.stage = oneOf(source, data, 'stage', STAGES, false);
    item.access = oneOf(source, data, 'access', ACCESS, true);
    item.modelTier = oneOf(source, data, 'model-tier', TIERS, false) ?? 'balanced';
  } else if (type === 'skill') {
    const flag = data['user-invocable-only'] ?? false;
    if (typeof flag !== 'boolean') fail(source, 'field "user-invocable-only" must be true or false');
    item.userInvocableOnly = flag;
  } else if (type === 'hook') {
    const events = data.events;
    const valid =
      Array.isArray(events) && events.length > 0 && events.every((event) => EVENTS.includes(event));
    if (!valid) fail(source, `field "events" must be a non-empty list of: ${EVENTS.join(', ')}`);
    item.events = events;
    if (!item.requires.includes(RUNTIME_ID)) item.requires.push(RUNTIME_ID);
  }
  return item;
}

function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(join(dir, entry.name), rel) : [rel];
    });
}

function folders(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// Reads <dir>/<name>/<main> and returns the built item, or fails if the main file is missing.
function folderItem(type, kind, dir, name, main) {
  const path = join(dir, name, main);
  if (!existsSync(path)) fail(`${kind}/${name}`, `missing ${main}`);
  return buildItem(type, name, readFileSync(path, 'utf8'), `${kind}/${name}/${main}`);
}

function checkRequires(items) {
  for (const item of items.values()) {
    for (const dep of item.requires) {
      if (!items.has(dep)) fail(item.source, `"requires" names unknown item "${dep}"`);
    }
  }
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const loop = [...trail.slice(trail.indexOf(id)), id].join(' → ');
      fail(items.get(id).source, `"requires" forms a cycle: ${loop}`);
    }
    state.set(id, 'visiting');
    for (const dep of items.get(id).requires) visit(dep, [...trail, id]);
    state.set(id, 'done');
  };
  for (const id of items.keys()) visit(id, []);
}

export function loadCatalog(dir) {
  const items = new Map();

  const agentsDir = join(dir, 'agents');
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).sort()) {
      if (!file.endsWith('.md')) continue;
      const text = readFileSync(join(agentsDir, file), 'utf8');
      const item = buildItem('agent', file.slice(0, -3), text, `agents/${file}`);
      items.set(item.id, item);
    }
  }

  const skillsDir = join(dir, 'skills');
  for (const name of folders(skillsDir)) {
    const item = folderItem('skill', 'skills', skillsDir, name, 'SKILL.md');
    const folder = join(skillsDir, name);
    item.files = listFiles(folder)
      .filter((rel) => rel !== 'SKILL.md')
      .map((rel) => ({ path: rel, content: readFileSync(join(folder, rel)) }));
    items.set(item.id, item);
  }

  const hooksDir = join(dir, 'hooks');
  for (const name of folders(hooksDir)) {
    const item = folderItem('hook', 'hooks', hooksDir, name, 'HOOK.md');
    const gate = join(hooksDir, name, 'gate.mjs');
    if (!existsSync(gate)) fail(`hooks/${name}`, 'missing gate.mjs');
    item.gate = readFileSync(gate, 'utf8');
    items.set(item.id, item);
  }

  const runtimeDir = join(dir, 'runtime');
  for (const name of folders(runtimeDir)) {
    const item = folderItem('runtime', 'runtime', runtimeDir, name, 'RUNTIME.md');
    if (item.id !== RUNTIME_ID) fail(item.source, `field "name" (${name}) must equal the folder name (hooks)`);
    item.sources = {};
    for (const file of RUNTIME_SOURCES) {
      const path = join(runtimeDir, name, file);
      if (!existsSync(path)) fail(`runtime/${name}`, `missing ${file}`);
      item.sources[file] = readFileSync(path, 'utf8');
    }
    items.set(item.id, item);
  }

  checkRequires(items);
  return items;
}
```

The "a runtime not named hooks" test renames only the frontmatter `name`, so `buildItem` reports it as a name/folder mismatch before the `RUNTIME_ID` check is reached. The extra check covers a folder that is itself misnamed.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/hook-catalog.test.js tests/catalog.test.js tests/resolve.test.js`
Expected: all pass, including the unchanged phase 1 catalog and resolver tests.

- [ ] **Step 7: Commit**

```bash
git add src/catalog.js src/resolve.js tests/hook-helpers.js tests/hook-catalog.test.js
git commit -m "Load hook and runtime items from the catalog"
```

---

### Task 3: The shipped runtime

**Files:**
- Create: `catalog/runtime/hooks/RUNTIME.md`, `catalog/runtime/hooks/runtime.mjs`, `catalog/runtime/hooks/run.mjs`, `catalog/runtime/hooks/opencode-plugin.js`
- Test: `tests/runtime.test.js`

**Interfaces:**
- Produces, from `runtime.mjs`:
  - `toRelative(root, path, cwd?) → string`
  - `parsePatch(text) → [{ path, content }]`
  - `matchesGlob(path, glob) → boolean`
  - `loadConfig(root) → { config: { releaseCommands: RegExp[], protectedPaths: string[], secretAllow: RegExp[], testCommands: RegExp[] }, warnings: string[] }` (user additions only; gates add their own defaults)
  - `findRun(root, now?) → null | { dir, name, status, stage, approved }` (`status` lower-cased)
  - `selfProtect(event, root) → string | undefined`
  - `normalize(harness, payload, root) → Event[]`
  - `evaluate({ harness, payload, root, gates, now? }) → { events, block?: string, notes: string[], warnings: string[] }`
  - `respond(harness, payload, result) → { code, stdout, stderr }`
  - `loadGates(dir) → Promise<[{ name, check }]>`
  - `handle(harness, payload, { root, gatesDir }) → Promise<{ code, stdout, stderr }>`
- Gate `ctx`: `{ root, harness, config, run, state: { get(), set(object) }, now, matchesGlob }`.
- OpenCode payloads passed to `normalize`/`evaluate`: `{ hook: 'tool', tool, args }` or `{ hook: 'prompt', text }`.
- `run.mjs` is invoked as `node run.mjs <harness>` with the hook JSON on stdin. It resolves the project root as two directories above itself and gates as `./gates`.
- `opencode-plugin.js` exports `ForgeflowGates`; it expects to live in `.opencode/plugins/` with the runtime in `.opencode/forgeflow/`.

- [ ] **Step 1: Write the failing test**

`tests/runtime.test.js`:

```js
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
import { tmpDir, writeTree } from './helpers.js';

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
      '.forgeflow/config.json': JSON.stringify({
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
      '.forgeflow/config.json': JSON.stringify({
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
      const root = writeTree(tmpDir(), { '.forgeflow/config.json': text });
      const { config, warnings } = loadConfig(root);
      expect(config.releaseCommands).toEqual([]);
      expect(warnings).toHaveLength(1);
    }
  });
});

describe('findRun', () => {
  const NOW = Date.UTC(2026, 9, 13, 12);
  const runIn = (root, name, state, ageHours = 0) => {
    const dir = join(root, '.forgeflow/runs', name);
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
    const dir = runIn(root, '20261013-add-login', 'mode: full\ncurrent stage: BUILD\nstatus: running\n');
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
    mkdirSync(join(root, '.forgeflow/runs/empty'), { recursive: true });
    writeTree(root, { '.forgeflow/runs/stray.txt': 'x' });
    expect(findRun(root, NOW)).toBeNull();
  });
});

describe('selfProtect', () => {
  const root = writeTree(tmpDir(), { '.claude/forgeflow/run.mjs': '' });
  const write = (path) => selfProtect({ kind: 'write', path, content: '' }, root);
  const shell = (command) => selfProtect({ kind: 'shell', command }, root);

  it('blocks writes to forgeflow hook files, config and lockfile', () => {
    for (const path of [
      '.claude/forgeflow/run.mjs',
      '.cursor/forgeflow/gates/secret-guard.mjs',
      '.forgeflow/config.json',
      '.forgeflow/lock.json',
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
    expect(write('.forgeflow/runs/r/state.md')).toBeUndefined();
    expect(write('.claude/agents/reviewer.md')).toBeUndefined();
  });

  it('blocks shell commands that touch the runner or remove gates', () => {
    expect(shell('rm -rf .claude/forgeflow/gates')).toContain('is protected');
    expect(shell('echo "" > .codex/forgeflow/run.mjs')).toContain('is protected');
    expect(shell('npx forgeflow remove approval-gate --target claude')).toContain('is protected');
  });

  it('allows other shell commands, including other forgeflow commands', () => {
    expect(shell('npm test')).toBeUndefined();
    expect(shell('forgeflow status')).toBeUndefined();
    expect(shell('forgeflow list && git remote remove origin')).toBeUndefined();
  });
});

describe('normalize', () => {
  const claude = (tool, input, extra = {}) =>
    normalize('claude', { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: ROOT, ...extra }, ROOT);

  it('maps Claude Code tools', () => {
    expect(claude('Bash', { command: 'npm test' })).toEqual([{ kind: 'shell', command: 'npm test' }]);
    expect(claude('Write', { file_path: '/work/app/a.js', content: 'x' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'x' },
    ]);
    expect(claude('Edit', { file_path: 'a.js', old_string: 'o', new_string: 'n' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'n' },
    ]);
    expect(
      claude('MultiEdit', { file_path: 'a.js', edits: [{ new_string: 'one' }, { new_string: 'two' }] })
    ).toEqual([{ kind: 'write', path: 'a.js', content: 'one\ntwo' }]);
    expect(claude('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'cell' })).toEqual([
      { kind: 'write', path: 'n.ipynb', content: 'cell' },
    ]);
  });

  it('maps Claude Code and Codex prompts and stops', () => {
    for (const harness of ['claude', 'codex']) {
      expect(normalize(harness, { hook_event_name: 'UserPromptSubmit', prompt: 'approve' }, ROOT)).toEqual([
        { kind: 'prompt', text: 'approve' },
      ]);
      expect(normalize(harness, { hook_event_name: 'Stop' }, ROOT)).toEqual([{ kind: 'stop' }]);
      expect(normalize(harness, { hook_event_name: 'Stop', stop_hook_active: true }, ROOT)).toEqual([]);
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
    expect(normalize('codex', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' } }, ROOT)).toEqual([
      { kind: 'shell', command: 'ls' },
    ]);
    expect(
      normalize('codex', { ...base, tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x' } }, ROOT)
    ).toEqual([{ kind: 'write', path: 'a.js', content: 'x' }]);
  });

  it('maps Cursor events', () => {
    const pre = (tool, input) =>
      normalize('cursor', { hook_event_name: 'preToolUse', tool_name: tool, tool_input: input, cwd: ROOT }, ROOT);
    expect(pre('Shell', { command: 'git push' })).toEqual([{ kind: 'shell', command: 'git push' }]);
    expect(pre('Write', { file_path: '/work/app/a.js', content: 'x' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'x' },
    ]);
    expect(pre('StrReplace', { file_path: 'a.js', new_string: 'n' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'n' },
    ]);
    expect(pre('Delete', { file_path: '.env' })).toEqual([{ kind: 'write', path: '.env', content: '' }]);
    expect(normalize('cursor', { hook_event_name: 'beforeSubmitPrompt', prompt: 'hi' }, ROOT)).toEqual([
      { kind: 'prompt', text: 'hi' },
    ]);
    expect(normalize('cursor', { hook_event_name: 'stop', loop_count: 0 }, ROOT)).toEqual([{ kind: 'stop' }]);
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
    ['an unknown tool', 'claude', { hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'x' } }],
    ['a missing tool_input', 'claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }],
    ['a non-string command', 'claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 7 } }],
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
  const run = (gates, payload = shellPayload) => evaluate({ harness: 'claude', payload, root, gates });

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
      tool_input: { file_path: join(root, '.forgeflow/config.json'), content: '{}' },
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
    const bad = writeTree(tmpDir(), { '.forgeflow/config.json': '{ broken' });
    const result = evaluate({ harness: 'claude', payload: shellPayload, root: bad, gates: [] });
    expect(result.warnings).toHaveLength(1);
  });
});

describe('respond', () => {
  const pre = { hook_event_name: 'PreToolUse' };
  const result = (overrides) => ({ events: [{ kind: 'shell', command: 'x' }], notes: [], warnings: [], ...overrides });

  it('allows silently when there is nothing to say', () => {
    for (const harness of ['claude', 'codex', 'cursor']) {
      expect(respond(harness, pre, result({}))).toEqual({ code: 0, stdout: '', stderr: '' });
    }
  });

  it('blocks Claude Code and Codex with exit 2 and the reason on stderr', () => {
    for (const harness of ['claude', 'codex']) {
      expect(respond(harness, pre, result({ block: 'no' }))).toEqual({ code: 2, stdout: '', stderr: 'no' });
    }
  });

  it('blocks Cursor with exit 2 and a deny decision', () => {
    const out = respond('cursor', { hook_event_name: 'preToolUse' }, result({ block: 'no' }));
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout)).toEqual({ permission: 'deny', user_message: 'no', agent_message: 'no' });
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
    expect(respond('claude', { hook_event_name: 'Stop' }, result({ ...warned, events: [{ kind: 'stop' }] })).stdout).toBe('');
    const prompt = respond(
      'claude',
      { hook_event_name: 'UserPromptSubmit' },
      result({ ...warned, events: [{ kind: 'prompt', text: 'hi' }], notes: ['recorded'] })
    );
    expect(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext).toBe('recorded\nconfig is broken');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/runtime.test.js`
Expected: FAIL, cannot resolve `../catalog/runtime/hooks/runtime.mjs`.

- [ ] **Step 3: Write `catalog/runtime/hooks/RUNTIME.md`**

```markdown
---
name: hooks
description: Runner that translates harness hook input into neutral events and calls each installed forgeflow gate.
---
Installed automatically with any forgeflow gate, and removed with the last one.

The runner reads the harness's hook input, turns it into `shell`, `write`, `prompt` and `stop` events, and passes each to every gate in the `gates/` folder beside it. The first gate that blocks wins.

It has no dependencies beyond Node 20. If it fails, the action it was checking proceeds.
```

- [ ] **Step 4: Write `catalog/runtime/hooks/runtime.mjs`**

```js
// forgeflow hook runtime. Uses only node: built-ins, because it runs in
// projects that have not installed forgeflow.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY = 24 * 60 * 60 * 1000;
const CONFIG_KEYS = ['releaseCommands', 'protectedPaths', 'secretAllow', 'testCommands'];
// Harness folder → the file that wires forgeflow's hooks into that harness.
const WIRING_FILES = {
  '.claude': '.claude/settings.json',
  '.codex': '.codex/hooks.json',
  '.cursor': '.cursor/hooks.json',
  '.opencode': '.opencode/plugins/forgeflow.js',
};

const text = (value) => (typeof value === 'string' ? value : '');
const posix = (path) => path.split('\\').join('/');

export function toRelative(root, path, cwd) {
  const absolute = isAbsolute(path) ? path : resolve(cwd || root, path);
  const rel = relative(root, absolute);
  const outside = rel === '' || rel.startsWith('..') || isAbsolute(rel);
  return posix(outside ? absolute : rel);
}

export function parsePatch(patch) {
  const files = [];
  for (const line of text(patch).split(/\r?\n/)) {
    const header =
      /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line);
    if (header) files.push({ path: header[1].trim(), lines: [] });
    else if (files.length > 0 && line.startsWith('+')) files.at(-1).lines.push(line.slice(1));
  }
  return files.map(({ path, lines }) => ({ path, content: lines.join('\n') }));
}

// Supports *, ** and ?. A glob with no slash is matched against the file name.
export function matchesGlob(path, glob) {
  const subject = glob.includes('/') ? path : path.split('/').pop();
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(subject);
}

export function loadConfig(root) {
  const config = Object.fromEntries(CONFIG_KEYS.map((key) => [key, []]));
  const warnings = [];
  const warn = (problem) => warnings.push(`forgeflow: .forgeflow/config.json ${problem}`);
  const path = join(root, '.forgeflow', 'config.json');
  if (!existsSync(path)) return { config, warnings };

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    warn(`is not valid JSON and was ignored (${error.message}).`);
    return { config, warnings };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warn('must contain a JSON object; it was ignored.');
    return { config, warnings };
  }

  for (const key of CONFIG_KEYS) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key])) {
      warn(`has a "${key}" value that is not a list; it was ignored.`);
      continue;
    }
    raw[key].forEach((entry, index) => {
      if (typeof entry !== 'string' || entry === '') {
        warn(`has a "${key}[${index}]" entry that is not a string; it was ignored.`);
      } else if (key === 'protectedPaths') {
        config[key].push(entry);
      } else {
        try {
          config[key].push(new RegExp(entry, 'i'));
        } catch {
          warn(`has a "${key}[${index}]" entry that is not a valid regular expression; it was ignored.`);
        }
      }
    });
  }
  return { config, warnings };
}

// Reads "name: value" from state.md, tolerating bullets, backticks and bold.
function field(body, name) {
  // Spaces and tabs only, never \s: a newline here would let an empty value swallow the next line.
  const pattern = new RegExp(`^[ \\t\\-*\`]*${name}[\`*]*[ \\t]*:[ \\t\`*]*(.*?)[ \\t\`*]*$`, 'im');
  const match = pattern.exec(body);
  return match ? match[1].trim() : '';
}

export function findRun(root, now = Date.now()) {
  const runs = join(root, '.forgeflow', 'runs');
  if (!existsSync(runs)) return null;

  let best = null;
  for (const name of readdirSync(runs)) {
    const dir = join(runs, name);
    let body;
    let modified;
    try {
      const state = join(dir, 'state.md');
      body = readFileSync(state, 'utf8');
      modified = statSync(state).mtimeMs;
    } catch {
      continue;
    }
    const status = field(body, 'status').toLowerCase();
    const active = status.startsWith('running') || status.startsWith('waiting for user');
    if (!active || now - modified > DAY) continue;
    if (best && best.modified >= modified) continue;
    best = { dir, name, status, stage: field(body, 'current stage'), modified };
  }
  if (!best) return null;

  let approved = false;
  try {
    approved = /^decision:\s*approved\s*$/im.test(readFileSync(join(best.dir, '09-approval.md'), 'utf8'));
  } catch {
    // no approval record
  }
  return { dir: best.dir, name: best.name, status: best.status, stage: best.stage, approved };
}

function stateStore(root) {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const file = join(tmpdir(), `forgeflow-${key}.json`);
  return {
    get() {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return {};
      }
    },
    set(value) {
      try {
        writeFileSync(file, JSON.stringify(value));
      } catch {
        // state is best effort
      }
    },
  };
}

export function selfProtect(event, root) {
  const refuse = (what) =>
    `forgeflow: ${what} is protected while quality gates are installed. A person must make this change.`;

  if (event.kind === 'write') {
    const path = event.path;
    if (path === '.forgeflow/config.json' || path === '.forgeflow/lock.json') return refuse(path);
    for (const [dir, wiring] of Object.entries(WIRING_FILES)) {
      if (path.startsWith(`${dir}/forgeflow/`)) return refuse(path);
      if (path === wiring && existsSync(join(root, dir, 'forgeflow'))) return refuse(path);
    }
  }
  if (event.kind === 'shell') {
    if (/forgeflow\/(run\.mjs|runtime\.mjs|gates)\b/.test(event.command)) {
      return refuse('the forgeflow hook runner');
    }
    if (/\bforgeflow\b[^|;&\n]*\bremove\b/.test(event.command)) return refuse('"forgeflow remove"');
  }
  return undefined;
}

export function normalize(harness, payload, root) {
  const data = payload ?? {};
  const input = data.tool_input ?? {};
  const event = data.hook_event_name;
  const shell = (command) => (typeof command === 'string' ? [{ kind: 'shell', command }] : []);
  const write = (path, content) => ({
    kind: 'write',
    path: toRelative(root, path, data.cwd),
    content: text(content),
  });
  const patch = (body) => parsePatch(body).map((file) => write(file.path, file.content));

  if (harness === 'claude' || harness === 'codex') {
    if (event === 'UserPromptSubmit') return [{ kind: 'prompt', text: text(data.prompt) }];
    if (event === 'Stop') return data.stop_hook_active ? [] : [{ kind: 'stop' }];
    if (event !== 'PreToolUse') return [];
    if (data.tool_name === 'Bash') return shell(input.command);
    if (typeof input.file_path === 'string') {
      if (Array.isArray(input.edits)) {
        return [write(input.file_path, input.edits.map((edit) => text(edit?.new_string)).join('\n'))];
      }
      return [write(input.file_path, input.content ?? input.new_string)];
    }
    if (typeof input.notebook_path === 'string') return [write(input.notebook_path, input.new_source)];
    if (harness === 'codex') return patch(input.command);
    return [];
  }

  if (harness === 'cursor') {
    if (event === 'beforeSubmitPrompt') return [{ kind: 'prompt', text: text(data.prompt) }];
    if (event === 'stop') return data.loop_count ? [] : [{ kind: 'stop' }];
    if (event !== 'preToolUse') return [];
    if (data.tool_name === 'Shell') return shell(input.command);
    if (typeof input.file_path === 'string') {
      return [write(input.file_path, input.content ?? input.new_string)];
    }
    return [];
  }

  if (harness === 'opencode') {
    if (data.hook === 'prompt') return [{ kind: 'prompt', text: text(data.text) }];
    if (data.hook !== 'tool') return [];
    const args = data.args ?? {};
    if (data.tool === 'bash') return shell(args.command);
    if (data.tool === 'patch') return patch(args.patchText ?? args.patch);
    if ((data.tool === 'write' || data.tool === 'edit') && typeof args.filePath === 'string') {
      return [write(args.filePath, args.content ?? args.newString)];
    }
    return [];
  }

  return [];
}

export function evaluate({ harness, payload, root, gates, now = Date.now() }) {
  const events = normalize(harness, payload, root);
  const { config, warnings } = loadConfig(root);
  const notes = [];
  const ctx = {
    root,
    harness,
    config,
    run: findRun(root, now),
    state: stateStore(root),
    now,
    matchesGlob,
  };

  for (const event of events) {
    const guard = selfProtect(event, root);
    if (guard) return { events, block: guard, notes, warnings };
    for (const gate of gates) {
      let result;
      try {
        result = gate.check(event, ctx);
      } catch (error) {
        warnings.push(`forgeflow: gate ${gate.name} failed (${error.message}) and was skipped.`);
        continue;
      }
      if (result?.block) return { events, block: result.block, notes, warnings };
      if (result?.note) notes.push(result.note);
    }
  }
  return { events, notes, warnings };
}

export function respond(harness, payload, { events, block, notes, warnings }) {
  const allow = { code: 0, stdout: '', stderr: '' };
  const isStop = events.some((event) => event.kind === 'stop');
  // Warnings ride along with a prompt only: on tool calls they would repeat
  // constantly, and on stop they would keep the turn from ending.
  const isPrompt = events.some((event) => event.kind === 'prompt');
  const message = [...notes, ...(isPrompt ? warnings : [])].join('\n');

  if (harness === 'cursor') {
    if (block) {
      const deny = { permission: 'deny', user_message: block, agent_message: block };
      return { code: 2, stdout: JSON.stringify(deny), stderr: block };
    }
    if (isStop && message) return { ...allow, stdout: JSON.stringify({ followup_message: message }) };
    return allow;
  }

  if (block) return { code: 2, stdout: '', stderr: block };
  if (!message) return allow;
  if (isStop) return { ...allow, stdout: JSON.stringify({ decision: 'block', reason: message }) };
  const context = { hookEventName: payload?.hook_event_name, additionalContext: message };
  return { ...allow, stdout: JSON.stringify({ hookSpecificOutput: context }) };
}

export async function loadGates(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.mjs'))
    .sort();
  const loaded = await Promise.all(
    files.map(async (file) => {
      try {
        const module = await import(pathToFileURL(join(dir, file)).href);
        return typeof module.check === 'function'
          ? { name: file.slice(0, -4), check: module.check }
          : null;
      } catch {
        return null; // a gate that cannot load is skipped
      }
    })
  );
  return loaded.filter(Boolean);
}

export async function handle(harness, payload, { root, gatesDir }) {
  const gates = await loadGates(gatesDir);
  return respond(harness, payload, evaluate({ harness, payload, root, gates }));
}
```

The Cursor block test expects `stderr` to carry the reason too; `respond` returns it. The first `respond` test compares against `{ code: 0, stdout: '', stderr: '' }`, which `allow` matches exactly.

- [ ] **Step 5: Write `catalog/runtime/hooks/run.mjs`**

```js
// Entry point for Claude Code, Codex and Cursor hooks: node run.mjs <harness>
// Any failure here exits 1, which every harness treats as "proceed".
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

try {
  const { handle } = await import('./runtime.mjs');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const out = await handle(process.argv[2], JSON.parse(raw), {
    root: resolve(here, '..', '..'),
    gatesDir: resolve(here, 'gates'),
  });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(`${out.stderr}\n`);
  process.exitCode = out.code;
} catch (error) {
  process.stderr.write(`forgeflow hook failed and was skipped: ${error.message}\n`);
  process.exitCode = 1;
}
```

- [ ] **Step 6: Write `catalog/runtime/hooks/opencode-plugin.js`**

```js
// OpenCode plugin: runs forgeflow gates before tool calls and on user messages.
// Lives in .opencode/plugins/; the runtime and gates live in .opencode/forgeflow/.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '..', 'forgeflow');
const root = resolve(here, '..', '..');

export const ForgeflowGates = async () => {
  let runtime;
  let gates;
  try {
    runtime = await import(pathToFileURL(resolve(dir, 'runtime.mjs')).href);
    gates = await runtime.loadGates(resolve(dir, 'gates'));
  } catch {
    return {}; // a broken install must not stop OpenCode from starting
  }

  const check = (payload) => {
    let result;
    try {
      result = runtime.evaluate({ harness: 'opencode', payload, root, gates });
    } catch {
      return; // fail open
    }
    if (result.block) throw new Error(result.block);
  };

  return {
    'tool.execute.before': async (input, output) => {
      check({ hook: 'tool', tool: input?.tool, args: output?.args });
    },
    'chat.message': async (_input, output) => {
      const parts = Array.isArray(output?.parts) ? output.parts : [];
      const text = parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      check({ hook: 'prompt', text });
    },
  };
};
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/runtime.test.js`
Expected: all pass.

- [ ] **Step 8: Check the real catalog still loads**

Run: `node bin/forgeflow.js doctor; echo "exit=$?"`
Expected: `catalog is valid (14 items)` and `exit=0` (13 phase 1 items plus `runtime:hooks`).

- [ ] **Step 9: Commit**

```bash
git add catalog/runtime tests/runtime.test.js
git commit -m "Add the shipped hook runtime, runner and OpenCode plugin"
```

---

### Task 4: The four gates

**Files:**
- Create: `catalog/hooks/approval-gate/{HOOK.md,gate.mjs}`, `catalog/hooks/secret-guard/{HOOK.md,gate.mjs}`, `catalog/hooks/protected-paths/{HOOK.md,gate.mjs}`, `catalog/hooks/test-reminder/{HOOK.md,gate.mjs}`
- Test: `tests/gates.test.js`

**Interfaces:**
- Consumes: the gate contract and `ctx` from Task 3 (`ctx.run`, `ctx.config`, `ctx.state`, `ctx.now`, `ctx.harness`, `ctx.matchesGlob`).
- Produces: four `check(event, ctx)` functions, and hook ids `hook:approval-gate`, `hook:secret-guard`, `hook:protected-paths`, `hook:test-reminder`.
- The approval record format (read by `findRun` and by the flow skills): first line `decision: approved`, then `recorded-by:`, `date:`, `user-message:` lines.

- [ ] **Step 1: Write the failing test**

`tests/gates.test.js`:

```js
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check as approval } from '../catalog/hooks/approval-gate/gate.mjs';
import { check as protectedPaths } from '../catalog/hooks/protected-paths/gate.mjs';
import { check as secretGuard } from '../catalog/hooks/secret-guard/gate.mjs';
import { check as testReminder } from '../catalog/hooks/test-reminder/gate.mjs';
import { matchesGlob } from '../catalog/runtime/hooks/runtime.mjs';
import { tmpDir } from './helpers.js';

function context(overrides = {}) {
  let stored = {};
  return {
    root: '/work/app',
    harness: 'claude',
    now: Date.UTC(2026, 9, 13, 12),
    run: null,
    config: { releaseCommands: [], protectedPaths: [], secretAllow: [], testCommands: [] },
    matchesGlob,
    state: { get: () => stored, set: (value) => (stored = value) },
    ...overrides,
  };
}
const shell = (command) => ({ kind: 'shell', command });
const write = (path, content = '') => ({ kind: 'write', path, content });
const prompt = (text) => ({ kind: 'prompt', text });

describe('approval-gate', () => {
  const activeRun = (overrides = {}) => {
    const dir = join(tmpDir(), '.forgeflow/runs/20261013-add-login');
    mkdirSync(dir, { recursive: true });
    return { dir, name: '20261013-add-login', status: 'running', stage: 'BUILD', approved: false, ...overrides };
  };
  const waiting = (overrides = {}) =>
    activeRun({ status: 'waiting for user', stage: 'HUMAN_APPROVAL', ...overrides });

  it('never lets an agent write the approval record', () => {
    for (const ctx of [context(), context({ run: waiting() })]) {
      const result = approval(write('.forgeflow/runs/r/09-approval.md', 'decision: approved'), ctx);
      expect(result.block).toContain('09-approval.md');
    }
    expect(approval(write('.forgeflow/runs/r/05-build.md'), context())).toBeUndefined();
    expect(approval(write('docs/09-approval.md'), context())).toBeUndefined();
  });

  it('never lets a shell command touch the approval record', () => {
    const result = approval(shell('echo "decision: approved" > .forgeflow/runs/r/09-approval.md'), context());
    expect(result.block).toContain('09-approval.md');
  });

  it.each([
    'git push',
    'git push origin main --force',
    'cd api && git   push',
    'npm publish',
    'pnpm publish --access public',
    'yarn publish',
    'yarn npm publish',
    'gh release create v1.0.0',
    'gh pr merge 12 --squash',
    'docker push registry/app:1',
    'kubectl apply -f k8s/',
    'terraform apply -auto-approve',
    'helm upgrade app ./chart',
    'helm install app ./chart',
    'GIT PUSH',
  ])('blocks "%s" during an unapproved run', (command) => {
    const result = approval(shell(command), context({ run: activeRun() }));
    expect(result.block).toContain('20261013-add-login');
    expect(result.block).toContain('approve');
  });

  it.each(['git status', 'git pull', 'npm test', 'npm run publish-docs', 'echo git pushed', 'docker build .'])(
    'allows "%s" during an unapproved run',
    (command) => {
      expect(approval(shell(command), context({ run: activeRun() }))).toBeUndefined();
    }
  );

  it('allows release commands when no run is active or the run is approved', () => {
    expect(approval(shell('git push'), context())).toBeUndefined();
    expect(approval(shell('git push'), context({ run: activeRun({ approved: true }) }))).toBeUndefined();
  });

  it('blocks a project-defined release command', () => {
    const ctx = context({ run: activeRun() });
    ctx.config.releaseCommands = [/\bmake\s+deploy\b/i];
    expect(approval(shell('make deploy'), ctx).block).toContain('approve');
    expect(approval(shell('make build'), ctx)).toBeUndefined();
  });

  it.each(['approve', 'Approve', 'APPROVED', '  approve  ', 'approve, ship it', 'approve\nthanks'])(
    'records approval when the user types "%s" at the approval step',
    (text) => {
      const run = waiting();
      const ctx = context({ run, harness: 'codex' });
      const result = approval(prompt(text), ctx);
      expect(result.note).toContain('20261013-add-login');
      const record = readFileSync(join(run.dir, '09-approval.md'), 'utf8').split('\n');
      expect(record[0]).toBe('decision: approved');
      expect(record[1]).toBe('recorded-by: forgeflow approval-gate (codex prompt hook)');
      expect(record[2]).toBe('date: 2026-10-13T12:00:00.000Z');
      expect(record[3]).toBe(`user-message: ${text.trim().replace(/\s+/g, ' ')}`);
    }
  );

  it('records approval at the quick flow SHIP step, whatever the case of the stage', () => {
    const run = waiting({ stage: 'ship' });
    expect(approval(prompt('approve'), context({ run })).note).toBeDefined();
  });

  it.each([
    ['there is no run', null],
    ['the run is still running', { status: 'running', stage: 'HUMAN_APPROVAL' }],
    ['the run waits at another stage', { status: 'waiting for user', stage: 'REQUIREMENT' }],
    ['the run is already approved', { status: 'waiting for user', stage: 'HUMAN_APPROVAL', approved: true }],
  ])('does nothing when %s', (_label, overrides) => {
    const run = overrides ? activeRun(overrides) : null;
    expect(approval(prompt('approve'), context({ run }))).toBeUndefined();
    if (run) expect(existsSync(join(run.dir, '09-approval.md'))).toBe(false);
  });

  it.each(['yes', 'looks good', 'do not approve', 'approvals are pending', 'I approve', ''])(
    'does not treat "%s" as approval',
    (text) => {
      const run = waiting();
      expect(approval(prompt(text), context({ run }))).toBeUndefined();
      expect(existsSync(join(run.dir, '09-approval.md'))).toBe(false);
    }
  );

  it('ignores stop events', () => {
    expect(approval({ kind: 'stop' }, context({ run: activeRun() }))).toBeUndefined();
  });
});

describe('secret-guard', () => {
  // Built by concatenation so this file never contains a literal credential.
  const alnum = (length) => 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2dE3fG4hI5'.repeat(3).slice(0, length);
  const samples = [
    ['AWS access key', `AKIA${'ABCDEFGH12345678'}`],
    ['AWS access key', `ASIA${'ABCDEFGH12345678'}`],
    ['GitHub token', `ghp_${alnum(36)}`],
    ['GitHub token', `gho_${alnum(36)}`],
    ['GitHub token', `github_pat_${alnum(30)}`],
    ['Slack token', `xoxb-${'123456789012'}-${alnum(12)}`],
    ['Stripe live key', `sk_live_${alnum(24)}`],
    ['Stripe live key', `rk_live_${alnum(24)}`],
    ['Google API key', `AIza${alnum(35)}`],
    ['Anthropic API key', `sk-ant-${alnum(40)}`],
    ['OpenAI API key', `sk-${alnum(40)}`],
    ['OpenAI API key', `sk-proj-${alnum(40)}`],
    ['private key', `-----BEGIN ${'RSA'} PRIVATE KEY-----`],
    ['private key', `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----`],
    ['private key', `-----BEGIN PRIVATE KEY-----`],
  ];

  it.each(samples)('blocks a %s', (kind, secret) => {
    const result = secretGuard(write('src/config.js', `const key = "${secret}";`), context());
    expect(result.block).toContain(kind);
    expect(result.block).toContain('src/config.js');
    expect(result.block).not.toContain(secret);
  });

  it.each([
    ['a short AWS-like id', `AKIA${'ABC'}`],
    ['a public key block', '-----BEGIN PUBLIC KEY-----'],
    ['a certificate block', '-----BEGIN CERTIFICATE-----'],
    ['a Stripe test key', `sk_test_${alnum(24)}`],
    ['a short sk- word', 'sk-short'],
    ['a risk-prefixed word', `risk-${alnum(30)}`],
    ['an environment reference', 'const key = process.env.API_KEY;'],
    ['ordinary code', 'export const token = readToken();'],
    ['empty content', ''],
  ])('allows %s', (_label, content) => {
    expect(secretGuard(write('src/a.js', content), context())).toBeUndefined();
  });

  it('finds a secret on any line', () => {
    const content = ['const a = 1;', `const k = "ghp_${alnum(36)}";`, 'const b = 2;'].join('\n');
    expect(secretGuard(write('a.js', content), context()).block).toContain('GitHub token');
  });

  it('skips a line marked forgeflow-allow-secret', () => {
    const line = `const fixture = "ghp_${alnum(36)}"; // forgeflow-allow-secret`;
    expect(secretGuard(write('test/fixtures.js', line), context())).toBeUndefined();
    const two = `${line}\nconst real = "ghp_${alnum(36)}";`;
    expect(secretGuard(write('a.js', two), context()).block).toContain('GitHub token');
  });

  it('skips matches a project allows', () => {
    const ctx = context();
    ctx.config.secretAllow = [/EXAMPLE/i];
    expect(secretGuard(write('a.md', `AKIA${'EXAMPLE123456789'}`), ctx)).toBeUndefined();
    expect(secretGuard(write('a.md', `AKIA${'ABCDEFGH12345678'}`), ctx).block).toContain('AWS');
  });

  it('ignores events that are not writes', () => {
    expect(secretGuard(shell(`echo ghp_${alnum(36)}`), context())).toBeUndefined();
    expect(secretGuard(prompt(`my key is ghp_${alnum(36)}`), context())).toBeUndefined();
  });
});

describe('protected-paths', () => {
  it.each(['.env', '.env.local', '.env.production', 'api/.env', 'certs/server.pem', 'keys/deploy.key'])(
    'blocks a write to %s',
    (path) => {
      const result = protectedPaths(write(path), context());
      expect(result.block).toContain(path);
      expect(result.block).toContain('protectedPaths');
    }
  );

  it.each(['.env.example', '.env.sample', '.env.template', 'api/.env.example', 'src/env.js', '.envrc', 'README.md'])(
    'allows a write to %s',
    (path) => {
      expect(protectedPaths(write(path), context())).toBeUndefined();
    }
  );

  it('blocks project-defined paths and names the pattern', () => {
    const ctx = context();
    ctx.config.protectedPaths = ['migrations/**', 'package-lock.json'];
    expect(protectedPaths(write('migrations/001_init.sql'), ctx).block).toContain('migrations/**');
    expect(protectedPaths(write('web/package-lock.json'), ctx).block).toContain('package-lock.json');
    expect(protectedPaths(write('src/migrations.js'), ctx)).toBeUndefined();
  });

  it('lets a project protect a default-exempt file explicitly', () => {
    const ctx = context();
    ctx.config.protectedPaths = ['.env.example'];
    expect(protectedPaths(write('.env.example'), ctx).block).toContain('.env.example');
  });

  it('handles an absolute path outside the project', () => {
    expect(protectedPaths(write('/home/dev/.env'), context()).block).toContain('/home/dev/.env');
    expect(protectedPaths(write('/etc/hosts'), context())).toBeUndefined();
  });

  it('ignores events that are not writes', () => {
    expect(protectedPaths(shell('cat .env'), context())).toBeUndefined();
  });
});

describe('test-reminder', () => {
  const stop = { kind: 'stop' };

  it('says nothing when a turn ends with no edits', () => {
    expect(testReminder(stop, context())).toBeUndefined();
  });

  it('nudges once when a turn ends with edits and no test run', () => {
    const ctx = context();
    testReminder(write('src/a.js'), ctx);
    expect(testReminder(stop, ctx).note).toContain('tests');
    expect(testReminder(stop, ctx)).toBeUndefined();
    testReminder(write('src/b.js'), ctx);
    expect(testReminder(stop, ctx)).toBeUndefined();
  });

  it.each([
    'npm test',
    'npm run test',
    'npm run test:unit',
    'pnpm test',
    'yarn test',
    'bun test',
    'npx vitest run',
    'npx jest --ci',
    'pytest -q',
    'python -m pytest',
    'go test ./...',
    'cargo test',
    'vendor/bin/phpunit',
    'mvn -q test',
    './gradlew test',
    'dotnet test',
    'bundle exec rspec',
    'make test',
  ])('treats "%s" as a test run', (command) => {
    const ctx = context();
    testReminder(write('src/a.js'), ctx);
    testReminder(shell(command), ctx);
    expect(testReminder(stop, ctx)).toBeUndefined();
  });

  it('nudges again for new edits after a test run', () => {
    const ctx = context();
    testReminder(write('src/a.js'), ctx);
    testReminder(stop, ctx);
    testReminder(shell('npm test'), ctx);
    testReminder(write('src/b.js'), ctx);
    expect(testReminder(stop, ctx).note).toBeDefined();
  });

  it.each(['npm install', 'git status', 'echo testing', 'npm run build'])(
    'does not treat "%s" as a test run',
    (command) => {
      const ctx = context();
      testReminder(write('src/a.js'), ctx);
      testReminder(shell(command), ctx);
      expect(testReminder(stop, ctx).note).toBeDefined();
    }
  );

  it('ignores edits to documentation and run files', () => {
    const ctx = context();
    testReminder(write('README.md'), ctx);
    testReminder(write('.forgeflow/runs/r/state.md'), ctx);
    testReminder(write('.forgeflow/runs/r/notes.txt'), ctx);
    expect(testReminder(stop, ctx)).toBeUndefined();
  });

  it('accepts a project-defined test command', () => {
    const ctx = context();
    ctx.config.testCommands = [/\bmake\s+check\b/i];
    testReminder(write('src/a.js'), ctx);
    testReminder(shell('make check'), ctx);
    expect(testReminder(stop, ctx)).toBeUndefined();
  });

  it('never blocks', () => {
    const ctx = context();
    for (const event of [write('src/a.js'), shell('ls'), stop, prompt('hi')]) {
      expect(testReminder(event, ctx)?.block).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/gates.test.js`
Expected: FAIL, cannot resolve `../catalog/hooks/approval-gate/gate.mjs`.

- [ ] **Step 3: Write `catalog/hooks/approval-gate/HOOK.md`**

```markdown
---
name: approval-gate
description: Blocks release commands during a forgeflow run until a person types approve, and records that approval itself so the model cannot.
events: [shell, write, prompt]
---
While a forgeflow run is in progress and has no recorded approval, this gate blocks agent-issued release commands: `git push`, `npm publish`, `pnpm publish`, `yarn publish`, `gh release create`, `gh pr merge`, `docker push`, `kubectl apply`, `terraform apply`, `helm upgrade` and `helm install`. Add your own under `releaseCommands` in `.forgeflow/config.json`.

When the flow reaches its approval step and you type `approve`, the gate writes `09-approval.md` in the run folder. Agents are blocked from writing that file or naming it in a shell command.

Outside a run, nothing is blocked. A run that has been idle for 24 hours no longer gates.
```

- [ ] **Step 4: Write `catalog/hooks/approval-gate/gate.mjs`**

```js
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RELEASE = [
  /\bgit\s+push\b/i,
  /\b(npm|pnpm)\s+publish\b/i,
  /\byarn\s+(npm\s+)?publish\b/i,
  /\bgh\s+release\s+create\b/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bdocker\s+push\b/i,
  /\bkubectl\s+apply\b/i,
  /\bterraform\s+apply\b/i,
  /\bhelm\s+(upgrade|install)\b/i,
];
const RECORD = /(^|\/)\.forgeflow\/runs\/[^/]+\/09-approval\.md$/;
const APPROVE = /^approved?$|^approve[\s,.!]/i;
const APPROVAL_STAGES = new Set(['human_approval', 'ship']);
const HOW = 'A person approves by typing "approve" when the flow asks.';

export function check(event, ctx) {
  if (event.kind === 'write') {
    if (!RECORD.test(event.path)) return undefined;
    return { block: `forgeflow approval-gate: agents may not write 09-approval.md. ${HOW}` };
  }

  if (event.kind === 'shell') {
    if (event.command.includes('09-approval.md')) {
      return {
        block:
          'forgeflow approval-gate: shell commands may not touch 09-approval.md. ' +
          'Read it with your file-reading capability instead.',
      };
    }
    const run = ctx.run;
    if (!run || run.approved) return undefined;
    const isRelease = [...RELEASE, ...ctx.config.releaseCommands].some((pattern) =>
      pattern.test(event.command)
    );
    if (!isRelease) return undefined;
    return {
      block:
        `forgeflow approval-gate: this release command is blocked because flow run ${run.name} ` +
        `has no recorded human approval. Complete the flow's approval step first. ${HOW}`,
    };
  }

  if (event.kind === 'prompt') {
    const run = ctx.run;
    const said = event.text.trim();
    if (!run || run.approved || !APPROVE.test(said)) return undefined;
    const atApprovalStep =
      run.status.startsWith('waiting for user') && APPROVAL_STAGES.has(run.stage.toLowerCase());
    if (!atApprovalStep) return undefined;

    const record = [
      'decision: approved',
      `recorded-by: forgeflow approval-gate (${ctx.harness} prompt hook)`,
      `date: ${new Date(ctx.now).toISOString()}`,
      `user-message: ${said.replace(/\s+/g, ' ')}`,
      '',
    ].join('\n');
    writeFileSync(join(run.dir, '09-approval.md'), record);
    return { note: `forgeflow: human approval recorded for run ${run.name} in 09-approval.md.` };
  }

  return undefined;
}
```

- [ ] **Step 5: Write `catalog/hooks/secret-guard/HOOK.md`**

```markdown
---
name: secret-guard
description: Blocks a file write whose new text contains a credential in a known format, such as a cloud access key, an API token or a private key.
events: [write]
---
Checks the text an agent is about to write. It recognizes AWS access key ids, GitHub tokens, Slack tokens, Stripe live keys, Google API keys, Anthropic and OpenAI API keys, and PEM private key headers.

It matches known formats only. It does not guess at passwords, so it stays quiet on ordinary code.

To allow a false positive, add `forgeflow-allow-secret` to that line, or add a pattern under `secretAllow` in `.forgeflow/config.json`.

It sees file-writing tools only. A secret written by a shell command is not seen.
```

- [ ] **Step 6: Write `catalog/hooks/secret-guard/gate.mjs`**

```js
const PATTERNS = [
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI API key', /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/],
  ['private key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
];
const ALLOW_MARK = 'forgeflow-allow-secret';

export function check(event, ctx) {
  if (event.kind !== 'write') return undefined;

  for (const line of event.content.split('\n')) {
    if (line.includes(ALLOW_MARK)) continue;
    for (const [kind, pattern] of PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      if (ctx.config.secretAllow.some((allow) => allow.test(match[0]))) continue;
      return {
        block:
          `forgeflow secret-guard: the text being written to ${event.path} looks like it ` +
          `contains a ${kind}. Read it from an environment variable or a secret store instead. ` +
          `If this is a false positive, a person can add ${ALLOW_MARK} to that line.`,
      };
    }
  }
  return undefined;
}
```

- [ ] **Step 7: Write `catalog/hooks/protected-paths/HOOK.md`**

```markdown
---
name: protected-paths
description: Blocks agent writes to files a project marks off-limits, such as environment files, private keys, applied migrations or lockfiles.
events: [write]
---
By default it protects `.env` and `.env.*` (but not `.env.example`, `.env.sample` or `.env.template`), `*.pem` and `*.key`.

Add your own globs under `protectedPaths` in `.forgeflow/config.json`. A glob with no `/` matches that file name in any folder; `*`, `**` and `?` are supported.

It sees file-writing tools only. A file changed by a shell command is not seen.
```

- [ ] **Step 8: Write `catalog/hooks/protected-paths/gate.mjs`**

```js
const DEFAULTS = ['.env', '.env.*', '*.pem', '*.key'];
// Committed templates that the .env.* default would otherwise catch.
const TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

export function check(event, ctx) {
  if (event.kind !== 'write') return undefined;

  const name = event.path.split('/').pop();
  const matches = (glob) => ctx.matchesGlob(event.path, glob);
  const pattern =
    ctx.config.protectedPaths.find(matches) ??
    (TEMPLATES.has(name) ? undefined : DEFAULTS.find(matches));
  if (!pattern) return undefined;

  return {
    block:
      `forgeflow protected-paths: ${event.path} is protected (${pattern}). A person must change ` +
      'this file, or remove the pattern from protectedPaths in .forgeflow/config.json.',
  };
}
```

- [ ] **Step 9: Write `catalog/hooks/test-reminder/HOOK.md`**

```markdown
---
name: test-reminder
description: Nudges the agent once when a turn ends with source edits and no test run since. Advisory only; it never blocks.
events: [shell, write, stop]
---
It notes when an agent changes a source file and when it runs a test command. If the agent ends its turn with edits and no test run since, it is asked once to run the tests or tell you why it did not.

Recognized test commands include `npm test`, `pnpm test`, `yarn test`, `bun test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `phpunit`, `mvn test`, `gradle test`, `dotnet test`, `rspec` and `make test`. Add your own under `testCommands` in `.forgeflow/config.json`.

Markdown files and anything under `.forgeflow/` do not count as source edits.

Not supported on OpenCode, which cannot send a message back to the agent at the end of a turn.
```

- [ ] **Step 10: Write `catalog/hooks/test-reminder/gate.mjs`**

```js
const TEST_COMMANDS = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/i,
  /\b(vitest|jest|pytest|phpunit|rspec)\b/i,
  /\b(go|cargo|dotnet)\s+test\b/i,
  /\b(mvn|gradle|gradlew)\b.*\btest\b/i,
  /\bmake\s+test\b/i,
];
const NUDGE =
  'forgeflow test-reminder: files were changed and no test command has run since. ' +
  "Run the project's tests now, or tell the user why you did not.";

const isSource = (path) => !path.startsWith('.forgeflow/') && !path.endsWith('.md');

export function check(event, ctx) {
  const state = ctx.state.get();

  if (event.kind === 'write') {
    if (isSource(event.path) && !state.dirty) ctx.state.set({ ...state, dirty: true });
    return undefined;
  }

  if (event.kind === 'shell') {
    const ranTests = [...TEST_COMMANDS, ...ctx.config.testCommands].some((pattern) =>
      pattern.test(event.command)
    );
    if (ranTests && (state.dirty || state.reminded)) ctx.state.set({ dirty: false, reminded: false });
    return undefined;
  }

  if (event.kind === 'stop' && state.dirty && !state.reminded) {
    ctx.state.set({ dirty: true, reminded: true });
    return { note: NUDGE };
  }
  return undefined;
}
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `npx vitest run tests/gates.test.js`
Expected: all pass. If a secret sample fails, fix the pattern in `gate.mjs`, not the sample.

- [ ] **Step 12: Check the listing, then commit**

Run: `node bin/forgeflow.js doctor`
Expected: `catalog is valid (18 items)`.

```bash
git add catalog/hooks tests/gates.test.js
git commit -m "Add approval, secret, protected-path and test-reminder gates"
```

---

### Task 5: Adapters render hooks and describe wiring

**Files:**
- Modify: `src/adapters/shared.js`, `src/adapters/claude.js`, `src/adapters/codex.js`, `src/adapters/cursor.js`, `src/adapters/opencode.js` (full replacements below)
- Test: `tests/hook-adapters.test.js`

**Interfaces:**
- Consumes: hook and runtime item shapes from Task 2; `wiring` shape from Task 1.
- Produces: every adapter's `render` handles `hook` and `runtime` items; every adapter exports `wiring` (`null` for OpenCode).
- Produces, in `shared.js`: `stamp(source, item, version)`, `hookFiles(dir, item, version)`, `commandWiring(path, command, matcher)`.

- [ ] **Step 1: Write the failing test**

`tests/hook-adapters.test.js`:

```js
import { describe, expect, it } from 'vitest';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as cursor from '../src/adapters/cursor.js';
import * as opencode from '../src/adapters/opencode.js';
import { isWired, mergeWiring } from '../src/wiring.js';

const ctx = { scope: 'project', version: '0.2.0' };
const hook = {
  id: 'hook:secret-guard',
  type: 'hook',
  name: 'secret-guard',
  description: 'Blocks secrets.',
  events: ['write'],
  requires: ['runtime:hooks'],
  body: 'About.',
  gate: 'export function check() {}\n',
  files: [],
};
const runtime = {
  id: 'runtime:hooks',
  type: 'runtime',
  name: 'hooks',
  description: 'Runner.',
  requires: [],
  body: 'About.',
  sources: { 'run.mjs': '// run\n', 'runtime.mjs': '// runtime\n', 'opencode-plugin.js': '// plugin\n' },
  files: [],
};

describe.each([
  ['claude', claude, '.claude'],
  ['codex', codex, '.codex'],
  ['cursor', cursor, '.cursor'],
])('%s', (_name, adapter, dir) => {
  it('renders a gate into its forgeflow folder with a marker line', () => {
    expect(adapter.render(hook, ctx)).toEqual([
      {
        path: `${dir}/forgeflow/gates/secret-guard.mjs`,
        content: '// managed by forgeflow: hook:secret-guard@0.2.0\nexport function check() {}\n',
      },
    ]);
  });

  it('renders the runner and runtime', () => {
    expect(adapter.render(runtime, ctx)).toEqual([
      { path: `${dir}/forgeflow/run.mjs`, content: '// managed by forgeflow: runtime:hooks@0.2.0\n// run\n' },
      {
        path: `${dir}/forgeflow/runtime.mjs`,
        content: '// managed by forgeflow: runtime:hooks@0.2.0\n// runtime\n',
      },
    ]);
  });

  it('describes wiring whose every entry runs its own runner', () => {
    const { wiring } = adapter;
    expect(wiring.path.startsWith(`${dir}/`)).toBe(true);
    for (const entry of Object.values(wiring.entries)) {
      const text = JSON.stringify(entry);
      expect(text).toContain(`${dir}/forgeflow/run.mjs`);
      expect(text).toContain('"timeout":10');
    }
    expect(isWired(mergeWiring(undefined, wiring), wiring)).toBe(true);
  });
});

describe('wiring details', () => {
  it('claude wires three events into settings.json', () => {
    const { wiring } = claude;
    expect(wiring.path).toBe('.claude/settings.json');
    expect(wiring.skeleton).toEqual({});
    const handler = {
      type: 'command',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/forgeflow/run.mjs" claude',
      timeout: 10,
    };
    expect(wiring.entries).toEqual({
      PreToolUse: { matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [handler] },
      UserPromptSubmit: { hooks: [handler] },
      Stop: { hooks: [handler] },
    });
  });

  it('codex wires three events into hooks.json and finds the repo root itself', () => {
    const { wiring } = codex;
    expect(wiring.path).toBe('.codex/hooks.json');
    expect(wiring.skeleton).toEqual({});
    expect(Object.keys(wiring.entries)).toEqual(['PreToolUse', 'UserPromptSubmit', 'Stop']);
    expect(wiring.entries.PreToolUse.matcher).toBe('Bash|apply_patch|Edit|Write');
    expect(wiring.entries.Stop.hooks[0].command).toBe(
      'node "$(git rev-parse --show-toplevel)/.codex/forgeflow/run.mjs" codex'
    );
  });

  it('cursor wires three events into a versioned hooks.json', () => {
    const { wiring } = cursor;
    expect(wiring.path).toBe('.cursor/hooks.json');
    expect(wiring.skeleton).toEqual({ version: 1, hooks: {} });
    const entry = { command: 'node .cursor/forgeflow/run.mjs cursor', timeout: 10 };
    expect(wiring.entries).toEqual({ preToolUse: entry, beforeSubmitPrompt: entry, stop: entry });
  });
});

describe('opencode', () => {
  it('renders a gate beside the runtime', () => {
    expect(opencode.render(hook, ctx)[0].path).toBe('.opencode/forgeflow/gates/secret-guard.mjs');
  });

  it('renders the runtime and a plugin, and no runner', () => {
    expect(opencode.render(runtime, ctx)).toEqual([
      {
        path: '.opencode/forgeflow/runtime.mjs',
        content: '// managed by forgeflow: runtime:hooks@0.2.0\n// runtime\n',
      },
      {
        path: '.opencode/plugins/forgeflow.js',
        content: '// managed by forgeflow: runtime:hooks@0.2.0\n// plugin\n',
      },
    ]);
  });

  it('has no config wiring', () => {
    expect(opencode.wiring).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/hook-adapters.test.js`
Expected: FAIL. Rendering a hook item returns an agent file or throws, and `wiring` is undefined.

- [ ] **Step 3: Write `src/adapters/shared.js`**

```js
import { stringify } from 'yaml';

export function marker(item, version) {
  return `managed by forgeflow: ${item.id}@${version}`;
}

export function markdown(data, item, version) {
  const frontmatter = stringify(data, { lineWidth: 0 });
  return `---\n${frontmatter}---\n\n${item.body}\n\n<!-- ${marker(item, version)} -->\n`;
}

export function skillFiles(dir, item, version, extraFrontmatter = {}) {
  const data = { name: item.name, description: item.description, ...extraFrontmatter };
  return [
    { path: `${dir}/SKILL.md`, content: markdown(data, item, version) },
    ...item.files.map((file) => ({ path: `${dir}/${file.path}`, content: file.content })),
  ];
}

export const isHookItem = (item) => item.type === 'hook' || item.type === 'runtime';

// Shipped JavaScript carries the marker as its first line.
export function stamp(source, item, version) {
  return `// ${marker(item, version)}\n${source}`;
}

// dir is the target's forgeflow folder, such as ".claude/forgeflow".
export function hookFiles(dir, item, version) {
  if (item.type === 'hook') {
    return [{ path: `${dir}/gates/${item.name}.mjs`, content: stamp(item.gate, item, version) }];
  }
  return ['run.mjs', 'runtime.mjs'].map((file) => ({
    path: `${dir}/${file}`,
    content: stamp(item.sources[file], item, version),
  }));
}

// Wiring in the shape Claude Code and Codex share.
export function commandWiring(path, command, matcher) {
  const handler = { type: 'command', command, timeout: 10 };
  return {
    path,
    skeleton: {},
    entries: {
      PreToolUse: { matcher, hooks: [handler] },
      UserPromptSubmit: { hooks: [handler] },
      Stop: { hooks: [handler] },
    },
  };
}
```

- [ ] **Step 4: Write `src/adapters/claude.js`**

```js
import { commandWiring, hookFiles, isHookItem, markdown, skillFiles } from './shared.js';

const MODELS = { fast: 'haiku', balanced: 'sonnet', strong: 'opus' };

export const name = 'claude';

export const wiring = commandWiring(
  '.claude/settings.json',
  'node "$CLAUDE_PROJECT_DIR/.claude/forgeflow/run.mjs" claude',
  'Bash|Write|Edit|MultiEdit|NotebookEdit'
);

export function root(scope, { cwd, home }) {
  return scope === 'global' ? home : cwd;
}

export function render(item, { version }) {
  if (isHookItem(item)) return hookFiles('.claude/forgeflow', item, version);
  if (item.type === 'skill') {
    const extra = item.userInvocableOnly ? { 'disable-model-invocation': true } : {};
    return skillFiles(`.claude/skills/${item.name}`, item, version, extra);
  }
  const data = { name: item.name, description: item.description };
  // Read-only agents keep Bash so they can run tests and git diff.
  if (item.access === 'read-only') data.tools = 'Read, Grep, Glob, Bash';
  data.model = MODELS[item.modelTier];
  return [{ path: `.claude/agents/${item.name}.md`, content: markdown(data, item, version) }];
}
```

- [ ] **Step 5: Write `src/adapters/codex.js`**

```js
import { commandWiring, hookFiles, isHookItem, marker, skillFiles } from './shared.js';

// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const escapeControl = (text) =>
  text.replace(CONTROL, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

// JSON string escapes are a subset of TOML basic-string escapes.
const basic = (text) => JSON.stringify(text).replace(/\u007f/g, '\\u007f');

// Body of a TOML multi-line basic string: keep newlines and single quotes
// readable, escape only what would end or corrupt the string.
const multiline = (text) => escapeControl(text.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"'));

export const name = 'codex';

// Codex runs hooks from the session's working directory, so the runner is
// located through git rather than a relative path.
export const wiring = commandWiring(
  '.codex/hooks.json',
  'node "$(git rev-parse --show-toplevel)/.codex/forgeflow/run.mjs" codex',
  'Bash|apply_patch|Edit|Write'
);

export function root(scope, { cwd, home }) {
  return scope === 'global' ? home : cwd;
}

export function render(item, { version }) {
  if (isHookItem(item)) return hookFiles('.codex/forgeflow', item, version);
  if (item.type === 'skill') return skillFiles(`.agents/skills/${item.name}`, item, version);
  const sandbox = item.access === 'read-only' ? 'read-only' : 'workspace-write';
  const content = [
    `# ${marker(item, version)}`,
    `name = ${basic(item.name)}`,
    `description = ${basic(item.description)}`,
    `sandbox_mode = ${basic(sandbox)}`,
    'developer_instructions = """',
    multiline(item.body),
    '"""',
    '',
  ].join('\n');
  return [{ path: `.codex/agents/${item.name}.toml`, content }];
}
```

- [ ] **Step 6: Write `src/adapters/cursor.js`**

```js
import { hookFiles, isHookItem, markdown, skillFiles } from './shared.js';

export const name = 'cursor';

// Cursor runs project hooks from the project root.
const entry = { command: 'node .cursor/forgeflow/run.mjs cursor', timeout: 10 };

export const wiring = {
  path: '.cursor/hooks.json',
  skeleton: { version: 1, hooks: {} },
  entries: { preToolUse: entry, beforeSubmitPrompt: entry, stop: entry },
};

export function root(scope, { cwd, home }) {
  return scope === 'global' ? home : cwd;
}

export function render(item, { version }) {
  if (isHookItem(item)) return hookFiles('.cursor/forgeflow', item, version);
  if (item.type === 'skill') {
    const extra = item.userInvocableOnly ? { 'disable-model-invocation': true } : {};
    return skillFiles(`.cursor/skills/${item.name}`, item, version, extra);
  }
  const data = {
    name: item.name,
    description: item.description,
    readonly: item.access === 'read-only',
  };
  return [{ path: `.cursor/agents/${item.name}.md`, content: markdown(data, item, version) }];
}
```

- [ ] **Step 7: Write `src/adapters/opencode.js`**

```js
import { join } from 'node:path';
import { hookFiles, markdown, skillFiles, stamp } from './shared.js';

export const name = 'opencode';

// OpenCode has no hook config file: the plugin below is the wiring.
export const wiring = null;

export function root(scope, { cwd, home }) {
  return scope === 'global' ? join(home, '.config', 'opencode') : cwd;
}

export function render(item, { scope, version }) {
  if (item.type === 'hook') return hookFiles('.opencode/forgeflow', item, version);
  if (item.type === 'runtime') {
    return [
      {
        path: '.opencode/forgeflow/runtime.mjs',
        content: stamp(item.sources['runtime.mjs'], item, version),
      },
      {
        path: '.opencode/plugins/forgeflow.js',
        content: stamp(item.sources['opencode-plugin.js'], item, version),
      },
    ];
  }
  const prefix = scope === 'global' ? '' : '.opencode/';
  if (item.type === 'skill') {
    const extra = item.userInvocableOnly
      ? { metadata: { 'opencode/autoinvoke': 'false', 'opencode/slash': 'true' } }
      : {};
    return skillFiles(`${prefix}skills/${item.name}`, item, version, extra);
  }
  const data = { description: item.description, mode: 'subagent' };
  if (item.access === 'read-only') data.permission = { edit: 'deny' };
  return [{ path: `${prefix}agents/${item.name}.md`, content: markdown(data, item, version) }];
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/hook-adapters.test.js tests/adapters.test.js`
Expected: all pass, including the unchanged phase 1 adapter tests.

- [ ] **Step 9: Commit**

```bash
git add src/adapters tests/hook-adapters.test.js
git commit -m "Render hook and runtime items and describe wiring per harness"
```

---
### Task 6: Install and remove wiring

**Files:**
- Modify: `src/plan.js`, `src/apply.js`, `src/lock.js`, `src/ops.js` (full replacements below)
- Test: `tests/hook-ops.test.js`

**Interfaces:**
- Consumes: `mergeWiring`, `stripWiring`, `isWired`, `parseConfig`, `serialize`, `RUNTIME_ID` (Task 1); adapters' `wiring` (Task 5).
- Produces, in `src/plan.js`:
  - `planWire(root, wiring, previous?) → { action: { type: 'wire'|'skip', path, content }, record: { path, created: boolean } }` (throws `ConfigError`)
  - `planUnwire(root, record, skeleton?) → { type: 'unwire'|'delete'|'skip'|'missing', path, content? }` (throws `ConfigError`)
  - `wiringState(root, wiring) → 'ok' | 'missing' | 'unreadable'`
- `applyActions` writes `wire` and `unwire` actions; they are never conflicts and ignore `force`.
- Lockfile: the `runtime:hooks` entry may carry `wiring: { path, created }`, validated by `readLock`.
- `add` / `update`: when `runtime:hooks` is among the entries and the adapter has wiring, the wiring action is applied after the files and reported as `{ id: 'runtime:hooks', type, path }` at the end of the target's actions.
- `remove`: when `runtime:hooks` is being removed and has a wiring record, the unwire action is applied before the files and reported first.
- `add` / `update` with `ctx.scope === 'global'` and any hook or runtime item throws `UsageError`.
- `status` entries gain `wiring: null | { path, state }`.

- [ ] **Step 1: Write the failing test**

`tests/hook-ops.test.js`:

```js
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as claudeAdapter from '../src/adapters/claude.js';
import * as cursorAdapter from '../src/adapters/cursor.js';
import { loadCatalog } from '../src/catalog.js';
import { ConfigError, LockError, UsageError } from '../src/errors.js';
import { lockPath, readLock } from '../src/lock.js';
import { add, remove, status, update } from '../src/ops.js';
import { isWired } from '../src/wiring.js';
import { agentMd, tmpDir, writeTree } from './helpers.js';
import { hookTree, runtimeTree } from './hook-helpers.js';

const RUNTIME = 'runtime:hooks';
const tree = {
  'agents/alpha.md': agentMd('alpha'),
  ...runtimeTree(),
  ...hookTree('g1'),
  ...hookTree('g2'),
};

let catalog;
let cwd;
let home;
const ctx = (overrides = {}) => ({
  catalog,
  version: '0.1.0',
  scope: 'project',
  cwd,
  home,
  force: false,
  dryRun: false,
  ...overrides,
});
const at = (path) => join(cwd, path);
const json = (path) => JSON.parse(readFileSync(at(path), 'utf8'));
const rows = (result) => result.plans[0].actions.map((action) => [action.id, action.type, action.path]);
const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: './my-hook.sh' }] };
const userSettings = { permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [mine] } };

beforeEach(() => {
  catalog = loadCatalog(writeTree(tmpDir(), tree));
  cwd = tmpDir();
  home = tmpDir();
});

describe('adding a gate', () => {
  it('installs the gate, the runner and the wiring, and records them', () => {
    const result = add(ctx(), ['g1'], ['claude']);
    expect(rows(result)).toEqual([
      [RUNTIME, 'create', '.claude/forgeflow/run.mjs'],
      [RUNTIME, 'create', '.claude/forgeflow/runtime.mjs'],
      ['hook:g1', 'create', '.claude/forgeflow/gates/g1.mjs'],
      [RUNTIME, 'wire', '.claude/settings.json'],
    ]);
    expect(readFileSync(at('.claude/forgeflow/gates/g1.mjs'), 'utf8')).toBe(
      '// managed by forgeflow: hook:g1@0.1.0\nexport function check() {}\n// g1\n'
    );
    expect(isWired(json('.claude/settings.json'), claudeAdapter.wiring)).toBe(true);

    const { items } = readLock(cwd).targets.claude;
    expect(items['hook:g1'].explicit).toBe(true);
    expect(items[RUNTIME].explicit).toBe(false);
    expect(items[RUNTIME].wiring).toEqual({ path: '.claude/settings.json', created: true });
    expect(items['hook:g1'].wiring).toBeUndefined();
  });

  it('merges into an existing config and keeps everything in it', () => {
    writeTree(cwd, { '.claude/settings.json': JSON.stringify(userSettings) });
    add(ctx(), ['g1'], ['claude']);
    const settings = json('.claude/settings.json');
    expect(settings.permissions).toEqual(userSettings.permissions);
    expect(settings.hooks.PreToolUse[0]).toEqual(mine);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(readLock(cwd).targets.claude.items[RUNTIME].wiring.created).toBe(false);
  });

  it('leaves the wiring alone when a second gate is added', () => {
    add(ctx(), ['g1'], ['claude']);
    const before = readFileSync(at('.claude/settings.json'), 'utf8');
    const result = add(ctx(), ['g2'], ['claude']);
    expect(rows(result).at(-1)).toEqual([RUNTIME, 'skip', '.claude/settings.json']);
    expect(readFileSync(at('.claude/settings.json'), 'utf8')).toBe(before);
    expect(readLock(cwd).targets.claude.items[RUNTIME].wiring.created).toBe(true);
  });

  it('restores wiring the user deleted, on update', () => {
    add(ctx(), ['g1'], ['claude']);
    writeFileSync(at('.claude/settings.json'), '{}');
    const result = update(ctx(), [], undefined);
    expect(rows(result).at(-1)).toEqual([RUNTIME, 'wire', '.claude/settings.json']);
    expect(isWired(json('.claude/settings.json'), claudeAdapter.wiring)).toBe(true);
  });

  it('creates a versioned hooks.json for Cursor', () => {
    add(ctx(), ['g1'], ['cursor']);
    const config = json('.cursor/hooks.json');
    expect(config.version).toBe(1);
    expect(isWired(config, cursorAdapter.wiring)).toBe(true);
    expect(existsSync(at('.cursor/forgeflow/run.mjs'))).toBe(true);
  });

  it('installs a plugin and no config wiring for OpenCode', () => {
    const result = add(ctx(), ['g1'], ['opencode']);
    expect(rows(result)).toEqual([
      [RUNTIME, 'create', '.opencode/forgeflow/runtime.mjs'],
      [RUNTIME, 'create', '.opencode/plugins/forgeflow.js'],
      ['hook:g1', 'create', '.opencode/forgeflow/gates/g1.mjs'],
    ]);
    expect(readLock(cwd).targets.opencode.items[RUNTIME].wiring).toBeUndefined();
  });

  it('does not wire when only agents are installed', () => {
    add(ctx(), ['alpha'], ['claude']);
    expect(existsSync(at('.claude/settings.json'))).toBe(false);
    expect(existsSync(at('.claude/forgeflow'))).toBe(false);
  });

  it('writes nothing on a dry run', () => {
    const result = add(ctx({ dryRun: true }), ['g1'], ['claude']);
    expect(rows(result).at(-1)).toEqual([RUNTIME, 'wire', '.claude/settings.json']);
    expect(existsSync(at('.claude'))).toBe(false);
  });

  it.each([
    ['invalid JSON', '{ broken'],
    ['a list', '[]'],
    ['a wrong hooks shape', '{"hooks":[]}'],
  ])('refuses a config that is %s and writes to no target, even with force', (_label, text) => {
    writeTree(cwd, { '.claude/settings.json': text });
    for (const force of [false, true]) {
      expect(() => add(ctx({ force }), ['g1'], ['cursor', 'claude'])).toThrow(ConfigError);
      expect(() => add(ctx({ force }), ['g1'], ['cursor', 'claude'])).toThrow('.claude/settings.json');
    }
    expect(readFileSync(at('.claude/settings.json'), 'utf8')).toBe(text);
    expect(existsSync(at('.cursor'))).toBe(false);
    expect(existsSync(at('.claude/forgeflow'))).toBe(false);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('refuses to install gates globally', () => {
    expect(() => add(ctx({ scope: 'global' }), ['g1'], ['claude'])).toThrow(UsageError);
    expect(() => add(ctx({ scope: 'global' }), ['g1'], ['claude'])).toThrow('per project');
    expect(existsSync(join(home, '.claude'))).toBe(false);
    add(ctx({ scope: 'global' }), ['alpha'], ['claude']);
    expect(existsSync(join(home, '.claude/agents/alpha.md'))).toBe(true);
  });
});

describe('removing a gate', () => {
  it('keeps the runner and wiring while another gate remains', () => {
    add(ctx(), ['g1', 'g2'], ['claude']);
    const result = remove(ctx(), ['g1'], ['claude']);
    expect(rows(result)).toEqual([['hook:g1', 'delete', '.claude/forgeflow/gates/g1.mjs']]);
    expect(existsSync(at('.claude/forgeflow/run.mjs'))).toBe(true);
    expect(isWired(json('.claude/settings.json'), claudeAdapter.wiring)).toBe(true);
  });

  it('removes the runner, the wiring and a config file it created with the last gate', () => {
    add(ctx(), ['g1'], ['claude']);
    const result = remove(ctx(), ['g1'], ['claude']);
    expect(rows(result)[0]).toEqual([RUNTIME, 'delete', '.claude/settings.json']);
    expect(existsSync(at('.claude'))).toBe(false);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('leaves the user config exactly as it was before the install', () => {
    writeTree(cwd, { '.claude/settings.json': JSON.stringify(userSettings) });
    add(ctx(), ['g1'], ['claude']);
    const result = remove(ctx(), ['g1'], ['claude']);
    expect(rows(result)[0]).toEqual([RUNTIME, 'unwire', '.claude/settings.json']);
    expect(json('.claude/settings.json')).toEqual(userSettings);
    expect(existsSync(at('.claude/forgeflow'))).toBe(false);
  });

  it('keeps a created config the user has since added to', () => {
    add(ctx(), ['g1'], ['claude']);
    const settings = json('.claude/settings.json');
    settings.model = 'opus';
    writeFileSync(at('.claude/settings.json'), JSON.stringify(settings));
    remove(ctx(), ['g1'], ['claude']);
    expect(json('.claude/settings.json')).toEqual({ model: 'opus' });
  });

  it('deletes a Cursor hooks.json it created', () => {
    add(ctx(), ['g1'], ['cursor']);
    remove(ctx(), ['g1'], ['cursor']);
    expect(existsSync(at('.cursor'))).toBe(false);
  });

  it('succeeds when the user already deleted the config', () => {
    add(ctx(), ['g1'], ['claude']);
    writeFileSync(at('.claude/settings.json'), '{}');
    expect(rows(remove(ctx(), ['g1'], ['claude']))[0]).toEqual([RUNTIME, 'skip', '.claude/settings.json']);
    expect(json('.claude/settings.json')).toEqual({});
  });

  it('refuses to remove the runtime while a gate needs it', () => {
    add(ctx(), ['g1'], ['claude']);
    expect(() => remove(ctx(), [RUNTIME], ['claude'])).toThrow('hook:g1 requires it');
  });

  it('writes nothing on a dry run', () => {
    add(ctx(), ['g1'], ['claude']);
    const before = readFileSync(at('.claude/settings.json'), 'utf8');
    remove(ctx({ dryRun: true }), ['g1'], ['claude']);
    expect(readFileSync(at('.claude/settings.json'), 'utf8')).toBe(before);
    expect(existsSync(at('.claude/forgeflow/gates/g1.mjs'))).toBe(true);
  });
});

describe('status', () => {
  it('reports wiring per target', () => {
    add(ctx(), ['g1'], ['claude', 'opencode']);
    add(ctx(), ['alpha'], ['cursor']);
    const byTarget = Object.fromEntries(status(ctx()).map((entry) => [entry.target, entry.wiring]));
    expect(byTarget).toEqual({
      claude: { path: '.claude/settings.json', state: 'ok' },
      opencode: null,
      cursor: null,
    });
  });

  it('reports wiring the user removed or broke', () => {
    add(ctx(), ['g1'], ['claude']);
    writeFileSync(at('.claude/settings.json'), '{}');
    expect(status(ctx())[0].wiring.state).toBe('missing');
    writeFileSync(at('.claude/settings.json'), '{ broken');
    expect(status(ctx())[0].wiring.state).toBe('unreadable');
  });
});

describe('lockfile wiring record', () => {
  const tamper = (wiring) => {
    add(ctx(), ['g1'], ['claude']);
    const lock = JSON.parse(readFileSync(lockPath(cwd), 'utf8'));
    lock.targets.claude.items[RUNTIME].wiring = wiring;
    writeFileSync(lockPath(cwd), JSON.stringify(lock));
  };

  it.each([
    ['a path outside the project', { path: '../settings.json', created: true }],
    ['an absolute path', { path: '/etc/settings.json', created: true }],
    ['a missing created flag', { path: '.claude/settings.json' }],
    ['a non-object', 'yes'],
  ])('refuses %s', (_label, wiring) => {
    tamper(wiring);
    expect(() => readLock(cwd)).toThrow(LockError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/hook-ops.test.js`
Expected: FAIL. The first test finds no `wire` action and no `.claude/settings.json`.

- [ ] **Step 3: Write `src/plan.js`**

```js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './lock.js';
import { isWired, mergeWiring, parseConfig, serialize, stripWiring } from './wiring.js';

const EDITED = 'was edited after install';
const FOREIGN = 'exists and was not installed by forgeflow';

function diskHash(root, path) {
  const full = join(root, path);
  return existsSync(full) ? sha256(readFileSync(full)) : null;
}

export function planInstall(root, files, recorded) {
  const known = new Map(recorded.map((entry) => [entry.path, entry.sha256]));

  const actions = files.map(({ path, content }) => {
    const have = diskHash(root, path);
    if (have === null) return { type: 'create', path, content };
    if (have === sha256(content)) return { type: 'skip', path, content };
    if (!known.has(path)) return { type: 'conflict', path, content, reason: FOREIGN };
    if (known.get(path) !== have) return { type: 'conflict', path, content, reason: EDITED };
    return { type: 'update', path, content };
  });

  const rendered = new Set(files.map((file) => file.path));
  for (const entry of recorded) {
    if (rendered.has(entry.path)) continue;
    const have = diskHash(root, entry.path);
    if (have === null) continue;
    actions.push(
      have === entry.sha256
        ? { type: 'delete', path: entry.path }
        : { type: 'keep', path: entry.path, reason: EDITED }
    );
  }
  return actions;
}

export function planRemove(root, recorded) {
  return recorded.map((entry) => {
    const have = diskHash(root, entry.path);
    if (have === null) return { type: 'missing', path: entry.path };
    if (have === entry.sha256) return { type: 'delete', path: entry.path };
    return { type: 'keep', path: entry.path, reason: EDITED };
  });
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Returns the parsed harness config, or undefined when the file does not exist.
function readConfig(root, path) {
  const full = join(root, path);
  return existsSync(full) ? parseConfig(readFileSync(full, 'utf8'), path) : undefined;
}

// previous is the lockfile's wiring record for this target, if there is one.
export function planWire(root, wiring, previous) {
  const current = readConfig(root, wiring.path);
  const merged = mergeWiring(current, wiring);
  const type = current !== undefined && same(current, merged) ? 'skip' : 'wire';
  const created = current === undefined ? true : (previous?.created ?? false);
  return {
    action: { type, path: wiring.path, content: serialize(merged) },
    record: { path: wiring.path, created },
  };
}

export function planUnwire(root, record, skeleton = {}) {
  const { path } = record;
  const current = readConfig(root, path);
  if (current === undefined) return { type: 'missing', path };
  const stripped = stripWiring(current, skeleton);
  if (same(stripped, current)) return { type: 'skip', path };
  if (record.created && same(stripped, skeleton)) return { type: 'delete', path };
  return { type: 'unwire', path, content: serialize(stripped) };
}

export function wiringState(root, wiring) {
  try {
    const current = readConfig(root, wiring.path);
    return current !== undefined && isWired(current, wiring) ? 'ok' : 'missing';
  } catch {
    return 'unreadable';
  }
}
```

- [ ] **Step 4: Write `src/apply.js`**

```js
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// wire and unwire rewrite a harness config with only forgeflow's entries
// changed, so they are never conflicts and do not depend on force.
const ALWAYS = new Set(['create', 'update', 'delete', 'wire', 'unwire']);
const WITH_FORCE = new Set(['conflict', 'keep']);

function touchesDisk(action, force) {
  return ALWAYS.has(action.type) || (force && WITH_FORCE.has(action.type));
}

export function checkWritable(root, actions, force = false) {
  for (const action of actions) {
    if (!touchesDisk(action, force)) continue;
    let dir = dirname(join(root, action.path));
    while (!existsSync(dir)) dir = dirname(dir);
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory`);
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      throw new Error(`no write permission for ${dir}`);
    }
  }
}

function writeAtomic(full, content) {
  mkdirSync(dirname(full), { recursive: true });
  const tmp = `${full}.forgeflow-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, full);
}

function removeAndPrune(root, path) {
  rmSync(join(root, path), { force: true });
  let dir = dirname(join(root, path));
  // Pruning is tidying, not part of the delete: never fail on it, never unlink a symlink.
  try {
    while (dir !== root && dir.startsWith(root) && !lstatSync(dir).isSymbolicLink()) {
      if (readdirSync(dir).length > 0) break;
      rmdirSync(dir);
      dir = dirname(dir);
    }
  } catch {
    // leave the directory in place
  }
}

export function applyActions(root, actions, force = false) {
  for (const action of actions) {
    if (!touchesDisk(action, force)) continue;
    if (action.content !== undefined) writeAtomic(join(root, action.path), action.content);
    else removeAndPrune(root, action.path);
  }
}
```

- [ ] **Step 5: Write `src/lock.js`**

```js
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LockError } from './errors.js';

export const LOCK_VERSION = 1;

export function lockPath(base) {
  return join(base, '.forgeflow', 'lock.json');
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// The lockfile is shared input (teams commit it), so its paths are not trusted:
// a path that leaves the install root could make remove or update delete anything.
function isSafePath(path) {
  if (typeof path !== 'string' || path === '' || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split('/').includes('..');
}

function validate(path, lock) {
  const malformed = (what) =>
    new LockError(`${path} is malformed: ${what}. Fix or delete it, then re-run.`);
  const requireSafe = (candidate, id) => {
    if (isSafePath(candidate)) return;
    throw new LockError(
      `${path} contains an unsafe file path (${JSON.stringify(candidate)}) for ${id}. ` +
        'Paths must be relative and stay inside the install directory. Fix or delete the lockfile.'
    );
  };

  if (!isObject(lock.targets)) throw malformed('"targets" must be an object');
  for (const [target, entry] of Object.entries(lock.targets)) {
    if (!isObject(entry) || !isObject(entry.items)) {
      throw malformed(`target "${target}" has no items`);
    }
    for (const [id, item] of Object.entries(entry.items)) {
      if (!isObject(item) || !Array.isArray(item.files)) throw malformed(`${id} has no files list`);
      for (const file of item.files) {
        requireSafe(file?.path, id);
        if (typeof file.sha256 !== 'string') throw malformed(`${id} has a file without a sha256`);
      }
      if (item.wiring !== undefined) {
        if (!isObject(item.wiring) || typeof item.wiring.created !== 'boolean') {
          throw malformed(`${id} has a malformed wiring record`);
        }
        requireSafe(item.wiring.path, id);
      }
    }
  }
}

export function readLock(base) {
  const path = lockPath(base);
  if (!existsSync(path)) return { version: LOCK_VERSION, forgeflow: null, targets: {} };

  let lock;
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new LockError(
      `${path} is not valid JSON (${error.message}). Fix or delete it, then re-run.`
    );
  }
  if (lock?.version !== LOCK_VERSION) {
    throw new LockError(
      `${path} has an unsupported format (version ${lock?.version}). ` +
        `This forgeflow reads version ${LOCK_VERSION}. Upgrade forgeflow or delete the file.`
    );
  }
  validate(path, lock);
  return lock;
}

export function writeLock(base, lock, version) {
  const path = lockPath(base);
  const targets = Object.fromEntries(
    Object.entries(lock.targets).filter(([, target]) => Object.keys(target.items).length > 0)
  );
  if (Object.keys(targets).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const data = { version: LOCK_VERSION, forgeflow: version, targets };
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}
```

- [ ] **Step 6: Write `src/ops.js`**

```js
import { getAdapter } from './adapters/index.js';
import { applyActions, checkWritable } from './apply.js';
import { ConflictError, UsageError } from './errors.js';
import { readLock, sha256, writeLock } from './lock.js';
import { planInstall, planRemove, planUnwire, planWire, wiringState } from './plan.js';
import { findId, resolve } from './resolve.js';
import { RUNTIME_ID } from './wiring.js';

const FILE_STATE = { delete: 'ok', keep: 'edited', missing: 'missing' };

const baseOf = (ctx) => (ctx.scope === 'global' ? ctx.home : ctx.cwd);
const isHookItem = (item) => item.type === 'hook' || item.type === 'runtime';
const wiringRow = ({ type, path }) => ({ id: RUNTIME_ID, type, path });

// A plan is { target, root, items, before?, after? }. before and after hold
// wiring actions: unwire runs before files are removed, wire after they exist,
// so a harness config never points at a runner that is not there.
function report(plans) {
  return plans.map(({ target, root, items, before = [], after = [] }) => ({
    target,
    root,
    actions: [
      ...before.map(wiringRow),
      ...items.flatMap((entry) =>
        entry.actions.map(({ type, path, reason }) =>
          reason ? { id: entry.id, type, path, reason } : { id: entry.id, type, path }
        )
      ),
      ...after.map(wiringRow),
    ],
  }));
}

function commit(ctx, lock, plans, record) {
  if (ctx.dryRun) return;
  for (const { root, items, before = [], after = [] } of plans) {
    const actions = [...before, ...items.flatMap((entry) => entry.actions), ...after];
    checkWritable(root, actions, ctx.force);
  }
  for (const plan of plans) {
    const target = (lock.targets[plan.target] ??= { items: {} });
    applyActions(plan.root, plan.before ?? [], ctx.force);
    for (const entry of plan.items) {
      applyActions(plan.root, entry.actions, ctx.force);
      record(target.items, entry);
    }
    applyActions(plan.root, plan.after ?? [], ctx.force);
  }
  // Written last: a crash never leaves a lockfile that claims unwritten files.
  writeLock(baseOf(ctx), lock, ctx.version);
}

// perTarget: [{ target, entries: [{ item, explicit }] }]
function install(ctx, lock, perTarget) {
  const plans = perTarget.map(({ target, entries }) => {
    if (ctx.scope === 'global' && entries.some(({ item }) => isHookItem(item))) {
      throw new UsageError('quality gates are installed per project. Run this without --global.');
    }
    const adapter = getAdapter(target);
    const root = adapter.root(ctx.scope, ctx);
    const installed = lock.targets[target]?.items ?? {};
    const after = [];
    const items = entries.map(({ item, explicit }) => {
      const files = adapter.render(item, { scope: ctx.scope, version: ctx.version });
      const actions = planInstall(root, files, installed[item.id]?.files ?? []);
      const entry = { id: item.id, explicit, files, actions };
      if (item.id === RUNTIME_ID && adapter.wiring) {
        const wired = planWire(root, adapter.wiring, installed[item.id]?.wiring);
        after.push(wired.action);
        entry.wiring = wired.record;
      }
      return entry;
    });
    return { target, root, items, after };
  });

  const conflicts = plans.flatMap((plan) =>
    plan.items.flatMap((entry) =>
      entry.actions
        .filter((action) => action.type === 'conflict')
        .map(({ path, reason }) => ({ target: plan.target, path, reason }))
    )
  );
  if (conflicts.length > 0 && !ctx.force) throw new ConflictError(conflicts);

  commit(ctx, lock, plans, (items, entry) => {
    items[entry.id] = {
      explicit: entry.explicit,
      files: entry.files.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
      ...(entry.wiring ? { wiring: entry.wiring } : {}),
    };
  });
  return report(plans);
}

export function add(ctx, refs, targets) {
  const lock = readLock(baseOf(ctx));
  const resolved = resolve(ctx.catalog, refs);
  const perTarget = targets.map((target) => ({
    target,
    entries: resolved.map(({ item, explicit }) => ({
      item,
      explicit: explicit || lock.targets[target]?.items[item.id]?.explicit === true,
    })),
  }));
  return { plans: install(ctx, lock, perTarget), skipped: [] };
}

export function update(ctx, refs, targets) {
  const lock = readLock(baseOf(ctx));
  const skipped = [];
  const named = refs.map((ref) => findId(ctx.catalog, ref));
  // Without --target, a named item is updated wherever it is installed.
  const everywhere = targets === undefined;
  if (everywhere) {
    for (const id of named) {
      if (!Object.values(lock.targets).some((target) => target.items[id])) {
        throw new UsageError(`${id} is not installed. Run "forgeflow status" to see what is.`);
      }
    }
  }
  const perTarget = (targets ?? Object.keys(lock.targets)).flatMap((target) => {
    const installed = lock.targets[target]?.items ?? {};
    const wanted = everywhere ? named.filter((id) => installed[id]) : named;
    if (everywhere && named.length > 0 && wanted.length === 0) return [];
    const ids = named.length > 0 ? wanted : Object.keys(installed);
    const current = [];
    for (const id of ids) {
      if (!installed[id]) {
        throw new UsageError(
          `${id} is not installed for ${target}. Run "forgeflow status" to see what is.`
        );
      }
      if (ctx.catalog.has(id)) current.push(id);
      else skipped.push({ target, id });
    }
    const entries = resolve(ctx.catalog, current).map(({ item }) => ({
      item,
      explicit: installed[item.id]?.explicit ?? false,
    }));
    return [{ target, entries }];
  });
  return { plans: install(ctx, lock, perTarget), skipped };
}

export function remove(ctx, refs, targets) {
  const lock = readLock(baseOf(ctx));
  // A full id is taken as given so items dropped from the catalog can still be removed.
  const ids = refs.map((ref) => (ref.includes(':') ? ref : findId(ctx.catalog, ref)));
  const requiresOf = (id) => ctx.catalog.get(id)?.requires ?? [];

  const plans = targets.map((target) => {
    const adapter = getAdapter(target);
    const root = adapter.root(ctx.scope, ctx);
    const installed = lock.targets[target]?.items ?? {};
    for (const id of ids) {
      if (!installed[id]) throw new UsageError(`${id} is not installed for ${target}.`);
    }

    const going = new Set(ids);
    for (const id of Object.keys(installed)) {
      if (going.has(id)) continue;
      const needed = requiresOf(id).find((dep) => going.has(dep));
      if (needed) {
        throw new UsageError(`cannot remove ${needed}: ${id} requires it. Remove ${id} first.`);
      }
    }

    // Sweep requirements nothing else needs, until none are left.
    for (let changed = true; changed; ) {
      changed = false;
      for (const [id, entry] of Object.entries(installed)) {
        if (going.has(id) || entry.explicit) continue;
        const stillNeeded = Object.keys(installed).some(
          (other) => !going.has(other) && requiresOf(other).includes(id)
        );
        if (!stillNeeded) {
          going.add(id);
          changed = true;
        }
      }
    }

    const before = [];
    const wiring = installed[RUNTIME_ID]?.wiring;
    if (going.has(RUNTIME_ID) && wiring) {
      before.push(planUnwire(root, wiring, adapter.wiring?.skeleton));
    }
    const items = Object.keys(installed)
      .filter((id) => going.has(id))
      .map((id) => ({ id, actions: planRemove(root, installed[id].files) }));
    return { target, root, items, before };
  });

  commit(ctx, lock, plans, (items, entry) => {
    delete items[entry.id];
  });
  return { plans: report(plans), skipped: [] };
}

export function status(ctx) {
  const lock = readLock(baseOf(ctx));
  return Object.entries(lock.targets).map(([target, { items }]) => {
    const adapter = getAdapter(target);
    const root = adapter.root(ctx.scope, ctx);
    const record = items[RUNTIME_ID]?.wiring;
    return {
      target,
      root,
      wiring:
        record && adapter.wiring
          ? { path: record.path, state: wiringState(root, adapter.wiring) }
          : null,
      items: Object.entries(items).map(([id, entry]) => ({
        id,
        explicit: entry.explicit,
        files: planRemove(root, entry.files).map(({ type, path }) => ({
          path,
          state: FILE_STATE[type],
        })),
      })),
    };
  });
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/hook-ops.test.js tests/ops.test.js tests/lock.test.js tests/plan.test.js tests/apply.test.js`
Expected: all pass, including the unchanged phase 1 tests.

- [ ] **Step 8: Commit**

```bash
git add src/plan.js src/apply.js src/lock.js src/ops.js tests/hook-ops.test.js
git commit -m "Wire and unwire harness hook configs on install and remove"
```

---

### Task 7: CLI and doctor

**Files:**
- Modify: `src/cli.js`, `src/doctor.js` (full replacements below)
- Modify: `tests/cli.test.js` (one line)
- Test: `tests/hook-cli.test.js`

**Interfaces:**
- Consumes: `status(ctx)` entries with `wiring` (Task 6); hook items with `events` (Task 2).
- Produces: `forgeflow add --hooks`, `forgeflow list --type hook`, wiring lines in `forgeflow status`, wiring checks in `forgeflow doctor`. `runtime` items are hidden from `list`.

- [ ] **Step 1: Update the phase 1 CLI test**

`--type hook` is now valid. In `tests/cli.test.js`, in the test `filters by type and prints JSON`, change:

```js
    expect(run('list', '--type', 'hook').code).toBe(2);
```

to:

```js
    expect(run('list', '--type', 'bogus').code).toBe(2);
```

- [ ] **Step 2: Write the failing test**

`tests/hook-cli.test.js`:

```js
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { agentMd, capture, tmpDir, writeTree } from './helpers.js';
import { hookTree, runtimeTree } from './hook-helpers.js';

let catalogDir;
let cwd;
let home;

function run(...argv) {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { cwd, home, stdout, stderr, catalogDir });
  return { code, out: stdout.text, err: stderr.text };
}

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), {
    'agents/alpha.md': agentMd('alpha', 'stage: review\n'),
    ...runtimeTree(),
    ...hookTree('g1', '[shell, write]'),
    ...hookTree('g2', '[stop]'),
  });
  cwd = tmpDir();
  home = tmpDir();
});

describe('list and info', () => {
  it('lists hooks with their events and hides the runtime', () => {
    const { code, out } = run('list');
    expect(code).toBe(0);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^hook:g1\s+shell,write\s+-\s+Gate g1\.$/);
    expect(out).not.toContain('runtime:hooks');
  });

  it('filters to hooks', () => {
    const { out } = run('list', '--type', 'hook', '--json');
    const rows = JSON.parse(out);
    expect(rows.map((row) => row.id)).toEqual(['hook:g1', 'hook:g2']);
    expect(rows[0].events).toEqual(['shell', 'write']);
    expect(run('list', '--type', 'runtime').code).toBe(2);
  });

  it('shows a hook', () => {
    const { code, out } = run('info', 'g1');
    expect(code).toBe(0);
    expect(out).toContain('hook:g1');
    expect(out).toMatch(/events:\s+shell, write/);
    expect(out).toMatch(/requires:\s+runtime:hooks/);
  });

  it('mentions --hooks in the usage text', () => {
    expect(run('--help').out).toContain('forgeflow add --hooks --target');
  });
});

describe('add --hooks', () => {
  it('installs every gate and reports the wiring', () => {
    const { code, out } = run('add', '--hooks', '--target', 'claude');
    expect(code).toBe(0);
    expect(out).toMatch(/create\s+\.claude\/forgeflow\/gates\/g1\.mjs/);
    expect(out).toMatch(/create\s+\.claude\/forgeflow\/gates\/g2\.mjs/);
    expect(out).toMatch(/wired\s+\.claude\/settings\.json/);
    expect(existsSync(join(cwd, '.claude/settings.json'))).toBe(true);
  });

  it('combines with named items and a flow-less install', () => {
    expect(run('add', 'alpha', '--hooks', '--target', 'cursor').code).toBe(0);
    expect(existsSync(join(cwd, '.cursor/agents/alpha.md'))).toBe(true);
    expect(existsSync(join(cwd, '.cursor/hooks.json'))).toBe(true);
  });

  it('exits 2 for --global with a gate', () => {
    const { code, err } = run('add', 'g1', '--target', 'claude', '--global');
    expect(code).toBe(2);
    expect(err).toContain('per project');
  });

  it('exits 1 and names a config it cannot parse', () => {
    writeTree(cwd, { '.claude/settings.json': '{ broken' });
    const { code, err } = run('add', 'g1', '--target', 'claude', '--force');
    expect(code).toBe(1);
    expect(err).toContain('.claude/settings.json');
    expect(err).toContain('is not valid JSON');
    expect(readFileSync(join(cwd, '.claude/settings.json'), 'utf8')).toBe('{ broken');
  });

  it('reports the unwiring on remove', () => {
    writeTree(cwd, { '.claude/settings.json': '{"model":"opus"}' });
    run('add', 'g1', '--target', 'claude');
    const { code, out } = run('remove', 'g1', '--target', 'claude');
    expect(code).toBe(0);
    expect(out).toMatch(/unwired\s+\.claude\/settings\.json/);
    expect(JSON.parse(readFileSync(join(cwd, '.claude/settings.json'), 'utf8'))).toEqual({ model: 'opus' });
  });
});

describe('status and doctor', () => {
  it('shows the wiring state', () => {
    run('add', 'g1', '--target', 'claude,opencode');
    const { out } = run('status');
    expect(out).toMatch(/wiring ok\s+\.claude\/settings\.json/);
    expect(out.match(/wiring/g)).toHaveLength(1);
  });

  it('passes doctor on a clean install and notes Codex trust', () => {
    run('add', 'g1', '--target', 'claude,codex');
    const { code, out } = run('doctor');
    expect(code).toBe(0);
    expect(out).toMatch(/ok\s+project install matches lockfile/);
    expect(out).toMatch(/ok\s+codex hooks need trusting \(.*\/hooks.*\)/);
  });

  it('does not mention Codex trust when Codex has no gates', () => {
    run('add', 'g1', '--target', 'claude');
    expect(run('doctor').out).not.toContain('codex hooks');
  });

  it('fails doctor when the wiring is gone or unreadable', () => {
    run('add', 'g1', '--target', 'claude');
    writeFileSync(join(cwd, '.claude/settings.json'), '{}');
    const gone = run('doctor');
    expect(gone.code).toBe(1);
    expect(gone.out).toContain('[claude] hook wiring in .claude/settings.json is missing');

    writeFileSync(join(cwd, '.claude/settings.json'), '{ broken');
    expect(run('doctor').out).toContain('is unreadable');
    expect(run('status').out).toMatch(/wiring unreadable\s+\.claude\/settings\.json/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/hook-cli.test.js tests/cli.test.js`
Expected: `tests/hook-cli.test.js` FAILS (the runtime is listed, `--hooks` is an unknown option). `tests/cli.test.js` passes.

- [ ] **Step 4: Write `src/doctor.js`**

```js
import { loadCatalog } from './catalog.js';
import { status } from './ops.js';

function problemsOf(targets) {
  return targets.flatMap((target) => {
    const files = target.items.flatMap((entry) =>
      entry.files
        .filter((file) => file.state !== 'ok')
        .map((file) => `[${target.target}] ${file.path} is ${file.state}`)
    );
    const { wiring } = target;
    if (wiring && wiring.state !== 'ok') {
      files.push(`[${target.target}] hook wiring in ${wiring.path} is ${wiring.state}`);
    }
    return files;
  });
}

export function runDoctor({ catalogDir, cwd, home, nodeVersion = process.versions.node }) {
  const checks = [];

  const major = Number(nodeVersion.split('.')[0]);
  checks.push({ name: 'Node.js >= 20', ok: major >= 20, detail: `found ${nodeVersion}` });

  try {
    const catalog = loadCatalog(catalogDir);
    checks.push({ name: 'catalog is valid', ok: true, detail: `${catalog.size} items` });
  } catch (error) {
    checks.push({ name: 'catalog is valid', ok: false, detail: error.message });
  }

  let codexHasGates = false;
  for (const scope of ['project', 'global']) {
    const name = `${scope} install matches lockfile`;
    try {
      const targets = status({ scope, cwd, home });
      const problems = problemsOf(targets);
      const detail = problems.length > 0 ? problems.join('; ') : 'no differences';
      checks.push({ name, ok: problems.length === 0, detail });
      codexHasGates ||= targets.some((target) => target.target === 'codex' && target.wiring);
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
    }
  }

  if (codexHasGates) {
    checks.push({
      name: 'codex hooks need trusting',
      ok: true,
      detail: 'forgeflow cannot check this: run /hooks in Codex to review and trust them',
    });
  }
  return checks;
}
```

- [ ] **Step 5: Write `src/cli.js`**

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getAdapter, targetNames } from './adapters/index.js';
import { loadCatalog } from './catalog.js';
import { runDoctor } from './doctor.js';
import { ConflictError, UsageError } from './errors.js';
import { add, remove, status, update } from './ops.js';
import { findId } from './resolve.js';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;
const DEFAULT_CATALOG = fileURLToPath(new URL('../catalog', import.meta.url));
const LISTED_TYPES = ['agent', 'skill', 'hook'];

const USAGE = `Usage:
  forgeflow list [--type agent|skill|hook] [--json]
  forgeflow info <id>
  forgeflow add <id...> --target <t>[,<t>...] [--global] [--dry-run] [--force]
  forgeflow add --flow quick|full --target <t>[,<t>...]
  forgeflow add --hooks --target <t>[,<t>...]
  forgeflow remove <id...> --target <t>[,<t>...] [--global] [--dry-run] [--force]
  forgeflow update [<id...>] [--target <t>[,<t>...]] [--global] [--dry-run] [--force]
  forgeflow status [--global]
  forgeflow doctor

Targets: ${targetNames.join(', ')}
An <id> is a name such as "reviewer", or a full id such as "agent:reviewer".
--hooks installs every quality gate. Gates are installed per project only.
`;

const OPTIONS = {
  target: { type: 'string' },
  flow: { type: 'string' },
  type: { type: 'string' },
  hooks: { type: 'boolean' },
  global: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

const LABELS = {
  skip: 'unchanged',
  keep: 'kept',
  missing: 'already gone',
  wire: 'wired',
  unwire: 'unwired',
};
const NOTHING = 'Nothing is installed here.\n';

function parseTargets(value, required) {
  if (value === undefined) {
    if (!required) return undefined;
    throw new UsageError(`--target is required. Choose from: ${targetNames.join(', ')}.`);
  }
  const names = [
    ...new Set(
      value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    ),
  ];
  if (names.length === 0) {
    throw new UsageError(`--target names no harness. Choose from: ${targetNames.join(', ')}.`);
  }
  names.forEach(getAdapter);
  return names;
}

function printResult(stdout, { plans, skipped }, dryRun) {
  for (const { target, root, actions } of plans) {
    stdout.write(`${target}  (${root})\n`);
    for (const { type, path, reason } of actions) {
      const label = (LABELS[type] ?? type).padEnd(12);
      stdout.write(`  ${label} ${path}${reason ? `  (${reason})` : ''}\n`);
    }
  }
  for (const { target, id } of skipped) {
    stdout.write(`[${target}] ${id} is no longer in the catalog; left as installed.\n`);
  }
  if (dryRun) stdout.write('Dry run: nothing was written.\n');
}

function printStatus(stdout, targets) {
  if (targets.length === 0) {
    stdout.write(NOTHING);
    return;
  }
  for (const { target, root, items, wiring } of targets) {
    stdout.write(`${target}  (${root})\n`);
    for (const { id, explicit, files } of items) {
      stdout.write(`  ${id}${explicit ? '' : '  (required)'}\n`);
      for (const { path, state } of files) stdout.write(`    ${state.padEnd(8)} ${path}\n`);
    }
    if (wiring) stdout.write(`  ${`wiring ${wiring.state}`.padEnd(17)} ${wiring.path}\n`);
  }
}

function run(argv, { cwd, home, stdout, stderr, catalogDir = DEFAULT_CATALOG }) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });
  const [command, ...refs] = positionals;

  if (values.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || command === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  if (!command) {
    stderr.write(USAGE);
    return 2;
  }

  if (command === 'doctor') {
    const checks = runDoctor({ catalogDir, cwd, home });
    for (const { name, ok, detail } of checks) {
      stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${name} (${detail})\n`);
    }
    return checks.every((check) => check.ok) ? 0 : 1;
  }

  const catalog = loadCatalog(catalogDir);
  const ctx = {
    catalog,
    version: VERSION,
    scope: values.global ? 'global' : 'project',
    cwd,
    home,
    force: Boolean(values.force),
    dryRun: Boolean(values['dry-run']),
  };

  switch (command) {
    case 'list': {
      if (values.type !== undefined && !LISTED_TYPES.includes(values.type)) {
        throw new UsageError(`--type must be one of: ${LISTED_TYPES.join(', ')}.`);
      }
      // The runtime is installed only as a requirement, so it is not offered.
      const items = [...catalog.values()]
        .filter((item) => LISTED_TYPES.includes(item.type))
        .filter((item) => values.type === undefined || item.type === values.type)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (values.json) {
        const rows = items.map(
          ({ id, type, name, description, stage, access, modelTier, events, requires }) => ({
            id,
            type,
            name,
            description,
            stage,
            access,
            modelTier,
            events,
            requires,
          })
        );
        stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else {
        for (const item of items) {
          const stage = (item.stage ?? item.events?.join(',') ?? '-').padEnd(13);
          const access = (item.access ?? '-').padEnd(10);
          stdout.write(`${item.id.padEnd(28)} ${stage} ${access} ${item.description}\n`);
        }
      }
      return 0;
    }

    case 'info': {
      if (refs.length !== 1) throw new UsageError('info takes exactly one item id.');
      const item = catalog.get(findId(catalog, refs[0]));
      const rows = [
        ['id', item.id],
        ['description', item.description],
        ['stage', item.stage],
        ['access', item.access],
        ['model tier', item.modelTier],
        ['events', item.events?.join(', ')],
        ['requires', item.requires.join(', ') || 'nothing'],
      ];
      for (const [label, value] of rows) {
        if (value !== undefined) stdout.write(`${`${label}:`.padEnd(13)} ${value}\n`);
      }
      return 0;
    }

    case 'add': {
      const wanted = [...refs];
      if (values.flow !== undefined) {
        if (!['quick', 'full'].includes(values.flow)) {
          throw new UsageError('--flow must be quick or full.');
        }
        wanted.push(`skill:forge-${values.flow}`);
      }
      if (values.hooks) {
        const gates = [...catalog.values()].filter((item) => item.type === 'hook');
        wanted.push(...gates.map((item) => item.id).sort());
      }
      if (wanted.length === 0) {
        throw new UsageError('name at least one item, or use --flow quick|full or --hooks.');
      }
      printResult(stdout, add(ctx, wanted, parseTargets(values.target, true)), ctx.dryRun);
      return 0;
    }

    case 'remove': {
      if (refs.length === 0) throw new UsageError('name at least one item to remove.');
      printResult(stdout, remove(ctx, refs, parseTargets(values.target, true)), ctx.dryRun);
      return 0;
    }

    case 'update': {
      const result = update(ctx, refs, parseTargets(values.target, false));
      if (result.plans.length === 0) stdout.write(NOTHING);
      else printResult(stdout, result, ctx.dryRun);
      return 0;
    }

    case 'status':
      printStatus(stdout, status(ctx));
      return 0;

    default:
      throw new UsageError(`unknown command "${command}". Run "forgeflow --help".`);
  }
}

export function main(argv, io) {
  try {
    return run(argv, io);
  } catch (error) {
    if (error instanceof ConflictError) {
      io.stderr.write(`forgeflow: ${error.message}:\n`);
      for (const { target, path, reason } of error.conflicts) {
        io.stderr.write(`  [${target}] ${path} (${reason})\n`);
      }
      io.stderr.write('Nothing was written. Re-run with --force to overwrite these files.\n');
      return 1;
    }
    io.stderr.write(`forgeflow: ${error.message}\n`);
    const usage = error instanceof UsageError || String(error.code).startsWith('ERR_PARSE_ARGS');
    return usage ? 2 : 1;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/hook-cli.test.js tests/cli.test.js`
Expected: all pass.

- [ ] **Step 7: Run everything, lint, and commit**

Run: `npm test && npm run lint`
Expected: every test file passes; 0 lint errors.

```bash
git add src/cli.js src/doctor.js tests/cli.test.js tests/hook-cli.test.js
git commit -m "Add --hooks, hook listing and wiring checks to the CLI"
```

---

### Task 8: End-to-end runner and plugin tests

**Files:**
- Test: `tests/hook-e2e.test.js`

**Interfaces:**
- Consumes: the real catalog; `add` (Task 6); the installed `run.mjs` and OpenCode plugin (Task 3); the four gates (Task 4).
- Produces: no new code. These tests run the installed scripts as a harness would, in a temp project that has no `node_modules`, which is the "teammate with only Node" criterion.

This task adds tests for behavior earlier tasks already built, so the tests are expected to pass on first run. To prove they can fail, Step 2 breaks the runner on purpose.

- [ ] **Step 1: Write the test**

`tests/hook-e2e.test.js`:

```js
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { add } from '../src/ops.js';
import { tmpDir } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const GATES = ['approval-gate', 'secret-guard', 'protected-paths', 'test-reminder'];
const DIRS = { claude: '.claude', codex: '.codex', cursor: '.cursor' };
// Built by concatenation so this file never contains a literal credential.
const TOKEN = `ghp_${'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2'}`;

function project(targets, gates = GATES) {
  const cwd = tmpDir();
  const ctx = { catalog, version: '0.1.0', scope: 'project', cwd, home: tmpDir(), force: false, dryRun: false };
  add(ctx, gates, targets);
  return cwd;
}

function fire(cwd, harness, payload) {
  const runner = join(cwd, DIRS[harness], 'forgeflow/run.mjs');
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [runner, harness], { input, encoding: 'utf8', cwd });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function startRun(cwd, state) {
  const dir = join(cwd, '.forgeflow/runs/20261013-1200-add-login');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.md'), state);
  return dir;
}

const claudeTool = (cwd, tool, input) => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: input,
  cwd,
});
const WAITING = 'mode: full\ncurrent stage: HUMAN_APPROVAL\nstatus: waiting for user\n';

describe('installed runner on Claude Code', () => {
  it('allows an ordinary command silently', () => {
    const cwd = project(['claude']);
    expect(fire(cwd, 'claude', claudeTool(cwd, 'Bash', { command: 'ls -la' }))).toEqual({
      code: 0,
      out: '',
      err: '',
    });
  });

  it('blocks a write containing a credential', () => {
    const cwd = project(['claude']);
    const payload = claudeTool(cwd, 'Write', { file_path: join(cwd, 'src/config.js'), content: `key = "${TOKEN}"` });
    const result = fire(cwd, 'claude', payload);
    expect(result.code).toBe(2);
    expect(result.err).toContain('secret-guard');
    expect(result.err).toContain('src/config.js');
    expect(result.err).not.toContain(TOKEN);
  });

  it('blocks a write to a protected path, including one from project config', () => {
    const cwd = project(['claude']);
    writeFileSync(join(cwd, '.forgeflow/config.json'), JSON.stringify({ protectedPaths: ['migrations/**'] }));
    const env = fire(cwd, 'claude', claudeTool(cwd, 'Edit', { file_path: '.env', new_string: 'A=1' }));
    expect(env.code).toBe(2);
    expect(env.err).toContain('protected-paths');
    const migration = claudeTool(cwd, 'Write', { file_path: 'migrations/001.sql', content: 'select 1' });
    expect(fire(cwd, 'claude', migration).code).toBe(2);
    expect(fire(cwd, 'claude', claudeTool(cwd, 'Write', { file_path: 'src/a.sql', content: '' })).code).toBe(0);
  });

  it('protects its own files and wiring', () => {
    const cwd = project(['claude']);
    for (const path of ['.claude/settings.json', '.claude/forgeflow/gates/secret-guard.mjs', '.forgeflow/config.json']) {
      const result = fire(cwd, 'claude', claudeTool(cwd, 'Write', { file_path: path, content: '{}' }));
      expect(result.code, path).toBe(2);
      expect(result.err, path).toContain('is protected');
    }
    const removal = claudeTool(cwd, 'Bash', { command: 'forgeflow remove approval-gate --target claude' });
    expect(fire(cwd, 'claude', removal).code).toBe(2);
  });

  it('gates a release until the person types approve', () => {
    const cwd = project(['claude']);
    const push = claudeTool(cwd, 'Bash', { command: 'git push origin main' });
    expect(fire(cwd, 'claude', push).code).toBe(0);

    const dir = startRun(cwd, WAITING);
    const blocked = fire(cwd, 'claude', push);
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain('20261013-1200-add-login');

    const forged = claudeTool(cwd, 'Write', { file_path: join(dir, '09-approval.md'), content: 'decision: approved' });
    expect(fire(cwd, 'claude', forged).code).toBe(2);
    const viaShell = claudeTool(cwd, 'Bash', { command: `echo "decision: approved" > ${dir}/09-approval.md` });
    expect(fire(cwd, 'claude', viaShell).code).toBe(2);
    expect(existsSync(join(dir, '09-approval.md'))).toBe(false);

    const chat = fire(cwd, 'claude', { hook_event_name: 'UserPromptSubmit', prompt: 'looks fine to me', cwd });
    expect(chat).toEqual({ code: 0, out: '', err: '' });
    expect(fire(cwd, 'claude', push).code).toBe(2);

    const approved = fire(cwd, 'claude', { hook_event_name: 'UserPromptSubmit', prompt: 'approve', cwd });
    expect(approved.code).toBe(0);
    expect(JSON.parse(approved.out).hookSpecificOutput).toEqual({
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'forgeflow: human approval recorded for run 20261013-1200-add-login in 09-approval.md.',
    });
    const record = readFileSync(join(dir, '09-approval.md'), 'utf8');
    expect(record.startsWith('decision: approved\nrecorded-by: forgeflow approval-gate (claude prompt hook)\n')).toBe(true);

    expect(fire(cwd, 'claude', push).code).toBe(0);
  });

  it('does not record approval while the run is still running', () => {
    const cwd = project(['claude']);
    const dir = startRun(cwd, 'current stage: BUILD\nstatus: running\n');
    fire(cwd, 'claude', { hook_event_name: 'UserPromptSubmit', prompt: 'approve', cwd });
    expect(existsSync(join(dir, '09-approval.md'))).toBe(false);
  });

  it('nudges once at the end of a turn with untested edits', () => {
    const cwd = project(['claude']);
    fire(cwd, 'claude', claudeTool(cwd, 'Write', { file_path: 'src/a.js', content: 'x' }));
    const first = fire(cwd, 'claude', { hook_event_name: 'Stop', cwd });
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out).decision).toBe('block');
    expect(JSON.parse(first.out).reason).toContain('test-reminder');
    expect(fire(cwd, 'claude', { hook_event_name: 'Stop', cwd }).out).toBe('');

    fire(cwd, 'claude', claudeTool(cwd, 'Bash', { command: 'npm test' }));
    fire(cwd, 'claude', claudeTool(cwd, 'Write', { file_path: 'src/b.js', content: 'y' }));
    expect(fire(cwd, 'claude', { hook_event_name: 'Stop', cwd, stop_hook_active: true }).out).toBe('');
    expect(JSON.parse(fire(cwd, 'claude', { hook_event_name: 'Stop', cwd }).out).decision).toBe('block');
  });

  it('runs only the gates that are installed', () => {
    const cwd = project(['claude'], ['protected-paths']);
    const secret = claudeTool(cwd, 'Write', { file_path: 'src/config.js', content: TOKEN });
    expect(fire(cwd, 'claude', secret).code).toBe(0);
    expect(fire(cwd, 'claude', claudeTool(cwd, 'Write', { file_path: '.env', content: '' })).code).toBe(2);
  });
});

describe('installed runner failure modes', () => {
  it.each([
    ['empty input', ''],
    ['input that is not JSON', 'not json'],
  ])('fails open on %s', (_label, input) => {
    const cwd = project(['claude']);
    const result = fire(cwd, 'claude', input);
    expect(result.code).toBe(1);
    expect(result.err).toContain('forgeflow hook failed and was skipped');
    expect(result.out).toBe('');
  });

  it.each([
    ['an empty object', {}],
    ['a list', []],
    ['an unknown event', { hook_event_name: 'Notification' }],
    ['a tool call with no input', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }],
  ])('allows %s', (_label, payload) => {
    const cwd = project(['claude']);
    expect(fire(cwd, 'claude', payload)).toEqual({ code: 0, out: '', err: '' });
  });

  it('keeps working when one gate file is broken', () => {
    const cwd = project(['claude']);
    writeFileSync(join(cwd, '.claude/forgeflow/gates/broken.mjs'), 'export function check( {');
    expect(fire(cwd, 'claude', claudeTool(cwd, 'Bash', { command: 'ls' })).code).toBe(0);
    const secret = claudeTool(cwd, 'Write', { file_path: 'a.js', content: TOKEN });
    expect(fire(cwd, 'claude', secret).code).toBe(2);
  });

  it('fails open when the runtime is missing', () => {
    const cwd = project(['claude']);
    writeFileSync(join(cwd, '.claude/forgeflow/runtime.mjs'), 'this is not javascript (');
    const result = fire(cwd, 'claude', claudeTool(cwd, 'Bash', { command: 'git push' }));
    expect(result.code).toBe(1);
    expect(result.err).toContain('forgeflow hook failed and was skipped');
  });

  it('ignores a broken project config and says so on the next prompt', () => {
    const cwd = project(['claude']);
    writeFileSync(join(cwd, '.forgeflow/config.json'), '{ broken');
    expect(fire(cwd, 'claude', claudeTool(cwd, 'Bash', { command: 'ls' }))).toEqual({ code: 0, out: '', err: '' });
    const prompt = fire(cwd, 'claude', { hook_event_name: 'UserPromptSubmit', prompt: 'hello', cwd });
    expect(JSON.parse(prompt.out).hookSpecificOutput.additionalContext).toContain('.forgeflow/config.json');
  });
});

describe('installed runner on Codex and Cursor', () => {
  it('blocks a Codex patch that adds a protected file or a credential', () => {
    const cwd = project(['codex']);
    const patch = (body) => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: body },
      cwd,
    });
    const env = fire(cwd, 'codex', patch('*** Begin Patch\n*** Add File: .env\n+A=1\n*** End Patch'));
    expect(env.code).toBe(2);
    expect(env.err).toContain('protected-paths');
    const secret = fire(cwd, 'codex', patch(`*** Update File: src/a.js\n+const k = "${TOKEN}";`));
    expect(secret.code).toBe(2);
    expect(secret.err).toContain('secret-guard');
    expect(fire(cwd, 'codex', patch('*** Update File: src/a.js\n+const k = 1;')).code).toBe(0);
  });

  it('blocks a Codex release during a run', () => {
    const cwd = project(['codex']);
    startRun(cwd, WAITING);
    const push = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, cwd };
    expect(fire(cwd, 'codex', push).code).toBe(2);
  });

  it('answers Cursor in its own format', () => {
    const cwd = project(['cursor']);
    startRun(cwd, WAITING);
    const push = { hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'git push' }, cwd };
    const blocked = fire(cwd, 'cursor', push);
    expect(blocked.code).toBe(2);
    expect(JSON.parse(blocked.out).permission).toBe('deny');
    expect(JSON.parse(blocked.out).agent_message).toContain('approval-gate');

    fire(cwd, 'cursor', { hook_event_name: 'beforeSubmitPrompt', prompt: 'approve' });
    expect(fire(cwd, 'cursor', push)).toEqual({ code: 0, out: '', err: '' });

    const write = { hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: 'src/a.js', content: 'x' }, cwd };
    fire(cwd, 'cursor', write);
    const stop = fire(cwd, 'cursor', { hook_event_name: 'stop', status: 'completed', loop_count: 0 });
    expect(JSON.parse(stop.out).followup_message).toContain('test-reminder');
    expect(fire(cwd, 'cursor', { hook_event_name: 'stop', status: 'completed', loop_count: 1 }).out).toBe('');
  });
});

describe('installed OpenCode plugin', () => {
  async function plugin(cwd) {
    const module = await import(pathToFileURL(join(cwd, '.opencode/plugins/forgeflow.js')).href);
    return module.ForgeflowGates({ directory: cwd });
  }
  const before = (hooks, tool, args) => hooks['tool.execute.before']({ tool, sessionID: 's', callID: 'c' }, { args });

  it('blocks by throwing and allows by returning', async () => {
    const cwd = project(['opencode']);
    const hooks = await plugin(cwd);
    await expect(before(hooks, 'bash', { command: 'ls' })).resolves.toBeUndefined();
    await expect(before(hooks, 'write', { filePath: join(cwd, 'a.js'), content: TOKEN })).rejects.toThrow('secret-guard');
    await expect(before(hooks, 'edit', { filePath: '.env', newString: 'A=1' })).rejects.toThrow('protected-paths');
    await expect(before(hooks, 'read', { filePath: '.env' })).resolves.toBeUndefined();
    await expect(hooks['tool.execute.before'](undefined, undefined)).resolves.toBeUndefined();
  });

  it('gates a release until the person types approve', async () => {
    const cwd = project(['opencode']);
    const hooks = await plugin(cwd);
    const dir = startRun(cwd, WAITING);
    await expect(before(hooks, 'bash', { command: 'git push' })).rejects.toThrow('approval-gate');

    await hooks['chat.message']({ sessionID: 's' }, { parts: [{ type: 'text', text: 'approve' }] });
    expect(readFileSync(join(dir, '09-approval.md'), 'utf8')).toContain('(opencode prompt hook)');
    await expect(before(hooks, 'bash', { command: 'git push' })).resolves.toBeUndefined();
  });

  it('returns no hooks when the runtime cannot be loaded', async () => {
    const cwd = project(['opencode']);
    writeFileSync(join(cwd, '.opencode/forgeflow/runtime.mjs'), 'this is not javascript (');
    expect(await plugin(cwd)).toEqual({});
  });
});
```

- [ ] **Step 2: Prove the tests can fail**

Temporarily edit `catalog/runtime/hooks/runtime.mjs`: in `respond`, change `if (block) return { code: 2, stdout: '', stderr: block };` to return `code: 0`.

Run: `npx vitest run tests/hook-e2e.test.js`
Expected: FAIL in the Claude Code and Codex block tests (exit code 0 instead of 2).

Then undo the edit: `git checkout catalog/runtime/hooks/runtime.mjs`

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx vitest run tests/hook-e2e.test.js`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add tests/hook-e2e.test.js
git commit -m "Test installed hook runner and OpenCode plugin end to end"
```

---

### Task 9: Flow skills use the typed approval

**Files:**
- Modify: `catalog/skills/forge-full/SKILL.md`, `catalog/skills/forge-quick/SKILL.md`, `catalog/agents/deployer.md`
- Test: `tests/hook-content.test.js`

**Interfaces:**
- Consumes: the approval record format and the `state.md` fields `findRun` reads (`status`, `current stage`).
- Produces: skills that set `status: waiting for user` and `current stage: HUMAN_APPROVAL` (full) or `current stage: SHIP` (quick) before asking, ask for `approve`, and read `09-approval.md` for `decision: approved`.

- [ ] **Step 1: Write the failing test**

`tests/hook-content.test.js`:

```js
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));

describe('shipped gates', () => {
  it.each([
    ['approval-gate', ['shell', 'write', 'prompt']],
    ['secret-guard', ['write']],
    ['protected-paths', ['write']],
    ['test-reminder', ['shell', 'write', 'stop']],
  ])('%s declares the events it handles', (name, events) => {
    const hook = catalog.get(`hook:${name}`);
    expect(hook.events).toEqual(events);
    expect(hook.requires).toEqual(['runtime:hooks']);
    expect(hook.gate).toContain('export function check(event, ctx)');
    expect(hook.gate).not.toMatch(/from '\.\.?\//);
  });

  it('ships exactly four gates and one runtime', () => {
    const types = [...catalog.values()].map((item) => item.type);
    expect(types.filter((type) => type === 'hook')).toHaveLength(4);
    expect(types.filter((type) => type === 'runtime')).toHaveLength(1);
  });

  it('shipped runtime code has no shebang and imports only node built-ins', () => {
    const { sources } = catalog.get('runtime:hooks');
    for (const [file, source] of Object.entries(sources)) {
      expect(source.startsWith('#!'), file).toBe(false);
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const specifier of imports) expect(specifier.startsWith('node:'), `${file}: ${specifier}`).toBe(true);
    }
  });
});

describe('flow skills and the approval gate', () => {
  it.each([
    ['forge-full', 'current stage: HUMAN_APPROVAL'],
    ['forge-quick', 'current stage: SHIP'],
  ])('%s sets the state the gate looks for, and asks for approve', (name, stage) => {
    const { body } = catalog.get(`skill:${name}`);
    expect(body).toContain('status: waiting for user');
    expect(body).toContain(stage);
    expect(body).toContain('reply with exactly `approve`');
    expect(body).toContain('decision: approved');
    expect(body).toContain('no bullets, backticks or other formatting');
  });

  it('deployer accepts the recorded approval line', () => {
    expect(catalog.get('agent:deployer').body).toContain('`decision: approved`');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/hook-content.test.js`
Expected: the three `flow skills and the approval gate` tests FAIL; the `shipped gates` tests pass.

- [ ] **Step 3: Edit `catalog/skills/forge-full/SKILL.md`**

Replace control rule 5 (the whole paragraph beginning `5. **Human approval.**`) with:

```markdown
5. **Human approval.** Set `status: waiting for user` and `current stage: HUMAN_APPROVAL` in `state.md`. Show the user: the change summary from `05-build.md`, the test result, the review verdict with any open minor findings, and the release-gate checklist. Ask them to reply with exactly `approve` to approve deploying, or to say what they want changed. Then stop and wait for their reply. After they reply, read `09-approval.md`. If it contains the line `decision: approved`, the approval is recorded: continue. If the file does not exist and their reply clearly approves, save their decision, in their words, with the date, as `09-approval.md`; if you are blocked from writing that file, an approval gate is installed, so ask the user to reply with exactly `approve`. If they decline or ask for changes, record that in `state.md`, stop the flow, and say what they asked for. Silence, an unrelated reply, or an earlier general go-ahead is not approval.
```

In the section `## Keeping state`, replace the line:

```markdown
`state.md` holds, one per line:
```

with:

```markdown
`state.md` holds these lines. Write each exactly as `key: value`, with no bullets, backticks or other formatting, so that tools can read it:
```

- [ ] **Step 4: Edit `catalog/skills/forge-quick/SKILL.md`**

Replace control rule 5 (the whole paragraph beginning `5. **Human confirmation.**`) with:

```markdown
5. **Human confirmation.** Set `status: waiting for user` and `current stage: SHIP` in `state.md`. Show the user: the change summary from `05-build.md`, the test result, the review verdict with any open minor findings, and the release-gate checklist. Ask them to reply with exactly `approve` to accept the change, or to say what they want changed. Then stop and wait for their reply. After they reply, read `09-approval.md`. If it contains the line `decision: approved`, the confirmation is recorded. If the file does not exist and their reply clearly accepts the change, save their decision, in their words, with the date, as `09-approval.md`; if you are blocked from writing that file, an approval gate is installed, so ask the user to reply with exactly `approve`. If they decline or ask for changes, record that in `state.md`. Silence, an unrelated reply, or an earlier general go-ahead is not confirmation.
```

In the section `## Keeping state`, make the same replacement as in Step 3 for the line `` `state.md` holds, one per line: ``.

- [ ] **Step 5: Edit `catalog/agents/deployer.md`**

In procedure step 1, replace:

```markdown
`09-approval.md` must exist in it and record an approval:
```

with:

```markdown
`09-approval.md` must exist in it and record an approval, either the line `decision: approved` or a person's approval in their own words:
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/hook-content.test.js tests/content.test.js`
Expected: all pass, including the phase 1 content tests (they still find `09-approval.md`, `state.md`, the five agent sections and no harness tool names).

- [ ] **Step 7: Commit**

```bash
git add catalog/skills catalog/agents/deployer.md tests/hook-content.test.js
git commit -m "Have the flows ask for a typed approve and read the recorded approval"
```

---

### Task 10: Documentation, lint coverage and final checks

**Files:**
- Modify: `README.md`, `docs/verification.md`, `package.json`, `.prettierignore`

**Interfaces:**
- Consumes: the finished CLI and catalog.
- Produces: user documentation for the gates, manual harness checks, and lint and format coverage for shipped JavaScript.

- [ ] **Step 1: Lint and format the shipped code**

In `package.json`, change the `lint` script to:

```json
    "lint": "oxlint bin src tests catalog",
```

Replace `.prettierignore` with:

```
node_modules/
catalog/**/*.md
docs/
```

Run: `npm run format && npm run lint`
Expected: prettier may reformat `catalog/**/*.mjs` and `.js`; oxlint reports 0 errors. Fix any warning in shipped code by changing the code, not by disabling the rule.

- [ ] **Step 2: Update `README.md`**

Replace the sentence:

```markdown
In this version the gates are instructions to the model. They are not enforced by hooks.
```

with:

```markdown
The stops in a flow are instructions to the model. Install the quality gates below to have the harness enforce them.
```

Insert this section immediately before `## Where files go`:

````markdown
## Quality gates

Gates are hooks the harness runs for you. Install all four, or pick the ones you want:

```bash
forgeflow add --hooks --target claude
forgeflow add secret-guard protected-paths --target cursor
```

| Gate | What it does |
|---|---|
| `approval-gate` | During a flow run, blocks `git push`, publish and deploy commands until you type `approve` at the flow's approval step. It records the approval itself; agents cannot. |
| `secret-guard` | Blocks a file write whose new text contains a credential in a known format. |
| `protected-paths` | Blocks agent writes to `.env` files, `*.pem`, `*.key`, and any paths you list. |
| `test-reminder` | Nudges the agent once when a turn ends with edits and no test run since. |

Gates are installed per project, not with `--global`. forgeflow copies a small runner into the harness's folder and adds its entries to the harness's hook config (`.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json`, or a plugin file for OpenCode). Your own hook entries are left alone, and `forgeflow remove` takes out only what forgeflow added. Teammates need Node 20 and nothing else.

### Configuring gates

Create `.forgeflow/config.json` to add to the defaults:

```json
{
  "releaseCommands": ["\\bmake\\s+deploy\\b"],
  "protectedPaths": ["migrations/**", "package-lock.json"],
  "secretAllow": ["EXAMPLE_[A-Z0-9]+"],
  "testCommands": ["\\bmake\\s+check\\b"]
}
```

`protectedPaths` are globs. The other three are regular expressions. To allow one false positive from `secret-guard`, add `forgeflow-allow-secret` to that line.

### What gates do not do

Gates raise the bar. They are not a sandbox.

- Shell commands are matched by pattern. A script that pushes, or an obfuscated command, is not caught.
- `secret-guard` and `protected-paths` see file-writing tools only, not files changed by a shell command.
- `approval-gate` applies only while a flow run is active. A run idle for 24 hours stops gating.
- If the runner crashes, the action goes through. `forgeflow doctor` checks the wiring.
- Agents can no longer edit the harness's hook config or `.forgeflow/config.json`. You make those changes.
- Codex runs project hooks only after you trust them (`/hooks`), and needs the project to be a git repository.
- On OpenCode, `test-reminder` does nothing.
````

In the `## Where files go` table, add a column so it reads:

```markdown
| Target | Agents | Skills | Gates |
|---|---|---|---|
| `claude` | `.claude/agents/` | `.claude/skills/` | `.claude/forgeflow/`, entries in `.claude/settings.json` |
| `codex` | `.codex/agents/` | `.agents/skills/` | `.codex/forgeflow/`, entries in `.codex/hooks.json` |
| `opencode` | `.opencode/agents/` | `.opencode/skills/` | `.opencode/forgeflow/`, `.opencode/plugins/forgeflow.js` |
| `cursor` | `.cursor/agents/` | `.cursor/skills/` | `.cursor/forgeflow/`, entries in `.cursor/hooks.json` |
```

In `## Adding to the catalog`, add this bullet after the skill bullet:

```markdown
- A gate is a folder, `catalog/hooks/<name>/`, with `HOOK.md` and `gate.mjs`. `gate.mjs` exports `check(event, ctx)` and may import only `node:` built-ins.
```

- [ ] **Step 3: Update `docs/verification.md`**

Append:

```markdown
## Quality gates

Install the gates in the same scratch repository:

    forgeflow add --hooks --target <harness>

On Codex, run `/hooks` and trust the project hooks first.

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 11 | The harness starts with no warning about the hook config or plugin | | | | |
| 12 | Asking the agent to create `.env` is blocked, and the agent reports why | | | | |
| 13 | Asking the agent to write a file containing a fake token (`ghp_` followed by 36 letters) is blocked | | | | |
| 14 | Asking the agent to edit one line of an existing file to add that token is blocked | | | | |
| 15 | Asking the agent to edit the harness's hook config is blocked | | | | |
| 16 | During a full-flow run, asking the agent to `git push` before approval is blocked | | | | |
| 17 | At HUMAN_APPROVAL, typing `approve` creates `09-approval.md` with `decision: approved` | | | | |
| 18 | After that, `git push` is no longer blocked | | | | |
| 19 | A subagent (for example `builder`) is blocked by the same gates as the main agent | | | | |
| 20 | Ending a turn after an edit with no test run produces one reminder (not OpenCode) | | | | |
| 21 | `forgeflow remove` of all gates leaves the hook config as it was before | | | | |

Check 14 matters most on Cursor: it shows whether a partial edit reaches the pre-tool hook with its new text. If it is not blocked there, `secret-guard` on Cursor covers whole-file writes only; record that in the README.

Check 19 shows whether the harness runs hooks for subagent tool calls. Record the result per harness.
```

- [ ] **Step 4: Run everything**

Run: `npm run format && npm run lint && npm test`
Expected: 0 lint errors; every test passes.

Run: `node bin/forgeflow.js doctor; echo "exit=$?"`
Expected: `catalog is valid (18 items)`, `exit=0`.

- [ ] **Step 5: Try the real CLI in a scratch directory**

```bash
F=/home/hkumar/Documents/ADLC/forgeflow/bin/forgeflow.js
SCRATCH=$(mktemp -d) && cd "$SCRATCH" && echo '{"model":"opus"}' > settings.tmp && mkdir .claude && mv settings.tmp .claude/settings.json \
  && node $F add --hooks --target claude,cursor,opencode && node $F status && node $F doctor \
  && echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":".env","content":"A=1"}}' | node .claude/forgeflow/run.mjs claude; echo "hook exit=$?" \
  && node $F remove approval-gate secret-guard protected-paths test-reminder --target claude,cursor,opencode && cat .claude/settings.json && ls -A
```

Expected: `add` reports `wired` for claude and cursor; `status` shows `wiring ok` twice; `doctor` is all `ok`; the hook prints a `protected-paths` message and `hook exit=2`; after `remove`, `.claude/settings.json` holds only `"model": "opus"`, and `ls -A` shows `.claude` and `.forgeflow` only.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Document quality gates and lint shipped hook code"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| 2. Success criterion 1 (install and remove gate, runner, wiring) | 6, 7 |
| 2. Success criteria 2–3 (release blocked, typed approval) | 4, 8 |
| 2. Success criterion 4 (never rewrite unparseable config, never touch user entries) | 1, 6 |
| 2. Success criterion 5 (teammate with only Node) | 3, 8 |
| 2. Success criterion 6 (tests without a harness) | every task |
| 3. Architecture | 1–7 |
| 4. Catalog, gate contract, combining decisions | 2, 3 |
| 5. Layout, wiring entries, merging rules, translation, responses, failure mode | 1, 3, 5, 8 |
| 6. Self-protection | 3, 8 |
| 7. Project configuration | 3, 4, 8 |
| 8. The four gates | 4 |
| 9. Limits | 10 (README) |
| 10. Installer changes, scope, CLI | 5, 6, 7 |
| 11. Flow skill changes | 9 |
| 12. Error handling | 1, 2, 3, 6, 7, 8 |
| 13. Testing, manual harness checks | every task; 10 (`docs/verification.md`) |
