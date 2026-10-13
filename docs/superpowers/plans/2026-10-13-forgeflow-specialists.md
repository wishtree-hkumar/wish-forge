# forgeflow Specialist Agents Implementation Plan (phase 3a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ten individually installable specialist agents, and have both flows run the four review specialists at REVIEW when they are installed.

**Architecture:** Specialists are ordinary agent items, so the install pipeline is untouched. The catalog gains one agent field, `joins`, and skill bodies gain two placeholders that each adapter fills with its own agents folders, so a flow can tell which specialists are installed for the harness it runs in. The flow skills and `release-gate` change in wording only.

**Tech Stack:** Node 20+ ESM JavaScript, `yaml` (only runtime dependency), `vitest`, `oxlint`, `prettier`, `smol-toml` (dev).

**Spec:** `docs/superpowers/specs/2026-10-13-forgeflow-specialists-design.md`

## Global Constraints

- Node 20+, ESM, no new runtime or dev dependency.
- Commit messages are a plain subject plus optional body. Never add `Co-Authored-By` or any other trailer.
- Agent and skill bodies name no harness-specific tool (no backticked `Edit`, `Write`, `Read`, `Grep`, `Glob`, `Bash`, `Task`; no `apply_patch`, `MultiEdit`, `TodoWrite`, `str_replace`).
- Every agent body has exactly these `##` sections, in this order: Role, Inputs, Procedure, Output, Limits.
- Every read-only agent's body contains the sentence `Do not modify any file.`
- Review specialists end with exactly `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`.
- Review specialists, in flow order: `security-reviewer`, `performance-reviewer`, `database-reviewer`, `accessibility-reviewer`.
- Specialist report files in a run directory are named `07-review-<agent name>.md`.
- Placeholders are exactly `{{agents-dir}}` and `{{global-agents-dir}}`.
- Installing a flow installs no specialist: neither flow skill adds one to `requires`.
- Run `npx vitest run` (whole suite) before each commit; it must be green.
- `catalog/**/*.md` and `docs/` are not formatted by prettier; everything else is. Run `npx prettier --write` on the source and test files a task touches.

## Review Focus

Inputs the spec implies and a person is likely to hit. Each has a test in the task named.

1. A flow skill installed with `--global` on OpenCode, where the agents folder has no `.opencode/` prefix: the installed text must still name `.opencode/agents` and `~/.config/opencode/agents`. (Task 2)
2. A placeholder typed with spaces or a wrong name (`{{ agents-dir }}`, `{{agent-dir}}`): the catalog must refuse it and name the token. (Task 2)
3. An agent body or a supporting skill file that contains `{{agents-dir}}`: it must be written unchanged, not substituted and not rejected. (Task 2)
4. `forgeflow add --specialists --hooks --global`: gates are project-only, so this must fail with the existing gate error and install nothing. (Task 3)
5. A project with a flow and specialists installed for two harnesses: each harness's skill must name only its own folders. (Task 6)

---

### Task 1: The `joins` agent field

**Files:**
- Modify: `src/catalog.js`
- Test: `tests/specialist-catalog.test.js` (create)

**Interfaces:**
- Consumes: `loadCatalog(dir)`, `CatalogError`, test helpers `agentMd`, `skillMd`, `tmpDir`, `writeTree`.
- Produces: agent items carry `joins`, which is `'review'` or `undefined`.

- [ ] **Step 1: Write `tests/specialist-catalog.test.js`**

`tests/specialist-catalog.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { CatalogError } from '../src/errors.js';
import { agentMd, skillMd, tmpDir, writeTree } from './helpers.js';

const load = (tree) => loadCatalog(writeTree(tmpDir(), tree));
const writer = (extra) =>
  `---\nname: sec\ndescription: Does sec things.\naccess: write\n${extra}---\nBody.\n`;

describe('joins', () => {
  it('is carried on a read-only agent that has no stage', () => {
    const catalog = load({ 'agents/sec.md': agentMd('sec', 'joins: review\n') });
    expect(catalog.get('agent:sec').joins).toBe('review');
    expect(catalog.get('agent:sec').stage).toBeUndefined();
  });

  it('is undefined when the agent does not set it', () => {
    expect(load({ 'agents/sec.md': agentMd('sec') }).get('agent:sec').joins).toBeUndefined();
  });

  it.each([
    [
      'a value other than review',
      agentMd('sec', 'joins: build\n'),
      'field "joins" must be one of: review',
    ],
    [
      'an agent that has a stage',
      agentMd('sec', 'stage: review\njoins: review\n'),
      'field "joins" is not allowed on an agent that has a stage',
    ],
    [
      'an agent with write access',
      writer('joins: review\n'),
      'field "joins" requires access: read-only',
    ],
  ])('is rejected on %s', (_case, text, message) => {
    const attempt = () => load({ 'agents/sec.md': text });
    expect(attempt).toThrow(CatalogError);
    expect(attempt).toThrow(`agents/sec.md: ${message}`);
  });

  it('is not a skill field', () => {
    const attempt = () => load({ 'skills/flow/SKILL.md': skillMd('flow', 'joins: review\n') });
    expect(attempt).toThrow('unknown field "joins"');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/specialist-catalog.test.js`
Expected: FAIL. The first test fails with `unknown field "joins" (allowed: name, description, stage, access, model-tier, requires)`; only "is not a skill field" and "is undefined when the agent does not set it" pass.

- [ ] **Step 3: Implement in `src/catalog.js`**

Add a constant beside `TIERS`:

```js
const JOINS = ['review'];
```

Change the agent entry of `FIELDS` to:

```js
  agent: ['name', 'description', 'stage', 'access', 'model-tier', 'joins', 'requires'],
```

In `buildItem`, replace the `if (type === 'agent') { … }` block's body with:

```js
    item.stage = oneOf(source, data, 'stage', STAGES, false);
    item.access = oneOf(source, data, 'access', ACCESS, true);
    item.modelTier = oneOf(source, data, 'model-tier', TIERS, false) ?? 'balanced';
    // An agent that joins a stage is called by the flows when it is installed.
    item.joins = oneOf(source, data, 'joins', JOINS, false);
    if (item.joins !== undefined) {
      if (item.stage !== undefined) {
        fail(source, 'field "joins" is not allowed on an agent that has a stage');
      }
      if (item.access !== 'read-only') fail(source, 'field "joins" requires access: read-only');
    }
```

- [ ] **Step 4: Run the test, then the suite**

Run: `npx vitest run tests/specialist-catalog.test.js`
Expected: PASS, 6 tests.

Run: `npx vitest run`
Expected: PASS, 574 tests (568 + 6).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/catalog.js tests/specialist-catalog.test.js
git add src/catalog.js tests/specialist-catalog.test.js
git commit -m "Add the joins field for agents the flows call when installed"
```

---

### Task 2: Agents-folder placeholders in skill bodies

**Files:**
- Create: `src/placeholders.js`
- Modify: `src/catalog.js`, `src/adapters/shared.js`, `src/adapters/claude.js`, `src/adapters/codex.js`, `src/adapters/cursor.js`, `src/adapters/opencode.js`
- Test: `tests/placeholders.test.js` (create)

**Interfaces:**
- Consumes: `loadCatalog`, adapter `render(item, { scope, version })`, test helpers `item`, `skill`, `skillMd`, `agentMd`.
- Produces:
  - `src/placeholders.js`: `PLACEHOLDERS` (array of the two tokens), `unknownPlaceholders(text) → string[]`, `fillPlaceholders(text, agentDirs) → string`.
  - Every adapter exports `agentDirs = { project: string, global: string }`.
  - `skillFiles(dir, item, version, agentDirs, extraFrontmatter = {})` in `src/adapters/shared.js` (the new fourth parameter moves `extraFrontmatter` to fifth).

- [ ] **Step 1: Write `tests/placeholders.test.js`**

`tests/placeholders.test.js`:

```js
import { describe, expect, it } from 'vitest';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as cursor from '../src/adapters/cursor.js';
import * as opencode from '../src/adapters/opencode.js';
import { loadCatalog } from '../src/catalog.js';
import { CatalogError } from '../src/errors.js';
import { PLACEHOLDERS, fillPlaceholders, unknownPlaceholders } from '../src/placeholders.js';
import { agentMd, item, skill, skillMd, tmpDir, writeTree } from './helpers.js';

const load = (tree) => loadCatalog(writeTree(tmpDir(), tree));
const dirs = { project: '.x/agents', global: '~/.x/agents' };
const BODY = 'Look in {{agents-dir}} and {{global-agents-dir}}, then {{agents-dir}} again.';

describe('placeholders', () => {
  it('are the two agents-folder tokens', () => {
    expect(PLACEHOLDERS).toEqual(['{{agents-dir}}', '{{global-agents-dir}}']);
  });

  it('fills every occurrence of both', () => {
    expect(fillPlaceholders(BODY, dirs)).toBe(
      'Look in .x/agents and ~/.x/agents, then .x/agents again.'
    );
  });

  it('leaves text without tokens alone', () => {
    expect(fillPlaceholders('No tokens here. {single} braces.', dirs)).toBe(
      'No tokens here. {single} braces.'
    );
  });

  it('reports each unknown token once', () => {
    const text = '{{agents-dir}} {{agent-dir}} {{ agents-dir }} {{agent-dir}} {{}}';
    expect(unknownPlaceholders(text)).toEqual(['{{agent-dir}}', '{{ agents-dir }}', '{{}}']);
    expect(unknownPlaceholders(BODY)).toEqual([]);
  });
});

describe('catalog', () => {
  const flow = (body) => ({
    'skills/flow/SKILL.md': `---\nname: flow\ndescription: Runs flow.\n---\n${body}\n`,
  });

  it('accepts both placeholders in a skill body', () => {
    expect(load(flow(BODY)).get('skill:flow').body).toBe(BODY);
  });

  it.each(['{{agent-dir}}', '{{ agents-dir }}', '{{global_agents_dir}}'])(
    'rejects the unknown placeholder %s and names it',
    (token) => {
      const attempt = () => load(flow(`Look in ${token}.`));
      expect(attempt).toThrow(CatalogError);
      expect(attempt).toThrow(`skills/flow/SKILL.md: unknown placeholder ${token}`);
      expect(attempt).toThrow('allowed: {{agents-dir}}, {{global-agents-dir}}');
    }
  );

  it('does not check agent bodies or supporting skill files', () => {
    const catalog = load({
      'agents/a.md': agentMd('a').replace('Body of a.', 'Uses {{anything}}.'),
      'skills/flow/SKILL.md': skillMd('flow'),
      'skills/flow/notes.md': 'A {{template}} example.',
    });
    expect(catalog.get('agent:a').body).toBe('Uses {{anything}}.');
    expect(catalog.get('skill:flow').files[0].content.toString()).toBe('A {{template}} example.');
  });
});

const EXPECTED = [
  ['claude', claude, '.claude/agents', '~/.claude/agents'],
  ['codex', codex, '.codex/agents', '~/.codex/agents'],
  ['opencode', opencode, '.opencode/agents', '~/.config/opencode/agents'],
  ['cursor', cursor, '.cursor/agents', '~/.cursor/agents'],
];

describe.each(EXPECTED)('%s adapter', (_name, adapter, project, global) => {
  it('exports its agents folders', () => {
    expect(adapter.agentDirs).toEqual({ project, global });
  });

  it('writes project agents into the folder it names', () => {
    const [file] = adapter.render(item(), { scope: 'project', version: '0.1.0' });
    expect(file.path.startsWith(`${project}/reviewer.`)).toBe(true);
  });

  it.each(['project', 'global'])('fills a skill body at %s scope', (scope) => {
    const files = adapter.render(skill({ body: BODY }), { scope, version: '0.1.0' });
    const main = files.find((file) => file.path.endsWith('SKILL.md'));
    expect(main.content).toContain(`Look in ${project} and ${global}, then ${project} again.`);
    expect(main.content).not.toContain('{{');
  });

  it('leaves an agent body and a supporting skill file unchanged', () => {
    const ctx = { scope: 'project', version: '0.1.0' };
    const [agent] = adapter.render(item({ body: BODY }), ctx);
    expect(agent.content).toContain('{{agents-dir}}');

    const extra = { path: 'notes.md', content: Buffer.from(BODY) };
    const files = adapter.render(skill({ files: [extra] }), ctx);
    expect(files.find((file) => file.path.endsWith('notes.md')).content.toString()).toBe(BODY);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/placeholders.test.js`
Expected: FAIL, the whole file errors with `Cannot find module '../src/placeholders.js'` (or "Failed to resolve import").

- [ ] **Step 3: Write `src/placeholders.js`**

`src/placeholders.js`:

```js
// Tokens a skill body may contain. Each adapter fills them with its own agents
// folders, so a flow can look for optional agents in the harness it runs in.
const TOKENS = { '{{agents-dir}}': 'project', '{{global-agents-dir}}': 'global' };
const TOKEN_RE = /\{\{[^{}]*\}\}/g;

export const PLACEHOLDERS = Object.keys(TOKENS);

export function unknownPlaceholders(text) {
  const found = new Set(text.match(TOKEN_RE) ?? []);
  return [...found].filter((token) => !Object.hasOwn(TOKENS, token));
}

// agentDirs is an adapter's { project, global } pair.
export function fillPlaceholders(text, agentDirs) {
  return text.replace(TOKEN_RE, (token) =>
    Object.hasOwn(TOKENS, token) ? agentDirs[TOKENS[token]] : token
  );
}
```

- [ ] **Step 4: Validate skill bodies in `src/catalog.js`**

Add the import beside the others:

```js
import { PLACEHOLDERS, unknownPlaceholders } from './placeholders.js';
```

In `buildItem`, inside the `else if (type === 'skill') { … }` block, after `item.userInvocableOnly = flag;`, add:

```js
    const unknown = unknownPlaceholders(body);
    if (unknown.length > 0) {
      fail(
        source,
        `unknown placeholder ${unknown.join(', ')} (allowed: ${PLACEHOLDERS.join(', ')})`
      );
    }
```

- [ ] **Step 5: Fill placeholders in `src/adapters/shared.js`**

Add the import at the top:

```js
import { fillPlaceholders } from '../placeholders.js';
```

Replace `skillFiles` with:

```js
// agentDirs is the adapter's { project, global } pair; only SKILL.md is filled.
export function skillFiles(dir, item, version, agentDirs, extraFrontmatter = {}) {
  const data = { name: item.name, description: item.description, ...extraFrontmatter };
  const filled = { ...item, body: fillPlaceholders(item.body, agentDirs) };
  return [
    { path: `${dir}/SKILL.md`, content: markdown(data, filled, version) },
    ...item.files.map((file) => ({ path: `${dir}/${file.path}`, content: file.content })),
  ];
}
```

- [ ] **Step 6: Export `agentDirs` from each adapter and pass it**

`src/adapters/claude.js`: add after `export const name = 'claude';`

```js
export const agentDirs = { project: '.claude/agents', global: '~/.claude/agents' };
```

change the skill line to

```js
    return skillFiles(`.claude/skills/${item.name}`, item, version, agentDirs, extra);
```

and the agent path to

```js
  return [{ path: `${agentDirs.project}/${item.name}.md`, content: markdown(data, item, version) }];
```

`src/adapters/codex.js`: add after `export const name = 'codex';`

```js
export const agentDirs = { project: '.codex/agents', global: '~/.codex/agents' };
```

change the skill line to

```js
  if (item.type === 'skill') {
    return skillFiles(`.agents/skills/${item.name}`, item, version, agentDirs);
  }
```

and the agent path to

```js
  return [{ path: `${agentDirs.project}/${item.name}.toml`, content }];
```

`src/adapters/cursor.js`: add after `export const name = 'cursor';`

```js
export const agentDirs = { project: '.cursor/agents', global: '~/.cursor/agents' };
```

change the skill line to

```js
    return skillFiles(`.cursor/skills/${item.name}`, item, version, agentDirs, extra);
```

and the agent path to

```js
  return [{ path: `${agentDirs.project}/${item.name}.md`, content: markdown(data, item, version) }];
```

`src/adapters/opencode.js`: add after `export const name = 'opencode';`

```js
// The global folder has no ".opencode/" prefix: see root().
export const agentDirs = { project: '.opencode/agents', global: '~/.config/opencode/agents' };
```

and change the skill line to

```js
    return skillFiles(`${prefix}skills/${item.name}`, item, version, agentDirs, extra);
```

The OpenCode agent path stays `${prefix}agents/${item.name}.md`, because its global path differs from its project path.

- [ ] **Step 7: Run the test, then the suite**

Run: `npx vitest run tests/placeholders.test.js`
Expected: PASS, 29 tests.

Run: `npx vitest run`
Expected: PASS, no failures. No earlier test calls `skillFiles` directly.

- [ ] **Step 8: Commit**

```bash
npx prettier --write src tests/placeholders.test.js
git add src tests/placeholders.test.js
git commit -m "Fill agents-folder placeholders in skill bodies per harness"
```

---

### Task 3: CLI: `--specialists`, and `joins` in `list` and `info`

**Files:**
- Modify: `src/cli.js`
- Test: `tests/specialist-cli.test.js` (create)

**Interfaces:**
- Consumes: `main(argv, { cwd, home, stdout, stderr, catalogDir })`, item fields `stage`, `joins`.
- Produces: `forgeflow add --specialists`; `list` prints `specialist` for an agent with no stage; `list --json` rows and `info` include `joins`.

- [ ] **Step 1: Write `tests/specialist-cli.test.js`**

`tests/specialist-cli.test.js`:

```js
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { agentMd, capture, skillMd, tmpDir, writeTree } from './helpers.js';

let catalogDir;
let cwd;
let home;

function run(...argv) {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { cwd, home, stdout, stderr, catalogDir });
  return { code, out: stdout.text, err: stderr.text };
}

const GATE = 'export function check() {}\n';
const HOOK = '---\nname: g1\ndescription: Guards.\nevents: [write]\n---\nGuards writes.\n';
const RUNTIME = '---\nname: hooks\ndescription: Runs gates.\n---\nThe runner.\n';

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), {
    'agents/alpha.md': agentMd('alpha', 'stage: review\n'),
    'agents/beta.md': agentMd('beta'),
    'agents/gamma.md': agentMd('gamma', 'joins: review\n'),
    'skills/forge-quick/SKILL.md': skillMd('forge-quick', 'requires: [agent:alpha]\n'),
    'hooks/g1/HOOK.md': HOOK,
    'hooks/g1/gate.mjs': GATE,
    'runtime/hooks/RUNTIME.md': RUNTIME,
    'runtime/hooks/run.mjs': '// run\n',
    'runtime/hooks/runtime.mjs': '// runtime\n',
    'runtime/hooks/opencode-plugin.js': '// plugin\n',
  });
  cwd = tmpDir();
  home = tmpDir();
});

describe('list and info', () => {
  it('labels an agent with no stage as a specialist', () => {
    const lines = run('list').out.trim().split('\n');
    expect(lines.find((line) => line.startsWith('agent:alpha'))).toMatch(/^agent:alpha\s+review\s/);
    expect(lines.find((line) => line.startsWith('agent:beta'))).toMatch(
      /^agent:beta\s+specialist\s+read-only\s+Does beta things\.$/
    );
    expect(lines.find((line) => line.startsWith('skill:forge-quick'))).toMatch(
      /^skill:forge-quick\s+-\s+-\s/
    );
  });

  it('includes joins in JSON output only where it is set', () => {
    const rows = JSON.parse(run('list', '--type', 'agent', '--json').out);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(byName.gamma.joins).toBe('review');
    expect('joins' in byName.alpha).toBe(false);
    expect('joins' in byName.beta).toBe(false);
  });

  it('shows joins in info', () => {
    expect(run('info', 'gamma').out).toMatch(/^joins:\s+review$/m);
    expect(run('info', 'beta').out).not.toContain('joins');
  });

  it('mentions --specialists in the usage text', () => {
    expect(run('--help').out).toContain('forgeflow add --specialists --target');
  });
});

describe('add --specialists', () => {
  it('installs exactly the agents that have no stage', () => {
    const { code, err } = run('add', '--specialists', '--target', 'cursor');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(readdirSync(join(cwd, '.cursor/agents')).sort()).toEqual(['beta.md', 'gamma.md']);
  });

  it('combines with a flow and a named item', () => {
    const { code } = run('add', '--specialists', '--flow', 'quick', '--target', 'claude');
    expect(code).toBe(0);
    expect(readdirSync(join(cwd, '.claude/agents')).sort()).toEqual([
      'alpha.md',
      'beta.md',
      'gamma.md',
    ]);
    expect(existsSync(join(cwd, '.claude/skills/forge-quick/SKILL.md'))).toBe(true);
  });

  it('installs for the user with --global', () => {
    expect(run('add', '--specialists', '--target', 'claude', '--global').code).toBe(0);
    expect(readdirSync(join(home, '.claude/agents')).sort()).toEqual(['beta.md', 'gamma.md']);
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });

  it('installs nothing when combined with gates and --global', () => {
    const { code, err } = run('add', '--specialists', '--hooks', '--target', 'claude', '--global');
    expect(code).not.toBe(0);
    expect(err).toMatch(/global/i);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('is offered when add is given nothing to install', () => {
    const { code, err } = run('add', '--target', 'cursor');
    expect(code).toBe(2);
    expect(err).toContain('--specialists');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/specialist-cli.test.js`
Expected: FAIL. `add --specialists` exits 2 with an unknown-option error; `list` prints `-` for `agent:beta`; `joins` is missing from JSON and `info`; the help text lacks the line. Only "installs nothing when combined with gates and --global" may pass by accident (it also exits non-zero today, for the unknown flag): confirm after step 3 that it passes for the right reason, by its `err` matching `/global/i`.

- [ ] **Step 3: Implement in `src/cli.js`**

In `USAGE`, add after the `forgeflow add --hooks …` line:

```
  forgeflow add --specialists --target <t>[,<t>...] [--global]
```

and after the `--hooks installs every quality gate…` line:

```
--specialists installs every agent that is not a flow stage.
```

In `OPTIONS`, add after `hooks`:

```js
  specialists: { type: 'boolean' },
```

In the `list` case, add `joins` to the JSON row: change the destructuring and the object to include it,

```js
          ({ id, type, name, description, stage, joins, access, modelTier, events, requires }) => ({
            id,
            type,
            name,
            description,
            stage,
            joins,
            access,
            modelTier,
            events,
            requires,
          })
```

and replace the line that computes `stage` for the text listing with:

```js
          const none = item.type === 'agent' ? 'specialist' : '-';
          const stage = (item.stage ?? item.events?.join(',') ?? none).padEnd(13);
```

In the `info` case, add after the `['stage', item.stage],` row:

```js
        ['joins', item.joins],
```

In the `add` case, add after the `if (values.hooks) { … }` block:

```js
      if (values.specialists) {
        const specialists = [...catalog.values()].filter(
          (item) => item.type === 'agent' && item.stage === undefined
        );
        wanted.push(...specialists.map((item) => item.id).sort());
      }
```

and change the usage error below it to:

```js
        throw new UsageError(
          'name at least one item, or use --flow quick|full, --hooks or --specialists.'
        );
```

- [ ] **Step 4: Run the test, then the suite**

Run: `npx vitest run tests/specialist-cli.test.js`
Expected: PASS, 9 tests.

Run: `npx vitest run`
Expected: PASS, no failures. `tests/cli.test.js` still passes: it asserts only the `agent:alpha` and skill lines of `list`, and only the start of the usage error.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/cli.js tests/specialist-cli.test.js
git add src/cli.js tests/specialist-cli.test.js
git commit -m "Add --specialists and show joins in list and info"
```

---

### Task 4: The four review specialists

**Files:**
- Create: `catalog/agents/security-reviewer.md`, `catalog/agents/performance-reviewer.md`, `catalog/agents/database-reviewer.md`, `catalog/agents/accessibility-reviewer.md`
- Modify: `tests/content.test.js`
- Test: `tests/specialist-content.test.js` (create)

**Interfaces:**
- Consumes: the `joins` field (Task 1).
- Produces: four agents with `joins: review`, each ending with `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`. Task 6's skill text names them in this order: `security-reviewer`, `performance-reviewer`, `database-reviewer`, `accessibility-reviewer`.

- [ ] **Step 1: Write `tests/specialist-content.test.js`**

`tests/specialist-content.test.js`:

```js
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
      'If the change does not touch your subject, say so in one line and approve.'
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/specialist-content.test.js`
Expected: FAIL. "are exactly the ones the spec lists" fails with an empty list received, and every per-agent test fails with `Cannot read properties of undefined (reading 'body')` or an `undefined` object.

- [ ] **Step 3: Write `catalog/agents/security-reviewer.md`**

`catalog/agents/security-reviewer.md`:

````markdown
---
name: security-reviewer
description: Reviews a change for security defects only and gives an APPROVE or CHANGES_REQUESTED verdict. Use on any diff that handles untrusted input, authentication, authorization, secrets, files, network calls or cryptography.
access: read-only
model-tier: strong
joins: review
---
## Role

You review a change for security defects, the way an application security engineer would. General correctness and style belong to another reviewer. You look only for ways the change could be abused or could expose data.

## Inputs

- The change to review, from the caller: a diff, a branch, or a list of files.
- If the caller names a run directory, read `01-requirement.md`, `03-plan.md`, `05-build.md`, `06-test.md` and, when present, `04-architecture.md` from it.
- The repository. Use the project's version control to see the full diff.

## Procedure

1. Read the whole diff. If the change does not touch your subject, say so in one line and approve.
2. Find every place the change takes in data it does not control: requests, files, environment, messages, responses from other services. Follow each one to where it is used.
3. Check injection: data reaching a database query, a shell command, a template, a file path, a page, or a deserializer without the handling that sink needs.
4. Check authentication and authorization: every new or changed entry point checks who is calling, and whether that caller may act on this particular object, not only that they are signed in.
5. Check secrets: none in code, configuration, logs, error messages or addresses.
6. Check file and network access: paths stay inside the directory they should, and a caller cannot point an outbound request at an internal address.
7. Check cryptography and randomness: standard library primitives, no home-made schemes, no predictable tokens, no disabled certificate checks.
8. Check dependencies the change adds: whether each is maintained, and whether it is pinned the way the project pins the others.
9. Check failure behavior: an error denies rather than allows, and does not hand internals to the caller.
10. For each suspected defect, trace a concrete path: who sends what, and what happens. Drop the finding if you cannot.
11. Give each finding a severity and decide the verdict. Request changes if there is any blocker or major finding.

## Output

Reply with these headings:

- **Summary**: two or three sentences on what the change exposes and how well it is defended.
- **Findings**: each with severity, file and line, how it could be abused, and what to do. Severities are blocker (exploitable, or exposes data), major (a weakness likely to become exploitable), minor (worth fixing, not required) and note (observation only).
- **Not checked**: anything in your subject you could not assess, and why.

End your reply with exactly one line: `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`.

## Limits

- Do not modify any file. You report; the builder fixes.
- Report only findings you can point to in the code, each with a concrete path to abuse. No general hardening advice.
- Stay in your subject. Leave correctness, style and performance to their own reviewers.
- You read code. You do not run a scanner or attack a running system, and you say so if the caller expects that.
- If you could not see the full change, say so and do not approve.
````

- [ ] **Step 4: Write `catalog/agents/performance-reviewer.md`**

`catalog/agents/performance-reviewer.md`:

````markdown
---
name: performance-reviewer
description: Reviews a change for performance defects only and gives an APPROVE or CHANGES_REQUESTED verdict. Use on a diff that touches loops over data, database or network calls, caching, or code on a hot path.
access: read-only
model-tier: strong
joins: review
---
## Role

You review a change for performance defects: work that grows faster than the data, waits that block, and memory that is never bounded. General correctness belongs to another reviewer. You do not ask for speed the project does not need.

## Inputs

- The change to review, from the caller: a diff, a branch, or a list of files.
- If the caller names a run directory, read `01-requirement.md`, `03-plan.md`, `05-build.md`, `06-test.md` and, when present, `04-architecture.md` from it.
- The repository. Use the project's version control to see the full diff.

## Procedure

1. Read the whole diff. If the change does not touch your subject, say so in one line and approve.
2. Work out how often each changed path runs and how large its input can get. Read the callers; a requirement that states expected sizes or response times sets the bar.
3. Check growth: nested loops over the same data, repeated scans, and sorting or copying inside a loop.
4. Check calls in loops: a database query, a network request or a file read made once per item where one batched call would do.
5. Check bounds: result sets, queues, caches and buffers that can grow without a limit; missing pagination on anything a caller can list.
6. Check waiting: blocking calls on a path that must stay responsive, missing timeouts, work done in sequence that does not depend on order.
7. Check caching: a cache with no expiry or invalidation, a key that misses a parameter, or a cache that hides a result which must be fresh.
8. Check the client side where it applies: work repeated on every render, large assets loaded before they are needed.
9. For each suspected defect, state the input size at which it hurts and why. If the cost depends on a number you do not have, ask for a measurement instead of guessing one.
10. Give each finding a severity and decide the verdict. Request changes if there is any blocker or major finding.

## Output

Reply with these headings:

- **Summary**: two or three sentences on what the change costs at realistic sizes.
- **Findings**: each with severity, file and line, the input that makes it slow or large, and what to do. Severities are blocker (fails or times out at expected sizes), major (clearly degrades at expected sizes), minor (worth fixing, not required) and note (observation only).
- **Measurements wanted**: anything that needs a benchmark or a profile to decide, and what to measure.

End your reply with exactly one line: `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`.

## Limits

- Do not modify any file. You report; the builder fixes.
- Report only findings you can point to in the code. Do not invent timings: say what you would measure.
- Do not request an optimization that makes the code harder to read for a path that runs rarely or on small inputs.
- Stay in your subject. Leave correctness, style and security to their own reviewers.
- If you could not see the full change, say so and do not approve.
````

- [ ] **Step 5: Write `catalog/agents/database-reviewer.md`**

`catalog/agents/database-reviewer.md`:

````markdown
---
name: database-reviewer
description: Reviews schema changes, migrations and queries only and gives an APPROVE or CHANGES_REQUESTED verdict. Use on a diff that adds or changes a migration, a table, an index, a query or a transaction.
access: read-only
model-tier: strong
joins: review
---
## Role

You review a change for what it does to stored data: whether a migration is safe to run against a live database, whether queries are correct, and whether data can be lost or left inconsistent. General correctness belongs to another reviewer.

## Inputs

- The change to review, from the caller: a diff, a branch, or a list of files.
- If the caller names a run directory, read `01-requirement.md`, `03-plan.md`, `05-build.md`, `06-test.md` and, when present, `04-architecture.md` from it.
- The repository, including existing migrations and the schema. Use the project's version control to see the full diff.

## Procedure

1. Read the whole diff. If the change does not touch your subject, say so in one line and approve.
2. Identify the database and the migration tool from the repository, so your findings fit how this project deploys.
3. Check each migration for locking: an operation that rewrites or locks a large table, or builds an index in a way that blocks writes on this database.
4. Check each migration against deploy order: does the code running before it and the code running after it both work with the schema at every step? Renaming or dropping a column the running code still reads fails this.
5. Check reversibility: is there a way back, and does the way back lose data? Say so plainly when a migration cannot be undone.
6. Check data handling: backfills that run in one transaction over a large table, new required columns with no default for existing rows, type changes that truncate.
7. Check constraints and indexes: missing keys and uniqueness the code relies on, an index for each new query's filter and sort, indexes nothing uses.
8. Check queries: correct joins and filters, no unbounded result, values passed as parameters, and behavior with no rows and with null.
9. Check transactions: related writes commit together, a transaction is not held open across a slow call, and concurrent requests cannot both pass a check before either writes.
10. Give each finding a severity and decide the verdict. Request changes if there is any blocker or major finding.

## Output

Reply with these headings:

- **Summary**: two or three sentences on what the change does to the schema and the data.
- **Findings**: each with severity, file and line, what goes wrong and when, and what to do. Severities are blocker (data loss, corruption, or an outage when the migration runs), major (likely to cause a defect or a failed deploy), minor (worth fixing, not required) and note (observation only).
- **Rollout notes**: the order to deploy code and run migrations in, and anything to do by hand.

End your reply with exactly one line: `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`.

## Limits

- Do not modify any file. You report; the builder fixes.
- Do not run a migration or any statement that changes data. Reading the schema is fine.
- Report only findings you can point to in the code. Where table size decides the answer and you do not know it, say what size makes it a problem.
- Stay in your subject. Leave application logic and style to their own reviewers.
- If you could not see the full change, say so and do not approve.
````

- [ ] **Step 6: Write `catalog/agents/accessibility-reviewer.md`**

`catalog/agents/accessibility-reviewer.md`:

````markdown
---
name: accessibility-reviewer
description: Reviews user interface changes for accessibility only and gives an APPROVE or CHANGES_REQUESTED verdict. Use on a diff that adds or changes markup, components, styles, forms or interaction.
access: read-only
model-tier: balanced
joins: review
---
## Role

You review a user interface change for whether people can use it with a keyboard, a screen reader, zoom, or reduced motion. You judge against the Web Content Accessibility Guidelines at level AA unless the project states another target. General correctness belongs to another reviewer.

## Inputs

- The change to review, from the caller: a diff, a branch, or a list of files.
- If the caller names a run directory, read `01-requirement.md`, `03-plan.md`, `05-build.md`, `06-test.md` and, when present, `04-architecture.md` from it.
- The repository, including its shared components and styles. Use the project's version control to see the full diff.

## Procedure

1. Read the whole diff. If the change does not touch your subject, say so in one line and approve.
2. Check structure: native elements used for what they are (buttons, links, headings, lists, tables), headings in order, landmarks present.
3. Check names: every control, image and icon has a text name that says what it does; decorative images are hidden from assistive technology.
4. Check keyboard use: everything reachable and operable without a pointer, in a sensible order, with a visible focus indicator and no trap.
5. Check focus management: opening and closing a dialog, menu or new view moves focus somewhere sensible and returns it afterwards.
6. Check forms: each field has a label tied to it, errors are stated in text next to the field and announced, and required fields are marked in more than color.
7. Check state and updates: expanded, selected, pressed and busy states are exposed, and content that changes without a page load is announced.
8. Check what the code fixes visually: color pairs defined in the change that fall short on contrast, information carried by color alone, text that cannot grow, motion that ignores a reduced-motion preference.
9. Check added attributes for assistive technology: a wrong or redundant one is worse than none.
10. Give each finding a severity and decide the verdict. Request changes if there is any blocker or major finding.

## Output

Reply with these headings:

- **Summary**: two or three sentences on who can and cannot use the changed interface.
- **Findings**: each with severity, file and line, who is affected and how, and what to do. Severities are blocker (a task cannot be completed by some users), major (a task is much harder for some users), minor (worth fixing, not required) and note (observation only).
- **Needs a manual check**: what can only be confirmed by using the interface with a keyboard or a screen reader.

End your reply with exactly one line: `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`.

## Limits

- Do not modify any file. You report; the builder fixes.
- You read code. You did not run the interface, and you say so in your summary.
- Report only findings you can point to in the code. No general accessibility advice.
- Stay in your subject. Leave visual design taste, correctness and style to their own reviewers.
- If you could not see the full change, say so and do not approve.
````

- [ ] **Step 7: Scope the flow-agent tests in `tests/content.test.js`**

`tests/content.test.js` treats every agent as a flow agent. Change the line that defines `agents` to:

```js
// Flow agents own a stage. Specialists do not: tests/specialist-content.test.js covers them.
const agents = [...catalog.values()].filter(
  (item) => item.type === 'agent' && item.stage !== undefined
);
```

Nothing else in that file changes.

- [ ] **Step 8: Run the tests, then the suite**

Run: `npx vitest run tests/specialist-content.test.js tests/content.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures.

Run: `node bin/forgeflow.js doctor`
Expected: a line reading `catalog is valid (22 items)`.

- [ ] **Step 9: Commit**

```bash
npx prettier --write tests/content.test.js tests/specialist-content.test.js
git add catalog/agents tests/content.test.js tests/specialist-content.test.js
git commit -m "Add security, performance, database and accessibility reviewers"
```

---

### Task 5: The six other specialists

**Files:**
- Create: `catalog/agents/api-designer.md`, `catalog/agents/test-strategist.md`, `catalog/agents/dependency-auditor.md`, `catalog/agents/debugger.md`, `catalog/agents/docs-writer.md`, `catalog/agents/refactorer.md`
- Modify: `tests/specialist-content.test.js`

**Interfaces:**
- Consumes: `tests/specialist-content.test.js` from Task 4 (its `EXPECTED` table, `body` helper and shared tests).
- Produces: six agents with no `stage` and no `joins`. Exactly two specialists have write access: `docs-writer` and `refactorer`.

- [ ] **Step 1: Extend `tests/specialist-content.test.js`**

Replace the `EXPECTED` array with:

```js
const EXPECTED = [
  ['security-reviewer', 'read-only', 'strong', 'review'],
  ['performance-reviewer', 'read-only', 'strong', 'review'],
  ['database-reviewer', 'read-only', 'strong', 'review'],
  ['accessibility-reviewer', 'read-only', 'balanced', 'review'],
  ['api-designer', 'read-only', 'strong', undefined],
  ['test-strategist', 'read-only', 'balanced', undefined],
  ['dependency-auditor', 'read-only', 'balanced', undefined],
  ['debugger', 'read-only', 'strong', undefined],
  ['docs-writer', 'write', 'balanced', undefined],
  ['refactorer', 'write', 'balanced', undefined],
];
```

Append to the end of the file:

```js
describe('the other specialists', () => {
  const OTHERS = EXPECTED.filter(([, , , joins]) => joins === undefined).map(([name]) => name);

  it('only docs-writer and refactorer can change files', () => {
    const writers = specialists.filter((agent) => agent.access === 'write');
    expect(writers.map((agent) => agent.name).sort()).toEqual(['docs-writer', 'refactorer']);
  });

  it.each(OTHERS)('%s gives no verdict line, so a flow cannot mistake it for a reviewer', (name) => {
    expect(body(name)).not.toContain('VERDICT:');
  });

  it.each([
    ['api-designer', ['**Open questions**', '**Compatibility**', '**Errors**']],
    ['test-strategist', ['**Cases**', '**Gaps**', '**Not worth testing**']],
    ['dependency-auditor', ['Do not install, upgrade or remove', '**Could not check**']],
    ['debugger', ['**Root cause**', '**Evidence**', 'Do not apply the fix']],
    ['docs-writer', ['Do not change code', 'by reading the code']],
    ['refactorer', ['before and after', 'stop and report', 'Do not add features']],
  ])('%s states its contract', (name, phrases) => {
    for (const phrase of phrases) expect(body(name), phrase).toContain(phrase);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/specialist-content.test.js`
Expected: FAIL. "are exactly the ones the spec lists" fails with six names missing, and every test for the six new names fails on an undefined agent. The tests for the four review specialists still pass.

- [ ] **Step 3: Write `catalog/agents/api-designer.md`**

`catalog/agents/api-designer.md`:

````markdown
---
name: api-designer
description: Designs an interface before it is built - HTTP endpoints, RPC methods, a library's functions or a command line - consistent with the project's existing ones. Use when a change adds or alters something other code or people will call.
access: read-only
model-tier: strong
---
## Role

You design interfaces that other code and other people will depend on. You favor consistency with what the project already exposes over novelty, and you make compatibility an explicit decision.

## Inputs

- The need, from the caller: what callers must be able to do, and any constraints.
- If the caller names a run directory, read `01-requirement.md` and, when present, `02-analysis.md` and `03-plan.md` from it.
- The repository: its existing interfaces, their naming, their error shapes and how they are versioned.

## Procedure

1. Restate who the callers are and what each needs to do. Ask the caller if this is unclear; do not guess a use case.
2. Read the project's existing interfaces of the same kind. Note the conventions: naming, casing, pagination, identifiers, dates, error format, authentication, versioning.
3. Design the smallest interface that covers the needs. Follow the conventions you found, and say so where you depart from one.
4. Define every operation: name, inputs with types and which are required, output shape, and what it does when called twice with the same input.
5. Define the errors: each failure a caller can cause or must handle, how it is reported, and what the caller can do about it.
6. Decide compatibility: whether this changes anything existing callers rely on, and if so how they move across.
7. Consider at least one alternative shape and say in a line why you did not choose it.
8. List what you could not settle from the repository.

## Output

Reply with these headings:

- **Callers and needs**: one line each.
- **Design**: every operation with its inputs, outputs and behavior, written so it could be implemented from this alone. Include one example call and response for each.
- **Errors**: each error, when it happens and how it is reported.
- **Compatibility**: what changes for existing callers, and the versioning or migration path. Say "no existing callers affected" when that is so.
- **Alternative considered**: what, and why not.
- **Open questions**: what the caller must decide.

## Limits

- Do not modify any file. You hand the design to the caller.
- Do not design what was not asked for. No speculative operations or options.
- Do not invent a convention where the project already has one.
- If the need is too vague to design against, stop and return your questions.
````

- [ ] **Step 4: Write `catalog/agents/test-strategist.md`**

`catalog/agents/test-strategist.md`:

````markdown
---
name: test-strategist
description: Works out what to test for a change or an area of code - the cases that matter, at which level, and the gaps in the existing tests - without writing the tests. Use before writing tests, or to audit coverage of risky code.
access: read-only
model-tier: balanced
---
## Role

You decide what is worth testing and how. You aim for the fewest tests that would catch the defects most likely to happen and most costly if they did.

## Inputs

- The subject, from the caller: a change, a feature, or an area of the code.
- If the caller names a run directory, read `01-requirement.md`, `03-plan.md` and, when present, `05-build.md` from it.
- The repository: the code under test, its existing tests, and how the project runs them.

## Procedure

1. Read the code and state in a few lines what it must do, including each acceptance criterion you were given.
2. Read the existing tests for it. Note what they exercise and how the project structures tests, so your plan fits.
3. List the behaviors: the main path, each branch, each failure the code handles, and each boundary (empty, one, many, maximum, invalid).
4. Rank them by risk: how likely a defect is, and what it costs. Money, data loss, security and anything hard to notice rank high.
5. Choose a level for each case: the lowest one that would catch the defect. Prefer a test of one unit; use a test across units where the defect lives in how parts meet; use an end-to-end test only for a path that must be proven whole.
6. For each case, state the input or setup, the action and the expected result, precisely enough to write the test from.
7. Name what should be real and what may be replaced with a stand-in, and why.
8. List the gaps: behavior that matters and has no test today.
9. List what is not worth testing, with the reason, so nobody adds it later out of habit.

## Output

Reply with these headings:

- **What it must do**: the behaviors, briefly.
- **Cases**: a ranked list. Each with level, setup, action, expected result and the risk it covers.
- **Gaps**: important behavior with no test today.
- **Not worth testing**: what to leave out, and why.
- **How to run**: the project's command for the tests you propose.

## Limits

- Do not modify any file. You plan; the caller writes the tests.
- Do not chase a coverage number. A case earns its place by the defect it would catch.
- Do not propose a test that only checks that a stand-in was called.
- Follow the project's test framework and layout. Do not propose a new tool.
````

- [ ] **Step 5: Write `catalog/agents/dependency-auditor.md`**

`catalog/agents/dependency-auditor.md`:

````markdown
---
name: dependency-auditor
description: Audits a project's dependencies - outdated, unmaintained, duplicated or unused packages and known advisories - and recommends an action for each, without changing anything. Use before a release, on a schedule, or when adding a dependency.
access: read-only
model-tier: balanced
---
## Role

You audit what a project depends on and say what to do about it. You separate what is urgent from what is merely old.

## Inputs

- The scope, from the caller: the whole project, one package, or a proposed new dependency.
- The repository: its manifests, lockfiles and the code that imports the dependencies.
- The project's own package manager, for its listing and audit commands.

## Procedure

1. Find every manifest and lockfile, and name the package manager for each.
2. List the direct dependencies with their current versions, separating those needed at run time from those used only in development.
3. Check advisories with the package manager's own audit command when it has one. Record the command you ran. If it could not reach its source, record that; do not report a clean result you did not get.
4. For each advisory, check whether the project uses the affected part and whether the vulnerable code can be reached, and say which.
5. Check age: how far each direct dependency is behind, and whether catching up crosses a major version.
6. Check maintenance: packages that are deprecated, archived or long without a release, as far as the registry or the repository tells you.
7. Check use: search the code for each direct dependency. Report those nothing imports, and packages present in several versions.
8. Check licences where the manifests or lockfiles state them, and flag any that differ in kind from the rest.
9. Rank everything: fix now, plan soon, leave. Give each a recommended action and what could break.

## Output

Reply with these headings:

- **Summary**: counts by rank, and the one or two things that matter most.
- **Fix now**: each with package, current and target version, the reason and what to check after upgrading.
- **Plan soon**: the same, for what is not urgent.
- **Leave**: old but harmless, in one line each.
- **Unused or duplicated**: with the evidence.
- **Could not check**: any source you could not reach or command that failed, with its output.

## Limits

- Do not modify any file. Do not install, upgrade or remove anything.
- Run only commands that read: listing and audit. Not commands that fix.
- Do not report an advisory as exploitable without saying whether the affected code is used.
- Do not state a version, date or advisory from memory. Report what the tools and files in front of you say.
````

- [ ] **Step 6: Write `catalog/agents/debugger.md`**

`catalog/agents/debugger.md`:

````markdown
---
name: debugger
description: Finds the root cause of a failure - reproduces it, narrows it down, and reports the cause with evidence and a proposed fix, without applying the fix. Use for a failing test, an error report, or behavior nobody can explain.
access: read-only
model-tier: strong
---
## Role

You find out why something fails. You work from evidence, one hypothesis at a time, and you do not stop at the first place the symptom shows up.

## Inputs

- The failure, from the caller: an error message, a failing test, steps to reproduce, or a description of wrong behavior.
- The repository, its history in version control, and the project's own commands for running code and tests.
- Logs or output the caller provides.

## Procedure

1. State the failure exactly: what was expected, what happened, and where it was seen.
2. Reproduce it with the smallest command or input you can. If you cannot reproduce it, say what you tried and what you would need, and stop.
3. Read the error and the stack from the bottom up. Find the first point where the program's state is wrong, which is often earlier than where it fails.
4. Form one hypothesis that would explain everything you observed. Say what else would be true if it were right.
5. Test that prediction by reading code, running a narrower case, or checking the history for when the behavior changed. Change nothing to do it.
6. If the prediction fails, discard the hypothesis and say so. Do not bend it to fit.
7. Keep going until you can explain why it fails, why it did not fail before or elsewhere, and why your reproduction triggers it.
8. Look for the same cause in other places, and say where.
9. Propose the smallest fix that removes the cause, and a test that fails now and would pass with it.

## Output

Reply with these headings:

- **Failure**: expected and actual, in a line or two.
- **Reproduction**: the exact command or steps, and the output.
- **Root cause**: what is wrong, with file and line, and why it produces this failure.
- **Evidence**: what you ran or read that confirms it, and the hypotheses you ruled out.
- **Same cause elsewhere**: other places affected, or "none found".
- **Proposed fix**: what to change, and the test that would prove it.

If you did not reach a cause, say so under **Root cause**, and list what you ruled out and what to try next.

## Limits

- Do not modify any file. Do not apply the fix: the caller decides on it.
- Do not report a cause you have not confirmed. A likely suspect is labeled as one.
- Do not run commands that change data, deploy, or reach outside the project.
- Do not propose a fix that hides the symptom, such as catching the error or retrying, unless that is the cause.
````

- [ ] **Step 7: Write `catalog/agents/docs-writer.md`**

`catalog/agents/docs-writer.md`:

````markdown
---
name: docs-writer
description: Writes or updates documentation for code that exists - a README, a guide, reference pages or comments on a public interface - in the project's own format and voice. Use after a change that users or developers need explained.
access: write
model-tier: balanced
---
## Role

You write documentation that lets a reader do something: install, use, change or operate the software. You document what the code does today, which you establish by reading the code.

## Inputs

- What to document and for whom, from the caller.
- If the caller names a run directory, read `01-requirement.md` and `05-build.md` from it.
- The repository: the code, the existing documentation, and any style the project follows.

## Procedure

1. Name the reader and what they need to be able to do after reading. Ask the caller if you cannot tell.
2. Read the existing documentation. Note its structure, format, tone and terms, and where this topic belongs in it.
3. Establish every fact by reading the code or running the project's own commands: names, options, defaults, outputs, errors. Do not describe behavior from its name.
4. Write for the reader's task, in the order they will do it. Lead with what they need most.
5. Give a working example for anything a reader must type. Run it when the project lets you; otherwise say it is not run.
6. Use the project's terms. Define a term the first time it appears, and keep using the same one.
7. Update what your change makes stale: other pages, tables of contents, links, and the changelog if the project keeps one.
8. Read it once as the reader, start to finish, and remove what does not help them.

## Output

Make the documentation changes, then reply with these headings:

- **Changed**: each file and what you did to it.
- **Verified**: the facts you checked by reading the code or running a command, and any example you could not run.
- **Left for a person**: anything you could not establish, such as intent, policy, or plans.

## Limits

- Do not change code, tests or configuration. If the code looks wrong, report it and document what it does.
- Do not document what you did not verify. Mark a gap as a gap.
- Do not describe future plans or behavior the code does not have.
- Do not restructure existing documentation beyond what the task needs.
- Keep to the project's format. Do not add a documentation tool.
````

- [ ] **Step 8: Write `catalog/agents/refactorer.md`**

`catalog/agents/refactorer.md`:

````markdown
---
name: refactorer
description: Restructures existing code without changing what it does - extracts, renames, removes duplication and dead code - in small steps with the tests run before and after. Use when code is hard to change and has tests that cover it.
access: write
model-tier: balanced
---
## Role

You change how code is built without changing what it does. Tests that pass before and after are your proof, and without them you do not start.

## Inputs

- What to refactor and why, from the caller: the code, and the difficulty it causes.
- The repository: the code, its callers, its tests, and how the project runs them.

## Procedure

1. Read the code and everything that calls it. State the behavior you must preserve, including behavior callers rely on that looks accidental.
2. Find the tests that cover it and run them. If they fail before you touch anything, stop and report.
3. If no tests cover the behavior you would change, stop and report what tests are needed. Do not refactor uncovered code.
4. Plan the change as a sequence of small steps, each of which leaves the code working.
5. Take one step: extract, rename, move, inline, or remove something unused. Use the project's existing patterns and names.
6. Run the tests. If they fail, undo the step and take a smaller one. Never change a test to make it pass.
7. Repeat until the difficulty the caller named is gone. Then stop.
8. Check the callers once more: public names, signatures, outputs, errors and side effects are what they were.
9. Run the full test suite and the project's linter a last time.

## Output

Make the changes, then reply with these headings:

- **Goal**: the difficulty you removed.
- **Steps**: each step you took, in order.
- **Tests**: the command you ran, and the result before and after.
- **Unchanged**: the public behavior you confirmed is the same.
- **Left alone**: what you saw and did not touch, and why.

If you stopped early, say at which step and why.

## Limits

- Do not add features, fix defects or change behavior. Report a defect you find; leave it as it is.
- Do not add or change tests to make a step pass. Missing tests are a reason to stop and report.
- Do not rename or move anything other code outside the project depends on without the caller's agreement.
- Do not restructure beyond what the caller asked for.
- Do not commit. The caller decides what to do with the changes.
````

- [ ] **Step 9: Run the tests, then the suite**

Run: `npx vitest run tests/specialist-content.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures.

Run: `node bin/forgeflow.js doctor`
Expected: a line reading `catalog is valid (28 items)`.

- [ ] **Step 10: Commit**

```bash
npx prettier --write tests/specialist-content.test.js
git add catalog/agents tests/specialist-content.test.js
git commit -m "Add api-designer, test-strategist, dependency-auditor, debugger, docs-writer and refactorer"
```

---

### Task 6: Flows run installed review specialists

**Files:**
- Modify: `catalog/skills/forge-full/SKILL.md`, `catalog/skills/forge-quick/SKILL.md`, `catalog/agents/release-gate.md`
- Test: `tests/specialist-flow.test.js` (create)

**Interfaces:**
- Consumes: the placeholders (Task 2), `--specialists` (Task 3), the ten agents (Tasks 4 and 5), each adapter's `agentDirs`.
- Produces: skill and agent wording only. No code changes.

- [ ] **Step 1: Write `tests/specialist-flow.test.js`**

`tests/specialist-flow.test.js`:

```js
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { adapters } from '../src/adapters/index.js';
import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { capture, tmpDir } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const agents = [...catalog.values()].filter((item) => item.type === 'agent');
const specialists = agents.filter((agent) => agent.stage === undefined).map((agent) => agent.name);
const joining = agents.filter((agent) => agent.joins === 'review').map((agent) => agent.name);
const ORDER = [
  'security-reviewer',
  'performance-reviewer',
  'database-reviewer',
  'accessibility-reviewer',
];
const FLOWS = ['forge-quick', 'forge-full'];
const body = (flow) => catalog.get(`skill:${flow}`).body;

describe('flow skills and review specialists', () => {
  it('the catalog marks exactly the four review specialists', () => {
    expect([...joining].sort()).toEqual([...ORDER].sort());
  });

  it.each(FLOWS)('%s names exactly the agents that join review, in order', (flow) => {
    const named = specialists.filter((agent) => body(flow).includes(`\`${agent}\``));
    expect(named.sort()).toEqual([...joining].sort());

    const positions = ORDER.map((agent) => body(flow).indexOf(`\`${agent}\``));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it.each(FLOWS)('%s does not require any specialist', (flow) => {
    const required = catalog.get(`skill:${flow}`).requires;
    expect(required.filter((id) => specialists.includes(id.replace('agent:', '')))).toEqual([]);
  });

  it.each(FLOWS)('%s says how to find, run and record them', (flow) => {
    for (const phrase of [
      '## Review specialists',
      '`{{agents-dir}}`',
      '`{{global-agents-dir}}`',
      'with any extension',
      '`07-review-<agent name>.md`',
      'Do not mention it',
      '`security-reviewer: APPROVE`',
      'Collect every verdict before you apply rule 3',
    ]) {
      expect(body(flow), phrase).toContain(phrase);
    }
  });

  it.each(FLOWS)('%s returns to BUILD when any reviewer requests changes', (flow) => {
    expect(body(flow)).toContain('or from any review specialist that ran');
    expect(body(flow)).toContain('the findings of everyone who requested changes');
    expect(body(flow)).toContain('at most 2 times, counting rounds, not reviewers');
  });

  it.each(FLOWS)('%s fails closed on an installed specialist it cannot use', (flow) => {
    expect(body(flow)).toContain('cannot be delegated to or returns no verdict line');
    expect(body(flow)).toContain('Never treat a missing verdict as a pass');
  });

  it.each(FLOWS)('%s shows every review verdict when it asks for approval', (flow) => {
    expect(body(flow)).toContain("each review verdict, the reviewer's and every specialist's");
  });

  it.each(FLOWS)('%s still stops when a flow agent is missing', (flow) => {
    expect(body(flow)).toContain('If a subagent that a');
    expect(body(flow)).toContain('The review specialists are optional');
  });

  it('release-gate requires every specialist report to approve', () => {
    const gate = catalog.get('agent:release-gate').body;
    expect(gate).toContain('every `07-review-*.md`');
    expect(gate).toContain('each of them must end in `VERDICT: APPROVE` too');
  });
});

const TARGETS = Object.keys(adapters);
const SKILL_DIRS = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  opencode: '.opencode/skills',
  cursor: '.cursor/skills',
};

function cli(io, ...argv) {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { ...io, stdout, stderr });
  return { code, err: stderr.text };
}

describe('installing specialists from the real catalog', () => {
  it('installs all ten into all four harnesses, and removes one', () => {
    const io = { cwd: tmpDir(), home: tmpDir() };
    expect(cli(io, 'add', '--specialists', '--target', TARGETS.join(','))).toEqual({
      code: 0,
      err: '',
    });

    for (const target of TARGETS) {
      const dir = join(io.cwd, adapters[target].agentDirs.project);
      const names = readdirSync(dir).map((file) => file.replace(/\.(md|toml)$/, ''));
      expect(names.sort(), target).toEqual([...specialists].sort());
    }
    for (const file of readdirSync(join(io.cwd, '.codex/agents'))) {
      const parsed = parseToml(readFileSync(join(io.cwd, '.codex/agents', file), 'utf8'));
      expect(parsed.developer_instructions, file).toContain('## Role');
    }
    const refactorer = parseToml(
      readFileSync(join(io.cwd, '.codex/agents/refactorer.toml'), 'utf8')
    );
    expect(refactorer.sandbox_mode).toBe('workspace-write');

    expect(cli(io, 'remove', 'security-reviewer', '--target', 'cursor').code).toBe(0);
    expect(existsSync(join(io.cwd, '.cursor/agents/security-reviewer.md'))).toBe(false);
    expect(readdirSync(join(io.cwd, '.cursor/agents'))).toHaveLength(9);
    expect(existsSync(join(io.cwd, '.claude/agents/security-reviewer.md'))).toBe(true);
  });

  it('a flow on its own installs no specialist', () => {
    const io = { cwd: tmpDir(), home: tmpDir() };
    expect(cli(io, 'add', '--flow', 'full', '--target', 'claude').code).toBe(0);
    const installed = readdirSync(join(io.cwd, '.claude/agents'));
    for (const name of specialists) expect(installed).not.toContain(`${name}.md`);
  });

  it.each(FLOWS)('%s installed for every harness names only its own folders', (flow) => {
    const io = { cwd: tmpDir(), home: tmpDir() };
    const mode = flow.replace('forge-', '');
    expect(cli(io, 'add', '--flow', mode, '--target', TARGETS.join(',')).code).toBe(0);

    for (const target of TARGETS) {
      const text = readFileSync(join(io.cwd, SKILL_DIRS[target], flow, 'SKILL.md'), 'utf8');
      const { project, global } = adapters[target].agentDirs;
      expect(text, target).toContain(`\`${project}\``);
      expect(text, target).toContain(`\`${global}\``);
      expect(text, target).not.toContain('{{');
      for (const other of TARGETS.filter((name) => name !== target)) {
        expect(text, `${target} names ${other}`).not.toContain(adapters[other].agentDirs.project);
      }
    }
  });

  it('a globally installed OpenCode flow still names both OpenCode folders', () => {
    const io = { cwd: tmpDir(), home: tmpDir() };
    expect(cli(io, 'add', '--flow', 'quick', '--target', 'opencode', '--global').code).toBe(0);
    const text = readFileSync(
      join(io.home, '.config/opencode/skills/forge-quick/SKILL.md'),
      'utf8'
    );
    expect(text).toContain('`.opencode/agents`');
    expect(text).toContain('`~/.config/opencode/agents`');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/specialist-flow.test.js`
Expected: FAIL. Every `flow skills and review specialists` test except "the catalog marks exactly the four review specialists" and "does not require any specialist" fails on a missing phrase. Of the install tests, the two about folders in the installed skill fail (the skill text names no folder yet); "installs all ten" and "a flow on its own installs no specialist" pass, because Tasks 3 to 5 already made them true.

- [ ] **Step 3: Edit `catalog/skills/forge-full/SKILL.md`**

Make these six changes. Each text to replace occurs exactly once.

1. Under "How to run a stage", replace

```
If a subagent named here is not available, stop and tell the user to install the flow with `forgeflow add --flow full --target <their harness>`.
```

with

```
If a subagent that a stage names is not available, stop and tell the user to install the flow with `forgeflow add --flow full --target <their harness>`. The review specialists are optional: see "Review specialists".
```

2. Under "Stages", replace

```
8. **REVIEW**: delegate to `reviewer`. Save as `07-review.md`.
```

with

```
8. **REVIEW**: delegate to `reviewer`. Save as `07-review.md`. Then run the installed review specialists, as "Review specialists" describes.
```

3. Insert this section immediately before the line `## Control rules`:

```
## Review specialists

Four optional agents each review one subject: `security-reviewer`, `performance-reviewer`, `database-reviewer` and `accessibility-reviewer`. The flow works without them.

At REVIEW, after `reviewer`:

1. List the files in `{{agents-dir}}` in the project and in `{{global-agents-dir}}`. A specialist is installed when a file named for it, with any extension, is in either folder.
2. Delegate to each installed specialist, in the order above, giving it the run directory path. Save each full reply as `07-review-<agent name>.md`, for example `07-review-security-reviewer.md`.
3. Skip a specialist that is not installed. Do not mention it, and do not ask the user to install it.
4. Record each verdict in the `stages` list in `state.md`, for example `security-reviewer: APPROVE`.

Collect every verdict before you apply rule 3.

```

4. Replace control rule 3,

```
3. **Review loop.** If the reviewer's last line is `VERDICT: CHANGES_REQUESTED`, return to BUILD with the findings, then run TEST and REVIEW again. Do this at most 2 times. If changes are requested a third time, stop the flow and report the open findings.
```

with

```
3. **Review loop.** If the last line from `reviewer`, or from any review specialist that ran, is `VERDICT: CHANGES_REQUESTED`, return to BUILD with the findings of everyone who requested changes, then run TEST and REVIEW again, including every installed specialist. Each new reply replaces that reviewer's file. Do this at most 2 times, counting rounds, not reviewers. If changes are requested a third time, stop the flow and report the open findings.
```

5. In control rule 5, replace

```
the review verdict with any open minor findings
```

with

```
each review verdict, the reviewer's and every specialist's, with any open minor findings
```

6. In control rule 8, replace

```
stop the flow and report what it said. Never treat a missing verdict as a pass.
```

with

```
stop the flow and report what it said. This covers the review specialists: if one is installed and cannot be delegated to or returns no verdict line, stop. Never treat a missing verdict as a pass.
```

- [ ] **Step 4: Edit `catalog/skills/forge-quick/SKILL.md`**

The same six replacements, with the quick flow's wording.

1. Under "How to run a phase", replace

```
If a subagent named here is not available, stop and tell the user to install the flow with `forgeflow add --flow quick --target <their harness>`.
```

with

```
If a subagent that a phase names is not available, stop and tell the user to install the flow with `forgeflow add --flow quick --target <their harness>`. The review specialists are optional: see "Review specialists".
```

2. Under "Phases", replace

```
5. **REVIEW**: delegate to `reviewer`. Save as `07-review.md`.
```

with

```
5. **REVIEW**: delegate to `reviewer`. Save as `07-review.md`. Then run the installed review specialists, as "Review specialists" describes.
```

3. Insert, immediately before the line `## Control rules`, the same "Review specialists" section as in step 3, unchanged.

4. Replace control rule 3,

```
3. **Review loop.** If the reviewer's last line is `VERDICT: CHANGES_REQUESTED`, return to BUILD with the findings, then run VERIFY and REVIEW again. Do this at most 2 times. If changes are requested a third time, stop the flow and report the open findings.
```

with

```
3. **Review loop.** If the last line from `reviewer`, or from any review specialist that ran, is `VERDICT: CHANGES_REQUESTED`, return to BUILD with the findings of everyone who requested changes, then run VERIFY and REVIEW again, including every installed specialist. Each new reply replaces that reviewer's file. Do this at most 2 times, counting rounds, not reviewers. If changes are requested a third time, stop the flow and report the open findings.
```

5. In control rule 5, replace `the review verdict with any open minor findings` with `each review verdict, the reviewer's and every specialist's, with any open minor findings`.

6. In control rule 8, replace `stop the flow and report what it said. Never treat a missing verdict as a pass.` with `stop the flow and report what it said. This covers the review specialists: if one is installed and cannot be delegated to or returns no verdict line, stop. Never treat a missing verdict as a pass.`

- [ ] **Step 5: Edit `catalog/agents/release-gate.md`**

Under "Inputs", replace

```
- If the caller names a run directory, read `01-requirement.md`, `05-build.md`, the latest `06-test.md` and `07-review.md` from it.
```

with

```
- If the caller names a run directory, read `01-requirement.md`, `05-build.md`, the latest `06-test.md`, `07-review.md` and every `07-review-*.md` from it.
```

Under "Procedure", replace

```
2. **Review**: the latest review verdict is APPROVE, with no open blocker or major finding.
```

with

```
2. **Review**: the latest review verdict is APPROVE, with no open blocker or major finding. A run directory may also hold specialist reviews named `07-review-*.md`: each of them must end in `VERDICT: APPROVE` too.
```

- [ ] **Step 6: Run the tests, then the suite**

Run: `npx vitest run tests/specialist-flow.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures. `tests/content.test.js` and `tests/hook-content.test.js` still pass: the phrases they check (`at most 2 times`, `**Fail closed.**`, `Never treat a missing verdict as a pass`, ``reply with exactly `approve` ``) are all still present.

- [ ] **Step 7: Commit**

```bash
npx prettier --write tests/specialist-flow.test.js
git add catalog tests/specialist-flow.test.js
git commit -m "Have the flows run installed review specialists at REVIEW"
```

---

### Task 7: Documentation and manual checks

**Files:**
- Modify: `README.md`, `docs/verification.md`
- Test: `tests/specialist-docs.test.js` (create)

**Interfaces:**
- Consumes: the real catalog; `--specialists`.
- Produces: user documentation. No code changes.

- [ ] **Step 1: Write `tests/specialist-docs.test.js`**

`tests/specialist-docs.test.js`:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const specialists = [...catalog.values()].filter(
  (item) => item.type === 'agent' && item.stage === undefined
);

describe('README', () => {
  const readme = read('README.md');

  it.each(specialists.map((agent) => agent.name))('lists the specialist %s', (name) => {
    expect(readme).toContain(`\`${name}\``);
  });

  it('shows how to install specialists and what the flows do with them', () => {
    expect(readme).toContain('forgeflow add --specialists --target');
    expect(readme).toContain('07-review-');
    expect(readme).toContain('`joins: review`');
    expect(readme).toContain('`{{agents-dir}}`');
  });
});

describe('verification checklist', () => {
  const checks = read('docs/verification.md');

  it('keeps the earlier checks and adds the specialist ones', () => {
    for (const number of [1, 10, 11, 24, 25, 30]) {
      expect(checks, `check ${number}`).toMatch(new RegExp(`^\\| ${number} \\|`, 'm'));
    }
    expect(checks).toContain('## Specialists');
    expect(checks).toContain('07-review-security-reviewer.md');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/specialist-docs.test.js`
Expected: FAIL. Every "lists the specialist" test fails, as do the two others (checks 25 and 30 and the `## Specialists` heading are missing).

- [ ] **Step 3: Edit `README.md`**

1. In the code block under "## Use", add these two lines after the `forgeflow add --flow full …` line:

```
forgeflow add security-reviewer --target claude  # one specialist
forgeflow add --specialists --target claude      # all ten specialists
```

2. After the sentence "Every agent also works on its own, outside a flow." (end of "## The agents"), add:

```markdown
### Specialists

Specialists own a subject instead of a stage. Install the ones you want; none comes with a flow.

| Agent                    | Does                                                                   | Can change files |
| ------------------------ | ---------------------------------------------------------------------- | ---------------- |
| `security-reviewer`      | Reviews a change for security defects and gives a verdict              | no               |
| `performance-reviewer`   | Reviews a change for performance defects and gives a verdict           | no               |
| `database-reviewer`      | Reviews schema changes, migrations and queries and gives a verdict     | no               |
| `accessibility-reviewer` | Reviews interface changes for accessibility and gives a verdict        | no               |
| `api-designer`           | Designs an interface before it is built                                | no               |
| `test-strategist`        | Says what to test, at which level, and what is missing                 | no               |
| `dependency-auditor`     | Audits dependencies and recommends an action for each                  | no               |
| `debugger`               | Finds the root cause of a failure and proposes a fix, without applying | no               |
| `docs-writer`            | Writes or updates documentation for code that exists                   | yes (docs only)  |
| `refactorer`             | Restructures code without changing behavior, tests run before and after | yes              |

The four reviewers are also used by the flows. At REVIEW, a flow runs each one that is installed for that harness, saves its report as `07-review-<agent name>.md` in the run directory, and returns to BUILD if any of them requests changes. With none installed, a flow runs exactly as before. Each installed reviewer adds one subagent run to every review round, including for changes outside its subject.

A specialist is a prompt for your harness's model, not a tool: `security-reviewer` is not a scanner, and `accessibility-reviewer` reads the code without running the interface.
```

3. Under "## Adding to the catalog", add these two bullets after the bullet that begins "A gate is a folder":

```markdown
- An agent with no `stage` is a specialist. Add `joins: review` to a read-only specialist to mark it as one the flows run at REVIEW, and name it in both flow skills: a test fails if the two disagree.
- A skill body may use `{{agents-dir}}` and `{{global-agents-dir}}`. Each harness's installer replaces them with that harness's agents folders.
```

- [ ] **Step 4: Append to `docs/verification.md`**

Add at the end of the file:

```markdown

## Specialists

Install the specialists and a flow in the same scratch repository:

    forgeflow add --specialists --flow quick --target <harness>

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 25 | All ten specialists appear in the harness's agent list | | | | |
| 26 | Asking "use the security-reviewer agent on the last commit" runs it, and its reply ends with a `VERDICT:` line | | | | |
| 27 | A quick-flow run creates `07-review-security-reviewer.md` and the three other specialist reports in the run directory | | | | |
| 28 | After `forgeflow remove` of all four reviewers, a new run creates no `07-review-*` file other than `07-review.md` and says nothing about specialists | | | | |
| 29 | With `security-reviewer` installed only with `--global`, a run in a project still runs it | | | | |
| 30 | Ask for a change with an obvious injection flaw: `security-reviewer` requests changes and the run returns to BUILD, then reviews again | | | | |

Check 27 shows whether the model follows the instruction to look in the agents folder. If a harness skips the specialists, record it in the README: on that harness they must be run by hand.

Check 29 matters most on OpenCode, whose user-level folder is `~/.config/opencode/agents`.
```

- [ ] **Step 5: Format, lint and run everything**

Run: `npx prettier --write README.md tests/specialist-docs.test.js`

Run: `npx vitest run`
Expected: PASS, no failures.

Run: `npm run lint`
Expected: no warnings and no errors.

Run: `npm run format:check`
Expected: `All matched files use Prettier code style!`

Run: `node bin/forgeflow.js list --type agent`
Expected: 21 lines; the ten specialists show `specialist` in the second column.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/verification.md tests/specialist-docs.test.js
git commit -m "Document the specialist agents and add their manual checks"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| 2. Success criteria 1, 2 | 3, 6 |
| 2. Success criteria 3, 4, 5 | 6 |
| 2. Success criterion 6 | 6 (`names exactly the agents that join review`) |
| 3.1 Review specialists | 4 |
| 3.2 The other six | 5 |
| 4.1 `joins` | 1 |
| 4.2 Agents-folder placeholders | 2 |
| 5.1 REVIEW stage, 5.2 Control rules | 6 |
| 5.3 `release-gate` | 6 |
| 6. CLI | 3 |
| 7. Limits | 7 (README) |
| 8. Error handling | 1, 2, 3, 6 |
| 9. Testing | every task; manual checks in 7 |
