# forgeflow core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the forgeflow CLI and catalog: canonical agents and flow skills that compile and install into Claude Code, Codex, OpenCode and Cursor, one item or a whole flow at a time.

**Architecture:** Items are authored once as Markdown with neutral frontmatter under `catalog/`. A resolver expands `requires`, a pure adapter per harness renders native files, a planner diffs them against disk and a lockfile, and an applier writes them. The CLI is a thin shell over `src/ops.js`.

**Tech Stack:** Node 20+, ESM JavaScript, `yaml` (only runtime dependency), `vitest`, `oxlint`, `prettier`, `smol-toml` (dev only, to prove Codex output parses).

**Spec:** `docs/superpowers/specs/2026-10-13-forgeflow-core-design.md`

## Global Constraints

- Node `>=20`. ESM only (`"type": "module"`). Runtime dependencies: `yaml` and nothing else.
- Argument parsing uses `node:util.parseArgs`. No CLI framework.
- Code style follows `.prettierrc`: single quotes, semicolons, 100 columns.
- Adapters are pure: no filesystem, no `process`, no clock. Only `src/apply.js`, `src/lock.js`, `src/plan.js` (read-only) and `src/catalog.js` (read-only) touch the filesystem.
- Each target writes only into its own directories (table in spec section 5).
- Item ids are `<type>:<name>`; names match `^[a-z][a-z0-9-]{0,62}$`.
- Exit codes: 0 success, 1 conflict or failed check, 2 usage error.
- Agent bodies name no harness-specific tool.
- Git commits: subject plus optional body only. Never add `Co-Authored-By` or any other trailer.
- Run all commands from the repository root `/home/hkumar/Documents/ADLC/forgeflow`.

## Review Focus

1. **Re-running after an interrupted install** (files on disk, no lockfile entry): the files are identical to what would be written, so the run adopts them instead of reporting conflicts. Tested in Task 5 and Task 7.
2. **Descriptions containing YAML-special characters** (`:`, `#`, quotes): rendered frontmatter must parse back to the same string in every Markdown adapter, and to valid TOML in Codex. Tested in Task 4.
3. **Removing an item whose file the user already deleted by hand**: `remove` succeeds and drops the lockfile entry. Tested in Task 7.
4. **Sloppy `--target` values** (`cursor,cursor,` or `,`): duplicates collapse to one install; an empty list is a usage error, not a silent no-op. Tested in Task 8.
5. **Catalog files with CRLF line endings or a BOM** (Windows checkout): they load the same as LF files. Tested in Task 1.

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `.gitignore`, `.prettierrc`, `.oxlintrc.json`, `vitest.config.js` | Tooling |
| `bin/forgeflow.js` | Process entry: calls `main`, sets exit code |
| `src/errors.js` | Error classes shared by all units |
| `src/frontmatter.js` | Parse `---` YAML frontmatter and body |
| `src/catalog.js` | Load and validate `catalog/` |
| `src/resolve.js` | Name lookup and `requires` expansion |
| `src/adapters/shared.js` | Marker and Markdown rendering shared by adapters |
| `src/adapters/{claude,codex,opencode,cursor}.js` | One pure renderer per harness |
| `src/adapters/index.js` | Target name → adapter |
| `src/lock.js` | Lockfile read/write, hashing |
| `src/plan.js` | Classify rendered and recorded files into actions |
| `src/apply.js` | Execute actions on disk |
| `src/ops.js` | `add`, `update`, `remove`, `status` |
| `src/doctor.js` | Environment and install checks |
| `src/cli.js` | Argument parsing, output, exit codes |
| `catalog/agents/*.md` | 11 flow agents |
| `catalog/skills/forge-quick/SKILL.md`, `catalog/skills/forge-full/SKILL.md` | The two flows |
| `tests/helpers.js` | Temp dirs, item factories, output capture |
| `tests/*.test.js` | One test file per source unit, plus `content.test.js` |
| `README.md`, `docs/verification.md` | Usage and the manual per-harness check |

---

### Task 1: Scaffold, errors and frontmatter parser

**Files:**
- Create: `package.json`, `.gitignore`, `.prettierrc`, `.oxlintrc.json`, `vitest.config.js`
- Create: `src/errors.js`, `src/frontmatter.js`, `tests/helpers.js`
- Test: `tests/frontmatter.test.js`

**Interfaces:**
- Produces: `parseFrontmatter(text: string) → { data: object, body: string }` (throws `Error` with a plain message; `body` is trimmed and uses `\n`).
- Produces: `CatalogError`, `UsageError`, `LockError`, `ConflictError` (`.conflicts: [{ target, path, reason }]`).
- Produces test helpers: `tmpDir()`, `writeTree(root, { 'rel/path': content })`, `agentMd(name, extraFrontmatterLines?)`, `skillMd(name, extraFrontmatterLines?)`, `item(overrides?)`, `skill(overrides?)`, `capture()`.

- [ ] **Step 1: Write the tooling files**

`package.json`:

```json
{
  "name": "forgeflow",
  "version": "0.1.0",
  "description": "Ready-to-use coding agents and development flows for Claude Code, Codex, OpenCode and Cursor.",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "forgeflow": "./bin/forgeflow.js" },
  "files": ["bin", "src", "catalog", "README.md"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "oxlint bin src tests",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "dependencies": { "yaml": "^2.9.1" },
  "devDependencies": {
    "oxlint": "^1.75.0",
    "prettier": "^3.6.2",
    "smol-toml": "^1.9.1",
    "vitest": "4.1.10"
  }
}
```

`.gitignore`:

```
node_modules/
coverage/
*.log
.DS_Store
.forgeflow/
```

`.prettierrc`:

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "es5",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

`.prettierignore`:

```
node_modules/
catalog/
docs/
```

`.oxlintrc.json`:

```json
{
  "env": { "node": true, "es2024": true },
  "plugins": ["import"],
  "categories": { "correctness": "error", "suspicious": "warn", "perf": "warn" },
  "rules": {
    "no-console": "off",
    "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }]
  },
  "ignorePatterns": ["node_modules/**"]
}
```

`vitest.config.js`:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
});
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: exits 0 and creates `node_modules/` and `package-lock.json`.

- [ ] **Step 3: Write `src/errors.js` and `tests/helpers.js`**

`src/errors.js`:

```js
export class CatalogError extends Error {}
export class UsageError extends Error {}
export class LockError extends Error {}

export class ConflictError extends Error {
  // conflicts: [{ target, path, reason }]
  constructor(conflicts) {
    super(`${conflicts.length} file(s) would be overwritten`);
    this.conflicts = conflicts;
  }
}
```

`tests/helpers.js`:

```js
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'forgeflow-'));
}

export function writeTree(root, tree) {
  for (const [path, content] of Object.entries(tree)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

export function agentMd(name, extra = '') {
  return `---\nname: ${name}\ndescription: Does ${name} things.\naccess: read-only\n${extra}---\nBody of ${name}.\n`;
}

export function skillMd(name, extra = '') {
  return `---\nname: ${name}\ndescription: Runs ${name}.\n${extra}---\nSteps of ${name}.\n`;
}

export function item(overrides = {}) {
  return {
    id: 'agent:reviewer',
    type: 'agent',
    name: 'reviewer',
    description: 'Reviews a change.',
    stage: 'review',
    access: 'read-only',
    modelTier: 'strong',
    requires: [],
    body: 'You review code.',
    files: [],
    source: 'agents/reviewer.md',
    ...overrides,
  };
}

export function skill(overrides = {}) {
  return {
    id: 'skill:forge-quick',
    type: 'skill',
    name: 'forge-quick',
    description: 'Run the quick flow.',
    userInvocableOnly: true,
    requires: [],
    body: 'Follow the steps.',
    files: [],
    source: 'skills/forge-quick/SKILL.md',
    ...overrides,
  };
}

export function capture() {
  let text = '';
  return {
    write(chunk) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}
```

- [ ] **Step 4: Write the failing test**

`tests/frontmatter.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter.js';

describe('parseFrontmatter', () => {
  it('splits data and body', () => {
    const { data, body } = parseFrontmatter('---\nname: a\nrequires: [x, y]\n---\n\nHello\nworld\n');
    expect(data).toEqual({ name: 'a', requires: ['x', 'y'] });
    expect(body).toBe('Hello\nworld');
  });

  it('accepts CRLF line endings and a BOM', () => {
    const { data, body } = parseFrontmatter('\uFEFF---\r\nname: a\r\n---\r\nLine 1\r\nLine 2\r\n');
    expect(data).toEqual({ name: 'a' });
    expect(body).toBe('Line 1\nLine 2');
  });

  it('keeps a --- line that appears inside the body', () => {
    const { body } = parseFrontmatter('---\nname: a\n---\nBefore\n---\nAfter\n');
    expect(body).toBe('Before\n---\nAfter');
  });

  it('treats empty frontmatter as an empty mapping', () => {
    expect(parseFrontmatter('---\n---\nBody').data).toEqual({});
  });

  it('rejects a file with no frontmatter', () => {
    expect(() => parseFrontmatter('Just text')).toThrow('must start with ---');
  });

  it('rejects unterminated frontmatter', () => {
    expect(() => parseFrontmatter('---\nname: a\n')).toThrow('no closing ---');
  });

  it('rejects invalid YAML', () => {
    expect(() => parseFrontmatter('---\nname: [unclosed\n---\nBody')).toThrow('invalid YAML');
  });

  it('rejects frontmatter that is not a mapping', () => {
    expect(() => parseFrontmatter('---\n- a\n- b\n---\nBody')).toThrow('must be a YAML mapping');
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run tests/frontmatter.test.js`
Expected: FAIL, cannot resolve `../src/frontmatter.js`.

- [ ] **Step 6: Write `src/frontmatter.js`**

```js
import { parse } from 'yaml';

export function parseFrontmatter(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') throw new Error('missing frontmatter: file must start with ---');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) throw new Error('unterminated frontmatter: no closing ---');

  let data;
  try {
    data = parse(lines.slice(1, end).join('\n')) ?? {};
  } catch (error) {
    throw new Error(`invalid YAML in frontmatter: ${error.message}`);
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('frontmatter must be a YAML mapping');
  }
  return { data, body: lines.slice(end + 1).join('\n').trim() };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/frontmatter.test.js`
Expected: 8 passed.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore .prettierrc .prettierignore .oxlintrc.json vitest.config.js src tests
git commit -m "Scaffold project and add frontmatter parser"
```

---

### Task 2: Catalog loader and validation

**Files:**
- Create: `src/catalog.js`
- Test: `tests/catalog.test.js`

**Interfaces:**
- Consumes: `parseFrontmatter`, `CatalogError`.
- Produces: `loadCatalog(dir: string) → Map<id, Item>`; `STAGES: string[]`.
- `Item` (agent): `{ id, type: 'agent', name, description, stage: string|undefined, access: 'read-only'|'write', modelTier: 'fast'|'balanced'|'strong', requires: string[], body: string, files: [], source: string }`.
- `Item` (skill): `{ id, type: 'skill', name, description, userInvocableOnly: boolean, requires: string[], body: string, files: [{ path: string, content: Buffer }], source: string }`. `files` are the other files in the skill folder, paths relative to that folder with `/` separators.
- Errors are `CatalogError` with message `<source>: <problem>`.

Duplicate ids need no check: `name` must equal the file or folder name, and a directory cannot hold two entries with the same name.

- [ ] **Step 1: Write the failing test**

`tests/catalog.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { CatalogError } from '../src/errors.js';
import { agentMd, skillMd, tmpDir, writeTree } from './helpers.js';

const load = (tree) => loadCatalog(writeTree(tmpDir(), tree));

describe('loadCatalog', () => {
  it('loads agents and skills keyed by id', () => {
    const catalog = load({
      'agents/reviewer.md': agentMd('reviewer', 'stage: review\nmodel-tier: strong\n'),
      'agents/builder.md': '---\nname: builder\ndescription: Builds.\naccess: write\n---\nBuild it.\n',
      'skills/flow/SKILL.md': skillMd(
        'flow',
        'user-invocable-only: true\nrequires: [agent:reviewer, agent:builder]\n'
      ),
      'skills/flow/notes/extra.md': 'extra',
    });

    expect([...catalog.keys()].sort()).toEqual(['agent:builder', 'agent:reviewer', 'skill:flow']);
    expect(catalog.get('agent:reviewer')).toMatchObject({
      type: 'agent',
      name: 'reviewer',
      description: 'Does reviewer things.',
      stage: 'review',
      access: 'read-only',
      modelTier: 'strong',
      requires: [],
      body: 'Body of reviewer.',
      source: 'agents/reviewer.md',
    });
    expect(catalog.get('agent:builder')).toMatchObject({ access: 'write', modelTier: 'balanced' });
    expect(catalog.get('agent:builder').stage).toBeUndefined();

    const flow = catalog.get('skill:flow');
    expect(flow).toMatchObject({
      type: 'skill',
      userInvocableOnly: true,
      requires: ['agent:reviewer', 'agent:builder'],
      body: 'Steps of flow.',
    });
    expect(flow.files).toEqual([{ path: 'notes/extra.md', content: Buffer.from('extra') }]);
  });

  it('returns an empty catalog for an empty directory', () => {
    expect(loadCatalog(tmpDir()).size).toBe(0);
  });

  it('ignores non-Markdown files in agents/', () => {
    expect(load({ 'agents/README.txt': 'x', 'agents/a.md': agentMd('a') }).size).toBe(1);
  });

  const invalid = [
    ['missing name', { 'agents/a.md': '---\ndescription: D.\naccess: write\n---\nB' }, 'agents/a.md: field "name"'],
    ['bad name characters', { 'agents/A_b.md': agentMd('A_b') }, 'field "name"'],
    ['name differs from file', { 'agents/a.md': agentMd('b') }, 'must equal the file name (a)'],
    ['name differs from folder', { 'skills/a/SKILL.md': skillMd('b') }, 'must equal the folder name (a)'],
    ['missing description', { 'agents/a.md': '---\nname: a\naccess: write\n---\nB' }, 'field "description"'],
    [
      'description too long',
      { 'agents/a.md': `---\nname: a\ndescription: ${'x'.repeat(1025)}\naccess: write\n---\nB` },
      'field "description"',
    ],
    ['missing access', { 'agents/a.md': '---\nname: a\ndescription: D.\n---\nB' }, 'field "access"'],
    ['bad access', { 'agents/a.md': '---\nname: a\ndescription: D.\naccess: admin\n---\nB' }, 'field "access"'],
    ['bad stage', { 'agents/a.md': agentMd('a', 'stage: launch\n') }, 'field "stage"'],
    ['bad model tier', { 'agents/a.md': agentMd('a', 'model-tier: huge\n') }, 'field "model-tier"'],
    ['requires not a list', { 'agents/a.md': agentMd('a', 'requires: agent:b\n') }, 'field "requires"'],
    ['unknown field', { 'agents/a.md': agentMd('a', 'acess: write\n') }, 'unknown field "acess"'],
    ['agent field on a skill', { 'skills/a/SKILL.md': skillMd('a', 'access: write\n') }, 'unknown field "access"'],
    [
      'non-boolean user-invocable-only',
      { 'skills/a/SKILL.md': skillMd('a', 'user-invocable-only: sometimes\n') },
      'field "user-invocable-only"',
    ],
    ['empty body', { 'agents/a.md': '---\nname: a\ndescription: D.\naccess: write\n---\n\n' }, 'body is empty'],
    ['no frontmatter', { 'agents/a.md': 'plain' }, 'agents/a.md: missing frontmatter'],
    ['skill folder without SKILL.md', { 'skills/a/notes.md': 'x' }, 'skills/a: missing SKILL.md'],
    ['unknown requires', { 'agents/a.md': agentMd('a', 'requires: [agent:ghost]\n') }, 'unknown item "agent:ghost"'],
    [
      'requires cycle',
      {
        'agents/a.md': agentMd('a', 'requires: [agent:b]\n'),
        'agents/b.md': agentMd('b', 'requires: [agent:a]\n'),
      },
      'forms a cycle: agent:a → agent:b → agent:a',
    ],
  ];

  it.each(invalid)('rejects %s', (_label, tree, message) => {
    expect(() => load(tree)).toThrow(CatalogError);
    expect(() => load(tree)).toThrow(message);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/catalog.test.js`
Expected: FAIL, cannot resolve `../src/catalog.js`.

- [ ] **Step 3: Write `src/catalog.js`**

```js
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError } from './errors.js';
import { parseFrontmatter } from './frontmatter.js';

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
const ACCESS = ['read-only', 'write'];
const TIERS = ['fast', 'balanced', 'strong'];
const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const FIELDS = {
  agent: ['name', 'description', 'stage', 'access', 'model-tier', 'requires'],
  skill: ['name', 'description', 'user-invocable-only', 'requires'],
};

function fail(source, problem) {
  throw new CatalogError(`${source}: ${problem}`);
}

function oneOf(source, data, field, allowed, required) {
  const value = data[field];
  if (value === undefined && !required) return undefined;
  if (!allowed.includes(value)) fail(source, `field "${field}" must be one of: ${allowed.join(', ')}`);
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

  const item = { id: `${type}:${data.name}`, type, name: data.name, description, requires, body, files: [], source };
  if (type === 'agent') {
    item.stage = oneOf(source, data, 'stage', STAGES, false);
    item.access = oneOf(source, data, 'access', ACCESS, true);
    item.modelTier = oneOf(source, data, 'model-tier', TIERS, false) ?? 'balanced';
  } else {
    const flag = data['user-invocable-only'] ?? false;
    if (typeof flag !== 'boolean') fail(source, 'field "user-invocable-only" must be true or false');
    item.userInvocableOnly = flag;
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
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = join(skillsDir, entry.name);
      const main = join(folder, 'SKILL.md');
      if (!existsSync(main)) fail(`skills/${entry.name}`, 'missing SKILL.md');
      const source = `skills/${entry.name}/SKILL.md`;
      const item = buildItem('skill', entry.name, readFileSync(main, 'utf8'), source);
      item.files = listFiles(folder)
        .filter((rel) => rel !== 'SKILL.md')
        .map((rel) => ({ path: rel, content: readFileSync(join(folder, rel)) }));
      items.set(item.id, item);
    }
  }

  checkRequires(items);
  return items;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/catalog.test.js`
Expected: all pass (3 plain tests plus 19 table rows).

- [ ] **Step 5: Commit**

```bash
git add src/catalog.js tests/catalog.test.js
git commit -m "Add catalog loader with validation"
```

---

### Task 3: Resolver

**Files:**
- Create: `src/resolve.js`
- Test: `tests/resolve.test.js`

**Interfaces:**
- Consumes: catalog `Map<id, Item>`, `UsageError`.
- Produces: `findId(catalog, ref: string) → id` (accepts a full id or a bare name; throws `UsageError` when unknown or ambiguous).
- Produces: `resolve(catalog, refs: string[]) → [{ item: Item, explicit: boolean }]`, dependencies before dependents, each item once. `explicit` is true only for items named in `refs`.

- [ ] **Step 1: Write the failing test**

`tests/resolve.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors.js';
import { findId, resolve } from '../src/resolve.js';
import { item, skill } from './helpers.js';

const catalog = new Map(
  [
    item({ id: 'agent:a', name: 'a' }),
    item({ id: 'agent:b', name: 'b', requires: ['agent:a'] }),
    item({ id: 'agent:twin', name: 'twin' }),
    skill({ id: 'skill:twin', name: 'twin' }),
    skill({ id: 'skill:flow', name: 'flow', requires: ['agent:b', 'agent:a'] }),
  ].map((entry) => [entry.id, entry])
);

describe('findId', () => {
  it('accepts a full id', () => {
    expect(findId(catalog, 'agent:a')).toBe('agent:a');
  });

  it('accepts an unambiguous bare name', () => {
    expect(findId(catalog, 'flow')).toBe('skill:flow');
  });

  it('rejects an unknown item', () => {
    expect(() => findId(catalog, 'ghost')).toThrow(UsageError);
    expect(() => findId(catalog, 'agent:ghost')).toThrow('unknown item "agent:ghost"');
  });

  it('rejects an ambiguous bare name and names the choices', () => {
    expect(() => findId(catalog, 'twin')).toThrow('use agent:twin or skill:twin');
  });
});

describe('resolve', () => {
  const ids = (entries) => entries.map(({ item: entry, explicit }) => [entry.id, explicit]);

  it('returns a single item with no requirements', () => {
    expect(ids(resolve(catalog, ['a']))).toEqual([['agent:a', true]]);
  });

  it('puts transitive requirements first and marks them implicit', () => {
    expect(ids(resolve(catalog, ['flow']))).toEqual([
      ['agent:a', false],
      ['agent:b', false],
      ['skill:flow', true],
    ]);
  });

  it('marks an item explicit when it is both named and required', () => {
    expect(ids(resolve(catalog, ['flow', 'agent:a']))).toEqual([
      ['agent:a', true],
      ['agent:b', false],
      ['skill:flow', true],
    ]);
  });

  it('lists a repeated ref once', () => {
    expect(resolve(catalog, ['a', 'agent:a'])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/resolve.test.js`
Expected: FAIL, cannot resolve `../src/resolve.js`.

- [ ] **Step 3: Write `src/resolve.js`**

```js
import { UsageError } from './errors.js';

const TYPES = ['agent', 'skill'];
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/resolve.test.js`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/resolve.js tests/resolve.test.js
git commit -m "Add item lookup and requires resolver"
```

---

### Task 4: Adapters for the four harnesses

**Files:**
- Create: `src/adapters/shared.js`, `src/adapters/claude.js`, `src/adapters/codex.js`, `src/adapters/opencode.js`, `src/adapters/cursor.js`, `src/adapters/index.js`
- Test: `tests/adapters.test.js`

**Interfaces:**
- Consumes: `Item` shapes from Task 2, `UsageError`.
- Each adapter module exports: `name: string`; `root(scope: 'project'|'global', { cwd, home }) → string`; `render(item, { scope, version }) → [{ path: string, content: string|Buffer }]` with `path` relative to `root` and `/` separators.
- Produces: `adapters` (object keyed by target name), `targetNames: string[]`, `getAdapter(name) → adapter` (throws `UsageError` listing valid names).

Mapping (spec section 5):

| | claude | codex | opencode | cursor |
|---|---|---|---|---|
| Agent path | `.claude/agents/<n>.md` | `.codex/agents/<n>.toml` | `.opencode/agents/<n>.md` (global: `agents/<n>.md`) | `.cursor/agents/<n>.md` |
| Skill dir | `.claude/skills/<n>/` | `.agents/skills/<n>/` | `.opencode/skills/<n>/` (global: `skills/<n>/`) | `.cursor/skills/<n>/` |
| Global root | `home` | `home` | `home/.config/opencode` | `home` |
| read-only | `tools: Read, Grep, Glob, Bash` | `sandbox_mode = "read-only"` | `permission: { edit: deny }` | `readonly: true` |
| write | no `tools` | `sandbox_mode = "workspace-write"` | no `permission` | `readonly: false` |
| model tier | `model: haiku/sonnet/opus` | — | — | — |
| user-invocable-only | `disable-model-invocation: true` | — | `metadata` with `opencode/autoinvoke: "false"`, `opencode/slash: "true"` | `disable-model-invocation: true` |

- [ ] **Step 1: Write the failing test**

`tests/adapters.test.js`:

```js
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as cursor from '../src/adapters/cursor.js';
import { getAdapter, targetNames } from '../src/adapters/index.js';
import * as opencode from '../src/adapters/opencode.js';
import { UsageError } from '../src/errors.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { item, skill } from './helpers.js';

const ctx = { scope: 'project', version: '0.1.0' };
const dirs = { cwd: '/work/app', home: '/home/dev' };
const reader = item();
const writer = item({ id: 'agent:builder', name: 'builder', access: 'write', modelTier: 'balanced' });
const tricky = 'Reviews: "quoted" text # not a comment, it\'s fine';

describe('registry', () => {
  it('lists the four targets', () => {
    expect(targetNames).toEqual(['claude', 'codex', 'opencode', 'cursor']);
  });

  it('rejects an unknown target and names the valid ones', () => {
    expect(() => getAdapter('vim')).toThrow(UsageError);
    expect(() => getAdapter('vim')).toThrow('claude, codex, opencode, cursor');
  });
});

describe('claude', () => {
  it('renders a read-only agent exactly', () => {
    expect(claude.render(reader, ctx)).toEqual([
      {
        path: '.claude/agents/reviewer.md',
        content:
          '---\n' +
          'name: reviewer\n' +
          'description: Reviews a change.\n' +
          'tools: Read, Grep, Glob, Bash\n' +
          'model: opus\n' +
          '---\n\n' +
          'You review code.\n\n' +
          '<!-- managed by forgeflow: agent:reviewer@0.1.0 -->\n',
      },
    ]);
  });

  it('omits tools for a write agent and maps the model tier', () => {
    const { data } = parseFrontmatter(claude.render(writer, ctx)[0].content);
    expect(data).toEqual({ name: 'builder', description: 'Reviews a change.', model: 'sonnet' });
  });

  it('maps the fast tier to haiku', () => {
    const { data } = parseFrontmatter(claude.render(item({ modelTier: 'fast' }), ctx)[0].content);
    expect(data.model).toBe('haiku');
  });

  it('renders a skill with extra files and explicit-only invocation', () => {
    const extra = { path: 'refs/states.md', content: Buffer.from('x') };
    const files = claude.render(skill({ files: [extra] }), ctx);
    expect(files.map((file) => file.path)).toEqual([
      '.claude/skills/forge-quick/SKILL.md',
      '.claude/skills/forge-quick/refs/states.md',
    ]);
    expect(files[1].content).toEqual(Buffer.from('x'));
    const { data, body } = parseFrontmatter(files[0].content);
    expect(data).toEqual({
      name: 'forge-quick',
      description: 'Run the quick flow.',
      'disable-model-invocation': true,
    });
    expect(body).toBe('Follow the steps.\n\n<!-- managed by forgeflow: skill:forge-quick@0.1.0 -->');
  });

  it('leaves model invocation on when the skill allows it', () => {
    const { data } = parseFrontmatter(claude.render(skill({ userInvocableOnly: false }), ctx)[0].content);
    expect(data).toEqual({ name: 'forge-quick', description: 'Run the quick flow.' });
  });

  it('uses cwd for project scope and home for global scope', () => {
    expect(claude.root('project', dirs)).toBe('/work/app');
    expect(claude.root('global', dirs)).toBe('/home/dev');
  });
});

describe('codex', () => {
  it('renders an agent as TOML', () => {
    const [file] = codex.render(reader, ctx);
    expect(file.path).toBe('.codex/agents/reviewer.toml');
    expect(file.content.split('\n')[0]).toBe('# managed by forgeflow: agent:reviewer@0.1.0');
    expect(parseToml(file.content)).toEqual({
      name: 'reviewer',
      description: 'Reviews a change.',
      sandbox_mode: 'read-only',
      developer_instructions: 'You review code.\n',
    });
  });

  it('gives a write agent the workspace-write sandbox', () => {
    expect(parseToml(codex.render(writer, ctx)[0].content).sandbox_mode).toBe('workspace-write');
  });

  it('escapes quotes, backslashes, triple quotes and control characters', () => {
    const body = 'Use "quotes", a \\ backslash, """triple""", """"four"""" and a bell \u0007.\nEnd"';
    const parsed = parseToml(codex.render(item({ body, description: tricky }), ctx)[0].content);
    expect(parsed.developer_instructions).toBe(`${body}\n`);
    expect(parsed.description).toBe(tricky);
  });

  it('renders a skill under .agents/skills with plain frontmatter', () => {
    const [file] = codex.render(skill(), ctx);
    expect(file.path).toBe('.agents/skills/forge-quick/SKILL.md');
    expect(parseFrontmatter(file.content).data).toEqual({
      name: 'forge-quick',
      description: 'Run the quick flow.',
    });
  });

  it('uses home for global scope', () => {
    expect(codex.root('global', dirs)).toBe('/home/dev');
  });
});

describe('opencode', () => {
  it('renders a read-only agent as a subagent that cannot edit', () => {
    const [file] = opencode.render(reader, ctx);
    expect(file.path).toBe('.opencode/agents/reviewer.md');
    expect(parseFrontmatter(file.content).data).toEqual({
      description: 'Reviews a change.',
      mode: 'subagent',
      permission: { edit: 'deny' },
    });
  });

  it('omits permission for a write agent', () => {
    expect(parseFrontmatter(opencode.render(writer, ctx)[0].content).data).toEqual({
      description: 'Reviews a change.',
      mode: 'subagent',
    });
  });

  it('marks an explicit-only skill as a slash command that is not auto-invoked', () => {
    const [file] = opencode.render(skill(), ctx);
    expect(file.path).toBe('.opencode/skills/forge-quick/SKILL.md');
    expect(parseFrontmatter(file.content).data.metadata).toEqual({
      'opencode/autoinvoke': 'false',
      'opencode/slash': 'true',
    });
  });

  it('drops the .opencode prefix under the global config directory', () => {
    expect(opencode.root('project', dirs)).toBe('/work/app');
    expect(opencode.root('global', dirs)).toBe('/home/dev/.config/opencode');
    const global = { scope: 'global', version: '0.1.0' };
    expect(opencode.render(reader, global)[0].path).toBe('agents/reviewer.md');
    expect(opencode.render(skill(), global)[0].path).toBe('skills/forge-quick/SKILL.md');
  });
});

describe('cursor', () => {
  it('renders a read-only agent', () => {
    const [file] = cursor.render(reader, ctx);
    expect(file.path).toBe('.cursor/agents/reviewer.md');
    expect(parseFrontmatter(file.content).data).toEqual({
      name: 'reviewer',
      description: 'Reviews a change.',
      readonly: true,
    });
  });

  it('renders a write agent', () => {
    expect(parseFrontmatter(cursor.render(writer, ctx)[0].content).data.readonly).toBe(false);
  });

  it('renders an explicit-only skill', () => {
    const [file] = cursor.render(skill(), ctx);
    expect(file.path).toBe('.cursor/skills/forge-quick/SKILL.md');
    expect(parseFrontmatter(file.content).data['disable-model-invocation']).toBe(true);
  });
});

describe('every Markdown adapter', () => {
  it.each([
    ['claude', claude],
    ['opencode', opencode],
    ['cursor', cursor],
  ])('%s round-trips a description with YAML-special characters', (_name, adapter) => {
    const [file] = adapter.render(item({ description: tricky }), ctx);
    expect(parseFrontmatter(file.content).data.description).toBe(tricky);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/adapters.test.js`
Expected: FAIL, cannot resolve `../src/adapters/claude.js`.

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
```

- [ ] **Step 4: Write `src/adapters/claude.js`**

```js
import { markdown, skillFiles } from './shared.js';

const MODELS = { fast: 'haiku', balanced: 'sonnet', strong: 'opus' };

export const name = 'claude';

export function root(scope, { cwd, home }) {
  return scope === 'global' ? home : cwd;
}

export function render(item, { version }) {
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
import { marker, skillFiles } from './shared.js';

// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const escapeControl = (text) =>
  text.replace(CONTROL, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

// JSON string escapes are a subset of TOML basic-string escapes.
const basic = (text) => JSON.stringify(text).replace(/\u007f/g, '\\u007f');

// Body of a TOML multi-line basic string: keep newlines and single quotes
// readable, escape only what would end or corrupt the string.
const multiline = (text) =>
  escapeControl(text.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"').replace(/"$/, '\\"'));

export const name = 'codex';

export function root(scope, { cwd, home }) {
  return scope === 'global' ? home : cwd;
}

export function render(item, { version }) {
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

- [ ] **Step 6: Write `src/adapters/opencode.js`**

```js
import { join } from 'node:path';
import { markdown, skillFiles } from './shared.js';

export const name = 'opencode';

export function root(scope, { cwd, home }) {
  return scope === 'global' ? join(home, '.config', 'opencode') : cwd;
}

export function render(item, { scope, version }) {
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

- [ ] **Step 7: Write `src/adapters/cursor.js`**

```js
import { markdown, skillFiles } from './shared.js';

export const name = 'cursor';

export function root(scope, { cwd, home }) {
  return scope === 'global' ? home : cwd;
}

export function render(item, { version }) {
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

- [ ] **Step 8: Write `src/adapters/index.js`**

```js
import { UsageError } from '../errors.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as cursor from './cursor.js';
import * as opencode from './opencode.js';

// To support another harness: add its module and one line here.
export const adapters = { claude, codex, opencode, cursor };
export const targetNames = Object.keys(adapters);

export function getAdapter(name) {
  const adapter = adapters[name];
  if (!adapter) {
    throw new UsageError(`unknown target "${name}". Choose from: ${targetNames.join(', ')}.`);
  }
  return adapter;
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run tests/adapters.test.js`
Expected: all pass. If the Codex escaping test fails, the fault is in `multiline`: the body must survive `parseToml` unchanged, so adjust the escaping, not the test.

- [ ] **Step 10: Commit**

```bash
git add src/adapters tests/adapters.test.js
git commit -m "Add Claude Code, Codex, OpenCode and Cursor adapters"
```

---

### Task 5: Lockfile and planner

**Files:**
- Create: `src/lock.js`, `src/plan.js`
- Test: `tests/lock.test.js`, `tests/plan.test.js`

**Interfaces:**
- Consumes: `LockError`.
- Produces: `sha256(content: string|Buffer) → hex string`; `lockPath(base) → string` (`<base>/.forgeflow/lock.json`); `readLock(base) → { version: 1, forgeflow: string|null, targets: { [target]: { items: { [id]: { explicit: boolean, files: [{ path, sha256 }] } } } } }` (a missing file yields an empty lock; unreadable or wrong-version throws `LockError`); `writeLock(base, lock, version)` (drops targets with no items; deletes the file when no targets remain).
- Produces: `planInstall(root, files: [{ path, content }], recorded: [{ path, sha256 }]) → Action[]` and `planRemove(root, recorded) → Action[]`.
- `Action`: `{ type, path, content?, reason? }`. Install types: `create`, `update`, `skip`, `conflict` (all carry `content`), plus `delete` and `keep` for recorded files that are no longer rendered. Remove types: `delete`, `keep`, `missing`.

- [ ] **Step 1: Write the failing tests**

`tests/lock.test.js`:

```js
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LockError } from '../src/errors.js';
import { lockPath, readLock, sha256, writeLock } from '../src/lock.js';
import { tmpDir, writeTree } from './helpers.js';

const entry = { explicit: true, files: [{ path: 'a.md', sha256: 'abc' }] };

describe('lockfile', () => {
  it('hashes strings and buffers the same way', () => {
    expect(sha256('abc')).toBe(sha256(Buffer.from('abc')));
    expect(sha256('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns an empty lock when the file is missing', () => {
    expect(readLock(tmpDir())).toEqual({ version: 1, forgeflow: null, targets: {} });
  });

  it('round-trips and stamps the forgeflow version', () => {
    const base = tmpDir();
    writeLock(base, { version: 1, targets: { cursor: { items: { 'agent:a': entry } } } }, '0.1.0');
    expect(readLock(base)).toEqual({
      version: 1,
      forgeflow: '0.1.0',
      targets: { cursor: { items: { 'agent:a': entry } } },
    });
    expect(readFileSync(lockPath(base), 'utf8').endsWith('}\n')).toBe(true);
  });

  it('drops empty targets and deletes the file when nothing is installed', () => {
    const base = tmpDir();
    const lock = { version: 1, targets: { cursor: { items: { 'agent:a': entry } }, codex: { items: {} } } };
    writeLock(base, lock, '0.1.0');
    expect(Object.keys(readLock(base).targets)).toEqual(['cursor']);

    writeLock(base, { version: 1, targets: { cursor: { items: {} } } }, '0.1.0');
    expect(existsSync(lockPath(base))).toBe(false);
  });

  it('refuses invalid JSON and leaves the file alone', () => {
    const base = writeTree(tmpDir(), { '.forgeflow/lock.json': '{ broken' });
    expect(() => readLock(base)).toThrow(LockError);
    expect(() => readLock(base)).toThrow('is not valid JSON');
    expect(readFileSync(lockPath(base), 'utf8')).toBe('{ broken');
  });

  it('refuses a lockfile from another format version', () => {
    const base = writeTree(tmpDir(), { '.forgeflow/lock.json': '{"version":2,"targets":{}}' });
    expect(() => readLock(base)).toThrow('unsupported format (version 2)');
  });
});
```

`tests/plan.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/lock.js';
import { planInstall, planRemove } from '../src/plan.js';
import { tmpDir, writeTree } from './helpers.js';

const file = { path: 'dir/a.md', content: 'new' };
const types = (actions) => actions.map((action) => [action.type, action.path]);

describe('planInstall', () => {
  it('creates a file that is absent', () => {
    expect(planInstall(tmpDir(), [file], [])).toEqual([{ type: 'create', ...file }]);
  });

  it('re-creates a recorded file that was deleted by hand', () => {
    const recorded = [{ path: 'dir/a.md', sha256: sha256('old') }];
    expect(types(planInstall(tmpDir(), [file], recorded))).toEqual([['create', 'dir/a.md']]);
  });

  it('skips a file that is already identical, recorded or not', () => {
    const root = writeTree(tmpDir(), { 'dir/a.md': 'new' });
    expect(types(planInstall(root, [file], []))).toEqual([['skip', 'dir/a.md']]);
    const recorded = [{ path: 'dir/a.md', sha256: sha256('new') }];
    expect(types(planInstall(root, [file], recorded))).toEqual([['skip', 'dir/a.md']]);
  });

  it('updates an unedited recorded file whose content changed', () => {
    const root = writeTree(tmpDir(), { 'dir/a.md': 'old' });
    const recorded = [{ path: 'dir/a.md', sha256: sha256('old') }];
    expect(planInstall(root, [file], recorded)).toEqual([{ type: 'update', ...file }]);
  });

  it('reports a conflict for a recorded file the user edited', () => {
    const root = writeTree(tmpDir(), { 'dir/a.md': 'edited' });
    const recorded = [{ path: 'dir/a.md', sha256: sha256('old') }];
    expect(planInstall(root, [file], recorded)).toEqual([
      { type: 'conflict', ...file, reason: 'was edited after install' },
    ]);
  });

  it('reports a conflict for a file forgeflow did not install', () => {
    const root = writeTree(tmpDir(), { 'dir/a.md': 'theirs' });
    expect(planInstall(root, [file], [])).toEqual([
      { type: 'conflict', ...file, reason: 'exists and was not installed by forgeflow' },
    ]);
  });

  it('deletes an unedited recorded file that is no longer rendered', () => {
    const root = writeTree(tmpDir(), { 'dir/a.md': 'new', 'dir/gone.md': 'old' });
    const recorded = [
      { path: 'dir/a.md', sha256: sha256('new') },
      { path: 'dir/gone.md', sha256: sha256('old') },
    ];
    expect(types(planInstall(root, [file], recorded))).toEqual([
      ['skip', 'dir/a.md'],
      ['delete', 'dir/gone.md'],
    ]);
  });

  it('keeps an edited recorded file that is no longer rendered', () => {
    const root = writeTree(tmpDir(), { 'dir/gone.md': 'edited' });
    const recorded = [{ path: 'dir/gone.md', sha256: sha256('old') }];
    expect(planInstall(root, [], recorded)).toEqual([
      { type: 'keep', path: 'dir/gone.md', reason: 'was edited after install' },
    ]);
  });

  it('ignores a recorded file that is no longer rendered and already gone', () => {
    expect(planInstall(tmpDir(), [], [{ path: 'dir/gone.md', sha256: 'x' }])).toEqual([]);
  });

  it('hashes Buffer content', () => {
    const root = writeTree(tmpDir(), { 'bin.dat': Buffer.from([0, 255]) });
    const binary = { path: 'bin.dat', content: Buffer.from([0, 255]) };
    expect(types(planInstall(root, [binary], []))).toEqual([['skip', 'bin.dat']]);
  });
});

describe('planRemove', () => {
  it('classifies recorded files as delete, keep or missing', () => {
    const root = writeTree(tmpDir(), { 'same.md': 'old', 'edited.md': 'changed' });
    const recorded = ['same.md', 'edited.md', 'gone.md'].map((path) => ({ path, sha256: sha256('old') }));
    expect(planRemove(root, recorded)).toEqual([
      { type: 'delete', path: 'same.md' },
      { type: 'keep', path: 'edited.md', reason: 'was edited after install' },
      { type: 'missing', path: 'gone.md' },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lock.test.js tests/plan.test.js`
Expected: FAIL, cannot resolve `../src/lock.js`.

- [ ] **Step 3: Write `src/lock.js`**

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

export function readLock(base) {
  const path = lockPath(base);
  if (!existsSync(path)) return { version: LOCK_VERSION, forgeflow: null, targets: {} };

  let lock;
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new LockError(`${path} is not valid JSON (${error.message}). Fix or delete it, then re-run.`);
  }
  if (lock?.version !== LOCK_VERSION || typeof lock.targets !== 'object' || lock.targets === null) {
    throw new LockError(
      `${path} has an unsupported format (version ${lock?.version}). ` +
        `This forgeflow reads version ${LOCK_VERSION}. Upgrade forgeflow or delete the file.`
    );
  }
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

- [ ] **Step 4: Write `src/plan.js`**

```js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './lock.js';

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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/lock.test.js tests/plan.test.js`
Expected: 6 + 11 passed.

- [ ] **Step 6: Commit**

```bash
git add src/lock.js src/plan.js tests/lock.test.js tests/plan.test.js
git commit -m "Add lockfile and install planner"
```

---

### Task 6: Applier

**Files:**
- Create: `src/apply.js`
- Test: `tests/apply.test.js`

**Interfaces:**
- Consumes: `Action[]` from Task 5.
- Produces: `checkWritable(root, actions, force = false)` — throws `Error('no write permission for <dir>')` if any action that would touch disk targets a directory that cannot be written.
- Produces: `applyActions(root, actions, force = false)` — writes `create` and `update`; deletes `delete`; with `force` also writes `conflict` and deletes `keep`; ignores `skip` and `missing`. Writes are atomic (temp file then rename). After a delete, empty parent directories below `root` are removed.

- [ ] **Step 1: Write the failing test**

`tests/apply.test.js`:

```js
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyActions, checkWritable } from '../src/apply.js';
import { tmpDir, writeTree } from './helpers.js';

const read = (root, path) => readFileSync(join(root, path), 'utf8');

describe('applyActions', () => {
  it('writes create and update actions, making directories', () => {
    const root = writeTree(tmpDir(), { 'a/old.md': 'old' });
    applyActions(root, [
      { type: 'create', path: 'a/b/new.md', content: 'new' },
      { type: 'update', path: 'a/old.md', content: 'updated' },
    ]);
    expect(read(root, 'a/b/new.md')).toBe('new');
    expect(read(root, 'a/old.md')).toBe('updated');
    expect(readdirSync(join(root, 'a'))).toEqual(['b', 'old.md']);
  });

  it('writes Buffer content byte for byte', () => {
    const root = tmpDir();
    applyActions(root, [{ type: 'create', path: 'bin.dat', content: Buffer.from([0, 255]) }]);
    expect(readFileSync(join(root, 'bin.dat'))).toEqual(Buffer.from([0, 255]));
  });

  it('leaves skip, missing, conflict and keep alone without force', () => {
    const root = writeTree(tmpDir(), { 'c.md': 'theirs', 'k.md': 'edited' });
    applyActions(root, [
      { type: 'skip', path: 's.md', content: 'x' },
      { type: 'missing', path: 'm.md' },
      { type: 'conflict', path: 'c.md', content: 'ours', reason: 'r' },
      { type: 'keep', path: 'k.md', reason: 'r' },
    ]);
    expect(read(root, 'c.md')).toBe('theirs');
    expect(read(root, 'k.md')).toBe('edited');
    expect(existsSync(join(root, 's.md'))).toBe(false);
  });

  it('overwrites conflicts and deletes kept files with force', () => {
    const root = writeTree(tmpDir(), { 'c.md': 'theirs', 'k.md': 'edited' });
    const actions = [
      { type: 'conflict', path: 'c.md', content: 'ours', reason: 'r' },
      { type: 'keep', path: 'k.md', reason: 'r' },
    ];
    applyActions(root, actions, true);
    expect(read(root, 'c.md')).toBe('ours');
    expect(existsSync(join(root, 'k.md'))).toBe(false);
  });

  it('deletes a file and prunes directories that become empty', () => {
    const root = writeTree(tmpDir(), { 'a/b/one.md': '1', 'a/keep.md': 'k' });
    applyActions(root, [{ type: 'delete', path: 'a/b/one.md' }]);
    expect(existsSync(join(root, 'a/b'))).toBe(false);
    expect(read(root, 'a/keep.md')).toBe('k');
  });

  it('never removes the root itself', () => {
    const root = writeTree(tmpDir(), { 'only.md': '1' });
    applyActions(root, [{ type: 'delete', path: 'only.md' }]);
    expect(existsSync(root)).toBe(true);
  });
});

describe('checkWritable', () => {
  const asUser = process.getuid?.() !== 0;

  it('passes when the nearest existing directory is writable', () => {
    const root = tmpDir();
    expect(() => checkWritable(root, [{ type: 'create', path: 'x/y/z.md', content: '' }])).not.toThrow();
  });

  it.skipIf(!asUser)('throws when the directory cannot be written', () => {
    const root = writeTree(tmpDir(), { 'locked/a.md': 'x' });
    chmodSync(join(root, 'locked'), 0o555);
    try {
      const action = { type: 'create', path: 'locked/new.md', content: '' };
      expect(() => checkWritable(root, [action])).toThrow('no write permission for');
      expect(() => checkWritable(root, [{ ...action, type: 'skip' }])).not.toThrow();
    } finally {
      chmodSync(join(root, 'locked'), 0o755);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/apply.test.js`
Expected: FAIL, cannot resolve `../src/apply.js`.

- [ ] **Step 3: Write `src/apply.js`**

```js
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const ALWAYS = new Set(['create', 'update', 'delete']);
const WITH_FORCE = new Set(['conflict', 'keep']);

function touchesDisk(action, force) {
  return ALWAYS.has(action.type) || (force && WITH_FORCE.has(action.type));
}

export function checkWritable(root, actions, force = false) {
  for (const action of actions) {
    if (!touchesDisk(action, force)) continue;
    let dir = dirname(join(root, action.path));
    while (!existsSync(dir)) dir = dirname(dir);
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
  while (dir !== root && dir.startsWith(root) && readdirSync(dir).length === 0) {
    rmdirSync(dir);
    dir = dirname(dir);
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/apply.test.js`
Expected: 8 passed (7 if run as root, with one skipped).

- [ ] **Step 5: Commit**

```bash
git add src/apply.js tests/apply.test.js
git commit -m "Add action applier with atomic writes"
```

---

### Task 7: Operations — add, update, remove, status

**Files:**
- Create: `src/ops.js`
- Test: `tests/ops.test.js`

**Interfaces:**
- Consumes: `resolve`, `findId`, `getAdapter`, `planInstall`, `planRemove`, `applyActions`, `checkWritable`, `readLock`, `writeLock`, `sha256`, `ConflictError`, `UsageError`.
- `ctx`: `{ catalog, version, scope: 'project'|'global', cwd, home, force: boolean, dryRun: boolean }`. The lockfile base is `cwd` for project scope and `home` for global scope.
- Produces: `add(ctx, refs: string[], targets: string[]) → Result`; `update(ctx, refs: string[], targets: string[]|undefined) → Result`; `remove(ctx, refs: string[], targets: string[]) → Result`.
- `Result`: `{ plans: [{ target, root, actions: [{ id, type, path, reason? }] }], skipped: [{ target, id }] }`. `skipped` lists installed items that the catalog no longer contains (only `update` fills it).
- Produces: `status({ scope, cwd, home }) → [{ target, root, items: [{ id, explicit, files: [{ path, state: 'ok'|'edited'|'missing' }] }] }]`.
- Throws `ConflictError` before writing anything when any target has a conflict and `force` is false.

- [ ] **Step 1: Write the failing test**

`tests/ops.test.js`:

```js
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { ConflictError, UsageError } from '../src/errors.js';
import { lockPath, readLock } from '../src/lock.js';
import { add, remove, status, update } from '../src/ops.js';
import { agentMd, skillMd, tmpDir, writeTree } from './helpers.js';

const tree = {
  'agents/alpha.md': agentMd('alpha'),
  'agents/beta.md': agentMd('beta'),
  'skills/flow/SKILL.md': skillMd('flow', 'requires: [agent:alpha, agent:beta]\n'),
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
const types = (result) => result.plans.flatMap((plan) => plan.actions.map((action) => action.type));

beforeEach(() => {
  catalog = loadCatalog(writeTree(tmpDir(), tree));
  cwd = tmpDir();
  home = tmpDir();
});

describe('add', () => {
  it('installs an item with its requirements and records them', () => {
    const result = add(ctx(), ['flow'], ['cursor']);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({ target: 'cursor', root: cwd });
    expect(result.plans[0].actions.map((action) => [action.id, action.type, action.path])).toEqual([
      ['agent:alpha', 'create', '.cursor/agents/alpha.md'],
      ['agent:beta', 'create', '.cursor/agents/beta.md'],
      ['skill:flow', 'create', '.cursor/skills/flow/SKILL.md'],
    ]);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toContain('Body of alpha.');

    const { items } = readLock(cwd).targets.cursor;
    expect(items['skill:flow'].explicit).toBe(true);
    expect(items['agent:alpha'].explicit).toBe(false);
    expect(items['agent:alpha'].files).toEqual([
      { path: '.cursor/agents/alpha.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  it('is idempotent', () => {
    add(ctx(), ['flow'], ['cursor']);
    expect(types(add(ctx(), ['flow'], ['cursor']))).toEqual(['skip', 'skip', 'skip']);
  });

  it('keeps an item explicit when a later add pulls it in as a requirement', () => {
    add(ctx(), ['alpha'], ['cursor']);
    add(ctx(), ['flow'], ['cursor']);
    expect(readLock(cwd).targets.cursor.items['agent:alpha'].explicit).toBe(true);
  });

  it('writes nothing on a dry run', () => {
    expect(types(add(ctx({ dryRun: true }), ['alpha'], ['cursor']))).toEqual(['create']);
    expect(existsSync(at('.cursor'))).toBe(false);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('refuses to overwrite a file it did not install, then does so with force', () => {
    writeTree(cwd, { '.cursor/agents/alpha.md': 'mine' });
    let error;
    try {
      add(ctx(), ['alpha'], ['cursor']);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.conflicts).toEqual([
      {
        target: 'cursor',
        path: '.cursor/agents/alpha.md',
        reason: 'exists and was not installed by forgeflow',
      },
    ]);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toBe('mine');

    add(ctx({ force: true }), ['alpha'], ['cursor']);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toContain('Body of alpha.');
  });

  it('writes to no target when one target has a conflict', () => {
    writeTree(cwd, { '.codex/agents/alpha.toml': 'mine' });
    expect(() => add(ctx(), ['alpha'], ['cursor', 'codex'])).toThrow(ConflictError);
    expect(existsSync(at('.cursor'))).toBe(false);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('adopts identical files left by an interrupted run', () => {
    add(ctx(), ['flow'], ['cursor']);
    rmSync(lockPath(cwd));
    expect(types(add(ctx(), ['flow'], ['cursor']))).toEqual(['skip', 'skip', 'skip']);
    expect(Object.keys(readLock(cwd).targets.cursor.items)).toHaveLength(3);
  });

  it('installs globally under home, with OpenCode in its config directory', () => {
    add(ctx({ scope: 'global' }), ['alpha'], ['opencode', 'claude']);
    expect(existsSync(join(home, '.config/opencode/agents/alpha.md'))).toBe(true);
    expect(existsSync(join(home, '.claude/agents/alpha.md'))).toBe(true);
    expect(existsSync(lockPath(home))).toBe(true);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('rejects an unknown item and an unknown target', () => {
    expect(() => add(ctx(), ['ghost'], ['cursor'])).toThrow(UsageError);
    expect(() => add(ctx(), ['alpha'], ['vim'])).toThrow('unknown target "vim"');
  });
});

describe('update', () => {
  const newer = () => loadCatalog(writeTree(tmpDir(), { ...tree, 'agents/alpha.md': agentMd('alpha').replace('Body', 'New body') }));

  it('rewrites unedited files from the current catalog', () => {
    add(ctx(), ['flow'], ['cursor']);
    const result = update(ctx({ catalog: newer() }), [], undefined);
    expect(types(result)).toEqual(['update', 'skip', 'skip']);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toContain('New body of alpha.');
    expect(readLock(cwd).targets.cursor.items['agent:alpha'].explicit).toBe(false);
  });

  it('reports a conflict for an edited file and overwrites it with force', () => {
    add(ctx(), ['alpha'], ['cursor']);
    writeFileSync(at('.cursor/agents/alpha.md'), 'my edit');

    expect(() => update(ctx({ catalog: newer() }), [], undefined)).toThrow(ConflictError);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toBe('my edit');

    update(ctx({ catalog: newer(), force: true }), [], undefined);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toContain('New body of alpha.');
  });

  it('covers every installed target when none is given, or only the named one', () => {
    add(ctx(), ['alpha'], ['cursor', 'claude']);
    const all = update(ctx({ catalog: newer() }), [], undefined);
    expect(all.plans.map((plan) => plan.target).sort()).toEqual(['claude', 'cursor']);

    const one = update(ctx(), [], ['claude']);
    expect(one.plans.map((plan) => plan.target)).toEqual(['claude']);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toContain('New body of alpha.');
  });

  it('rejects an item that is not installed', () => {
    add(ctx(), ['alpha'], ['cursor']);
    expect(() => update(ctx(), ['beta'], ['cursor'])).toThrow('agent:beta is not installed for cursor');
  });

  it('skips and reports an installed item the catalog no longer has', () => {
    add(ctx(), ['alpha', 'beta'], ['cursor']);
    const smaller = loadCatalog(writeTree(tmpDir(), { 'agents/alpha.md': agentMd('alpha') }));
    const result = update(ctx({ catalog: smaller }), [], undefined);
    expect(result.skipped).toEqual([{ target: 'cursor', id: 'agent:beta' }]);
    expect(existsSync(at('.cursor/agents/beta.md'))).toBe(true);
  });
});

describe('remove', () => {
  it('removes an item, its now-unneeded requirements, the lockfile and empty directories', () => {
    add(ctx(), ['flow'], ['cursor']);
    const result = remove(ctx(), ['flow'], ['cursor']);
    expect(types(result)).toEqual(['delete', 'delete', 'delete']);
    expect(existsSync(at('.cursor'))).toBe(false);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('keeps a requirement the user installed explicitly', () => {
    add(ctx(), ['alpha'], ['cursor']);
    add(ctx(), ['flow'], ['cursor']);
    remove(ctx(), ['flow'], ['cursor']);
    expect(Object.keys(readLock(cwd).targets.cursor.items)).toEqual(['agent:alpha']);
    expect(existsSync(at('.cursor/agents/alpha.md'))).toBe(true);
    expect(existsSync(at('.cursor/agents/beta.md'))).toBe(false);
  });

  it('refuses to remove an item another installed item requires', () => {
    add(ctx(), ['flow'], ['cursor']);
    expect(() => remove(ctx(), ['alpha'], ['cursor'])).toThrow(
      'cannot remove agent:alpha: skill:flow requires it'
    );
    expect(existsSync(at('.cursor/agents/alpha.md'))).toBe(true);
  });

  it('leaves an edited file in place, drops its record, and deletes it with force', () => {
    add(ctx(), ['alpha', 'beta'], ['cursor']);
    writeFileSync(at('.cursor/agents/alpha.md'), 'my edit');

    const result = remove(ctx(), ['alpha'], ['cursor']);
    expect(result.plans[0].actions).toEqual([
      { id: 'agent:alpha', type: 'keep', path: '.cursor/agents/alpha.md', reason: 'was edited after install' },
    ]);
    expect(readFileSync(at('.cursor/agents/alpha.md'), 'utf8')).toBe('my edit');
    expect(Object.keys(readLock(cwd).targets.cursor.items)).toEqual(['agent:beta']);

    writeFileSync(at('.cursor/agents/beta.md'), 'my edit');
    remove(ctx({ force: true }), ['beta'], ['cursor']);
    expect(existsSync(at('.cursor/agents/beta.md'))).toBe(false);
  });

  it('succeeds when the file was already deleted by hand', () => {
    add(ctx(), ['alpha'], ['cursor']);
    rmSync(at('.cursor/agents/alpha.md'));
    expect(types(remove(ctx(), ['alpha'], ['cursor']))).toEqual(['missing']);
    expect(existsSync(lockPath(cwd))).toBe(false);
  });

  it('touches only the named target', () => {
    add(ctx(), ['alpha'], ['cursor', 'claude']);
    remove(ctx(), ['alpha'], ['cursor']);
    expect(existsSync(at('.cursor'))).toBe(false);
    expect(existsSync(at('.claude/agents/alpha.md'))).toBe(true);
    expect(Object.keys(readLock(cwd).targets)).toEqual(['claude']);
  });

  it('writes nothing on a dry run', () => {
    add(ctx(), ['alpha'], ['cursor']);
    expect(types(remove(ctx({ dryRun: true }), ['alpha'], ['cursor']))).toEqual(['delete']);
    expect(existsSync(at('.cursor/agents/alpha.md'))).toBe(true);
    expect(existsSync(lockPath(cwd))).toBe(true);
  });

  it('rejects an item that is not installed', () => {
    expect(() => remove(ctx(), ['alpha'], ['cursor'])).toThrow('agent:alpha is not installed for cursor');
  });

  it('removes by full id an installed item the catalog no longer has', () => {
    add(ctx(), ['beta'], ['cursor']);
    const smaller = loadCatalog(writeTree(tmpDir(), { 'agents/alpha.md': agentMd('alpha') }));
    remove(ctx({ catalog: smaller }), ['agent:beta'], ['cursor']);
    expect(existsSync(at('.cursor'))).toBe(false);
  });
});

describe('status', () => {
  it('reports ok, edited and missing files per target', () => {
    add(ctx(), ['flow'], ['cursor']);
    writeFileSync(at('.cursor/agents/alpha.md'), 'my edit');
    rmSync(at('.cursor/agents/beta.md'));

    const [cursor] = status(ctx());
    expect(cursor.target).toBe('cursor');
    expect(cursor.items.map((entry) => [entry.id, entry.explicit, entry.files[0].state])).toEqual([
      ['agent:alpha', false, 'edited'],
      ['agent:beta', false, 'missing'],
      ['skill:flow', true, 'ok'],
    ]);
  });

  it('returns an empty list when nothing is installed', () => {
    expect(status(ctx())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ops.test.js`
Expected: FAIL, cannot resolve `../src/ops.js`.

- [ ] **Step 3: Write `src/ops.js`**

```js
import { getAdapter } from './adapters/index.js';
import { applyActions, checkWritable } from './apply.js';
import { ConflictError, UsageError } from './errors.js';
import { readLock, sha256, writeLock } from './lock.js';
import { planInstall, planRemove } from './plan.js';
import { findId, resolve } from './resolve.js';

const FILE_STATE = { delete: 'ok', keep: 'edited', missing: 'missing' };

const baseOf = (ctx) => (ctx.scope === 'global' ? ctx.home : ctx.cwd);

function report(plans) {
  return plans.map(({ target, root, items }) => ({
    target,
    root,
    actions: items.flatMap((entry) =>
      entry.actions.map(({ type, path, reason }) =>
        reason ? { id: entry.id, type, path, reason } : { id: entry.id, type, path }
      )
    ),
  }));
}

function commit(ctx, lock, plans, record) {
  if (ctx.dryRun) return;
  for (const plan of plans) {
    checkWritable(plan.root, plan.items.flatMap((entry) => entry.actions), ctx.force);
  }
  for (const plan of plans) {
    const target = (lock.targets[plan.target] ??= { items: {} });
    for (const entry of plan.items) {
      applyActions(plan.root, entry.actions, ctx.force);
      record(target.items, entry);
    }
  }
  // Written last: a crash never leaves a lockfile that claims unwritten files.
  writeLock(baseOf(ctx), lock, ctx.version);
}

// perTarget: [{ target, entries: [{ item, explicit }] }]
function install(ctx, lock, perTarget) {
  const plans = perTarget.map(({ target, entries }) => {
    const adapter = getAdapter(target);
    const root = adapter.root(ctx.scope, ctx);
    const installed = lock.targets[target]?.items ?? {};
    const items = entries.map(({ item, explicit }) => {
      const files = adapter.render(item, { scope: ctx.scope, version: ctx.version });
      const actions = planInstall(root, files, installed[item.id]?.files ?? []);
      return { id: item.id, explicit, files, actions };
    });
    return { target, root, items };
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
  const perTarget = (targets ?? Object.keys(lock.targets)).map((target) => {
    const installed = lock.targets[target]?.items ?? {};
    const ids =
      refs.length > 0 ? refs.map((ref) => findId(ctx.catalog, ref)) : Object.keys(installed);
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
    return { target, entries };
  });
  return { plans: install(ctx, lock, perTarget), skipped };
}

export function remove(ctx, refs, targets) {
  const lock = readLock(baseOf(ctx));
  // A full id is taken as given so items dropped from the catalog can still be removed.
  const ids = refs.map((ref) => (ref.includes(':') ? ref : findId(ctx.catalog, ref)));
  const requiresOf = (id) => ctx.catalog.get(id)?.requires ?? [];

  const plans = targets.map((target) => {
    const root = getAdapter(target).root(ctx.scope, ctx);
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

    const items = Object.keys(installed)
      .filter((id) => going.has(id))
      .map((id) => ({ id, actions: planRemove(root, installed[id].files) }));
    return { target, root, items };
  });

  commit(ctx, lock, plans, (items, entry) => {
    delete items[entry.id];
  });
  return { plans: report(plans), skipped: [] };
}

export function status(ctx) {
  const lock = readLock(baseOf(ctx));
  return Object.entries(lock.targets).map(([target, { items }]) => {
    const root = getAdapter(target).root(ctx.scope, ctx);
    return {
      target,
      root,
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ops.test.js`
Expected: all pass. A non-explicit requirement that nothing needs is removed by any `remove` on that target; the "keeps a requirement the user installed explicitly" test pins the case that must survive.

- [ ] **Step 5: Run the whole suite and the linter**

Run: `npm test && npm run lint`
Expected: every test file passes; oxlint reports 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/ops.js tests/ops.test.js
git commit -m "Add add, update, remove and status operations"
```

---

### Task 8: CLI and doctor

**Files:**
- Create: `src/doctor.js`, `src/cli.js`, `bin/forgeflow.js`
- Test: `tests/cli.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces: `runDoctor({ catalogDir, cwd, home, nodeVersion? }) → [{ name, ok, detail }]`.
- Produces: `main(argv: string[], { cwd, home, stdout, stderr, catalogDir? }) → exit code` (`stdout`/`stderr` need only `.write(string)`). `catalogDir` defaults to the `catalog/` folder beside `src/`.

Commands (spec section 7): `list [--type agent|skill] [--json]`, `info <id>`, `add <id…> | --flow quick|full`, `remove <id…>`, `update [<id…>]`, `status`, `doctor`, with `--target`, `--global`, `--dry-run`, `--force`, `--help`, `--version`. `--flow quick` is an alias for `skill:forge-quick`, `--flow full` for `skill:forge-full`.

- [ ] **Step 1: Write the failing test**

`tests/cli.test.js`:

```js
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), {
    'agents/alpha.md': agentMd('alpha', 'stage: review\n'),
    'agents/beta.md': agentMd('beta'),
    'skills/forge-quick/SKILL.md': skillMd('forge-quick', 'requires: [agent:alpha]\n'),
    'skills/forge-full/SKILL.md': skillMd('forge-full', 'requires: [agent:alpha, agent:beta]\n'),
  });
  cwd = tmpDir();
  home = tmpDir();
});

describe('general', () => {
  it('prints usage for --help and exits 0', () => {
    const { code, out } = run('--help');
    expect(code).toBe(0);
    expect(out).toContain('forgeflow add <id...> --target');
  });

  it('prints the version', () => {
    expect(run('--version')).toMatchObject({ code: 0, out: '0.1.0\n' });
  });

  it('exits 2 with usage on stderr when no command is given', () => {
    const { code, err } = run();
    expect(code).toBe(2);
    expect(err).toContain('Usage:');
  });

  it('exits 2 for an unknown command or flag', () => {
    expect(run('launch')).toMatchObject({ code: 2 });
    expect(run('launch').err).toContain('unknown command "launch"');
    expect(run('list', '--bogus').code).toBe(2);
  });

  it('exits 1 and names the file when the catalog is invalid', () => {
    writeTree(catalogDir, { 'agents/bad.md': 'no frontmatter' });
    const { code, err } = run('list');
    expect(code).toBe(1);
    expect(err).toContain('agents/bad.md');
  });
});

describe('list and info', () => {
  it('lists every item with stage and access', () => {
    const { code, out } = run('list');
    expect(code).toBe(0);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^agent:alpha\s+review\s+read-only\s+Does alpha things\.$/);
    expect(lines[2]).toMatch(/^skill:forge-full\s+-\s+-\s+Runs forge-full\.$/);
  });

  it('filters by type and prints JSON', () => {
    const { out } = run('list', '--type', 'skill', '--json');
    expect(JSON.parse(out).map((entry) => entry.id)).toEqual(['skill:forge-full', 'skill:forge-quick']);
    expect(run('list', '--type', 'hook').code).toBe(2);
  });

  it('shows one item', () => {
    const { code, out } = run('info', 'forge-full');
    expect(code).toBe(0);
    expect(out).toContain('skill:forge-full');
    expect(out).toContain('requires:     agent:alpha, agent:beta');
    expect(run('info').code).toBe(2);
    expect(run('info', 'ghost').code).toBe(2);
  });
});

describe('add', () => {
  it('installs an agent and reports what it wrote', () => {
    const { code, out } = run('add', 'alpha', '--target', 'cursor');
    expect(code).toBe(0);
    expect(out).toContain('cursor');
    expect(out).toMatch(/create\s+\.cursor\/agents\/alpha\.md/);
    expect(existsSync(join(cwd, '.cursor/agents/alpha.md'))).toBe(true);
  });

  it('installs a flow to several targets', () => {
    const { code } = run('add', '--flow', 'quick', '--target', 'claude,codex');
    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.claude/skills/forge-quick/SKILL.md'))).toBe(true);
    expect(existsSync(join(cwd, '.claude/agents/alpha.md'))).toBe(true);
    expect(existsSync(join(cwd, '.agents/skills/forge-quick/SKILL.md'))).toBe(true);
    expect(existsSync(join(cwd, '.codex/agents/alpha.toml'))).toBe(true);
  });

  it('collapses repeated targets and ignores a trailing comma', () => {
    const { code, out } = run('add', 'alpha', '--target', 'cursor,cursor,');
    expect(code).toBe(0);
    expect(out.match(/create/g)).toHaveLength(1);
  });

  it('exits 2 for a missing, empty or unknown target', () => {
    expect(run('add', 'alpha').err).toContain('--target is required');
    expect(run('add', 'alpha').code).toBe(2);
    expect(run('add', 'alpha', '--target', ',').code).toBe(2);
    expect(run('add', 'alpha', '--target', 'vim').err).toContain('unknown target "vim"');
    expect(existsSync(join(cwd, '.forgeflow'))).toBe(false);
  });

  it('exits 2 when no item is named or the flow is unknown', () => {
    expect(run('add', '--target', 'cursor').err).toContain('name at least one item');
    expect(run('add', '--flow', 'turbo', '--target', 'cursor').err).toContain('--flow must be quick or full');
    expect(run('add', 'ghost', '--target', 'cursor').code).toBe(2);
  });

  it('exits 1 on a conflict, lists the file, and writes nothing', () => {
    writeTree(cwd, { '.cursor/agents/alpha.md': 'mine' });
    const { code, err } = run('add', 'alpha', 'beta', '--target', 'cursor');
    expect(code).toBe(1);
    expect(err).toContain('[cursor] .cursor/agents/alpha.md');
    expect(err).toContain('--force');
    expect(existsSync(join(cwd, '.cursor/agents/beta.md'))).toBe(false);

    expect(run('add', 'alpha', '--target', 'cursor', '--force').code).toBe(0);
    expect(readFileSync(join(cwd, '.cursor/agents/alpha.md'), 'utf8')).toContain('Body of alpha.');
  });

  it('writes nothing on --dry-run and says so', () => {
    const { code, out } = run('add', 'alpha', '--target', 'cursor', '--dry-run');
    expect(code).toBe(0);
    expect(out).toContain('Dry run');
    expect(existsSync(join(cwd, '.cursor'))).toBe(false);
  });

  it('installs under home with --global', () => {
    expect(run('add', 'alpha', '--target', 'claude', '--global').code).toBe(0);
    expect(existsSync(join(home, '.claude/agents/alpha.md'))).toBe(true);
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });
});

describe('remove, update and status', () => {
  it('removes what add installed', () => {
    run('add', '--flow', 'full', '--target', 'cursor');
    const { code, out } = run('remove', 'forge-full', '--target', 'cursor');
    expect(code).toBe(0);
    expect(out.match(/delete/g)).toHaveLength(3);
    expect(existsSync(join(cwd, '.cursor'))).toBe(false);
  });

  it('exits 2 when remove has no item, no target, or a required item', () => {
    run('add', '--flow', 'quick', '--target', 'cursor');
    expect(run('remove', '--target', 'cursor').code).toBe(2);
    expect(run('remove', 'alpha').code).toBe(2);
    const blocked = run('remove', 'alpha', '--target', 'cursor');
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain('skill:forge-quick requires it');
  });

  it('reports kept files when removing an edited item', () => {
    run('add', 'alpha', '--target', 'cursor');
    writeFileSync(join(cwd, '.cursor/agents/alpha.md'), 'my edit');
    const { code, out } = run('remove', 'alpha', '--target', 'cursor');
    expect(code).toBe(0);
    expect(out).toMatch(/kept\s+\.cursor\/agents\/alpha\.md\s+\(was edited after install\)/);
  });

  it('updates all installed targets without --target', () => {
    run('add', 'alpha', '--target', 'cursor,claude');
    writeTree(catalogDir, { 'agents/alpha.md': agentMd('alpha').replace('Body', 'New body') });
    const { code, out } = run('update');
    expect(code).toBe(0);
    expect(out.match(/update/g)).toHaveLength(2);
    expect(readFileSync(join(cwd, '.claude/agents/alpha.md'), 'utf8')).toContain('New body');
  });

  it('says so when there is nothing to update', () => {
    expect(run('update')).toMatchObject({ code: 0, out: 'Nothing is installed here.\n' });
  });

  it('shows installed items and flags edited files', () => {
    run('add', '--flow', 'quick', '--target', 'cursor');
    writeFileSync(join(cwd, '.cursor/agents/alpha.md'), 'my edit');
    const { code, out } = run('status');
    expect(code).toBe(0);
    expect(out).toMatch(/agent:alpha\s+\(required\)/);
    expect(out).toMatch(/edited\s+\.cursor\/agents\/alpha\.md/);
    expect(out).toMatch(/ok\s+\.cursor\/skills\/forge-quick\/SKILL\.md/);
    expect(run('status', '--global').out).toBe('Nothing is installed here.\n');
  });
});

describe('doctor', () => {
  it('passes on a clean install', () => {
    run('add', 'alpha', '--target', 'cursor');
    const { code, out } = run('doctor');
    expect(code).toBe(0);
    expect(out).toMatch(/ok\s+catalog is valid \(4 items\)/);
    expect(out).toMatch(/ok\s+Node\.js >= 20/);
  });

  it('exits 1 when an installed file was edited', () => {
    run('add', 'alpha', '--target', 'cursor');
    writeFileSync(join(cwd, '.cursor/agents/alpha.md'), 'my edit');
    const { code, out } = run('doctor');
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL\s+project install matches lockfile/);
    expect(out).toContain('.cursor/agents/alpha.md is edited');
  });

  it('exits 1 when the catalog is invalid', () => {
    writeTree(catalogDir, { 'agents/bad.md': 'no frontmatter' });
    const { code, out } = run('doctor');
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL\s+catalog is valid/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli.test.js`
Expected: FAIL, cannot resolve `../src/cli.js`.

- [ ] **Step 3: Write `src/doctor.js`**

```js
import { loadCatalog } from './catalog.js';
import { status } from './ops.js';

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

  for (const scope of ['project', 'global']) {
    const name = `${scope} install matches lockfile`;
    try {
      const problems = status({ scope, cwd, home }).flatMap((target) =>
        target.items.flatMap((entry) =>
          entry.files
            .filter((file) => file.state !== 'ok')
            .map((file) => `[${target.target}] ${file.path} is ${file.state}`)
        )
      );
      const detail = problems.length > 0 ? problems.join('; ') : 'no differences';
      checks.push({ name, ok: problems.length === 0, detail });
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
    }
  }
  return checks;
}
```

- [ ] **Step 4: Write `src/cli.js`**

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

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const DEFAULT_CATALOG = fileURLToPath(new URL('../catalog', import.meta.url));

const USAGE = `Usage:
  forgeflow list [--type agent|skill] [--json]
  forgeflow info <id>
  forgeflow add <id...> --target <t>[,<t>...] [--global] [--dry-run] [--force]
  forgeflow add --flow quick|full --target <t>[,<t>...]
  forgeflow remove <id...> --target <t>[,<t>...] [--global] [--dry-run] [--force]
  forgeflow update [<id...>] [--target <t>[,<t>...]] [--global] [--dry-run] [--force]
  forgeflow status [--global]
  forgeflow doctor

Targets: ${targetNames.join(', ')}
An <id> is a name such as "reviewer", or a full id such as "agent:reviewer".
`;

const OPTIONS = {
  target: { type: 'string' },
  flow: { type: 'string' },
  type: { type: 'string' },
  global: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

const LABELS = { skip: 'unchanged', keep: 'kept', missing: 'already gone' };
const NOTHING = 'Nothing is installed here.\n';

function parseTargets(value, required) {
  if (value === undefined) {
    if (!required) return undefined;
    throw new UsageError(`--target is required. Choose from: ${targetNames.join(', ')}.`);
  }
  const names = [...new Set(value.split(',').map((name) => name.trim()).filter(Boolean))];
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
  for (const { target, root, items } of targets) {
    stdout.write(`${target}  (${root})\n`);
    for (const { id, explicit, files } of items) {
      stdout.write(`  ${id}${explicit ? '' : '  (required)'}\n`);
      for (const { path, state } of files) stdout.write(`    ${state.padEnd(8)} ${path}\n`);
    }
  }
}

function run(argv, { cwd, home, stdout, stderr, catalogDir = DEFAULT_CATALOG }) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
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
      if (values.type !== undefined && !['agent', 'skill'].includes(values.type)) {
        throw new UsageError('--type must be agent or skill.');
      }
      const items = [...catalog.values()]
        .filter((item) => values.type === undefined || item.type === values.type)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (values.json) {
        const rows = items.map(({ id, type, name, description, stage, access, modelTier, requires }) => ({
          id,
          type,
          name,
          description,
          stage,
          access,
          modelTier,
          requires,
        }));
        stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else {
        for (const item of items) {
          const stage = (item.stage ?? '-').padEnd(13);
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
      if (wanted.length === 0) {
        throw new UsageError('name at least one item, or use --flow quick|full.');
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

- [ ] **Step 5: Write `bin/forgeflow.js`**

```js
#!/usr/bin/env node
import { homedir } from 'node:os';
import { main } from '../src/cli.js';

process.exitCode = main(process.argv.slice(2), {
  cwd: process.cwd(),
  home: homedir(),
  stdout: process.stdout,
  stderr: process.stderr,
});
```

Then: `chmod +x bin/forgeflow.js`

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/cli.test.js`
Expected: all pass.

- [ ] **Step 7: Smoke-test the real binary**

Run: `node bin/forgeflow.js --version && node bin/forgeflow.js list; echo "exit=$?"`
Expected: prints `0.1.0`, then nothing (the real catalog is still empty), then `exit=0`.

- [ ] **Step 8: Run the whole suite and the linter, then commit**

Run: `npm test && npm run lint`
Expected: all pass, 0 lint errors.

```bash
git add src/doctor.js src/cli.js bin tests/cli.test.js
git commit -m "Add CLI and doctor command"
```

---
### Task 9: The eleven flow agents

**Files:**
- Create: `catalog/agents/requirement-analyst.md`, `analyzer.md`, `planner.md`, `architect.md`, `builder.md`, `tester.md`, `fixer.md`, `reviewer.md`, `release-gate.md`, `deployer.md`, `feedback.md`
- Test: `tests/content.test.js`

**Interfaces:**
- Consumes: `loadCatalog` and the canonical agent format (spec section 4).
- Produces: agents with these exact ids, which Task 10's skills list in `requires`: `agent:requirement-analyst`, `agent:analyzer`, `agent:planner`, `agent:architect`, `agent:builder`, `agent:tester`, `agent:fixer`, `agent:reviewer`, `agent:release-gate`, `agent:deployer`, `agent:feedback`.
- Every body has exactly these five `##` headings, in this order: `Role`, `Inputs`, `Procedure`, `Output`, `Limits`.
- Run-directory file names the agents read (written by the flow skill, not by agents): `00-request.md`, `01-requirement.md`, `02-analysis.md`, `03-plan.md`, `04-architecture.md`, `05-build.md`, `06-test.md`, `07-review.md`, `08-release-gate.md`, `09-approval.md`, `10-deploy.md`, `11-feedback.md`.
- Verdict lines other units depend on: tester ends with `VERDICT: PASS` or `VERDICT: FAIL`; reviewer with `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`; release-gate with `VERDICT: GO` or `VERDICT: NO_GO`.

Agents return their result in their reply. They never write run-directory files, because read-only agents cannot write.

- [ ] **Step 1: Write the failing test**

`tests/content.test.js`:

```js
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const agents = [...catalog.values()].filter((item) => item.type === 'agent');

const EXPECTED = [
  ['requirement-analyst', 'requirement', 'read-only', 'balanced'],
  ['analyzer', 'analyze', 'read-only', 'strong'],
  ['planner', 'plan', 'read-only', 'strong'],
  ['architect', 'architect', 'read-only', 'strong'],
  ['builder', 'build', 'write', 'balanced'],
  ['tester', 'test', 'write', 'balanced'],
  ['fixer', 'fix', 'write', 'balanced'],
  ['reviewer', 'review', 'read-only', 'strong'],
  ['release-gate', 'release_gate', 'read-only', 'balanced'],
  ['deployer', 'deploy', 'write', 'balanced'],
  ['feedback', 'feedback', 'read-only', 'fast'],
];
const SECTIONS = ['Role', 'Inputs', 'Procedure', 'Output', 'Limits'];
const HARNESS_TOOL =
  /`(Edit|Write|Read|Grep|Glob|Bash|Task|MultiEdit|TodoWrite|apply_patch|str_replace)`|\b(apply_patch|MultiEdit|TodoWrite|str_replace)\b/;

describe('flow agents', () => {
  it('are exactly the eleven the spec lists', () => {
    expect(agents.map((agent) => agent.name).sort()).toEqual(EXPECTED.map(([name]) => name).sort());
  });

  it.each(EXPECTED)('%s has stage %s, access %s, tier %s', (name, stage, access, modelTier) => {
    expect(catalog.get(`agent:${name}`)).toMatchObject({ stage, access, modelTier, requires: [] });
  });

  it.each(EXPECTED)('%s has the five sections in order', (name) => {
    const headings = [...catalog.get(`agent:${name}`).body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(SECTIONS);
  });

  it.each(EXPECTED)('%s names no harness-specific tool', (name) => {
    expect(catalog.get(`agent:${name}`).body).not.toMatch(HARNESS_TOOL);
  });

  it.each([
    ['tester', ['VERDICT: PASS', 'VERDICT: FAIL']],
    ['reviewer', ['VERDICT: APPROVE', 'VERDICT: CHANGES_REQUESTED']],
    ['release-gate', ['VERDICT: GO', 'VERDICT: NO_GO']],
  ])('%s defines its verdict lines', (name, verdicts) => {
    for (const verdict of verdicts) expect(catalog.get(`agent:${name}`).body).toContain(verdict);
  });

  it('read-only agents are told not to modify files', () => {
    for (const agent of agents.filter((entry) => entry.access === 'read-only')) {
      expect(agent.body, agent.name).toMatch(/do not (create, )?(modify|change|edit)/i);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/content.test.js`
Expected: FAIL on "are exactly the eleven the spec lists" (the catalog is empty).

- [ ] **Step 3: Write `catalog/agents/requirement-analyst.md`**

```markdown
---
name: requirement-analyst
description: Turns a raw request into a structured requirement with acceptance criteria and open questions. Use at the start of any change, before planning.
stage: requirement
access: read-only
model-tier: balanced
---
## Role

You turn a request into a requirement that someone else can plan and test against. You do not design or implement anything.

## Inputs

- The request, as given to you by the caller.
- If the caller names a run directory, read `00-request.md` from it.
- The repository, to learn what already exists and which terms the project uses.

## Procedure

1. Restate the request in one or two sentences. If you cannot, the request is unclear: say what is missing.
2. Look through the repository for the code, documentation and tests the request touches, so the requirement uses the project's own names.
3. List what must be true when the work is done. Separate behavior (functional) from qualities such as performance, security or compatibility (non-functional).
4. Write acceptance criteria that a test or a person can check. Each one states a starting condition, an action and an observable result.
5. List what is explicitly out of scope, so the change does not grow.
6. List open questions. A question belongs here only if two reasonable answers would lead to different implementations.

## Output

Reply with these headings:

- **Summary**: the request in one or two sentences.
- **Functional requirements**: numbered F1, F2, …
- **Non-functional requirements**: numbered N1, N2, … or "None".
- **Acceptance criteria**: numbered A1, A2, …, each naming the requirement it checks.
- **Out of scope**
- **Open questions**: numbered, each with the options you see and the one you would assume. Write "None" if there are none.

## Limits

- Do not modify any file.
- Do not invent requirements the request does not imply. If something seems missing, put it under Open questions.
- Do not propose a solution or name files to change. That belongs to planning.
```

- [ ] **Step 4: Write `catalog/agents/analyzer.md`**

```markdown
---
name: analyzer
description: Assesses feasibility, affected code, risks, dependencies and effort for a requirement. Use after the requirement is settled and before planning larger or riskier work.
stage: analyze
access: read-only
model-tier: strong
---
## Role

You work out what a requirement means for this codebase: what it touches, what could go wrong and how large it is. You inform the plan. You do not write it.

## Inputs

- The requirement, from the caller.
- If the caller names a run directory, read `01-requirement.md` from it.
- The repository, including its tests, build configuration and dependency manifests.

## Procedure

1. For each functional requirement, find the code that implements the nearest existing behavior. Record file paths.
2. Trace who calls that code and what it calls, far enough to know what a change there can break.
3. Check how the affected code is tested today and how the project runs its tests.
4. List external dependencies the work needs: libraries, services, data, credentials, migrations. Note any that are missing.
5. Identify risks. For each, state what would go wrong, how likely it is, and what would reduce it.
6. Judge feasibility: can this be done as stated with what exists? If not, say what blocks it.
7. Estimate effort as small (under a day), medium (days) or large (a week or more), and say what drives the estimate.

## Output

Reply with these headings:

- **Feasibility**: feasible, feasible with conditions (list them), or blocked (say by what).
- **Affected code**: paths, each with one line on why it is affected.
- **Existing tests**: what covers the affected code and the command that runs it.
- **Dependencies**
- **Risks**: each with likelihood (low, medium, high), impact and mitigation.
- **Effort**: small, medium or large, with the main driver.
- **Notes for planning**: constraints the plan must respect.

## Limits

- Do not modify any file.
- Report only what you verified in the repository. Mark anything you inferred as an assumption.
- If the requirement has unanswered open questions that change the analysis, stop and list them instead of guessing.
```

- [ ] **Step 5: Write `catalog/agents/planner.md`**

```markdown
---
name: planner
description: Breaks a requirement into an ordered list of small implementation tasks, each with files and a verification step. Use before building anything that needs more than one edit.
stage: plan
access: read-only
model-tier: strong
---
## Role

You turn a requirement into a task list that a builder can follow without making design decisions. You do not implement the tasks.

## Inputs

- The requirement, from the caller.
- If the caller names a run directory, read `01-requirement.md` and, when present, `02-analysis.md` from it.
- The repository, to name real files and follow existing structure.

## Procedure

1. Read the code the change touches, so every task names files that exist or says clearly that it creates one.
2. Choose the simplest approach that meets every acceptance criterion. If you considered another approach, say in one line why you rejected it.
3. Split the work into tasks. Each task changes one thing, leaves the project building, and can be verified on its own.
4. Order tasks so each depends only on earlier ones.
5. For each task, give the verification: the command to run or the behavior to observe, and the expected result.
6. Map every acceptance criterion to the task that satisfies it. A criterion with no task means the plan is incomplete.

## Output

Reply with these headings:

- **Approach**: two to four sentences.
- **Tasks**: numbered T1, T2, … Each has: goal, files to create or change, what to do, and verification.
- **Coverage**: each acceptance criterion with the task or tasks that satisfy it.
- **Risks and assumptions**: anything the builder should know before starting.

## Limits

- Do not modify any file.
- Do not plan work the requirement does not ask for, including refactoring unrelated code.
- If a decision needs architectural design (new components, new interfaces between parts, data model changes), say so and name the decision instead of deciding it inside a task.
```

- [ ] **Step 6: Write `catalog/agents/architect.md`**

```markdown
---
name: architect
description: Designs components, interfaces and data flow for a change, and records the key decisions with their reasons. Use when work adds components, changes interfaces between parts, or changes the data model.
stage: architect
access: read-only
model-tier: strong
---
## Role

You decide the structure of a change: which parts exist, what each is responsible for and how they talk to each other. You produce a design the builder follows. You do not write the implementation.

## Inputs

- The requirement and plan, from the caller.
- If the caller names a run directory, read `01-requirement.md`, `02-analysis.md` and `03-plan.md` from it.
- The repository, to fit the design to the architecture that already exists.

## Procedure

1. Describe the current structure around the change in a few lines: the parts involved and how they connect today.
2. Define the components the change adds or alters. Give each one responsibility.
3. Define the interfaces between them: function or endpoint signatures, data shapes, and who calls whom.
4. Describe the data flow for the main use case, step by step, and for the most important failure case.
5. For each decision that had a real alternative, record the options, the one you chose and why.
6. Check the design against the non-functional requirements and the risks from analysis. Say how each is addressed.
7. Note what the plan must change to follow this design.

## Output

Reply with these headings:

- **Context**: the existing structure the change fits into.
- **Components**: each with its responsibility and the files it lives in.
- **Interfaces**: signatures and data shapes.
- **Data flow**: main path, then failure path.
- **Decisions**: numbered D1, D2, … each with options, choice and reason.
- **Requirements check**: each non-functional requirement and risk, with how the design handles it.
- **Plan adjustments**: tasks to add, change or reorder. Write "None" if the plan stands.

## Limits

- Do not modify any file.
- Prefer the patterns the codebase already uses. Introduce a new pattern or dependency only with a recorded decision.
- Design only what the requirement needs. Do not add extension points for needs nobody has stated.
```

- [ ] **Step 7: Write `catalog/agents/builder.md`**

```markdown
---
name: builder
description: Implements a planned change in the codebase, task by task, and summarizes what changed. Use when there is a plan or a clear, small change to make.
stage: build
access: write
model-tier: balanced
---
## Role

You implement the plan. You write production code that matches the surrounding code, and you leave the project building.

## Inputs

- The plan or the change to make, from the caller.
- If the caller names a run directory, read `01-requirement.md`, `03-plan.md` and, when present, `04-architecture.md` from it.
- If the caller passes review findings or a previous `07-review.md`, treat each finding as a required change.
- The repository.

## Procedure

1. Read every file you are about to change, and one or two neighboring files, to learn naming, structure and error-handling conventions.
2. Work through the tasks in order. For each task, make the change, then run its verification step if it can be run without the tests that come later.
3. Match the existing code: same style, same libraries, same patterns. Add a dependency only if the plan or design names it.
4. Handle the failure cases the requirement and design describe. Do not add handling for cases that cannot happen.
5. After the last task, build the project or run its type or syntax check, using the project's own command.
6. Re-read your full change once, as a reviewer would, and fix what you find.

## Output

Reply with these headings:

- **Changes**: each file created, changed or deleted, with one line on what changed.
- **Tasks completed**: the task numbers done, and any not done with the reason.
- **Build check**: the command you ran and its result.
- **Deviations**: anything you did differently from the plan or design, and why. Write "None" if there are none.
- **Notes for testing**: behavior that most needs a test.

## Limits

- Change only what the plan requires. Do not refactor, rename or reformat unrelated code.
- Do not write to the run directory. The caller records your summary.
- Do not commit, push, publish or deploy.
- If a task cannot be done as planned, stop and report why instead of improvising a different design.
```

- [ ] **Step 8: Write `catalog/agents/tester.md`**

```markdown
---
name: tester
description: Writes tests for the acceptance criteria, runs the project's test suite and reports a PASS or FAIL verdict with the failures. Use after a change is built, and again after each fix.
stage: test
access: write
model-tier: balanced
---
## Role

You find out whether the change works. You write the tests the acceptance criteria call for, run the suite and report exactly what happened.

## Inputs

- The change to test, from the caller.
- If the caller names a run directory, read `01-requirement.md` and `05-build.md` from it. On a repeat run, also read the latest `06-test.md`.
- The repository, including its existing tests and the command that runs them.

## Procedure

1. Find how the project runs tests: a script in its manifest, a task runner file, or its contributor documentation. If you cannot find a test command, stop and report that.
2. Run the existing suite first. Record failures that exist before your tests are added.
3. For each acceptance criterion, check whether a test already covers it. Where none does, write one in the project's existing test style and location.
4. Add tests for the failure cases the requirement names and for the boundaries of each input.
5. Run the full suite. Read the complete output.
6. For each failing test, record its name, the assertion or error message, and the file and line.
7. Decide the verdict. PASS only if every test passed and every acceptance criterion has a passing test.

## Output

Reply with these headings:

- **Test command**: the exact command.
- **Tests added**: each file, with the acceptance criteria it covers.
- **Result**: counts of passed, failed and skipped.
- **Failures**: each with test name, message and location. Write "None" if there are none.
- **Uncovered criteria**: acceptance criteria with no passing test, and why.

End your reply with exactly one line: `VERDICT: PASS` or `VERDICT: FAIL`.

## Limits

- Create or change test files only. Never change production code to make a test pass. Report the failure instead.
- Never weaken, skip or delete an existing test to get a passing run.
- Report the real result. Do not write PASS if you could not run the suite.
- Do not write to the run directory. The caller records your report.
```

- [ ] **Step 9: Write `catalog/agents/fixer.md`**

```markdown
---
name: fixer
description: Finds the root cause of reported test failures and makes the smallest fix. Use when tests fail after a change.
stage: fix
access: write
model-tier: balanced
---
## Role

You make failing tests pass by fixing the actual defect. You find the cause before you change anything.

## Inputs

- The failures to fix, from the caller: test names, messages and locations.
- If the caller names a run directory, read the latest `06-test.md`, `05-build.md` and `01-requirement.md` from it.
- The repository.

## Procedure

1. Reproduce one failure by running that test alone. If it does not fail, report that and stop.
2. Read the failing assertion and the code under test. Trace from the wrong result back to the line that produces it.
3. State the root cause in one sentence. If you cannot, keep investigating. Do not try changes to see what happens.
4. Decide where the defect is. If the production code is wrong, fix it there. If the test contradicts the requirement, the test is wrong: say so and fix the test, quoting the requirement.
5. Make the smallest change that removes the cause.
6. Run the failing test again, then the full suite, to confirm the fix and check nothing else broke.
7. Repeat for the remaining failures. Failures with the same cause need one fix.

## Output

Reply with these headings:

- **Fixes**: for each, the failing tests, the root cause in one sentence, and the files changed.
- **Verification**: the command you ran and the result after your fixes.
- **Unresolved**: failures you could not fix, with what you learned about each. Write "None" if there are none.

## Limits

- Fix only what the reported failures require. Do not improve nearby code.
- Do not make a test pass by deleting it, skipping it, loosening its assertion or special-casing the test in production code.
- Do not write to the run directory. The caller records your report.
- If a fix needs a design change, stop and report it instead of making that change.
```

- [ ] **Step 10: Write `catalog/agents/reviewer.md`**

```markdown
---
name: reviewer
description: Reviews a change for correctness, security and maintainability and gives an APPROVE or CHANGES_REQUESTED verdict. Use after a change passes its tests, or on any diff.
stage: review
access: read-only
model-tier: strong
---
## Role

You review a change the way a careful senior engineer would: you look for defects that would hurt users or the next developer, and you say plainly whether it is ready.

## Inputs

- The change to review, from the caller: a diff, a branch, or a list of files.
- If the caller names a run directory, read `01-requirement.md`, `03-plan.md`, `05-build.md`, `06-test.md` and, when present, `04-architecture.md` from it.
- The repository. Use the project's version control to see the full diff.

## Procedure

1. Read the whole diff before judging any part of it.
2. Read enough of the surrounding code to understand how each changed part is used.
3. Check correctness: does the change do what each requirement says? Walk through the main path and the failure paths. Look at boundaries, empty inputs and concurrent use where they apply.
4. Check security: untrusted input, authentication and authorization, secrets in code or logs, injection, unsafe file or network access.
5. Check the tests: do they exercise the behavior, or only that the code runs? Is any acceptance criterion untested?
6. Check maintainability: naming, duplication, dead code, consistency with the codebase, and anything the next reader would misunderstand.
7. Check scope: flag changes the requirement did not ask for.
8. Give each finding a severity and decide the verdict. Request changes if there is any blocker or major finding.

## Output

Reply with these headings:

- **Summary**: two or three sentences on what the change does and its overall quality.
- **Findings**: each with severity, file and line, what is wrong, and what to do. Severities are blocker (wrong or unsafe), major (likely to cause a defect or real maintenance cost), minor (worth fixing, not required) and note (observation only).
- **Requirements check**: each acceptance criterion, marked met, not met or not verifiable.

End your reply with exactly one line: `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`.

## Limits

- Do not modify any file. You report; the builder fixes.
- Report only findings you can point to in the code. No general advice.
- Do not request changes for personal style where the code follows the project's conventions.
- If you could not see the full change, say so and do not approve.
```

- [ ] **Step 11: Write `catalog/agents/release-gate.md`**

```markdown
---
name: release-gate
description: Runs a release-readiness checklist over a tested and reviewed change and gives a GO or NO_GO verdict. Use before asking a person to approve shipping.
stage: release_gate
access: read-only
model-tier: balanced
---
## Role

You are the last automated check before a person is asked to approve. You verify the evidence that the change is ready. You do not re-review the code.

## Inputs

- The change and its test and review results, from the caller.
- If the caller names a run directory, read `01-requirement.md`, `05-build.md`, the latest `06-test.md` and `07-review.md` from it.
- The repository, including its changelog, version files and release documentation.

## Procedure

Check each item and record pass, fail or not applicable, with the evidence:

1. **Tests**: the latest test report says PASS, and it was produced after the last code change.
2. **Review**: the latest review verdict is APPROVE, with no open blocker or major finding.
3. **Requirements**: every acceptance criterion is marked met.
4. **Breaking changes**: compare public interfaces before and after: exported functions, command-line options, endpoints, configuration keys, data formats. List anything removed or changed incompatibly.
5. **Version**: if the project versions its releases, state the right increment for this change (patch, minor or major) and whether the version file reflects it.
6. **Changelog and documentation**: if the project keeps a changelog or user documentation, check that user-visible changes are recorded.
7. **Leftovers**: search the diff for debugging output, commented-out code, unresolved markers and anything that looks like a secret.
8. **Working tree**: confirm there are no uncommitted or untracked files that belong to the change but were left out.

The verdict is GO only if no item fails.

## Output

Reply with these headings:

- **Checklist**: the eight items, each with pass, fail or not applicable, and its evidence.
- **Breaking changes**: the list, or "None".
- **Blocking items**: what must be done before this can ship. Write "None" if the verdict is GO.

End your reply with exactly one line: `VERDICT: GO` or `VERDICT: NO_GO`.

## Limits

- Do not modify any file, and do not fix what you find. Report it.
- Do not mark an item as passed without evidence you looked at. If you cannot check it, mark it failed and say why.
- You do not approve the release. A person does that after reading your checklist.
```

- [ ] **Step 12: Write `catalog/agents/deployer.md`**

```markdown
---
name: deployer
description: Carries out a project's documented release or deployment steps after a person has approved, and records what ran. Use only after explicit human approval.
stage: deploy
access: write
model-tier: balanced
---
## Role

You carry out the release steps the project already documents, exactly as written, and keep a record. You never invent a deployment process.

## Inputs

- Confirmation from the caller that a person approved this release, and what they approved.
- If the caller names a run directory, read `09-approval.md` and `08-release-gate.md` from it.
- The repository's release documentation: contributor or release guides, deployment scripts, pipeline configuration, task runner files.

## Procedure

1. Confirm approval. If the caller did not state that a person approved, or `09-approval.md` exists and does not record an approval, stop and report that you cannot proceed.
2. Find the documented release steps. If the project documents none, stop and report that, listing where you looked.
3. List the steps you are about to run, in order, with the exact commands, and state which of them cannot be undone.
4. Run the steps one at a time. After each, check that it succeeded before starting the next.
5. If a step fails, stop. Do not retry with different options and do not skip ahead. Report the failure and the documented rollback step, if there is one.
6. After the last step, run whatever check the documentation gives for confirming the release worked.

## Output

Reply with these headings:

- **Approval**: who approved and what, as given to you.
- **Steps run**: each command, in order, with its result.
- **Outcome**: released, failed at a named step, or not started with the reason.
- **Verification**: the check you ran and what it showed.
- **Rollback**: the documented rollback procedure, and whether you ran any of it.

## Limits

- Never run a release step without recorded human approval.
- Run only documented steps. Do not guess credentials, environments, branch names or version numbers.
- Do not force-push, delete branches or tags, or overwrite a published version unless the documented steps say so and the approval covers it.
- Do not write to the run directory. The caller records your report.
```

- [ ] **Step 13: Write `catalog/agents/feedback.md`**

```markdown
---
name: feedback
description: Writes a short retrospective of a completed run and proposes follow-up requirements. Use after a change ships or a run stops.
stage: feedback
access: read-only
model-tier: fast
---
## Role

You look back over a finished run and record what is worth knowing next time: what went well, what cost time, and what work remains.

## Inputs

- A description of the run, from the caller.
- If the caller names a run directory, read every stage file in it, and `state.md`.
- The repository, only to confirm facts the stage files mention.

## Procedure

1. Reconstruct the timeline from the stage files: which stages ran, how many times testing and fixing repeated, and whether review sent the work back.
2. Compare the result with the original requirement. Note any acceptance criterion that was dropped, changed or left unverified.
3. Identify what cost the most rework, and trace it to its origin: an unclear requirement, a missing analysis, a wrong plan, a defect in the build.
4. Collect minor review findings, notes and uncovered criteria that were left open.
5. Turn each open item, and each improvement worth making, into a follow-up requirement written so that it could start a new run.

## Output

Reply with these headings:

- **Outcome**: what shipped, or where the run stopped and why.
- **Timeline**: the stages run, with loop counts.
- **What went well**
- **What cost time**: each item with its origin.
- **Open items**: findings and criteria left unresolved.
- **Follow-up requirements**: numbered, each one or two sentences, most valuable first.

## Limits

- Do not modify any file.
- Report what the stage files show. Do not speculate about causes they do not support.
- Keep it short. Leave out anything that would not change what someone does next time.
```

- [ ] **Step 14: Run the test to verify it passes**

Run: `npx vitest run tests/content.test.js`
Expected: all pass. If "names no harness-specific tool" fails, reword the sentence in that agent to describe the capability in plain words.

- [ ] **Step 15: Check the listing, then commit**

Run: `node bin/forgeflow.js list`
Expected: 11 rows, each with its stage and access.

```bash
git add catalog/agents tests/content.test.js
git commit -m "Add the eleven flow agents"
```

---

### Task 10: The quick and full flow skills

**Files:**
- Create: `catalog/skills/forge-quick/SKILL.md`, `catalog/skills/forge-full/SKILL.md`
- Modify: `tests/content.test.js` (append)

**Interfaces:**
- Consumes: the eleven agent ids and the run-directory file names and verdict lines from Task 9; `main` from Task 8.
- Produces: `skill:forge-quick` and `skill:forge-full`, which `forgeflow add --flow quick|full` installs.
- Rule checked by test: an agent name appears in backticks in a skill body if and only if that agent is in the skill's `requires`.

- [ ] **Step 1: Append the failing tests to `tests/content.test.js`**

Add these imports at the top of the file, with the existing ones:

```js
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { main } from '../src/cli.js';
import { capture, tmpDir } from './helpers.js';
```

Add at the end of the file:

```js
const QUICK = ['requirement-analyst', 'planner', 'builder', 'tester', 'fixer', 'reviewer', 'release-gate'];
const FULL = EXPECTED.map(([name]) => name);

describe('flow skills', () => {
  it.each([
    ['forge-quick', QUICK],
    ['forge-full', FULL],
  ])('%s requires exactly the agents it names', (name, expected) => {
    const flow = catalog.get(`skill:${name}`);
    expect(flow.userInvocableOnly).toBe(true);
    expect([...flow.requires].sort()).toEqual(expected.map((agent) => `agent:${agent}`).sort());

    const named = agents.map((agent) => agent.name).filter((agent) => flow.body.includes(`\`${agent}\``));
    expect(named.sort()).toEqual([...expected].sort());
  });

  it.each(['forge-quick', 'forge-full'])('%s states the control rules', (name) => {
    const { body } = catalog.get(`skill:${name}`);
    expect(body).toContain('at most 3 fix attempts');
    expect(body).toContain('at most 2 times');
    expect(body).toContain('VERDICT: NO_GO');
    expect(body).toContain('09-approval.md');
    expect(body).toContain('state.md');
    expect(body).toMatch(/forgeflow add/);
    expect(body).not.toMatch(HARNESS_TOOL);
  });

  it('forge-full runs the twelve stages in order', () => {
    const { body } = catalog.get('skill:forge-full');
    const stages = [
      'REQUIREMENT',
      'ANALYZE',
      'PLAN',
      'ARCHITECT',
      'BUILD',
      'TEST',
      'FIX',
      'REVIEW',
      'RELEASE_GATE',
      'HUMAN_APPROVAL',
      'DEPLOY',
      'FEEDBACK',
    ];
    const positions = stages.map((stage) => body.indexOf(`**${stage}**`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('forge-quick runs the six phases in order and does not deploy', () => {
    const { body } = catalog.get('skill:forge-quick');
    const positions = ['DEFINE', 'PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SHIP'].map((phase) =>
      body.indexOf(`**${phase}**`)
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(body).toContain('does not deploy');
  });
});

describe('installing the real catalog', () => {
  const install = (flow, targets) => {
    const cwd = tmpDir();
    const io = { cwd, home: tmpDir(), stdout: capture(), stderr: capture() };
    const code = main(['add', '--flow', flow, '--target', targets], io);
    return { cwd, code, err: io.stderr.text };
  };

  it('installs the full flow into all four harnesses', () => {
    const { cwd, code, err } = install('full', 'claude,codex,opencode,cursor');
    expect(err).toBe('');
    expect(code).toBe(0);

    for (const dir of ['.claude/agents', '.codex/agents', '.opencode/agents', '.cursor/agents']) {
      expect(readdirSync(join(cwd, dir)), dir).toHaveLength(11);
    }
    for (const dir of ['.claude/skills', '.agents/skills', '.opencode/skills', '.cursor/skills']) {
      expect(existsSync(join(cwd, dir, 'forge-full/SKILL.md')), dir).toBe(true);
    }
    for (const file of readdirSync(join(cwd, '.codex/agents'))) {
      const parsed = parseToml(readFileSync(join(cwd, '.codex/agents', file), 'utf8'));
      expect(parsed.name, file).toBe(file.replace(/\.toml$/, ''));
      expect(parsed.developer_instructions, file).toContain('## Role');
    }
  });

  it('installs only the seven quick-flow agents for the quick flow', () => {
    const { cwd, code } = install('quick', 'cursor');
    expect(code).toBe(0);
    expect(readdirSync(join(cwd, '.cursor/agents')).sort()).toEqual(QUICK.map((name) => `${name}.md`).sort());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/content.test.js`
Expected: the new tests FAIL (`skill:forge-quick` is undefined; `add --flow` exits 2); Task 9's tests still pass.

- [ ] **Step 3: Write `catalog/skills/forge-full/SKILL.md`**

```markdown
---
name: forge-full
description: Run the forgeflow full flow for a larger or riskier change - REQUIREMENT, ANALYZE, PLAN, ARCHITECT, BUILD, TEST and FIX, REVIEW, RELEASE_GATE, HUMAN_APPROVAL, DEPLOY, FEEDBACK. Use when the user asks to run the full forge flow.
user-invocable-only: true
requires:
  - agent:requirement-analyst
  - agent:analyzer
  - agent:planner
  - agent:architect
  - agent:builder
  - agent:tester
  - agent:fixer
  - agent:reviewer
  - agent:release-gate
  - agent:deployer
  - agent:feedback
---
# forgeflow: full flow

You are the orchestrator. You run twelve stages in order. For each stage you delegate the work to the named subagent, save what it returns, and decide what happens next. You do not do a stage's work yourself.

## Before you start

1. Take the user's request from their message. If they gave no request, ask for it and wait.
2. If the user pointed you at an existing run directory, read its `state.md` and continue from the stage it names. Otherwise create a new run directory at `.forgeflow/runs/<YYYYMMDD-HHMM>-<slug>/`, where the slug is two to four lowercase words from the request joined by hyphens.
3. Save the request, word for word, as `00-request.md` in the run directory.
4. Create `state.md` as described under "Keeping state".
5. Tell the user the run directory path, and that committing it or ignoring it in version control is their choice.

## How to run a stage

1. Delegate to the stage's subagent. Give it the run directory path and anything the stage row says to pass.
2. Save the subagent's full reply to the stage's file in the run directory. Subagents do not write these files; you do.
3. Update `state.md`.
4. Tell the user in one or two lines what the stage produced.
5. Apply the control rules below before starting the next stage.

If a subagent named here is not available, stop and tell the user to install the flow with `forgeflow add --flow full --target <their harness>`.

## Stages

1. **REQUIREMENT**: delegate to `requirement-analyst`. Save as `01-requirement.md`.
2. **ANALYZE**: delegate to `analyzer`. Save as `02-analysis.md`.
3. **PLAN**: delegate to `planner`. Save as `03-plan.md`.
4. **ARCHITECT**: delegate to `architect`. Save as `04-architecture.md`. If it lists plan adjustments, send them to `planner` and replace `03-plan.md` with the revised plan.
5. **BUILD**: delegate to `builder`. Save as `05-build.md`.
6. **TEST**: delegate to `tester`. Save as `06-test.md`.
7. **FIX**: only when the test verdict is FAIL. Delegate to `fixer` with the failures, append its reply to `06-test.md`, then run TEST again.
8. **REVIEW**: delegate to `reviewer`. Save as `07-review.md`.
9. **RELEASE_GATE**: delegate to `release-gate`. Save as `08-release-gate.md`.
10. **HUMAN_APPROVAL**: you do this yourself, with the user. See rule 5.
11. **DEPLOY**: delegate to `deployer`, telling it who approved and what. Save as `10-deploy.md`.
12. **FEEDBACK**: delegate to `feedback`. Save as `11-feedback.md`, then show the user its outcome and follow-up requirements.

## Control rules

1. **Open questions.** If REQUIREMENT returns open questions, put them to the user and wait. Add the answers to `01-requirement.md` before ANALYZE.
2. **Test and fix loop.** While the tester's last line is `VERDICT: FAIL`, run FIX then TEST again, with at most 3 fix attempts. If the tests still fail after the third, stop the flow and report the remaining failures to the user.
3. **Review loop.** If the reviewer's last line is `VERDICT: CHANGES_REQUESTED`, return to BUILD with the findings, then run TEST and REVIEW again. Do this at most 2 times. If changes are requested a third time, stop the flow and report the open findings.
4. **Release gate.** If the last line is `VERDICT: NO_GO`, stop the flow and report the blocking items. Do not ask for approval.
5. **Human approval.** Show the user: the change summary from `05-build.md`, the test result, the review verdict with any open minor findings, and the release-gate checklist. Ask plainly whether they approve deploying. Then stop and wait for their reply. Continue only if they explicitly approve in this conversation. Save their decision, in their words, with the date, as `09-approval.md`. If they decline or ask for changes, record that, stop the flow, and say what they asked for. Silence, an unrelated reply, or an earlier general go-ahead is not approval.
6. **Deploy.** Nothing in DEPLOY may run unless `09-approval.md` records an approval. If the `deployer` reports that the project documents no release steps, stop and ask the user what deploying means for this project.
7. **Stopping.** Whenever the flow stops early, update `state.md`, tell the user which stage stopped and why, and say that the run can be resumed from its run directory. Then run FEEDBACK if at least BUILD completed.

## Keeping state

`state.md` holds, one per line:

- `mode: full`
- `request:` the first line of the request
- `current stage:` the stage in progress or about to start
- `fix attempts:` a number, starting at 0
- `review returns:` a number, starting at 0
- `stages:` a list of each finished stage with its result, for example `test: FAIL`, `review: APPROVE`
- `status:` `running`, `waiting for user`, `stopped: <reason>` or `complete`

Rewrite it after every stage, so a new session or another tool can pick the run up from this file alone.
```

- [ ] **Step 4: Write `catalog/skills/forge-quick/SKILL.md`**

```markdown
---
name: forge-quick
description: Run the forgeflow quick flow for an everyday change - DEFINE, PLAN, BUILD, VERIFY, REVIEW, SHIP. Use when the user asks to run the quick forge flow.
user-invocable-only: true
requires:
  - agent:requirement-analyst
  - agent:planner
  - agent:builder
  - agent:tester
  - agent:fixer
  - agent:reviewer
  - agent:release-gate
---
# forgeflow: quick flow

You are the orchestrator. You run six phases in order. For each phase you delegate the work to the named subagent, save what it returns, and decide what happens next. You do not do a phase's work yourself.

The quick flow ends with a reviewed, checked change that the user has confirmed. It does not deploy. For larger or riskier work, or when a release must be carried out, tell the user the full flow exists.

## Before you start

1. Take the user's request from their message. If they gave no request, ask for it and wait.
2. If the user pointed you at an existing run directory, read its `state.md` and continue from the phase it names. Otherwise create a new run directory at `.forgeflow/runs/<YYYYMMDD-HHMM>-<slug>/`, where the slug is two to four lowercase words from the request joined by hyphens.
3. Save the request, word for word, as `00-request.md` in the run directory.
4. Create `state.md` as described under "Keeping state".
5. Tell the user the run directory path, and that committing it or ignoring it in version control is their choice.

## How to run a phase

1. Delegate to the phase's subagent. Give it the run directory path and anything the phase row says to pass.
2. Save the subagent's full reply to the phase's file in the run directory. Subagents do not write these files; you do.
3. Update `state.md`.
4. Tell the user in one or two lines what the phase produced.
5. Apply the control rules below before starting the next phase.

If a subagent named here is not available, stop and tell the user to install the flow with `forgeflow add --flow quick --target <their harness>`.

## Phases

1. **DEFINE**: delegate to `requirement-analyst`. Save as `01-requirement.md`.
2. **PLAN**: delegate to `planner`. Save as `03-plan.md`.
3. **BUILD**: delegate to `builder`. Save as `05-build.md`.
4. **VERIFY**: delegate to `tester`. Save as `06-test.md`. When the verdict is FAIL, delegate to `fixer` with the failures, append its reply to `06-test.md`, then delegate to `tester` again.
5. **REVIEW**: delegate to `reviewer`. Save as `07-review.md`.
6. **SHIP**: delegate to `release-gate`. Save as `08-release-gate.md`. Then confirm with the user as rule 5 describes.

## Control rules

1. **Open questions.** If DEFINE returns open questions, put them to the user and wait. Add the answers to `01-requirement.md` before PLAN.
2. **Test and fix loop.** While the tester's last line is `VERDICT: FAIL`, fix then test again, with at most 3 fix attempts. If the tests still fail after the third, stop the flow and report the remaining failures to the user.
3. **Review loop.** If the reviewer's last line is `VERDICT: CHANGES_REQUESTED`, return to BUILD with the findings, then run VERIFY and REVIEW again. Do this at most 2 times. If changes are requested a third time, stop the flow and report the open findings.
4. **Release gate.** If the last line is `VERDICT: NO_GO`, stop the flow and report the blocking items. Do not ask for confirmation.
5. **Human confirmation.** Show the user: the change summary from `05-build.md`, the test result, the review verdict with any open minor findings, and the release-gate checklist. Ask plainly whether they accept the change. Then stop and wait for their reply. Save their decision, in their words, with the date, as `09-approval.md`. Silence, an unrelated reply, or an earlier general go-ahead is not confirmation.
6. **After confirmation.** Do not commit, push, merge, publish or deploy as part of this flow. If the user wants any of those, they will ask, and that is a separate request.
7. **Stopping.** Whenever the flow stops early, update `state.md`, tell the user which phase stopped and why, and say that the run can be resumed from its run directory.

## Keeping state

`state.md` holds, one per line:

- `mode: quick`
- `request:` the first line of the request
- `current stage:` the phase in progress or about to start
- `fix attempts:` a number, starting at 0
- `review returns:` a number, starting at 0
- `stages:` a list of each finished phase with its result, for example `verify: FAIL`, `review: APPROVE`
- `status:` `running`, `waiting for user`, `stopped: <reason>` or `complete`

Rewrite it after every phase, so a new session or another tool can pick the run up from this file alone.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/content.test.js`
Expected: all pass. The "requires exactly the agents it names" test fails if a skill body puts an agent name in backticks that its `requires` omits: `forge-quick` must not name `analyzer`, `architect`, `deployer` or `feedback` in backticks.

- [ ] **Step 6: Try the real CLI in a scratch directory**

```bash
SCRATCH=$(mktemp -d) && (cd "$SCRATCH" && node /home/hkumar/Documents/ADLC/forgeflow/bin/forgeflow.js add --flow quick --target claude,cursor && node /home/hkumar/Documents/ADLC/forgeflow/bin/forgeflow.js status && node /home/hkumar/Documents/ADLC/forgeflow/bin/forgeflow.js remove forge-quick --target claude,cursor && ls -A)
```

Expected: `add` lists 8 `create` lines per target; `status` lists 8 items per target, 7 marked `(required)`; `remove` lists 8 `delete` lines per target; the final `ls -A` prints only `.forgeflow` (an empty directory).

- [ ] **Step 7: Commit**

```bash
git add catalog/skills tests/content.test.js
git commit -m "Add quick and full flow skills"
```

---

### Task 11: README, verification checklist and final checks

**Files:**
- Create: `README.md`, `docs/verification.md`

**Interfaces:**
- Consumes: the finished CLI and catalog.
- Produces: user documentation, and the manual per-harness check the spec requires before the first internal release.

- [ ] **Step 1: Write `README.md`**

````markdown
# forgeflow

Ready-to-use coding agents and development flows for Claude Code, Codex, OpenCode and Cursor.

Each agent is written once and compiled into the native format of the harness you use. Install one agent, or a whole flow.

forgeflow does not call a model. Your harness runs the agents; forgeflow only installs their definitions.

## Install

Needs Node 20 or newer.

```bash
git clone <repository-url> forgeflow
cd forgeflow && npm install && npm link    # puts `forgeflow` on your PATH
```

## Use

Run these from the root of the project you want the agents in.

```bash
forgeflow list                                   # what is available
forgeflow add reviewer --target cursor           # one agent
forgeflow add --flow quick --target claude       # a flow and the agents it needs
forgeflow add --flow full --target claude,codex  # several harnesses at once
forgeflow status                                 # what is installed here
forgeflow update                                 # rewrite installed files from the current catalog
forgeflow remove reviewer --target cursor
```

| Option | Meaning |
|---|---|
| `--target` | `claude`, `codex`, `opencode` or `cursor`. Required for `add` and `remove`. Separate several with commas. |
| `--global` | Install for your user account instead of the current project. |
| `--dry-run` | Show what would change and write nothing. |
| `--force` | Overwrite or delete files that you edited or that forgeflow did not install. |

forgeflow treats the directory you run it in as the project root.

## The flows

After installing a flow, start it inside your harness.

| Flow | Stages | Start it with |
|---|---|---|
| `forge-quick` | DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP | `/forge-quick <request>` |
| `forge-full` | REQUIREMENT → ANALYZE → PLAN → ARCHITECT → BUILD → TEST ⇄ FIX → REVIEW → RELEASE_GATE → HUMAN_APPROVAL → DEPLOY → FEEDBACK | `/forge-full <request>` |

In Codex, start a flow by naming the skill: `$forge-quick <request>`.

The quick flow ends with a reviewed change you have confirmed; it does not deploy. The full flow stops at HUMAN_APPROVAL and continues to DEPLOY only when you approve in the conversation.

Each run keeps its stage outputs in `.forgeflow/runs/<date>-<slug>/`. Point a flow at that directory to resume a run in a new session or a different harness.

In this version the gates are instructions to the model. They are not enforced by hooks.

## The agents

| Agent | Stage | Can change files |
|---|---|---|
| `requirement-analyst` | REQUIREMENT | no |
| `analyzer` | ANALYZE | no |
| `planner` | PLAN | no |
| `architect` | ARCHITECT | no |
| `builder` | BUILD | yes |
| `tester` | TEST | yes (tests only) |
| `fixer` | FIX | yes |
| `reviewer` | REVIEW | no |
| `release-gate` | RELEASE_GATE | no |
| `deployer` | DEPLOY | yes |
| `feedback` | FEEDBACK | no |

Every agent also works on its own, outside a flow.

## Where files go

| Target | Agents | Skills |
|---|---|---|
| `claude` | `.claude/agents/` | `.claude/skills/` |
| `codex` | `.codex/agents/` | `.agents/skills/` |
| `opencode` | `.opencode/agents/` | `.opencode/skills/` |
| `cursor` | `.cursor/agents/` | `.cursor/skills/` |

With `--global` these live under your home directory (`~/.config/opencode/` for OpenCode).

forgeflow records what it installed in `.forgeflow/lock.json`. It never overwrites or deletes a file you edited unless you pass `--force`. Commit the lockfile if your team shares the installed agents.

## Adding to the catalog

- An agent is one file, `catalog/agents/<name>.md`.
- A skill is a folder, `catalog/skills/<name>/SKILL.md`.

The frontmatter fields are described in `docs/superpowers/specs/2026-10-13-forgeflow-core-design.md`, section 4. Run `forgeflow doctor` to validate the catalog, and `npm test` before committing.

To support another harness, add `src/adapters/<name>.js` exporting `name`, `root` and `render`, and register it in `src/adapters/index.js`.

## Development

```bash
npm test          # run the tests
npm run lint      # oxlint
npm run format    # prettier
```
````

- [ ] **Step 2: Write `docs/verification.md`**

```markdown
# Manual verification per harness

The automated tests prove that forgeflow writes well-formed files. They cannot prove that each harness loads them. Do this check once per harness before the first internal release, and again when a harness changes its agent or skill format.

Record the harness version and the date beside each result.

## Setup

In an empty scratch repository that has at least one source file and a working test command:

    forgeflow add --flow full --target <harness>

## Checks

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 1 | The harness starts with no warning about the installed files | | | | |
| 2 | All 11 agents appear in the harness's agent list | | | | |
| 3 | `forge-full` and, after installing it, `forge-quick` can be started explicitly | | | | |
| 4 | Asking "use the reviewer agent on the last commit" runs `reviewer` as a subagent | | | | |
| 5 | `reviewer`, asked to edit a file, does not edit it | | | | |
| 6 | `builder`, asked to make a small change, edits the file | | | | |
| 7 | A quick-flow run creates `.forgeflow/runs/<run>/` with `state.md` and the stage files | | | | |
| 8 | A full-flow run stops at HUMAN_APPROVAL and waits | | | | |
| 9 | Declining at HUMAN_APPROVAL stops the run before DEPLOY | | | | |
| 10 | `forgeflow remove forge-full --target <harness>` leaves no forgeflow file behind | | | | |

How to list agents: `/agents` in Claude Code; `/agent` in Codex; `@` completion in OpenCode; the subagent picker in Cursor.

## Known differences between harnesses

- Model selection is set only for Claude Code. Elsewhere agents use the session's model.
- On Claude Code, read-only agents can still run shell commands, so check 5 relies on the agent's instructions there. On Codex, OpenCode and Cursor the harness enforces it.
- In Codex, flows are started with `$forge-quick`, not `/forge-quick`.

If a check fails, record what the harness did, and compare the installed file with that harness's current documentation before changing an adapter.
```

- [ ] **Step 3: Format, lint and run everything**

Run: `npm run format && npm run lint && npm test`
Expected: prettier rewrites files in `src/`, `tests/` and `bin/` only (`catalog/` and `docs/` are ignored); oxlint reports 0 errors; every test passes.

- [ ] **Step 4: Run doctor against the real catalog**

Run: `node bin/forgeflow.js doctor; echo "exit=$?"`
Expected: four `ok` lines, including `catalog is valid (13 items)`, then `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add README and manual verification checklist"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| 2. Success criteria 1–2 (valid native files, flows install) | 4, 7, 10 |
| 2. Success criteria 3–4 (exact remove, no silent overwrite) | 5, 6, 7 |
| 2. Success criterion 5 (fifth harness = one adapter + one line) | 4 (`src/adapters/index.js`) |
| 2. Success criterion 6 (tests need no harness) | every task |
| 3. Architecture and layout | 1–8 |
| 4. Canonical format and validation | 1, 2 |
| 5. Adapters, paths, field mapping, marker | 4 |
| 6. Lockfile, planning, safety | 5, 6, 7 |
| 7. CLI and exit codes | 8 |
| 8. Agents, run directory, flow skills, control rules | 9, 10 |
| 9. Error handling | 2, 5, 6, 7, 8 |
| 10. Testing, including the manual harness check | every task; 11 (`docs/verification.md`) |
