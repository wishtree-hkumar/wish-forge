# forgeflow Rules Packs Implementation Plan (phase 3b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `rule` catalog type with ten rules packs that reach the model on all four harnesses, and a `standards-reviewer` agent that checks a change against the installed packs and joins the flows at REVIEW.

**Architecture:** A rule is one catalog file rendered by each adapter into that harness's own rules mechanism: native rule files for Claude Code and Cursor, a marked pointer block in `AGENTS.md` for Codex, and one `instructions` entry in `opencode.json` for OpenCode. The two edits to user-owned files go through one small pure module (`src/rules-wiring.js`) and one planner function, recorded per target in the lockfile. Placeholders are extended to agent bodies so the reviewer looks only in its own harness's folder.

**Tech Stack:** Node 20+ ESM JavaScript, `yaml` (only runtime dependency), `vitest`, `oxlint`, `prettier`, `smol-toml` (dev).

**Spec:** `docs/superpowers/specs/2026-10-13-forgeflow-rules-design.md`

## Global Constraints

- Node 20+, ESM, no new runtime or dev dependency.
- Commit messages are a plain subject plus optional body. Never add `Co-Authored-By` or any other trailer.
- Rule file paths: Claude Code `.claude/rules/forgeflow/<name>.md`; Cursor `.cursor/rules/forgeflow-<name>.mdc`; Codex `.codex/forgeflow/rules/<name>.md`; OpenCode `.opencode/forgeflow/rules/<name>.md` (no `.opencode/` prefix at global scope).
- Markers are exactly `<!-- forgeflow:rules:start -->` and `<!-- forgeflow:rules:end -->`.
- OpenCode entry: `.opencode/forgeflow/rules/*.md` (project), `~/.config/opencode/forgeflow/rules/*.md` (global).
- forgeflow never changes text outside its markers in `AGENTS.md`, and never changes anything in `opencode.json` except its own `instructions` entry.
- A damaged or unparsable user file is a `ConfigError` raised while planning, before any file for any target is written. `--force` does not override it.
- Every rule pack body is at most 6,000 bytes, starts with one `# ` heading, and names no harness-specific tool.
- Placeholders are exactly `{{agents-dir}}`, `{{global-agents-dir}}` and `{{rules-location}}`, filled in agent and skill bodies only.
- Review specialists, in flow order: `security-reviewer`, `performance-reviewer`, `database-reviewer`, `accessibility-reviewer`, `standards-reviewer`.
- Run `npx vitest run` (whole suite) before each commit; it must be green.
- `catalog/**/*.md` and `docs/` are not formatted by prettier; everything else is.

## Review Focus

Inputs the spec implies and a person is likely to hit. Each has a test in the task named.

1. An `AGENTS.md` the user already wrote, with or without a trailing newline, with CRLF line endings, or starting with a byte-order mark: every byte outside the block must survive add and remove. (Task 4)
2. An `AGENTS.md` whose markers were damaged by a hand edit (one marker deleted, duplicated, or reordered): refused, nothing written for any target. (Tasks 4 and 5)
3. An `AGENTS.md` that is a symbolic link to another instructions file: the link must survive and its target must be edited. (Task 5)
4. An OpenCode project whose config is `opencode.jsonc`, or an `opencode.json` with comments: refused with the line to add, and accepted on the next run once the user has added it. (Task 5)
5. A project with rules installed for Codex and OpenCode together, then one rule removed: the Codex block shrinks, the OpenCode entry stays, and removing the last rule restores both files. (Task 5)

---

### Task 1: The `rule` catalog type

**Files:**
- Modify: `src/catalog.js`, `src/resolve.js`, `src/cli.js`, `tests/helpers.js`
- Test: `tests/rule-catalog.test.js` (create)

**Interfaces:**
- Consumes: `loadCatalog(dir)`, `findId(catalog, ref)`, `main(argv, io)`.
- Produces:
  - Catalog items of type `rule` with id `rule:<name>`, loaded from `rules/<name>.md`, carrying `paths` (array of strings, or `undefined` for "all work").
  - Test helper `ruleMd(name, extra = '')` in `tests/helpers.js`.
  - `forgeflow list --type rule`; `paths` in `list --json` and `info`.

- [ ] **Step 1: Add the test helper to `tests/helpers.js`**

Add after `skillMd`:

```js
export function ruleMd(name, extra = '') {
  return `---\nname: ${name}\ndescription: ${name} standards.\n${extra}---\n# ${name}\n\n- A rule of ${name}.\n`;
}
```

- [ ] **Step 2: Write `tests/rule-catalog.test.js`**

`tests/rule-catalog.test.js`:

```js
import { beforeEach, describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { CatalogError, UsageError } from '../src/errors.js';
import { findId } from '../src/resolve.js';
import { agentMd, capture, ruleMd, tmpDir, writeTree } from './helpers.js';

const load = (tree) => loadCatalog(writeTree(tmpDir(), tree));
const TS = ruleMd('ts', 'paths:\n  - "**/*.ts"\n  - "**/*.tsx"\n');

describe('rule items', () => {
  it('load from rules/ with their paths', () => {
    const catalog = load({ 'rules/ts.md': TS, 'rules/common.md': ruleMd('common') });
    expect(catalog.get('rule:ts')).toMatchObject({
      id: 'rule:ts',
      type: 'rule',
      name: 'ts',
      description: 'ts standards.',
      paths: ['**/*.ts', '**/*.tsx'],
      requires: [],
      body: '# ts\n\n- A rule of ts.',
      source: 'rules/ts.md',
    });
    expect(catalog.get('rule:common').paths).toBeUndefined();
  });

  it.each([
    ['an empty list', 'paths: []\n'],
    ['a string', 'paths: "**/*.ts"\n'],
    ['a list holding a number', 'paths: [1]\n'],
    ['a list holding an empty string', 'paths: [""]\n'],
  ])('reject paths that is %s', (_case, extra) => {
    const attempt = () => load({ 'rules/ts.md': ruleMd('ts', extra) });
    expect(attempt).toThrow(CatalogError);
    expect(attempt).toThrow(
      'rules/ts.md: field "paths" must be a non-empty list of file patterns'
    );
  });

  it('reject agent fields and a name that differs from the file', () => {
    expect(() => load({ 'rules/ts.md': ruleMd('ts', 'access: read-only\n') })).toThrow(
      'unknown field "access" (allowed: name, description, paths, requires)'
    );
    expect(() => load({ 'rules/ts.md': ruleMd('js') })).toThrow(
      'field "name" (js) must equal the file name (ts)'
    );
  });

  it('do not have their bodies checked for placeholders', () => {
    const text = ruleMd('ts').replace('- A rule of ts.', '- Write `{{ value }}` in templates.');
    expect(load({ 'rules/ts.md': text }).get('rule:ts').body).toContain('{{ value }}');
  });
});

describe('finding a rule by name', () => {
  it('resolves a bare name to the rule', () => {
    expect(findId(load({ 'rules/ts.md': TS }), 'ts')).toBe('rule:ts');
  });

  it('is ambiguous when an agent has the same name', () => {
    const catalog = load({ 'rules/ts.md': TS, 'agents/ts.md': agentMd('ts') });
    expect(() => findId(catalog, 'ts')).toThrow(UsageError);
    expect(() => findId(catalog, 'ts')).toThrow('"ts" is ambiguous: use agent:ts or rule:ts.');
  });
});

describe('cli', () => {
  let catalogDir;
  const run = (...argv) => {
    const stdout = capture();
    const stderr = capture();
    const io = { cwd: tmpDir(), home: tmpDir(), stdout, stderr, catalogDir };
    return { code: main(argv, io), out: stdout.text, err: stderr.text };
  };

  beforeEach(() => {
    catalogDir = writeTree(tmpDir(), {
      'agents/alpha.md': agentMd('alpha', 'stage: review\n'),
      'rules/common.md': ruleMd('common'),
      'rules/ts.md': TS,
    });
  });

  it('lists rules with the rule label', () => {
    const lines = run('list').out.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/^rule:ts\s+rule\s+-\s+ts standards\.$/);
  });

  it('filters to rules and shows paths in JSON', () => {
    const rows = JSON.parse(run('list', '--type', 'rule', '--json').out);
    expect(rows.map((row) => row.id)).toEqual(['rule:common', 'rule:ts']);
    expect(rows[1].paths).toEqual(['**/*.ts', '**/*.tsx']);
    expect('paths' in rows[0]).toBe(false);
  });

  it('shows what a rule applies to in info', () => {
    expect(run('info', 'ts').out).toMatch(/^paths:\s+\*\*\/\*\.ts, \*\*\/\*\.tsx$/m);
    expect(run('info', 'common').out).toMatch(/^paths:\s+all work$/m);
    expect(run('info', 'alpha').out).not.toContain('paths');
  });

  it('offers rule as a type in the usage text and the error', () => {
    expect(run('--help').out).toContain('--type agent|skill|hook|rule');
    expect(run('list', '--type', 'bogus').err).toContain('agent, skill, hook, rule');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/rule-catalog.test.js`
Expected: FAIL. `catalog.get('rule:ts')` is `undefined` (the `rules/` folder is not read), `findId` throws `unknown item "ts"`, and the CLI tests fail on the missing lines.

- [ ] **Step 4: Load rules in `src/catalog.js`**

Add to `FIELDS`, after the `agent` entry:

```js
  rule: ['name', 'description', 'paths', 'requires'],
```

In `buildItem`, change the line that picks the container word to:

```js
    const container = type === 'agent' || type === 'rule' ? 'file' : 'folder';
```

In `buildItem`, add a branch after the `else if (type === 'hook') { … }` block:

```js
  } else if (type === 'rule') {
    const { paths } = data;
    if (paths !== undefined) {
      const valid =
        Array.isArray(paths) &&
        paths.length > 0 &&
        paths.every((pattern) => typeof pattern === 'string' && pattern.trim() !== '');
      if (!valid) fail(source, 'field "paths" must be a non-empty list of file patterns');
      // Absent means the rule applies to all work.
      item.paths = [...paths];
    }
  }
```

In `loadCatalog`, replace the block that reads `agents/` (from `const agentsDir = …` to the end of its `if`) with:

```js
  // Agents and rules are single files; the file name is the item name.
  for (const [type, kind] of [
    ['agent', 'agents'],
    ['rule', 'rules'],
  ]) {
    const folder = join(dir, kind);
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder).sort()) {
      if (!file.endsWith('.md')) continue;
      const text = readFileSync(join(folder, file), 'utf8');
      const item = buildItem(type, file.slice(0, -3), text, `${kind}/${file}`);
      items.set(item.id, item);
    }
  }
```

- [ ] **Step 5: Resolve rule names in `src/resolve.js`**

Change `TYPES` to:

```js
const TYPES = ['agent', 'skill', 'hook', 'rule'];
```

- [ ] **Step 6: List and describe rules in `src/cli.js`**

Change `LISTED_TYPES` to:

```js
const LISTED_TYPES = ['agent', 'skill', 'hook', 'rule'];
```

In `USAGE`, change the first line to `  forgeflow list [--type agent|skill|hook|rule] [--json]`, and add after the `--specialists installs…` line:

```
A rule is a pack of coding standards, such as "common" or "typescript".
```

In the `list` case, add `paths` to the JSON row (in the destructuring and in the object, after `events`), and replace the line that sets `none` with:

```js
          const none = { agent: 'specialist', rule: 'rule' }[item.type] ?? '-';
```

In the `info` case, add after the `['events', …]` row:

```js
        ['paths', item.type === 'rule' ? (item.paths?.join(', ') ?? 'all work') : undefined],
```

- [ ] **Step 7: Run the test, then the suite**

Run: `npx vitest run tests/rule-catalog.test.js`
Expected: PASS, 13 tests.

Run: `npx vitest run`
Expected: PASS, no failures.

- [ ] **Step 8: Commit**

```bash
npx prettier --write src tests
git add src tests
git commit -m "Add the rule catalog type"
```

---

### Task 2: Render rules for each harness

**Files:**
- Modify: `src/adapters/shared.js`, `src/adapters/claude.js`, `src/adapters/codex.js`, `src/adapters/cursor.js`, `src/adapters/opencode.js`, `src/ops.js`
- Test: `tests/rule-adapters.test.js` (create)

**Interfaces:**
- Consumes: rule items (Task 1), `marker(item, version)`, test helper `ruleMd`.
- Produces:
  - `appliesTo(item) → string` in `src/adapters/shared.js`: `'all work'` or ``'files matching `a`, `b`'``.
  - `ruleFile(path, item, version, { frontmatter = '', header = '' })` in `src/adapters/shared.js`.
  - Every adapter renders `type: 'rule'` and exports `rulesLocation` (a string).
  - `cursor.globalRules === false`; `ops.install` refuses a rule for such a target at global scope.

- [ ] **Step 1: Write `tests/rule-adapters.test.js`**

`tests/rule-adapters.test.js`:

```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as cursor from '../src/adapters/cursor.js';
import * as opencode from '../src/adapters/opencode.js';
import { appliesTo } from '../src/adapters/shared.js';
import { main } from '../src/cli.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { capture, ruleMd, tmpDir, writeTree } from './helpers.js';

const project = { scope: 'project', version: '0.1.0' };
const global = { scope: 'global', version: '0.1.0' };
const BODY = '# TypeScript\n\n- Prefer `unknown` to `any`.';
const scoped = {
  id: 'rule:ts',
  type: 'rule',
  name: 'ts',
  description: 'TypeScript: standards',
  paths: ['**/*.ts', '**/*.tsx'],
  requires: [],
  body: BODY,
  files: [],
};
const always = { ...scoped, id: 'rule:common', name: 'common', paths: undefined };
const MARK = '\n\n<!-- managed by forgeflow: rule:ts@0.1.0 -->\n';

describe('appliesTo', () => {
  it('describes patterns, or all work', () => {
    expect(appliesTo(scoped)).toBe('files matching `**/*.ts`, `**/*.tsx`');
    expect(appliesTo(always)).toBe('all work');
  });
});

describe('claude', () => {
  it('writes a scoped rule into its own subfolder with a paths list', () => {
    const [file, ...rest] = claude.render(scoped, project);
    expect(rest).toEqual([]);
    expect(file.path).toBe('.claude/rules/forgeflow/ts.md');
    const { data, body } = parseFrontmatter(file.content);
    expect(data).toEqual({ paths: ['**/*.ts', '**/*.tsx'] });
    expect(body.startsWith(BODY)).toBe(true);
    expect(file.content.endsWith(MARK)).toBe(true);
  });

  it('writes an always-on rule with no frontmatter at all', () => {
    const [file] = claude.render(always, project);
    expect(file.path).toBe('.claude/rules/forgeflow/common.md');
    expect(file.content).toBe(
      `${BODY}\n\n<!-- managed by forgeflow: rule:common@0.1.0 -->\n`
    );
  });

  it('uses the same relative path at global scope', () => {
    expect(claude.render(scoped, global)[0].path).toBe('.claude/rules/forgeflow/ts.md');
  });
});

describe('cursor', () => {
  it('writes a scoped rule as .mdc with bare comma-separated globs', () => {
    const [file] = cursor.render(scoped, project);
    expect(file.path).toBe('.cursor/rules/forgeflow-ts.mdc');
    expect(file.content).toBe(
      '---\n' +
        'description: "TypeScript: standards"\n' +
        'globs: **/*.ts, **/*.tsx\n' +
        'alwaysApply: false\n' +
        `---\n\n${BODY}${MARK}`
    );
  });

  it('marks a rule without paths as always applied, with no globs line', () => {
    const { content } = cursor.render(always, project)[0];
    expect(content).toContain('alwaysApply: true\n');
    expect(content).not.toContain('globs');
  });

  it('declares that it has no user-level rule files', () => {
    expect(cursor.globalRules).toBe(false);
  });
});

describe('codex', () => {
  it('writes the rule beside the gates, starting with what it applies to', () => {
    const [file] = codex.render(scoped, project);
    expect(file.path).toBe('.codex/forgeflow/rules/ts.md');
    expect(file.content).toBe(
      `Applies to: files matching \`**/*.ts\`, \`**/*.tsx\`.\n\n${BODY}${MARK}`
    );
  });

  it('says all work for a rule without paths', () => {
    expect(codex.render(always, project)[0].content.startsWith('Applies to: all work.\n\n')).toBe(
      true
    );
  });
});

describe('opencode', () => {
  it('writes the rule under .opencode in a project', () => {
    const [file] = opencode.render(scoped, project);
    expect(file.path).toBe('.opencode/forgeflow/rules/ts.md');
    expect(file.content).toBe(
      `Applies to: files matching \`**/*.ts\`, \`**/*.tsx\`.\n\n${BODY}${MARK}`
    );
  });

  it('drops the .opencode prefix under the global config directory', () => {
    expect(opencode.render(scoped, global)[0].path).toBe('forgeflow/rules/ts.md');
  });
});

describe('rulesLocation', () => {
  it.each([
    [claude, '`.claude/rules/forgeflow` in the project and `~/.claude/rules/forgeflow`'],
    [cursor, '`.cursor/rules` in the project (the files named `forgeflow-*.mdc`)'],
    [codex, '`.codex/forgeflow/rules` in the project and `~/.codex/forgeflow/rules`'],
    [
      opencode,
      '`.opencode/forgeflow/rules` in the project and `~/.config/opencode/forgeflow/rules`',
    ],
  ])('names where each harness keeps its rules', (adapter, phrase) => {
    expect(adapter.rulesLocation).toBe(phrase);
  });
});

describe('a rule for Cursor with --global', () => {
  it('is refused, and nothing is installed for any target', () => {
    const catalogDir = writeTree(tmpDir(), { 'rules/common.md': ruleMd('common') });
    const io = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture(), catalogDir };
    const code = main(['add', 'common', '--target', 'claude,cursor', '--global'], io);
    expect(code).toBe(2);
    expect(io.stderr.text).toContain('Cursor keeps user-level rules in its settings');
    expect(existsSync(join(io.home, '.claude'))).toBe(false);
    expect(existsSync(join(io.home, '.cursor'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/rule-adapters.test.js`
Expected: FAIL. `appliesTo` is not exported, every adapter renders the rule as an agent (wrong path), `rulesLocation` and `globalRules` are `undefined`, and the `--global` install succeeds.

- [ ] **Step 3: Add the helpers to `src/adapters/shared.js`**

Add after `skillFiles`:

```js
// How a rule's reach is put into words where the harness cannot scope it.
export function appliesTo(item) {
  if (!item.paths) return 'all work';
  return `files matching ${item.paths.map((pattern) => `\`${pattern}\``).join(', ')}`;
}

export const appliesHeader = (item) => `Applies to: ${appliesTo(item)}.\n\n`;

// frontmatter is the text between the fences, ending in a newline, or '' for none.
export function ruleFile(path, item, version, { frontmatter = '', header = '' } = {}) {
  const front = frontmatter ? `---\n${frontmatter}---\n\n` : '';
  const content = `${front}${header}${item.body}\n\n<!-- ${marker(item, version)} -->\n`;
  return [{ path, content }];
}
```

- [ ] **Step 4: Render rules in each adapter**

`src/adapters/claude.js`: change the import line to

```js
import { stringify } from 'yaml';
import { commandWiring, hookFiles, isHookItem, markdown, ruleFile, skillFiles } from './shared.js';
```

add after `agentDirs`:

```js
export const rulesLocation =
  '`.claude/rules/forgeflow` in the project and `~/.claude/rules/forgeflow`';
```

and in `render`, after the `isHookItem` line:

```js
  if (item.type === 'rule') {
    // A rule without paths loads for every session, so it gets no frontmatter.
    const frontmatter = item.paths ? stringify({ paths: item.paths }, { lineWidth: 0 }) : '';
    return ruleFile(`.claude/rules/forgeflow/${item.name}.md`, item, version, { frontmatter });
  }
```

`src/adapters/cursor.js`: change the import line to

```js
import { stringify } from 'yaml';
import { hookFiles, isHookItem, markdown, ruleFile, skillFiles } from './shared.js';
```

add after `agentDirs`:

```js
export const rulesLocation = '`.cursor/rules` in the project (the files named `forgeflow-*.mdc`)';
// Cursor keeps user-level rules in its settings, not in files.
export const globalRules = false;
```

and in `render`, after the `isHookItem` line:

```js
  if (item.type === 'rule') {
    const lines = [stringify({ description: item.description }, { lineWidth: 0 }).trimEnd()];
    // Cursor reads globs as a bare comma-separated list, so they are not YAML-quoted.
    if (item.paths) lines.push(`globs: ${item.paths.join(', ')}`);
    lines.push(`alwaysApply: ${item.paths ? 'false' : 'true'}`);
    return ruleFile(`.cursor/rules/forgeflow-${item.name}.mdc`, item, version, {
      frontmatter: `${lines.join('\n')}\n`,
    });
  }
```

`src/adapters/codex.js`: add `appliesHeader` and `ruleFile` to the import from `./shared.js`, add after `agentDirs`:

```js
export const rulesLocation =
  '`.codex/forgeflow/rules` in the project and `~/.codex/forgeflow/rules`';
```

and in `render`, after the `isHookItem` line:

```js
  if (item.type === 'rule') {
    return ruleFile(`.codex/forgeflow/rules/${item.name}.md`, item, version, {
      header: appliesHeader(item),
    });
  }
```

`src/adapters/opencode.js`: add `appliesHeader` and `ruleFile` to the import from `./shared.js`, add after `agentDirs`:

```js
export const rulesLocation =
  '`.opencode/forgeflow/rules` in the project and `~/.config/opencode/forgeflow/rules`';
```

and in `render`, after the line `const prefix = scope === 'global' ? '' : '.opencode/';`:

```js
  if (item.type === 'rule') {
    return ruleFile(`${prefix}forgeflow/rules/${item.name}.md`, item, version, {
      header: appliesHeader(item),
    });
  }
```

- [ ] **Step 5: Refuse a rule where the harness has no user-level rule files, in `src/ops.js`**

In `install`, after the existing `if (ctx.scope === 'global' && entries.some(({ item }) => isHookItem(item))) { … }` block and the line `const adapter = getAdapter(target);`, add:

```js
    const hasRule = entries.some(({ item }) => item.type === 'rule');
    if (ctx.scope === 'global' && hasRule && adapter.globalRules === false) {
      throw new UsageError(
        'Cursor keeps user-level rules in its settings, not in files. ' +
          'Install rules for cursor without --global.'
      );
    }
```

- [ ] **Step 6: Run the test, then the suite**

Run: `npx vitest run tests/rule-adapters.test.js`
Expected: PASS, 17 tests.

Run: `npx vitest run`
Expected: PASS, no failures.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src tests
git add src tests
git commit -m "Render rules for each harness"
```

---

### Task 3: Placeholders in agent bodies, and the rules-location token

**Files:**
- Modify: `src/placeholders.js`, `src/catalog.js`, `src/adapters/shared.js`, `src/adapters/claude.js`, `src/adapters/codex.js`, `src/adapters/cursor.js`, `src/adapters/opencode.js`
- Test: `tests/placeholders.test.js` (replace)

**Interfaces:**
- Consumes: each adapter's `agentDirs` and `rulesLocation` (Task 2).
- Produces:
  - `PLACEHOLDERS` is `['{{agents-dir}}', '{{global-agents-dir}}', '{{rules-location}}']`.
  - `fillPlaceholders(text, places)` where `places = { agentDirs: { project, global }, rulesLocation }`. This replaces the phase 3a signature, whose second argument was `agentDirs`.
  - `skillFiles(dir, item, version, places, extraFrontmatter = {})`: the fourth parameter is now `places`.
  - `filled(item, places) → item` in `src/adapters/shared.js`, used for agent bodies.
  - Each adapter exports `places`.
  - The catalog checks agent bodies for unknown placeholders, as it does skill bodies.

- [ ] **Step 1: Replace `tests/placeholders.test.js`**

`tests/placeholders.test.js`:

```js
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as cursor from '../src/adapters/cursor.js';
import * as opencode from '../src/adapters/opencode.js';
import { loadCatalog } from '../src/catalog.js';
import { CatalogError } from '../src/errors.js';
import { PLACEHOLDERS, fillPlaceholders, unknownPlaceholders } from '../src/placeholders.js';
import { agentMd, item, ruleMd, skill, skillMd, tmpDir, writeTree } from './helpers.js';

const load = (tree) => loadCatalog(writeTree(tmpDir(), tree));
const places = {
  agentDirs: { project: '.x/agents', global: '~/.x/agents' },
  rulesLocation: '`.x/rules` in the project',
};
const BODY = 'Look in {{agents-dir}} and {{global-agents-dir}}, then {{agents-dir}} again.';
const RULES = 'List the files in {{rules-location}}.';

describe('placeholders', () => {
  it('are the three location tokens', () => {
    expect(PLACEHOLDERS).toEqual([
      '{{agents-dir}}',
      '{{global-agents-dir}}',
      '{{rules-location}}',
    ]);
  });

  it('fills every occurrence of each', () => {
    expect(fillPlaceholders(BODY, places)).toBe(
      'Look in .x/agents and ~/.x/agents, then .x/agents again.'
    );
    expect(fillPlaceholders(RULES, places)).toBe('List the files in `.x/rules` in the project.');
  });

  it('leaves text without tokens alone', () => {
    expect(fillPlaceholders('No tokens here. {single} braces.', places)).toBe(
      'No tokens here. {single} braces.'
    );
  });

  it('reports each unknown token once', () => {
    const text = '{{agents-dir}} {{agent-dir}} {{ agents-dir }} {{agent-dir}} {{}}';
    expect(unknownPlaceholders(text)).toEqual(['{{agent-dir}}', '{{ agents-dir }}', '{{}}']);
    expect(unknownPlaceholders(`${BODY} ${RULES}`)).toEqual([]);
  });
});

describe('catalog', () => {
  const flow = (body) => ({
    'skills/flow/SKILL.md': `---\nname: flow\ndescription: Runs flow.\n---\n${body}\n`,
  });
  const agent = (body) => ({ 'agents/a.md': agentMd('a').replace('Body of a.', body) });

  it('accepts every placeholder in a skill body and in an agent body', () => {
    expect(load(flow(`${BODY} ${RULES}`)).get('skill:flow').body).toBe(`${BODY} ${RULES}`);
    expect(load(agent(RULES)).get('agent:a').body).toBe(RULES);
  });

  it.each(['{{agent-dir}}', '{{ agents-dir }}', '{{rules_location}}'])(
    'rejects the unknown placeholder %s in a skill and in an agent',
    (token) => {
      for (const [tree, source] of [
        [flow(`Look in ${token}.`), 'skills/flow/SKILL.md'],
        [agent(`Look in ${token}.`), 'agents/a.md'],
      ]) {
        const attempt = () => load(tree);
        expect(attempt).toThrow(CatalogError);
        expect(attempt).toThrow(`${source}: unknown placeholder ${token}`);
        expect(attempt).toThrow(
          'allowed: {{agents-dir}}, {{global-agents-dir}}, {{rules-location}}'
        );
      }
    }
  );

  it('does not check rule bodies or supporting skill files', () => {
    const catalog = load({
      'rules/r.md': ruleMd('r').replace('- A rule of r.', '- Write {{ value }}.'),
      'skills/flow/SKILL.md': skillMd('flow'),
      'skills/flow/notes.md': 'A {{template}} example.',
    });
    expect(catalog.get('rule:r').body).toContain('{{ value }}');
    expect(catalog.get('skill:flow').files[0].content.toString()).toBe('A {{template}} example.');
  });
});

const EXPECTED = [
  ['claude', claude, '.claude/agents', '~/.claude/agents'],
  ['codex', codex, '.codex/agents', '~/.codex/agents'],
  ['opencode', opencode, '.opencode/agents', '~/.config/opencode/agents'],
  ['cursor', cursor, '.cursor/agents', '~/.cursor/agents'],
];

describe.each(EXPECTED)('%s adapter', (name, adapter, project, global) => {
  const text = (file) =>
    name === 'codex' && file.path.endsWith('.toml')
      ? parseToml(file.content).developer_instructions
      : file.content;

  it('exports its places', () => {
    expect(adapter.agentDirs).toEqual({ project, global });
    expect(adapter.places).toEqual({
      agentDirs: adapter.agentDirs,
      rulesLocation: adapter.rulesLocation,
    });
  });

  it('writes project agents into the folder it names', () => {
    const [file] = adapter.render(item(), { scope: 'project', version: '0.1.0' });
    expect(file.path.startsWith(`${project}/reviewer.`)).toBe(true);
  });

  it.each(['project', 'global'])('fills a skill body at %s scope', (scope) => {
    const files = adapter.render(skill({ body: `${BODY} ${RULES}` }), { scope, version: '0.1.0' });
    const main = files.find((file) => file.path.endsWith('SKILL.md'));
    expect(main.content).toContain(`Look in ${project} and ${global}, then ${project} again.`);
    expect(main.content).toContain(`List the files in ${adapter.rulesLocation}.`);
    expect(main.content).not.toContain('{{');
  });

  it.each(['project', 'global'])('fills an agent body at %s scope', (scope) => {
    const [file] = adapter.render(item({ body: `${BODY} ${RULES}` }), { scope, version: '0.1.0' });
    expect(text(file)).toContain(`Look in ${project} and ${global}, then ${project} again.`);
    expect(text(file)).toContain(`List the files in ${adapter.rulesLocation}.`);
    expect(text(file)).not.toContain('{{');
  });

  it('leaves a rule body and a supporting skill file unchanged', () => {
    const ctx = { scope: 'project', version: '0.1.0' };
    const rule = { ...item({ id: 'rule:r', type: 'rule', name: 'r' }), body: `# R\n\n- ${BODY}` };
    expect(adapter.render(rule, ctx)[0].content).toContain('{{agents-dir}}');

    const extra = { path: 'notes.md', content: Buffer.from(BODY) };
    const files = adapter.render(skill({ files: [extra] }), ctx);
    expect(files.find((file) => file.path.endsWith('notes.md')).content.toString()).toBe(BODY);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/placeholders.test.js`
Expected: FAIL. `PLACEHOLDERS` has two entries, `{{rules-location}}` is rejected by the catalog as unknown, an agent body with a bad token loads, `places` is `undefined`, and agent bodies come out unfilled.

- [ ] **Step 3: Replace `src/placeholders.js`**

`src/placeholders.js`:

```js
// Tokens an agent or skill body may contain. Each adapter fills them with its
// own locations, so the text looks only in the harness it is installed for.
const TOKENS = {
  '{{agents-dir}}': (places) => places.agentDirs.project,
  '{{global-agents-dir}}': (places) => places.agentDirs.global,
  '{{rules-location}}': (places) => places.rulesLocation,
};
const TOKEN_RE = /\{\{[^{}]*\}\}/g;

export const PLACEHOLDERS = Object.keys(TOKENS);

export function unknownPlaceholders(text) {
  const found = new Set(text.match(TOKEN_RE) ?? []);
  return [...found].filter((token) => !Object.hasOwn(TOKENS, token));
}

// places is an adapter's { agentDirs: { project, global }, rulesLocation }.
export function fillPlaceholders(text, places) {
  return text.replace(TOKEN_RE, (token) =>
    Object.hasOwn(TOKENS, token) ? TOKENS[token](places) : token
  );
}
```

- [ ] **Step 4: Check agent bodies in `src/catalog.js`**

In `buildItem`, remove the `const unknown = unknownPlaceholders(body); if (unknown.length > 0) { … }` lines from the `else if (type === 'skill')` block, and add this immediately before the line `const item = {`:

```js
  if (type === 'agent' || type === 'skill') {
    const unknown = unknownPlaceholders(body);
    if (unknown.length > 0) {
      fail(
        source,
        `unknown placeholder ${unknown.join(', ')} (allowed: ${PLACEHOLDERS.join(', ')})`
      );
    }
  }
```

- [ ] **Step 5: Fill agent bodies in the adapters**

`src/adapters/shared.js`: replace `skillFiles` and the comment above it with:

```js
// places is the adapter's { agentDirs, rulesLocation }.
export const filled = (item, places) => ({ ...item, body: fillPlaceholders(item.body, places) });

// Only SKILL.md is filled; supporting files are copied as they are.
export function skillFiles(dir, item, version, places, extraFrontmatter = {}) {
  const data = { name: item.name, description: item.description, ...extraFrontmatter };
  return [
    { path: `${dir}/SKILL.md`, content: markdown(data, filled(item, places), version) },
    ...item.files.map((file) => ({ path: `${dir}/${file.path}`, content: file.content })),
  ];
}
```

In each of `claude.js`, `codex.js`, `cursor.js` and `opencode.js`:

1. add `filled` to the import from `./shared.js`;
2. add after the `rulesLocation` export:

```js
export const places = { agentDirs, rulesLocation };
```

3. in the `skillFiles(…)` call, replace the argument `agentDirs` with `places`;
4. fill the agent body:
   - `claude.js`, `cursor.js`, `opencode.js`: in the last line of `render`, replace `markdown(data, item, version)` with `markdown(data, filled(item, places), version)`.
   - `codex.js`: replace `multiline(item.body),` with `multiline(filled(item, places).body),`.

- [ ] **Step 6: Run the test, then the suite**

Run: `npx vitest run tests/placeholders.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures. The real catalog still loads: no agent body contains a `{{` token yet.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src tests
git add src tests
git commit -m "Fill placeholders in agent bodies and add the rules-location token"
```

---

### Task 4: Merging into `AGENTS.md` and `opencode.json`

**Files:**
- Create: `src/rules-wiring.js`
- Test: `tests/rules-wiring.test.js` (create)

**Interfaces:**
- Consumes: `ConfigError`.
- Produces, all pure functions on strings and plain objects:
  - `RULES_ID = 'rules'`, `START`, `END` (the two marker strings).
  - `hasBlock(text, path) → boolean`
  - `mergeBlock(text | undefined, block, path) → string`
  - `stripBlock(text, path) → string`
  - `parseInstructions(text, path, entry) → object`
  - `handWired(text, entry) → boolean`
  - `mergeInstructions(config | undefined, { entry, skeleton }) → object`
  - `stripInstructions(config, entry) → object`
  - `path` is used only in error messages. Damaged input throws `ConfigError`.

- [ ] **Step 1: Write `tests/rules-wiring.test.js`**

`tests/rules-wiring.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import {
  END,
  START,
  handWired,
  hasBlock,
  mergeBlock,
  mergeInstructions,
  parseInstructions,
  stripBlock,
  stripInstructions,
} from '../src/rules-wiring.js';

const P = 'AGENTS.md';
const block = (line) => `${START}\n## Coding standards\n\n- ${line}\n${END}`;
const ONE = block('one');
const TWO = block('two');

describe('markers', () => {
  it('are HTML comments a Markdown reader does not show', () => {
    expect(START).toBe('<!-- forgeflow:rules:start -->');
    expect(END).toBe('<!-- forgeflow:rules:end -->');
  });
});

describe('mergeBlock', () => {
  it('makes a new file of just the block', () => {
    expect(mergeBlock(undefined, ONE, P)).toBe(`${ONE}\n`);
    expect(mergeBlock('', ONE, P)).toBe(`${ONE}\n`);
  });

  it('appends after one blank line, keeping the user text', () => {
    expect(mergeBlock('# Mine\n\nKeep this.\n', ONE, P)).toBe(`# Mine\n\nKeep this.\n\n${ONE}\n`);
  });

  it('adds the missing final newline first', () => {
    expect(mergeBlock('# Mine', ONE, P)).toBe(`# Mine\n\n${ONE}\n`);
  });

  it('replaces an existing block where it stands', () => {
    const text = `Top\n\n${ONE}\n\nBottom\n`;
    expect(mergeBlock(text, TWO, P)).toBe(`Top\n\n${TWO}\n\nBottom\n`);
  });

  it('is idempotent', () => {
    const once = mergeBlock('# Mine\n', ONE, P);
    expect(mergeBlock(once, ONE, P)).toBe(once);
  });

  it('writes the block in CRLF when the file uses CRLF', () => {
    const merged = mergeBlock('# Mine\r\n\r\nKeep.\r\n', ONE, P);
    expect(merged).toBe(`# Mine\r\n\r\nKeep.\r\n\r\n${ONE.replace(/\n/g, '\r\n')}\r\n`);
    expect(merged.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('keeps a byte-order mark', () => {
    expect(mergeBlock('﻿# Mine\n', ONE, P).startsWith('﻿# Mine\n')).toBe(true);
  });
});

describe('stripBlock', () => {
  it.each([
    ['ends in a newline', '# Mine\n\nKeep this.\n'],
    ['uses CRLF', '# Mine\r\n\r\nKeep.\r\n'],
    ['starts with a byte-order mark', '﻿# Mine\n'],
    ['ends in blank lines', '# Mine\n\n\n'],
  ])('restores a file that %s exactly', (_case, original) => {
    expect(stripBlock(mergeBlock(original, ONE, P), P)).toBe(original);
  });

  it('leaves a file that had no final newline with one', () => {
    expect(stripBlock(mergeBlock('# Mine', ONE, P), P)).toBe('# Mine\n');
  });

  it('leaves nothing of a file that held only the block', () => {
    expect(stripBlock(mergeBlock(undefined, ONE, P), P)).toBe('');
  });

  it('keeps text the user wrote after the block', () => {
    const text = `${mergeBlock('Top\n', ONE, P)}\nBottom\n`;
    expect(stripBlock(text, P)).toBe('Top\n\nBottom\n');
  });

  it('returns a file without a block unchanged', () => {
    expect(stripBlock('# Mine\n', P)).toBe('# Mine\n');
    expect(hasBlock('# Mine\n', P)).toBe(false);
    expect(hasBlock(mergeBlock('# Mine\n', ONE, P), P)).toBe(true);
  });
});

describe('damaged markers', () => {
  it.each([
    ['a start with no end', `Top\n${START}\ntext\n`],
    ['an end with no start', `Top\ntext\n${END}\n`],
    ['an end before the start', `${END}\ntext\n${START}\n`],
    ['two starts', `${START}\n${START}\ntext\n${END}\n`],
    ['two blocks', `${ONE}\n\n${TWO}\n`],
  ])('refuse %s in every operation', (_case, text) => {
    for (const attempt of [
      () => mergeBlock(text, ONE, P),
      () => stripBlock(text, P),
      () => hasBlock(text, P),
    ]) {
      expect(attempt).toThrow(ConfigError);
      expect(attempt).toThrow('AGENTS.md has damaged forgeflow markers');
    }
  });
});

const J = 'opencode.json';
const ENTRY = '.opencode/forgeflow/rules/*.md';
const wiring = { entry: ENTRY, skeleton: { $schema: 'https://opencode.ai/config.json' } };

describe('mergeInstructions', () => {
  it('starts a new config from the skeleton', () => {
    expect(mergeInstructions(undefined, wiring)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      instructions: [ENTRY],
    });
  });

  it('adds the key last when the config has none, keeping every other key', () => {
    const merged = mergeInstructions({ model: 'x', agent: { a: 1 } }, wiring);
    expect(merged).toEqual({ model: 'x', agent: { a: 1 }, instructions: [ENTRY] });
    expect(Object.keys(merged)).toEqual(['model', 'agent', 'instructions']);
  });

  it('appends after the user entries, in order', () => {
    const merged = mergeInstructions({ instructions: ['a.md', 'b.md'], model: 'x' }, wiring);
    expect(merged.instructions).toEqual(['a.md', 'b.md', ENTRY]);
    expect(Object.keys(merged)).toEqual(['instructions', 'model']);
  });

  it('is idempotent and does not change its input', () => {
    const config = { instructions: ['a.md'] };
    const once = mergeInstructions(config, wiring);
    expect(mergeInstructions(once, wiring)).toEqual(once);
    expect(config).toEqual({ instructions: ['a.md'] });
  });
});

describe('stripInstructions', () => {
  it('removes only the forgeflow entry', () => {
    expect(stripInstructions({ instructions: ['a.md', ENTRY, 'b.md'], model: 'x' }, ENTRY)).toEqual(
      { instructions: ['a.md', 'b.md'], model: 'x' }
    );
  });

  it('drops a list it leaves empty', () => {
    expect(stripInstructions(mergeInstructions(undefined, wiring), ENTRY)).toEqual(wiring.skeleton);
  });

  it('returns a config without the entry unchanged', () => {
    expect(stripInstructions({ instructions: [] }, ENTRY)).toEqual({ instructions: [] });
    expect(stripInstructions({ model: 'x' }, ENTRY)).toEqual({ model: 'x' });
  });
});

describe('parseInstructions', () => {
  it('returns a sound config', () => {
    expect(parseInstructions('{"instructions":["a.md"]}', J, ENTRY)).toEqual({
      instructions: ['a.md'],
    });
    expect(parseInstructions('{}', J, ENTRY)).toEqual({});
  });

  it.each([
    ['JSON with a comment', '{\n  // mine\n  "model": "x"\n}', 'is not valid JSON'],
    ['a list', '[]', 'must contain a JSON object'],
    ['instructions that is a string', '{"instructions":"a.md"}', 'not a list of strings'],
    ['instructions holding a number', '{"instructions":[1]}', 'not a list of strings'],
  ])('refuses %s and says what to add by hand', (_case, text, problem) => {
    const attempt = () => parseInstructions(text, J, ENTRY);
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(`opencode.json ${problem}`);
    expect(attempt).toThrow('add ".opencode/forgeflow/rules/*.md" to its "instructions" list');
  });
});

describe('handWired', () => {
  it('finds the quoted entry in text forgeflow cannot parse', () => {
    expect(handWired(`{\n  // mine\n  "instructions": ["${ENTRY}"]\n}`, ENTRY)).toBe(true);
    expect(handWired('{\n  // mine\n  "instructions": []\n}', ENTRY)).toBe(false);
    expect(handWired(`// ${ENTRY}`, ENTRY)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/rules-wiring.test.js`
Expected: FAIL, the file errors with `Cannot find module '../src/rules-wiring.js'`.

- [ ] **Step 3: Write `src/rules-wiring.js`**

`src/rules-wiring.js`:

```js
import { ConfigError } from './errors.js';

// Row id for the block or entry in install reports.
export const RULES_ID = 'rules';
export const START = '<!-- forgeflow:rules:start -->';
export const END = '<!-- forgeflow:rules:end -->';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const count = (text, needle) => text.split(needle).length - 1;

// Returns the block's { start, end } offsets, or null when the text has none.
function locate(text, path) {
  const starts = count(text, START);
  const ends = count(text, END);
  if (starts === 0 && ends === 0) return null;
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new ConfigError(
      `${path} has damaged forgeflow markers (expected one "${START}" followed by one "${END}"). ` +
        'forgeflow will not modify it: repair the markers, or delete them and the text between them, and re-run.'
    );
  }
  return { start, end: end + END.length };
}

export function hasBlock(text, path) {
  return locate(text, path) !== null;
}

// Only the text between the markers is forgeflow's. Everything else is kept.
export function mergeBlock(text, block, path) {
  if (text === undefined || text === '') return `${block}\n`;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const ours = block.replace(/\n/g, eol);
  const at = locate(text, path);
  if (at) return text.slice(0, at.start) + ours + text.slice(at.end);
  const gap = text.endsWith('\n') ? eol : eol + eol;
  return `${text}${gap}${ours}${eol}`;
}

export function stripBlock(text, path) {
  const at = locate(text, path);
  if (!at) return text;
  // Take back the line break after the block and the blank line added before it.
  const after = text.slice(at.end).replace(/^\r?\n/, '');
  const before = text.slice(0, at.start);
  return (/(\r?\n){2}$/.test(before) ? before.replace(/\r?\n$/, '') : before) + after;
}

export function parseInstructions(text, path, entry) {
  const refuse = (problem) =>
    new ConfigError(
      `${path} ${problem}. forgeflow will not modify it: fix the file, ` +
        `or add ${JSON.stringify(entry)} to its "instructions" list by hand, and re-run.`
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

// True when a config forgeflow cannot use already holds the entry as a string.
export function handWired(text, entry) {
  return text.includes(JSON.stringify(entry));
}

export function mergeInstructions(config, { entry, skeleton }) {
  const base = clone(config ?? skeleton);
  const list = base.instructions ?? [];
  if (!list.includes(entry)) base.instructions = [...list, entry];
  return base;
}

export function stripInstructions(config, entry) {
  const base = clone(config);
  if (!base.instructions?.includes(entry)) return base;
  const rest = base.instructions.filter((existing) => existing !== entry);
  if (rest.length > 0) base.instructions = rest;
  else delete base.instructions;
  return base;
}
```

- [ ] **Step 4: Run the test, then the suite**

Run: `npx vitest run tests/rules-wiring.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src tests
git add src tests
git commit -m "Add merging of the rules block and the OpenCode instructions entry"
```

---

### Task 5: Wire rules on install and remove

**Files:**
- Modify: `src/plan.js`, `src/ops.js`, `src/lock.js`, `src/adapters/codex.js`, `src/adapters/opencode.js`
- Test: `tests/rule-ops.test.js` (create)

**Interfaces:**
- Consumes: everything from Task 4; `appliesTo` (Task 2); `serialize` from `src/wiring.js`.
- Produces:
  - `codex.rulesWiring(scope) → { kind: 'block', path, block(rules) }`, where `rules` is `[{ name, applies }]` in name order and `applies` may be `undefined`.
  - `opencode.rulesWiring(scope) → { kind: 'json', path, alternative, entry, skeleton }`.
  - `planRulesWiring(root, wiring, rules, previous) → { action, record }` in `src/plan.js`. `action` is `{ id: 'rules', type, path, content? }` with `type` one of `wire`, `unwire`, `delete`, `skip`, `missing`. `record` is `{ path, created }` or `null`.
  - `rulesState(root, wiring) → 'ok' | 'missing' | 'unreadable'` in `src/plan.js`.
  - Lockfile: `targets[<target>].rules = { path, created }`.
  - `ops.status()` rows gain `rules: { path, state } | null`.

- [ ] **Step 1: Write `tests/rule-ops.test.js`**

`tests/rule-ops.test.js`:

```js
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { readLock } from '../src/lock.js';
import { status } from '../src/ops.js';
import { END, START } from '../src/rules-wiring.js';
import { agentMd, capture, ruleMd, tmpDir, writeTree } from './helpers.js';

let catalogDir;
let cwd;
let home;

function run(...argv) {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { cwd, home, stdout, stderr, catalogDir });
  return { code, out: stdout.text, err: stderr.text };
}
const read = (path, base = cwd) => readFileSync(join(base, path), 'utf8');
const has = (path, base = cwd) => existsSync(join(base, path));
const TS = ruleMd('ts', 'paths:\n  - "**/*.ts"\n');
const ENTRY = '.opencode/forgeflow/rules/*.md';
const LINE = {
  common: '- `.codex/forgeflow/rules/common.md`: all work',
  ts: '- `.codex/forgeflow/rules/ts.md`: files matching `**/*.ts`',
};

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), {
    'agents/alpha.md': agentMd('alpha'),
    'rules/common.md': ruleMd('common'),
    'rules/ts.md': TS,
  });
  cwd = tmpDir();
  home = tmpDir();
});

describe('codex', () => {
  it('creates AGENTS.md with a block listing the rule', () => {
    const { code, out, err } = run('add', 'common', '--target', 'codex');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toMatch(/create\s+\.codex\/forgeflow\/rules\/common\.md/);
    expect(out).toMatch(/wired\s+AGENTS\.md/);

    const text = read('AGENTS.md');
    expect(text.startsWith(`${START}\n## Coding standards\n\n`)).toBe(true);
    expect(text).toContain('read each file below that applies to the files you are working on');
    expect(text).toContain(`\n${LINE.common}\n${END}\n`);
    expect(readLock(cwd).targets.codex.rules).toEqual({ path: 'AGENTS.md', created: true });
  });

  it('lists every installed rule in name order, and shrinks on remove', () => {
    run('add', 'ts', '--target', 'codex');
    run('add', 'common', '--target', 'codex');
    expect(read('AGENTS.md')).toContain(`\n${LINE.common}\n${LINE.ts}\n${END}\n`);

    const { out } = run('remove', 'ts', '--target', 'codex');
    expect(out).toMatch(/wired\s+AGENTS\.md/);
    expect(read('AGENTS.md')).toContain(`\n\n${LINE.common}\n${END}\n`);
    expect(read('AGENTS.md')).not.toContain('ts.md');
    expect(has('.codex/forgeflow/rules/ts.md')).toBe(false);
    expect(readLock(cwd).targets.codex.rules).toEqual({ path: 'AGENTS.md', created: true });
  });

  it('deletes an AGENTS.md it created when the last rule goes', () => {
    run('add', 'common', '--target', 'codex');
    const { code, out } = run('remove', 'common', '--target', 'codex');
    expect(code).toBe(0);
    expect(out).toMatch(/delete\s+AGENTS\.md/);
    expect(has('AGENTS.md')).toBe(false);
    expect(has('.forgeflow/lock.json')).toBe(false);
  });

  it('keeps the user text byte for byte through add and remove', () => {
    const mine = '# My project\r\n\r\nUse tabs.\r\n';
    writeFileSync(join(cwd, 'AGENTS.md'), mine);
    run('add', 'common', 'ts', '--target', 'codex');
    expect(read('AGENTS.md').startsWith(`${mine}\r\n${START}\r\n`)).toBe(true);
    expect(readLock(cwd).targets.codex.rules.created).toBe(false);

    run('remove', 'common', 'ts', '--target', 'codex');
    expect(read('AGENTS.md')).toBe(mine);
  });

  it('keeps an AGENTS.md it created if the user wrote in it since', () => {
    run('add', 'common', '--target', 'codex');
    writeFileSync(join(cwd, 'AGENTS.md'), `${read('AGENTS.md')}\nMine.\n`);
    expect(run('remove', 'common', '--target', 'codex').out).toMatch(/unwired\s+AGENTS\.md/);
    expect(read('AGENTS.md')).toBe('\nMine.\n');
  });

  it('reports unchanged when nothing in the block changes', () => {
    run('add', 'common', '--target', 'codex');
    expect(run('add', 'common', '--target', 'codex').out).toMatch(/unchanged\s+AGENTS\.md/);
    expect(run('add', 'alpha', '--target', 'codex').out).toMatch(/unchanged\s+AGENTS\.md/);
  });

  it('refreshes the block on update when the catalog changes', () => {
    run('add', 'ts', '--target', 'codex');
    writeTree(catalogDir, { 'rules/ts.md': ruleMd('ts', 'paths:\n  - "**/*.mts"\n') });
    expect(run('update').out).toMatch(/wired\s+AGENTS\.md/);
    expect(read('AGENTS.md')).toContain('ts.md`: files matching `**/*.mts`');
  });

  it('keeps a rule that left the catalog listed by path only', () => {
    writeTree(catalogDir, { 'rules/old.md': ruleMd('old') });
    run('add', 'common', 'old', '--target', 'codex');
    rmSync(join(catalogDir, 'rules/old.md'));

    expect(run('add', 'ts', '--target', 'codex').code).toBe(0);
    const text = read('AGENTS.md');
    expect(text).toContain(`${LINE.common}\n- \`.codex/forgeflow/rules/old.md\`\n${LINE.ts}\n`);
    expect(has('.codex/forgeflow/rules/old.md')).toBe(true);
  });

  it('installs under ~/.codex with --global and names the files from the home folder', () => {
    expect(run('add', 'common', '--target', 'codex', '--global').code).toBe(0);
    expect(has('.codex/forgeflow/rules/common.md', home)).toBe(true);
    expect(read('.codex/AGENTS.md', home)).toContain(
      '- `~/.codex/forgeflow/rules/common.md`: all work'
    );
    expect(has('AGENTS.md')).toBe(false);
  });

  it('writes nothing on a dry run', () => {
    const { out } = run('add', 'common', '--target', 'codex', '--dry-run');
    expect(out).toMatch(/wired\s+AGENTS\.md/);
    expect(has('AGENTS.md')).toBe(false);
    expect(has('.codex')).toBe(false);
  });
});

describe('opencode', () => {
  it('creates opencode.json with the one entry, which never changes', () => {
    const { code, out } = run('add', 'common', '--target', 'opencode');
    expect(code).toBe(0);
    expect(out).toMatch(/wired\s+opencode\.json/);
    expect(JSON.parse(read('opencode.json'))).toEqual({
      $schema: 'https://opencode.ai/config.json',
      instructions: [ENTRY],
    });
    expect(has('.opencode/forgeflow/rules/common.md')).toBe(true);

    expect(run('add', 'ts', '--target', 'opencode').out).toMatch(/unchanged\s+opencode\.json/);
    expect(run('remove', 'ts', '--target', 'opencode').out).toMatch(/unchanged\s+opencode\.json/);
    expect(JSON.parse(read('opencode.json')).instructions).toEqual([ENTRY]);
  });

  it('deletes a config it created when the last rule goes', () => {
    run('add', 'common', '--target', 'opencode');
    expect(run('remove', 'common', '--target', 'opencode').out).toMatch(/delete\s+opencode\.json/);
    expect(has('opencode.json')).toBe(false);
  });

  it('adds to and removes from a config the user owns, touching nothing else', () => {
    const mine = { model: 'x', instructions: ['a.md'], agent: { build: { mode: 'primary' } } };
    writeFileSync(join(cwd, 'opencode.json'), JSON.stringify(mine));
    run('add', 'common', '--target', 'opencode');
    expect(JSON.parse(read('opencode.json'))).toEqual({ ...mine, instructions: ['a.md', ENTRY] });
    expect(readLock(cwd).targets.opencode.rules).toEqual({ path: 'opencode.json', created: false });

    expect(run('remove', 'common', '--target', 'opencode').out).toMatch(/unwired\s+opencode\.json/);
    expect(JSON.parse(read('opencode.json'))).toEqual(mine);
  });

  it('uses the home-relative entry with --global', () => {
    expect(run('add', 'common', '--target', 'opencode', '--global').code).toBe(0);
    expect(has('.config/opencode/forgeflow/rules/common.md', home)).toBe(true);
    expect(JSON.parse(read('.config/opencode/opencode.json', home)).instructions).toEqual([
      '~/.config/opencode/forgeflow/rules/*.md',
    ]);
  });

  it('refuses a lone opencode.jsonc, then accepts it once the entry is added by hand', () => {
    writeFileSync(join(cwd, 'opencode.jsonc'), '{\n  // mine\n  "model": "x"\n}\n');
    const refused = run('add', 'common', '--target', 'opencode');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('opencode.jsonc');
    expect(refused.err).toContain(`add "${ENTRY}" to its "instructions" list`);
    expect(has('.opencode')).toBe(false);
    expect(has('opencode.json')).toBe(false);

    const byHand = `{\n  // mine\n  "model": "x",\n  "instructions": ["${ENTRY}"]\n}\n`;
    writeFileSync(join(cwd, 'opencode.jsonc'), byHand);
    const accepted = run('add', 'common', '--target', 'opencode');
    expect(accepted.code).toBe(0);
    expect(accepted.out).toMatch(/unchanged\s+opencode\.jsonc/);
    expect(has('.opencode/forgeflow/rules/common.md')).toBe(true);
    expect(has('opencode.json')).toBe(false);
    expect(read('opencode.jsonc')).toBe(byHand);
    expect(readLock(cwd).targets.opencode.rules).toBeUndefined();

    expect(run('remove', 'common', '--target', 'opencode').code).toBe(0);
    expect(read('opencode.jsonc')).toBe(byHand);
  });

  it('treats an unparsable opencode.json the same way', () => {
    writeFileSync(join(cwd, 'opencode.json'), '{\n  // mine\n}\n');
    expect(run('add', 'common', '--target', 'opencode').code).toBe(1);
    expect(has('.opencode')).toBe(false);

    const byHand = `{\n  // mine\n  "instructions": ["${ENTRY}"]\n}\n`;
    writeFileSync(join(cwd, 'opencode.json'), byHand);
    expect(run('add', 'common', '--target', 'opencode').code).toBe(0);
    expect(read('opencode.json')).toBe(byHand);
  });
});

describe('claude and cursor', () => {
  it('need no wiring: the harness loads the rule files itself', () => {
    const { code, out } = run('add', 'common', 'ts', '--target', 'claude,cursor');
    expect(code).toBe(0);
    expect(out).not.toMatch(/wired/);
    expect(has('.claude/rules/forgeflow/ts.md')).toBe(true);
    expect(has('.cursor/rules/forgeflow-common.mdc')).toBe(true);
    expect(has('AGENTS.md')).toBe(false);
    expect(has('opencode.json')).toBe(false);
    expect(readLock(cwd).targets.claude.rules).toBeUndefined();
  });
});

describe('several targets', () => {
  it('shrinks the Codex block, keeps the OpenCode entry, and restores both at the end', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# Mine\n');
    writeFileSync(join(cwd, 'opencode.json'), '{\n  "model": "x"\n}\n');
    run('add', 'common', 'ts', '--target', 'codex,opencode');

    run('remove', 'ts', '--target', 'codex,opencode');
    expect(read('AGENTS.md')).toContain(LINE.common);
    expect(read('AGENTS.md')).not.toContain(LINE.ts);
    expect(JSON.parse(read('opencode.json')).instructions).toEqual([ENTRY]);

    run('remove', 'common', '--target', 'codex,opencode');
    expect(read('AGENTS.md')).toBe('# Mine\n');
    expect(read('opencode.json')).toBe('{\n  "model": "x"\n}\n');
  });

  it('writes nothing for any target when one user file is damaged', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), `# Mine\n${START}\nhalf a block\n`);
    const { code, err } = run('add', 'common', '--target', 'claude,codex,opencode');
    expect(code).toBe(1);
    expect(err).toContain('AGENTS.md has damaged forgeflow markers');
    for (const path of ['.claude', '.codex', '.opencode', 'opencode.json', '.forgeflow']) {
      expect(has(path), path).toBe(false);
    }
    expect(run('add', 'common', '--target', 'codex', '--force').code).toBe(1);
  });
});

describe('symbolic links', () => {
  it('edits the file AGENTS.md points to and keeps the link', () => {
    writeTree(cwd, { 'docs/INSTRUCTIONS.md': '# Shared\n' });
    symlinkSync('docs/INSTRUCTIONS.md', join(cwd, 'AGENTS.md'));

    const { code, out } = run('add', 'common', '--target', 'codex');
    expect(code).toBe(0);
    expect(out).toMatch(/wired\s+docs\/INSTRUCTIONS\.md/);
    expect(lstatSync(join(cwd, 'AGENTS.md')).isSymbolicLink()).toBe(true);
    expect(read('docs/INSTRUCTIONS.md')).toContain(LINE.common);
    expect(readLock(cwd).targets.codex.rules).toEqual({ path: 'AGENTS.md', created: false });

    run('remove', 'common', '--target', 'codex');
    expect(lstatSync(join(cwd, 'AGENTS.md')).isSymbolicLink()).toBe(true);
    expect(read('docs/INSTRUCTIONS.md')).toBe('# Shared\n');
  });

  it('refuses a link that leaves the project, and a broken one', () => {
    const outside = join(tmpDir(), 'OUTSIDE.md');
    writeFileSync(outside, '# Elsewhere\n');
    symlinkSync(outside, join(cwd, 'AGENTS.md'));
    const leaving = run('add', 'common', '--target', 'codex');
    expect(leaving.code).toBe(1);
    expect(leaving.err).toContain('AGENTS.md is a symbolic link to a file outside');
    expect(readFileSync(outside, 'utf8')).toBe('# Elsewhere\n');
    expect(has('.codex')).toBe(false);

    cwd = tmpDir();
    symlinkSync('nowhere.md', join(cwd, 'AGENTS.md'));
    const broken = run('add', 'common', '--target', 'codex');
    expect(broken.code).toBe(1);
    expect(broken.err).toContain('AGENTS.md is a broken symbolic link');
  });
});

describe('status', () => {
  const state = (target) =>
    status({ scope: 'project', cwd, home }).find((row) => row.target === target).rules;

  it('reports the block and the entry', () => {
    run('add', 'common', '--target', 'claude,codex,opencode');
    expect(state('codex')).toEqual({ path: 'AGENTS.md', state: 'ok' });
    expect(state('opencode')).toEqual({ path: 'opencode.json', state: 'ok' });
    expect(state('claude')).toBeNull();
  });

  it('reports missing and unreadable', () => {
    run('add', 'common', '--target', 'codex,opencode');
    writeFileSync(join(cwd, 'AGENTS.md'), '# Rewritten by hand\n');
    writeFileSync(join(cwd, 'opencode.json'), '{ not json');
    expect(state('codex').state).toBe('missing');
    expect(state('opencode').state).toBe('unreadable');

    writeFileSync(join(cwd, 'AGENTS.md'), `${START}\n`);
    expect(state('codex').state).toBe('unreadable');
  });
});

describe('lockfile', () => {
  it('rejects a rules record with an unsafe path or a missing flag', () => {
    run('add', 'common', '--target', 'codex');
    const path = join(cwd, '.forgeflow/lock.json');
    const lock = JSON.parse(readFileSync(path, 'utf8'));

    lock.targets.codex.rules = { path: '../AGENTS.md', created: true };
    writeFileSync(path, JSON.stringify(lock));
    expect(run('status').err).toContain('unsafe file path');

    lock.targets.codex.rules = { path: 'AGENTS.md' };
    writeFileSync(path, JSON.stringify(lock));
    expect(run('status').err).toContain('malformed rules record');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/rule-ops.test.js`
Expected: FAIL. Rule files are created, but no `AGENTS.md` or `opencode.json` is written, `status` rows have no `rules`, and the lockfile test finds no validation error.

- [ ] **Step 3: Describe the wiring in the two adapters**

`src/adapters/codex.js`: add the import

```js
import { END, START } from '../rules-wiring.js';
```

and add after the `places` export:

```js
const RULES_INTRO =
  'These standards are installed by forgeflow. Before you write or review code, ' +
  'read each file below that applies to the files you are working on, and follow it.';

// Codex reads only AGENTS.md, so the rule files are listed there. rules is
// [{ name, applies }] in name order; applies is unknown for a rule that has
// left the catalog.
export function rulesWiring(scope) {
  const dir = scope === 'global' ? '~/.codex/forgeflow/rules' : '.codex/forgeflow/rules';
  return {
    kind: 'block',
    path: scope === 'global' ? '.codex/AGENTS.md' : 'AGENTS.md',
    block: (rules) =>
      [
        START,
        '## Coding standards',
        '',
        RULES_INTRO,
        '',
        ...rules.map(
          ({ name, applies }) => `- \`${dir}/${name}.md\`${applies ? `: ${applies}` : ''}`
        ),
        END,
      ].join('\n'),
  };
}
```

`src/adapters/opencode.js`: add after the `places` export:

```js
// OpenCode loads every file its "instructions" list names, so one glob covers
// whichever rules are installed.
export function rulesWiring(scope) {
  return {
    kind: 'json',
    path: 'opencode.json',
    alternative: 'opencode.jsonc',
    entry:
      scope === 'global'
        ? '~/.config/opencode/forgeflow/rules/*.md'
        : '.opencode/forgeflow/rules/*.md',
    skeleton: { $schema: 'https://opencode.ai/config.json' },
  };
}
```

- [ ] **Step 4: Plan the wiring in `src/plan.js`**

Replace the first two import lines with:

```js
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ConfigError } from './errors.js';
```

add after the existing `./wiring.js` import:

```js
import {
  RULES_ID,
  handWired,
  hasBlock,
  mergeBlock,
  mergeInstructions,
  parseInstructions,
  stripBlock,
  stripInstructions,
} from './rules-wiring.js';
```

and append to the end of the file:

```js
// A user file that is a symbolic link is edited through the link, so the link
// survives. Returns the path to read and write, relative to root.
function throughLink(root, path) {
  const full = join(root, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return path;
  }
  if (!stat.isSymbolicLink()) return path;
  const refuse = (problem) =>
    new ConfigError(`${path} is ${problem}. forgeflow will not modify it.`);
  let target;
  try {
    target = realpathSync(full);
  } catch {
    throw refuse('a broken symbolic link');
  }
  const inside = relative(realpathSync(root), target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw refuse(`a symbolic link to a file outside ${root}`);
  }
  return inside.split(sep).join('/');
}

function readText(root, path) {
  const full = join(root, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
}

// The file's next text, and whether nothing but forgeflow's skeleton is left.
function nextRulesText(wiring, current, rules) {
  if (wiring.kind === 'block') {
    if (rules.length > 0) {
      return { text: mergeBlock(current, wiring.block(rules), wiring.path), bare: false };
    }
    const text = stripBlock(current, wiring.path);
    return { text, bare: text.replace(/^﻿/, '').trim() === '' };
  }
  const config =
    current === undefined ? undefined : parseInstructions(current, wiring.path, wiring.entry);
  const next =
    rules.length > 0 ? mergeInstructions(config, wiring) : stripInstructions(config, wiring.entry);
  // An unchanged config keeps its text, so the user's formatting survives.
  const text = config !== undefined && same(next, config) ? current : serialize(next);
  return { text, bare: same(next, wiring.skeleton) };
}

// A config forgeflow cannot use is still fine when the user has put the entry
// in by hand. Returns the path of that file, or undefined.
function wiredByHand(root, wiring, path, current) {
  if (wiring.kind !== 'json') return undefined;
  if (current !== undefined) {
    try {
      parseInstructions(current, wiring.path, wiring.entry);
      return undefined;
    } catch (error) {
      if (handWired(current, wiring.entry)) return path;
      throw error;
    }
  }
  const other = readText(root, wiring.alternative);
  if (other === undefined) return undefined;
  if (handWired(other, wiring.entry)) return wiring.alternative;
  throw new ConfigError(
    `${wiring.alternative} exists and ${wiring.path} does not. forgeflow will not create a ` +
      `second OpenCode config: add ${JSON.stringify(wiring.entry)} to its "instructions" list ` +
      `in ${wiring.alternative} by hand, and re-run.`
  );
}

// rules is every rule the target will have after the operation: [{ name, applies }].
// An empty list takes forgeflow's part out again. previous is the lockfile record.
export function planRulesWiring(root, wiring, rules, previous) {
  const path = throughLink(root, wiring.path);
  const current = readText(root, path);
  const row = (type, extra = {}) => ({ id: RULES_ID, type, path, ...extra });

  if (rules.length > 0) {
    const byHand = wiredByHand(root, wiring, path, current);
    if (byHand) return { action: { id: RULES_ID, type: 'skip', path: byHand }, record: null };
    const { text } = nextRulesText(wiring, current, rules);
    const created = current === undefined ? true : (previous?.created ?? false);
    return {
      action: row(text === current ? 'skip' : 'wire', { content: text }),
      record: { path: wiring.path, created },
    };
  }

  if (current === undefined) return { action: row('missing'), record: null };
  const { text, bare } = nextRulesText(wiring, current, rules);
  if (text === current) return { action: row('skip'), record: null };
  const ours = previous?.created && bare && path === wiring.path;
  return { action: ours ? row('delete') : row('unwire', { content: text }), record: null };
}

export function rulesState(root, wiring) {
  try {
    const current = readText(root, throughLink(root, wiring.path));
    if (current === undefined) return 'missing';
    if (wiring.kind === 'block') return hasBlock(current, wiring.path) ? 'ok' : 'missing';
    const config = parseInstructions(current, wiring.path, wiring.entry);
    return config.instructions?.includes(wiring.entry) ? 'ok' : 'missing';
  } catch {
    return 'unreadable';
  }
}
```

- [ ] **Step 5: Validate the record in `src/lock.js`**

In `validate`, inside the `for (const [target, entry] of Object.entries(lock.targets))` loop, after the inner loop over `entry.items`, add:

```js
    if (entry.rules !== undefined) {
      if (!isObject(entry.rules) || typeof entry.rules.created !== 'boolean') {
        throw malformed(`target "${target}" has a malformed rules record`);
      }
      requireSafe(entry.rules.path, `target "${target}"`);
    }
```

- [ ] **Step 6: Use it in `src/ops.js`**

Change the imports to:

```js
import { getAdapter } from './adapters/index.js';
import { appliesTo } from './adapters/shared.js';
import { applyActions, checkWritable } from './apply.js';
import { ConflictError, UsageError } from './errors.js';
import { readLock, sha256, writeLock } from './lock.js';
import {
  planInstall,
  planRemove,
  planRulesWiring,
  planUnwire,
  planWire,
  rulesState,
  wiringState,
} from './plan.js';
import { findId, resolve } from './resolve.js';
import { RUNTIME_ID } from './wiring.js';
```

Replace the `wiringRow` line with:

```js
const isRuleId = (id) => id.startsWith('rule:');
// Hook wiring rows carry no id of their own; rules wiring rows do.
const wiringRow = ({ id = RUNTIME_ID, type, path }) => ({ id, type, path });

// What a harness needs to list each rule, in name order. A rule that has left
// the catalog is still installed, so it stays listed without its patterns.
function describeRules(catalog, ids) {
  return [...ids].sort().map((id) => {
    const item = catalog.get(id);
    return { name: id.slice('rule:'.length), applies: item ? appliesTo(item) : undefined };
  });
}
```

In the comment above `report`, change the first sentence to: `A plan is { target, root, items, before?, after?, rules? }.` and add the sentence: `rules is the lockfile's rules record after the operation: an object to set it, null to drop it, undefined to leave it.`

In `commit`, after the line `applyActions(plan.root, plan.after ?? [], ctx.force);`, add:

```js
    if (plan.rules === null) delete target.rules;
    else if (plan.rules) target.rules = plan.rules;
```

In `install`, replace the line `return { target, root, items, after };` with:

```js
    let rules;
    const rulesWiring = adapter.rulesWiring?.(ctx.scope);
    const ruleIds = new Set(
      [...Object.keys(installed), ...entries.map(({ item }) => item.id)].filter(isRuleId)
    );
    if (rulesWiring && ruleIds.size > 0) {
      const planned = planRulesWiring(
        root,
        rulesWiring,
        describeRules(ctx.catalog, ruleIds),
        lock.targets[target]?.rules
      );
      after.push(planned.action);
      rules = planned.record;
    }
    return { target, root, items, after, rules };
```

In `remove`, replace the line `return { target, root, items, before };` with:

```js
    let rules;
    const record = lock.targets[target]?.rules;
    if (record && [...going].some(isRuleId)) {
      const rulesWiring = adapter.rulesWiring?.(ctx.scope);
      const staying = Object.keys(installed).filter((id) => isRuleId(id) && !going.has(id));
      rules = null;
      if (rulesWiring) {
        const planned = planRulesWiring(
          root,
          rulesWiring,
          describeRules(ctx.catalog, staying),
          record
        );
        before.push(planned.action);
        rules = planned.record;
      }
    }
    return { target, root, items, before, rules };
```

In `status`, change the callback's parameter from `([target, { items }])` to `([target, entry])`, add `const { items } = entry;` as its first line, and add this property to the returned object after `wiring`:

```js
      rules:
        entry.rules && adapter.rulesWiring
          ? { path: entry.rules.path, state: rulesState(root, adapter.rulesWiring(ctx.scope)) }
          : null,
```

- [ ] **Step 7: Run the test, then the suite**

Run: `npx vitest run tests/rule-ops.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures.

- [ ] **Step 8: Commit**

```bash
npx prettier --write src tests
git add src tests
git commit -m "Wire rules into AGENTS.md and opencode.json on install and remove"
```

---

### Task 6: Report rules wiring in `status` and `doctor`

**Files:**
- Modify: `src/cli.js`, `src/doctor.js`
- Test: `tests/rule-cli.test.js` (create)

**Interfaces:**
- Consumes: `status()` rows with `rules: { path, state } | null` (Task 5).
- Produces: a `rules <state>  <path>` line in `forgeflow status`; a problem line in `forgeflow doctor` for any state other than `ok`.

- [ ] **Step 1: Write `tests/rule-cli.test.js`**

`tests/rule-cli.test.js`:

```js
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { capture, ruleMd, tmpDir, writeTree } from './helpers.js';

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
  catalogDir = writeTree(tmpDir(), { 'rules/common.md': ruleMd('common') });
  cwd = tmpDir();
  home = tmpDir();
  run('add', 'common', '--target', 'claude,codex,opencode');
});

describe('status', () => {
  it('shows the state of the block and the entry, and nothing for Claude Code', () => {
    const { out } = run('status');
    expect(out).toMatch(/^ {2}rules ok\s+AGENTS\.md$/m);
    expect(out).toMatch(/^ {2}rules ok\s+opencode\.json$/m);
    expect(out.match(/rules ok/g)).toHaveLength(2);
  });

  it('shows a block that was removed by hand as missing', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# Mine\n');
    expect(run('status').out).toMatch(/^ {2}rules missing\s+AGENTS\.md$/m);
  });
});

describe('doctor', () => {
  it('passes when the wiring is in place', () => {
    const { code, out } = run('doctor');
    expect(code).toBe(0);
    expect(out).toContain('project install matches lockfile (no differences)');
  });

  it('fails and names the file when the wiring is gone or unreadable', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# Mine\n');
    writeFileSync(join(cwd, 'opencode.json'), '{ not json');
    const { code, out } = run('doctor');
    expect(code).toBe(1);
    expect(out).toContain('[codex] rules wiring in AGENTS.md is missing');
    expect(out).toContain('[opencode] rules wiring in opencode.json is unreadable');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/rule-cli.test.js`
Expected: FAIL. `status` prints no `rules` line, and `doctor` exits 0 with the wiring gone.

- [ ] **Step 3: Print the line in `src/cli.js`**

In `printStatus`, change the destructuring to `{ target, root, items, wiring, rules }` and add after the line that prints `wiring`:

```js
    if (rules) stdout.write(`  ${`rules ${rules.state}`.padEnd(17)} ${rules.path}\n`);
```

- [ ] **Step 4: Report the problem in `src/doctor.js`**

In `problemsOf`, change `const { wiring } = target;` to `const { wiring, rules } = target;` and add before `return files;`:

```js
    if (rules && rules.state !== 'ok') {
      files.push(`[${target.target}] rules wiring in ${rules.path} is ${rules.state}`);
    }
```

- [ ] **Step 5: Run the test, then the suite**

Run: `npx vitest run tests/rule-cli.test.js`
Expected: PASS, 4 tests.

Run: `npx vitest run`
Expected: PASS, no failures.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src tests
git add src tests
git commit -m "Report rules wiring in status and doctor"
```

---

### Task 7: The ten rules packs

**Files:**
- Create: `catalog/rules/common.md`, `typescript.md`, `python.md`, `php.md`, `java.md`, `csharp.md`, `go.md`, `react.md`, `vue.md`, `angular.md` (all under `catalog/rules/`)
- Test: `tests/rule-content.test.js` (create)

**Interfaces:**
- Consumes: the rule type (Task 1), rendering (Task 2), wiring (Task 5).
- Produces: ten items `rule:<name>`. Task 8's `standards-reviewer` reads whichever are installed.

- [ ] **Step 1: Write `tests/rule-content.test.js`**

`tests/rule-content.test.js`:

```js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { capture, tmpDir } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const rules = [...catalog.values()].filter((item) => item.type === 'rule');

const EXPECTED = [
  ['common', undefined],
  [
    'typescript',
    ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
  ],
  ['python', ['**/*.py', '**/*.pyi']],
  ['php', ['**/*.php']],
  ['java', ['**/*.java']],
  ['csharp', ['**/*.cs', '**/*.cshtml', '**/*.razor']],
  ['go', ['**/*.go']],
  ['react', ['**/*.tsx', '**/*.jsx']],
  ['vue', ['**/*.vue']],
  [
    'angular',
    [
      '**/*.component.ts',
      '**/*.component.html',
      '**/*.service.ts',
      '**/*.directive.ts',
      '**/*.pipe.ts',
      '**/*.module.ts',
    ],
  ],
];
const NAMES = EXPECTED.map(([name]) => name);
const HARNESS_TOOL =
  /`(Edit|Write|Read|Grep|Glob|Bash|Task|MultiEdit|TodoWrite|apply_patch|str_replace)`|\b(apply_patch|MultiEdit|TodoWrite|str_replace)\b/;
const body = (name) => catalog.get(`rule:${name}`).body;
const lines = (name) => body(name).split('\n');

describe('rules packs', () => {
  it('are exactly the ten the spec lists', () => {
    expect(rules.map((rule) => rule.name).sort()).toEqual([...NAMES].sort());
  });

  it.each(EXPECTED)('%s applies to the patterns the spec gives', (name, paths) => {
    const rule = catalog.get(`rule:${name}`);
    expect(rule.paths).toEqual(paths);
    expect(rule.requires).toEqual([]);
    expect(rule.description.endsWith('.')).toBe(true);
    expect(rule.description.length).toBeLessThanOrEqual(200);
  });

  it.each(NAMES)('%s is one titled document of grouped bullets', (name) => {
    expect(lines(name)[0]).toMatch(/^# \S/);
    expect(lines(name).filter((line) => line.startsWith('# '))).toHaveLength(1);
    expect(lines(name).filter((line) => line.startsWith('## ')).length).toBeGreaterThanOrEqual(3);
    expect(lines(name).filter((line) => line.startsWith('- ')).length).toBeGreaterThanOrEqual(15);
  });

  it.each(NAMES)('%s holds nothing but its title, headings, bullets and one intro line', (name) => {
    const other = lines(name).filter(
      (line) => line !== '' && !line.startsWith('#') && !line.startsWith('- ')
    );
    expect(other.length).toBeLessThanOrEqual(1);
  });

  it.each(NAMES)('%s stays within 6,000 bytes', (name) => {
    expect(Buffer.byteLength(body(name))).toBeLessThanOrEqual(6000);
  });

  it.each(NAMES)('%s names no harness-specific tool', (name) => {
    expect(body(name)).not.toMatch(HARNESS_TOOL);
  });

  it('common lets the project convention win', () => {
    expect(body('common')).toContain("the project's convention wins");
  });

  it.each([
    ['php', '## Laravel'],
    ['java', '## Spring'],
    ['csharp', '## ASP.NET Core'],
  ])('%s keeps its framework rules in a section that says when it applies', (name, heading) => {
    const at = lines(name).indexOf(heading);
    expect(at).toBeGreaterThan(0);
    expect(lines(name)[at + 2]).toContain('only when the project uses');
  });
});

describe('installing the real packs', () => {
  const io = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture() };
  const code = main(['add', ...NAMES, '--target', 'claude,codex,opencode,cursor'], io);
  const read = (path) => readFileSync(join(io.cwd, path), 'utf8');

  it('writes every pack for every harness', () => {
    expect(io.stderr.text).toBe('');
    expect(code).toBe(0);
    for (const name of NAMES) {
      for (const path of [
        `.claude/rules/forgeflow/${name}.md`,
        `.cursor/rules/forgeflow-${name}.mdc`,
        `.codex/forgeflow/rules/${name}.md`,
        `.opencode/forgeflow/rules/${name}.md`,
      ]) {
        expect(existsSync(join(io.cwd, path)), path).toBe(true);
      }
    }
  });

  it('lists all ten in the Codex block, well inside the 32 KiB cap', () => {
    const text = read('AGENTS.md');
    expect(text.match(/^- `\.codex\/forgeflow\/rules\//gm)).toHaveLength(10);
    expect(text).toContain('- `.codex/forgeflow/rules/common.md`: all work');
    expect(text).toContain('- `.codex/forgeflow/rules/vue.md`: files matching `**/*.vue`');
    expect(Buffer.byteLength(text)).toBeLessThan(4096);
  });

  it('scopes stack packs and leaves common always on', () => {
    expect(read('.claude/rules/forgeflow/common.md').startsWith('# ')).toBe(true);
    expect(read('.claude/rules/forgeflow/go.md').startsWith('---\npaths:\n')).toBe(true);
    expect(read('.cursor/rules/forgeflow-common.mdc')).toContain('alwaysApply: true');
    expect(read('.cursor/rules/forgeflow-go.mdc')).toContain('globs: **/*.go\nalwaysApply: false');
    expect(read('.opencode/forgeflow/rules/go.md').startsWith('Applies to: files matching')).toBe(
      true
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/rule-content.test.js`
Expected: FAIL. No rule is in the catalog, so the list is empty, every per-pack test fails on `undefined`, and the install exits 2 with `unknown item "common"`.

- [ ] **Step 3: Write `catalog/rules/common.md`**

`catalog/rules/common.md`:

````markdown
---
name: common
description: Coding standards for every language - naming, functions, errors, tests, security, comments, dependencies and version control.
---
# Common standards

These apply to all code. Where a rule here differs from what this project already does consistently, the project's convention wins: match the code around you.

## Naming and structure

- Name things for what they mean in the problem, not for their type or how they are built.
- Use one word for one idea across the codebase. Do not introduce a second name for something that already has one.
- A function does one thing. If you need "and" to describe it, split it.
- Keep a function short enough to read without scrolling, and nest no deeper than three levels. Return early instead.
- Pass what a function needs as parameters. Do not reach for global or shared mutable state.
- Delete dead code, unused parameters and commented-out code. Version control remembers them.
- Do not add an abstraction, an option or a layer until there is a second real use for it.

## Errors

- Handle an error where you can do something about it. Otherwise let it travel up unchanged.
- Never swallow an error. An empty handler, or one that only logs and carries on as if nothing happened, is a defect.
- Fail fast on input that cannot be right. Validate at the boundary, then trust the value inside.
- Make error messages say what happened and what was expected, with the value that caused it, but never a secret.
- Release what you acquire, on every path, including the failing ones.

## Tests

- Every change in behavior comes with a test that fails without it.
- Test behavior through the public interface, not private details. A refactor should not break tests.
- One test checks one behavior, and its name says which.
- Replace a real dependency with a stand-in only when it is slow, random or external. Never assert only that a stand-in was called.
- Tests do not depend on each other, on order, on the clock or on the network.

## Security

- Treat everything from outside the process as untrusted: requests, files, environment, other services.
- Never build a query, a command, a path or markup by joining strings with untrusted input. Use parameters and the escaping the platform provides.
- Keep secrets out of code, logs, error messages and version control. Read them from configuration at run time.
- Check that the caller may act on this particular object, not only that they are signed in.
- Deny by default. When a check fails or errors, refuse.

## Comments and documentation

- Comment why, not what. If a comment restates the code, delete it and improve the name.
- Keep comments true. Change the comment in the same edit that changes the code.
- Document every public interface: what it does, its inputs, its result and its failures.

## Dependencies

- Add a dependency only when writing the code yourself would be clearly worse. Prefer the standard library.
- Pin versions the way the project already does, and commit the lockfile.

## Version control

- One logical change per commit, with a message that says why.
- Do not commit generated files, build output, editor settings or secrets.
- Use the project's formatter and linter, and leave no warnings behind.
````

- [ ] **Step 4: Write `catalog/rules/typescript.md`**

`catalog/rules/typescript.md`:

````markdown
---
name: typescript
description: TypeScript and JavaScript standards - types, modules, async code, errors and Node.
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mts"
  - "**/*.cts"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mjs"
  - "**/*.cjs"
---
# TypeScript and JavaScript standards

The typing rules apply to TypeScript files. The rest apply to JavaScript as well.

## Types

- Keep `strict` on. Do not weaken compiler options to make an error go away.
- Do not use `any`. Use `unknown` for a value you have not checked, and narrow it before use.
- Do not silence the compiler with `as`, `!` or an ignore comment. If you must, say why on the same line.
- Give every exported function explicit parameter and return types. Let local variables be inferred.
- Model a value that can take several shapes as a union with a discriminating field, and handle every case; make the default branch a compile error with `never`.
- Prefer `readonly` properties and arrays for data that should not change after creation.
- Validate data from outside the program at run time. A type annotation on parsed JSON proves nothing.
- Use `undefined` for "absent" unless an interface you do not control requires `null`. Do not mix the two for one meaning.
- Prefer a union of string literals to an `enum`.

## Language

- Use `const` by default and `let` only when the binding is reassigned. Never `var`.
- Compare with `===` and `!==`.
- Use `??` for defaults and `?.` for optional access. Do not use `||` where `0`, `''` or `false` is a valid value.
- Do not mutate a parameter or shared object. Return a new value.
- Prefer `map`, `filter` and `for…of` to an index loop, and never use `for…in` on an array.

## Modules

- Use ES modules. Prefer named exports to a default export.
- Import types with `import type`.
- No import cycles. A module that needs two others to import each other is doing two jobs.
- Do not reach into another package's internal files. Import from its public entry point.

## Async

- Every promise is awaited, returned or explicitly handled. A floating promise is a defect.
- Use `async` and `await` instead of chained `then` calls.
- Run independent work together with `Promise.all`. Do not await in a loop unless order matters.
- Give every network and timer wait a timeout or a cancellation signal.

## Errors

- Throw `Error` objects, never strings or plain objects. Add a `cause` when wrapping.
- A caught value is `unknown`. Check what it is before reading its fields.
- Do not use an exception for an outcome the caller expects. Return a result the type system makes them handle.

## Node

- Read configuration from the environment in one place at start-up, validate it, and pass it on as values.
- Use the asynchronous file and network functions in request handlers. Synchronous ones block every request.
- Never pass unchecked input to a child process, a file path or a dynamic `import`.
````

- [ ] **Step 5: Write `catalog/rules/python.md`**

`catalog/rules/python.md`:

````markdown
---
name: python
description: Python standards - typing, functions, errors, data, packaging and pytest.
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python standards

## Style

- Follow PEP 8 as the project's formatter applies it. Do not hand-format around the tool.
- Use `snake_case` for functions and variables, `PascalCase` for classes, and `UPPER_CASE` for constants.
- Prefer f-strings for building text, except in logging calls, where you pass arguments so formatting is deferred.
- Use `pathlib.Path` for file paths, not string joining.
- Compare with `is` only for `None`, `True` and `False`. Use `==` for values.

## Typing

- Annotate every function's parameters and return type, including `-> None`.
- Use built-in generics (`list[str]`, `dict[str, int]`) and `X | None`, not the older `typing` aliases.
- Do not use `Any` to make the type checker quiet. Narrow with `isinstance`, or define a `Protocol`.
- Describe structured data with a `dataclass` or a typed model, not a bare `dict` or tuple.
- Keep the type checker clean. An ignore comment names the error code and says why.

## Functions and data

- Never use a mutable default argument. Default to `None` and create the value inside.
- Make arguments keyword-only once a function takes more than three, or when a boolean is passed.
- Return one type from a function. Do not return a value on one path and `None` on another without saying so in the type.
- Prefer a comprehension to a loop that appends, and a generator when the result is only iterated once.
- Mark data that should not change as frozen.
- Do not use module-level mutable state. Pass dependencies in.

## Errors

- Catch the narrowest exception that you can handle. Never a bare `except:`, and `except Exception` only at a top-level boundary that logs and re-raises or reports.
- Chain with `raise NewError(...) from err` so the cause is kept.
- Define a specific exception class for a failure callers need to tell apart.
- Use a `with` block for anything that must be closed or released.
- Do not use `assert` for checks that must run in production. Assertions can be switched off.

## Modules and packaging

- Use absolute imports. No wildcard imports.
- Importing a module has no side effects: no network, no file writes, no work at import time. Put a script's entry behind `if __name__ == "__main__":`.
- Declare dependencies in `pyproject.toml` and commit the lockfile the project uses.
- Do not read environment variables all over the code. Load settings once, validate them, and pass them on.

## Async

- Do not call blocking code from a coroutine. Use the async client, or hand the call to a worker thread.
- Every task you create is awaited or kept and cancelled. Do not drop the reference.

## Tests

- Write tests with pytest: plain functions, plain `assert`, one behavior per test.
- Share setup through fixtures, and keep each fixture small. Prefer `tmp_path` and `monkeypatch` to hand-rolled patching.
- Use `pytest.mark.parametrize` for the same check over several inputs.
- Assert on an exception with `pytest.raises` and check its message or type, not just that something was raised.
````

- [ ] **Step 6: Write `catalog/rules/php.md`**

`catalog/rules/php.md`:

````markdown
---
name: php
description: PHP standards - types, errors, classes, data access and security, with a section for Laravel projects.
paths:
  - "**/*.php"
---
# PHP standards

## Language

- Start every file with `declare(strict_types=1);`.
- Follow PSR-12 as the project's formatter applies it, and PSR-4 for where classes live.
- Declare a type for every parameter, return value and property. Use `?T` or a union when a value can be absent.
- Compare with `===` and `!==`. Never rely on loose comparison or type juggling.
- Use `readonly` properties and constructor promotion for value objects.
- Use an `enum` for a fixed set of values, not class constants or strings.
- Use `match` for a value-to-value mapping. It is strict and must be exhaustive.
- Do not use `@` to suppress errors, `extract`, `eval`, or variable variables.

## Structure

- One class per file. Make a class `final` unless it is designed to be extended.
- Inject what a class needs through its constructor. Do not call static helpers or a service locator from inside business logic.
- Keep controllers and command handlers thin: read input, call a service, return a response.
- Do not use static mutable state or global variables.
- Return typed objects or typed collections from services, not associative arrays whose keys the caller must guess.

## Errors

- Throw exceptions for failures. Do not return `false` or `null` to signal an error.
- Catch the specific exception type you can handle. Catch `Throwable` only at a top-level boundary that logs and reports.
- Define a domain exception class for a failure callers need to tell apart, and keep the original as `previous`.

## Data and security

- Use prepared statements with bound parameters for every query. Never interpolate a value into SQL.
- Escape output for the context it lands in. In templates, use the engine's escaping and never print raw input.
- Validate and cast request input at the boundary, into a typed object.
- Hash passwords with `password_hash` and check them with `password_verify`.
- Do not `unserialize` data from outside the program. Use JSON.
- Check the type, size and destination of an uploaded file, and store it outside the web root under a name you generate.

## Tests

- Write tests with the project's test framework, one behavior per test method, named for the behavior.
- Use data providers for the same check over several inputs.

## Laravel

These apply only when the project uses Laravel.

- Validate requests in a form request class, and use only the validated data.
- Never pass the whole request to `create` or `update`. Set `$fillable` and pass named fields.
- Put authorization in policies and call them from the controller or the form request.
- Prevent query-in-a-loop problems: eager-load relations with `with`, and enable lazy-loading prevention outside production.
- Keep business logic out of controllers, models' boot methods and templates. Put it in a service or an action class.
- Read configuration with `config()`. Call `env()` only inside files in the `config` directory.
- Wrap related writes in `DB::transaction`.
- Do slow work in queued jobs, and make each job safe to run twice.
- Return API responses through resource classes, not raw models.
- Change the schema only through migrations, and give each one a working `down`.
````

- [ ] **Step 7: Write `catalog/rules/java.md`**

`catalog/rules/java.md`:

````markdown
---
name: java
description: Java standards - types, immutability, errors, concurrency and tests, with a section for Spring projects.
paths:
  - "**/*.java"
---
# Java standards

## Language

- Use the language level the build declares, and its features: records for data carriers, sealed types for closed hierarchies, switch expressions, pattern matching.
- Make fields `private final` unless they must change. Make classes `final` unless they are designed for extension.
- Never return `null` for a collection or an array. Return an empty one.
- Return `Optional<T>` from a method that may have no result. Do not use `Optional` for fields or parameters.
- Do not pass or return `null` across a public method without saying so in the contract. Check arguments at the boundary with `Objects.requireNonNull`.
- Use generics fully. No raw types and no unchecked casts without a comment saying why it is safe.
- Override `equals` and `hashCode` together, or use a record.
- Use `var` only where the type is obvious from the right-hand side.
- Compare strings and objects with `equals`, and enums with `==`.

## Structure

- Program to interfaces at module boundaries, and to concrete classes inside them.
- Inject dependencies through the constructor. No field injection and no static singletons holding state.
- Keep a class to one responsibility. A class named Manager, Helper or Util is usually several.
- Return unmodifiable collections from a class that owns the data. Copy what you are handed if you keep it.
- Use `java.time` for dates and times, and `BigDecimal` for money.

## Errors

- Throw the most specific exception that fits. Use unchecked exceptions for programming errors and for failures the caller cannot recover from.
- Never catch `Exception` or `Throwable` except at a top-level boundary that logs and reports. Never leave a catch block empty.
- Keep the cause when wrapping: pass the original exception to the new one.
- Close resources with try-with-resources.
- Restore the interrupt flag when you catch `InterruptedException` and cannot rethrow it.

## Concurrency

- Prefer immutable objects and the `java.util.concurrent` classes to hand-written locking.
- Do not share a mutable object between threads without stating how access is guarded.
- Run tasks on an executor you can shut down. Do not create threads directly.
- Give every blocking call on another service a timeout.

## Logging and tests

- Log through the project's logging facade with parameter placeholders, not string concatenation. Never log secrets or personal data.
- Write tests with the project's test framework, one behavior per test, with a name that states it.
- Use parameterized tests for the same check over several inputs.

## Spring

These apply only when the project uses Spring.

- Use constructor injection. A class with one constructor needs no annotation on it.
- Keep controllers thin. They map requests to a service call and a response, and hold no business logic.
- Never expose a persistence entity in a request or a response. Map to and from separate request and response types.
- Validate request bodies with bean validation annotations and `@Valid`.
- Put `@Transactional` on service methods, not on controllers or repositories, and mark reads as read-only.
- Do not call a transactional or cached method from another method of the same class: the proxy is bypassed.
- Bind configuration to typed properties classes. Do not scatter `@Value` through the code.
- Handle errors in one place with a controller advice, and return one consistent error shape.
- Avoid loading relations lazily outside a transaction, and fetch what a use case needs in one query.
- Never build a query by concatenating input. Use parameters or derived query methods.
````

- [ ] **Step 8: Write `catalog/rules/csharp.md`**

`catalog/rules/csharp.md`:

````markdown
---
name: csharp
description: C# standards - nullability, async code, errors, data and tests, with a section for ASP.NET Core projects.
paths:
  - "**/*.cs"
  - "**/*.cshtml"
  - "**/*.razor"
---
# C# standards

## Language

- Keep nullable reference types enabled, and treat their warnings as errors. Do not silence one with `!` unless you say why.
- Use `PascalCase` for types, methods and properties, `camelCase` for locals and parameters, and prefix interfaces with `I`.
- Use records for data carriers and value objects. Use `init` or `required` properties instead of a settable property that should not change.
- Use file-scoped namespaces and one public type per file.
- Use `var` where the type is obvious from the right-hand side, and the explicit type otherwise.
- Prefer pattern matching and switch expressions to chains of `if` and casts.
- Mark classes `sealed` unless they are designed for inheritance.
- Use `decimal` for money, and `DateTimeOffset` with an injected time provider for the clock.
- Return an empty collection, never `null`, and expose `IReadOnlyList<T>` or `IEnumerable<T>` rather than a mutable list.

## Async

- Async all the way: never block on asynchronous work with `.Result`, `.Wait()` or `GetAwaiter().GetResult()`.
- Suffix asynchronous methods with `Async`, and return a task type. Use `async void` only for event handlers.
- Accept a `CancellationToken` in every asynchronous public method and pass it on to every call that takes one.
- Do not start work and forget it. Await it, or hand it to a background service that owns its lifetime.
- Do not wrap synchronous code in a thread-pool call to make it look asynchronous.

## Errors and resources

- Throw the most specific exception type. Validate arguments at public boundaries with the guard helpers the framework provides.
- Catch only what you can handle. Rethrow with `throw;` so the stack trace is kept.
- Never leave a catch block empty, and never catch the base exception type except at a top-level boundary that logs and reports.
- Dispose what you create with `using` or `await using`.

## Data

- Enumerate a query once. Materialize it when you need to read it more than once.
- Never build SQL by joining strings with input. Use parameters or the query provider.
- Do not load an entity only to read one field. Project to what you need.
- Read-only queries do not track changes.

## Structure and tests

- Depend on abstractions at module boundaries and inject them through the constructor. No service locator and no static mutable state.
- Log with message templates and named placeholders, not interpolated strings. Never log secrets or personal data.
- Write tests with the project's test framework, one behavior per test, arranged as setup, action and check.

## ASP.NET Core

These apply only when the project uses ASP.NET Core.

- Keep controllers and endpoint handlers thin: bind, validate, call a service, map the result.
- Never bind a request directly to a persistence entity, and never return one. Use separate request and response types.
- Validate every request model, and return problem details in one consistent shape for errors.
- Register services with the narrowest lifetime that works. Never inject a scoped service into a singleton.
- Bind configuration to typed options classes and validate them at start-up. Do not read configuration keys by string through the code.
- Require authorization by default, and opt endpoints out explicitly.
- Create HTTP clients through the client factory, with timeouts. Do not create one per call.
- Take the request's cancellation token in every handler and pass it down.
- Change the schema only through migrations kept in version control.
- Do slow work in a hosted background service or a queue, not inside the request.
````

- [ ] **Step 9: Write `catalog/rules/go.md`**

`catalog/rules/go.md`:

````markdown
---
name: go
description: Go standards - errors, interfaces, concurrency, packages and tests.
paths:
  - "**/*.go"
---
# Go standards

## Style

- Format with `gofmt` and keep `go vet` clean. Do not argue with the formatter.
- Use short names for short scopes and descriptive names for package-level identifiers. No underscores, no `Get` prefix on getters.
- Name a package for what it provides, in one lower-case word. Avoid `util`, `common` and `helpers`.
- Do not repeat the package name in its identifiers: `http.Server`, not `http.HTTPServer`.
- Make the zero value of a type useful, or provide a constructor and say so.
- Return early on error and keep the main path unindented.
- Document every exported identifier with a comment that starts with its name.

## Errors

- Check every error. Assign to `_` only with a comment saying why it is safe to ignore.
- Wrap an error with context using `fmt.Errorf("doing x: %w", err)`. Say what you were doing, not "failed to".
- Compare with `errors.Is` and `errors.As`, never by matching the message text.
- Handle an error once: either log it or return it, not both.
- Do not `panic` for a failure a caller could handle. Reserve it for states that mean the program is wrong.
- Return a nil error with a usable value, and a non-nil error with a zero value.

## Interfaces and types

- Accept interfaces, return concrete types.
- Define an interface where it is used, not where it is implemented, and keep it to the methods that user needs.
- Do not add an interface for a type with one implementation and no test double.
- Use a pointer receiver when the method changes the value or the value is large, and be consistent across a type's methods.
- Do not use `any` where a concrete type or a type parameter would do.

## Concurrency

- Pass `context.Context` as the first parameter of anything that does input, output or waits. Never store it in a struct.
- Never start a goroutine without knowing how it stops. Tie it to a context or a done channel, and wait for it.
- The sender closes a channel, never the receiver.
- Guard shared state with a mutex kept next to the data it protects, or confine the state to one goroutine.
- Use `errgroup` or a wait group to run and collect concurrent work. Do not sleep to wait for a goroutine.
- Run the tests with the race detector.

## Resources

- Close what you open with `defer`, immediately after checking the error from opening it.
- Check the error from closing something you wrote to.
- Give every outbound network call a timeout. Do not use the default HTTP client for calls that leave the process.
- Do not `defer` inside a long loop. Move the body into a function.

## Packages

- Keep `main` small: parse configuration, build dependencies, start, and handle shutdown.
- No package-level mutable state and no `init` functions with side effects. Pass dependencies in.
- Put code that other modules must not import under `internal`.
- Keep `go.mod` tidy, and commit `go.sum`.

## Tests

- Use table-driven tests with named cases run through `t.Run`.
- Mark helpers with `t.Helper()`, and use `t.Cleanup` and `t.TempDir` rather than manual teardown.
- Compare with the standard library or the project's chosen helper, and print both got and want on failure.
- Test through exported behavior. Put tests in the `_test` package when they need only the public interface.
````

- [ ] **Step 10: Write `catalog/rules/react.md`**

`catalog/rules/react.md`:

````markdown
---
name: react
description: React standards - components, state, effects, performance and accessibility.
paths:
  - "**/*.tsx"
  - "**/*.jsx"
---
# React standards

## Components

- Write function components. One component per file, named in `PascalCase`, with the file named after it.
- Keep a component to one job. When it fetches, decides and renders, split it.
- Give props an explicit type, and destructure them in the parameter list.
- Never define a component inside another component's body. It is recreated on every render and loses its state.
- Components and hooks are pure during render: no mutation of props, state or outside variables, and no side effects.
- Prefer composition through `children` and props to configuration flags that switch a component between modes.
- Do not pass a prop through more than two components that do not use it. Compose differently, or use context.

## State

- Keep state as close as possible to where it is used, and lift it only as far as the nearest common parent.
- Do not store what you can compute. Derive it during render from props and state.
- Never copy a prop into state unless it is explicitly an initial value, and name it that way.
- Never mutate state. Create a new object or array.
- Use the updater form, `setCount(c => c + 1)`, when the next state depends on the previous one.
- Use a reducer when several values change together or the next state depends on an action.
- Use context for values many components read and that change rarely. It is not a general state store.

## Effects

- Use an effect only to synchronize with something outside React: the network, the document, a subscription, a timer.
- Do not use an effect to compute a value from props or state, or to respond to a user event. Do the first during render and the second in the event handler.
- List every reactive value an effect reads in its dependency array. Never silence the lint rule.
- Return a cleanup function for every subscription, timer and listener.
- Guard asynchronous effects against a stale response: ignore or abort a request whose inputs have changed.

## Hooks

- Call hooks only at the top level of a component or a custom hook, never in a condition or a loop.
- Name custom hooks `useSomething`, and extract one when stateful logic is shared.
- Do not reach for a ref to hold a value that should cause a render.

## Lists and rendering

- Give list items a `key` that is stable and unique among siblings, from the data. Never the array index for a list that can reorder, grow or shrink.
- Render conditionally with a ternary or an early return. Beware `&&` with a number: `0` is rendered.
- Do not inject markup from a string. If you must, sanitize it first and say where it came from.

## Performance

- Measure before optimizing. Do not add memoization by default.
- Memoize a value or a callback only when it is expensive to make or its identity is a dependency of something else.
- Load large routes and rarely used components lazily.

## Accessibility and tests

- Use the right element: a button for an action, a link for navigation, a label for every input.
- Every interactive element works with the keyboard and shows focus.
- Test what the user sees and does, by role and text. Do not assert on component internals or implementation details.
````

- [ ] **Step 11: Write `catalog/rules/vue.md`**

`catalog/rules/vue.md`:

````markdown
---
name: vue
description: Vue standards - single-file components, reactivity, props and events, composables and templates.
paths:
  - "**/*.vue"
---
# Vue standards

These assume Vue 3. In a Vue 2 project, follow the project's existing component style instead.

## Components

- Write single-file components with `<script setup>` and the Composition API, in TypeScript where the project uses it.
- Name components with two or more words in `PascalCase`, and name the file the same.
- Order the blocks script, template, style, the same way in every file.
- Keep a component to one job. When it fetches, decides and renders, split it.
- Scope component styles with `scoped` or CSS modules. Do not leak styles to other components.

## Props and events

- Declare props with `defineProps` and full types. Mark what is required, and give the rest defaults.
- Never mutate a prop. Emit an event and let the parent change the value.
- Declare every event with `defineEmits`, with the type of its payload.
- Use `v-model` with `defineModel` for two-way values instead of a hand-written prop and event pair.
- Pass data down with props and up with events. Use provide and inject only for values many levels need.
- Do not reach into a child through a template ref to change its state. Expose a method deliberately, or use props.

## Reactivity

- Use `ref` for single values and `reactive` for objects you never replace. Pick one habit per project.
- Never destructure a reactive object or props without `toRefs` or a getter. The result is no longer reactive.
- Compute derived values with `computed`. A computed getter has no side effects and does not change state.
- Use a watcher only to cause an effect outside the component's state: a request, storage, the document. Do not use one to keep two pieces of state in step.
- Clean up what a watcher or lifecycle hook starts: timers, listeners, subscriptions.
- Guard asynchronous watchers against a stale response when their source changes again.

## Composables

- Extract shared stateful logic into a composable named `useSomething` that returns refs.
- Call composables only at the top level of `<script setup>` or another composable.
- A composable takes its inputs as arguments, refs or getters. It does not read a component's internals.

## Templates

- Keep templates declarative. Move anything longer than a simple expression into a computed value or a function.
- Give every `v-for` item a `:key` that is stable and unique, from the data. Never the index for a list that can reorder, grow or shrink.
- Never put `v-if` and `v-for` on the same element. Filter in a computed value, or wrap with a `<template>`.
- Do not use `v-html` with content you did not write. If you must, sanitize it first.
- Use the shorthand forms `:` and `@` consistently.

## State and routing

- Keep state local until two distant components need it. Then use the project's store.
- In a store, change state only through its actions, and keep derived values in getters.
- Load route components lazily, and guard routes that need a signed-in user in the router, not in the component.

## Accessibility and tests

- Use the right element: a button for an action, a link for navigation, a label for every input.
- Every interactive element works with the keyboard and shows focus.
- Test a component through what it renders and emits. Do not assert on its internal state.
````

- [ ] **Step 12: Write `catalog/rules/angular.md`**

`catalog/rules/angular.md`:

````markdown
---
name: angular
description: Angular standards - components, signals and RxJS, templates, dependency injection and tests.
paths:
  - "**/*.component.ts"
  - "**/*.component.html"
  - "**/*.service.ts"
  - "**/*.directive.ts"
  - "**/*.pipe.ts"
  - "**/*.module.ts"
---
# Angular standards

These follow current Angular. Where the project is on an older version, keep to the style its code already uses.

## Components

- Write standalone components. Do not add a new module to hold one.
- Use `ChangeDetectionStrategy.OnPush` for every component.
- Keep a component to presentation and wiring. Put data access and business rules in services.
- Follow the file naming the project uses, with one component, directive, pipe or service per file.
- Split a component that both fetches data and renders it into a container and a presentational part.
- Keep a selector prefix that is consistent across the application.

## Inputs, outputs and state

- Declare inputs and outputs with the `input()`, `output()` and `model()` functions in new code, and mark required inputs as required.
- Never mutate an input. Emit an output and let the parent change the value.
- Hold component state in signals. Derive values with `computed`, never by copying state.
- Use an `effect` only to synchronize with something outside the signal graph. Do not set other signals from one.
- Keep state local until two distant components need it. Then use a service or the project's store.

## RxJS

- Every subscription ends. Use the `async` pipe, `takeUntilDestroyed`, or convert to a signal, and never leave a manual subscription without teardown.
- Do not nest subscriptions. Combine with `switchMap`, `mergeMap`, `concatMap` or `combineLatest`, and choose the one whose cancellation behavior you want.
- Use `switchMap` for a request that a newer one replaces, such as search.
- Handle errors inside the inner stream, so one failure does not end the outer one.
- Expose observables from services as read-only. Keep subjects private.
- Do not subscribe in a service just to copy a value into a field.

## Templates

- Use the built-in control flow, `@if`, `@for` and `@switch`, in new templates.
- Give every `@for` a `track` expression that is stable and unique, from the data.
- Never call a method that does work from a template binding. Use a signal, a computed value or a pure pipe.
- Do not bind markup from a string unless it has been sanitized, and never bypass the sanitizer for content you did not write.
- Keep templates free of logic longer than a simple expression.

## Dependency injection and services

- Provide application-wide services in the root injector, and feature services where the feature is loaded.
- Inject with `inject()` or the constructor, consistently within a file.
- Depend on an abstraction or an injection token where a service has more than one implementation.
- Make HTTP calls only in services, type their responses, and handle shared concerns such as authentication in interceptors.

## Forms and routing

- Use typed reactive forms for anything beyond a single field, and keep validation in validators, not in the template.
- Load feature routes lazily, and protect routes with functional guards.
- Read route parameters as observables or signals, since a component can be reused across navigations.

## Types, accessibility and tests

- Keep strict TypeScript and strict template checking on. No `any` in component, service or template types.
- Use the right element: a button for an action, a link for navigation, a label for every input, and make every control work with the keyboard.
- Test components through the rendered output and user interaction, and test services with their HTTP calls replaced by the testing controller.
````

- [ ] **Step 13: Run the tests, then the suite**

Run: `npx vitest run tests/rule-content.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures.

Run: `node bin/forgeflow.js list --type rule`
Expected: ten lines, each starting `rule:` with `rule` in the second column.

- [ ] **Step 14: Commit**

```bash
npx prettier --write tests
git add catalog/rules tests/rule-content.test.js
git commit -m "Add ten rules packs"
```

---

### Task 8: `standards-reviewer`, and five review specialists in the flows

**Files:**
- Create: `catalog/agents/standards-reviewer.md`
- Modify: `catalog/skills/forge-full/SKILL.md`, `catalog/skills/forge-quick/SKILL.md`, `README.md`, `tests/specialist-content.test.js`, `tests/specialist-flow.test.js`
- Test: `tests/standards-reviewer.test.js` (create)

**Interfaces:**
- Consumes: `{{rules-location}}` in agent bodies (Task 3); `joins: review`; each adapter's `rulesLocation` and `agentDirs`.
- Produces: `agent:standards-reviewer`. The flows' review specialists become five, in the order of Global Constraints.

- [ ] **Step 1: Write `tests/standards-reviewer.test.js`**

`tests/standards-reviewer.test.js`:

```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { adapters } from '../src/adapters/index.js';
import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { capture, tmpDir } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const agent = catalog.get('agent:standards-reviewer');
const ORDER = [
  'security-reviewer',
  'performance-reviewer',
  'database-reviewer',
  'accessibility-reviewer',
  'standards-reviewer',
];

describe('standards-reviewer', () => {
  it('is a read-only review specialist on the balanced tier', () => {
    expect(agent).toMatchObject({
      access: 'read-only',
      modelTier: 'balanced',
      joins: 'review',
      requires: [],
    });
    expect(agent.stage).toBeUndefined();
  });

  it.each([
    'List the files in {{rules-location}}',
    'A folder that does not exist has none',
    'this includes the case where no pack is installed',
    'Do not report code the change did not touch',
    "the project's convention wins",
    "formatter or linter",
    'quote the rule',
    '**Standards used**',
    '**Not covered**',
    'Not your own preferences',
  ])('says: %s', (phrase) => {
    expect(agent.body).toContain(phrase);
  });

  it('uses no placeholder other than the rules location', () => {
    expect(agent.body.match(/\{\{[^{}]*\}\}/g)).toEqual(['{{rules-location}}']);
  });
});

describe('installed for each harness', () => {
  const io = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture() };
  const targets = Object.keys(adapters);
  const code = main(['add', 'standards-reviewer', '--target', targets.join(',')], io);

  it.each(targets)('%s names only its own rules folder', (target) => {
    expect(code).toBe(0);
    const { agentDirs, rulesLocation } = adapters[target];
    const extension = target === 'codex' ? 'toml' : 'md';
    const raw = readFileSync(
      join(io.cwd, agentDirs.project, `standards-reviewer.${extension}`),
      'utf8'
    );
    const text = target === 'codex' ? parseToml(raw).developer_instructions : raw;
    expect(text).toContain(`List the files in ${rulesLocation}.`);
    expect(text).not.toContain('{{');
    for (const other of targets.filter((name) => name !== target)) {
      expect(text, `${target} names ${other}`).not.toContain(adapters[other].rulesLocation);
    }
  });
});

describe('flows', () => {
  it.each(['forge-quick', 'forge-full'])('%s names five review specialists in order', (flow) => {
    const { body } = catalog.get(`skill:${flow}`);
    expect(body).toContain('Five optional agents each review one subject');
    expect(body).not.toContain('Four optional agents');
    const positions = ORDER.map((name) => body.indexOf(`\`${name}\``));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(catalog.get(`skill:${flow}`).requires).not.toContain('agent:standards-reviewer');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/standards-reviewer.test.js`
Expected: FAIL. `agent` is `undefined`, the install exits 2 with `unknown item "standards-reviewer"`, and both flows still say "Four optional agents".

- [ ] **Step 3: Write `catalog/agents/standards-reviewer.md`**

`catalog/agents/standards-reviewer.md`:

````markdown
---
name: standards-reviewer
description: Reviews a change against the coding standards packs installed in this project and gives an APPROVE or CHANGES_REQUESTED verdict, quoting the rule each finding breaks. Use on any diff once a rules pack is installed.
access: read-only
model-tier: balanced
joins: review
---
## Role

You check a change against the coding standards this project has installed. A finding exists only where an installed rule is broken, and you quote that rule. Your own preferences, and general correctness, belong elsewhere.

## Inputs

- The change to review, from the caller: a diff, a branch, or a list of files.
- If the caller names a run directory, read `01-requirement.md`, `03-plan.md`, `05-build.md`, `06-test.md` and, when present, `04-architecture.md` from it.
- The installed standards: each file in the rules folder is one pack.
- The repository. Use the project's version control to see the full diff.

## Procedure

1. Read the whole diff. If the change does not touch your subject, say so in one line and end with `VERDICT: APPROVE`. Your subject is code that an installed standards pack covers, so this includes the case where no pack is installed.
2. List the files in {{rules-location}}. A folder that does not exist has none.
3. Work out which packs apply. A pack says what it covers at its top: either all work, or file patterns, given in a line that starts `Applies to:` or in a `paths` or `globs` field. Read every pack that covers at least one changed file.
4. Check each line the change adds or alters against every rule of the packs that cover its file. Do not report code the change did not touch.
5. Before you report a broken rule, read the code around it. Where this project consistently does otherwise, the project's convention wins: report the difference as a note, not as a defect.
6. Skip anything the project's formatter or linter already checks.
7. For each finding, name the pack and quote the rule.
8. Give each finding a severity and decide the verdict. Request changes if there is any blocker or major finding.

## Output

Reply with these headings:

- **Standards used**: the packs you read, and which changed files each covered.
- **Findings**: each with severity, file and line, the pack and the rule quoted, and what to do. Severities are blocker (the broken rule makes the code wrong or unsafe), major (likely to cause a defect or real maintenance cost), minor (worth fixing, not required) and note (observation only).
- **Not covered**: changed files that no installed pack applies to.

End your reply with exactly one line: `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`.

## Limits

- Do not modify any file. You report; the builder fixes.
- Report only a broken rule you can quote from an installed pack. Not your own preferences, and not a rule from a pack that is not installed.
- Do not grade a rule as blocker or major only because it is a rule. Grade the effect of breaking it here.
- Stay in your subject. Leave defects that break no installed rule to the other reviewers.
- If you could not see the full change, say so and do not approve.
````

- [ ] **Step 4: Name five specialists in both flow skills**

In `catalog/skills/forge-full/SKILL.md` and in `catalog/skills/forge-quick/SKILL.md`, replace

```
Four optional agents each review one subject: `security-reviewer`, `performance-reviewer`, `database-reviewer` and `accessibility-reviewer`. The flow works without them.
```

with

```
Five optional agents each review one subject: `security-reviewer`, `performance-reviewer`, `database-reviewer`, `accessibility-reviewer` and `standards-reviewer`. The flow works without them.
```

- [ ] **Step 5: Update the phase 3a tests and the README for the eleventh specialist**

`tests/specialist-content.test.js`: in `EXPECTED`, add this row after the `accessibility-reviewer` row:

```js
  ['standards-reviewer', 'read-only', 'balanced', 'review'],
```

`tests/specialist-flow.test.js`: add `'standards-reviewer',` as the last element of `ORDER`; rename the test `the catalog marks exactly the four review specialists` to `the catalog marks exactly the review specialists the flows name`; rename `installs all ten into all four harnesses, and removes one` to `installs every specialist into all four harnesses, and removes one`; and in that test change `toHaveLength(9)` to `toHaveLength(specialists.length - 1)`.

`README.md`: in the Specialists table, add this row after the `accessibility-reviewer` row:

```markdown
| `standards-reviewer` | Reviews a change against the installed rules packs and gives a verdict | no |
```

In the same section replace "The four reviewers are also used by the flows." with "The five reviewers are also used by the flows.", and in the usage block replace the comment `# all ten specialists` with `# every specialist`.

- [ ] **Step 6: Run the tests, then the suite**

Run: `npx vitest run tests/standards-reviewer.test.js tests/specialist-content.test.js tests/specialist-flow.test.js tests/specialist-docs.test.js`
Expected: PASS, no failures.

Run: `npx vitest run`
Expected: PASS, no failures.

- [ ] **Step 7: Commit**

```bash
npx prettier --write README.md tests
git add catalog README.md tests
git commit -m "Add standards-reviewer and run it at REVIEW as the fifth specialist"
```

---

### Task 9: Documentation and manual checks

**Files:**
- Modify: `README.md`, `docs/verification.md`
- Test: `tests/rule-docs.test.js` (create)

**Interfaces:**
- Consumes: the real catalog.
- Produces: user documentation. No code changes.

- [ ] **Step 1: Write `tests/rule-docs.test.js`**

`tests/rule-docs.test.js`:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const rules = [...catalog.values()].filter((item) => item.type === 'rule');

describe('README', () => {
  const readme = read('README.md');

  it.each(rules.map((rule) => rule.name))('lists the rules pack %s', (name) => {
    expect(readme).toMatch(new RegExp(`^\\| \`${name}\` +\\|`, 'm'));
  });

  it('says how to install a pack and where each harness keeps it', () => {
    expect(readme).toContain('## Rules packs');
    expect(readme).toContain('forgeflow add common typescript --target');
    for (const path of [
      '.claude/rules/forgeflow/',
      '.cursor/rules/forgeflow-',
      '.codex/forgeflow/rules/',
      '.opencode/forgeflow/rules/',
      'AGENTS.md',
      'opencode.json',
    ]) {
      expect(readme, path).toContain(path);
    }
  });

  it('states the limits a user needs before relying on rules', () => {
    for (const phrase of [
      'AGENTS.override.md',
      'opencode.jsonc',
      'forgeflow:rules:start',
      'not available with `--global` on Cursor',
    ]) {
      expect(readme, phrase).toContain(phrase);
    }
  });

  it('explains how to add a rule to the catalog', () => {
    expect(readme).toContain('catalog/rules/<name>.md');
    expect(readme).toContain('`{{rules-location}}`');
  });
});

describe('verification checklist', () => {
  const checks = read('docs/verification.md');

  it('keeps the earlier checks and adds the rules ones', () => {
    for (const number of [1, 10, 11, 24, 25, 31, 32, 38]) {
      expect(checks, `check ${number}`).toMatch(new RegExp(`^\\| ${number} \\|`, 'm'));
    }
    expect(checks).toContain('## Rules packs');
    expect(checks).toContain('07-review-standards-reviewer.md');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/rule-docs.test.js`
Expected: FAIL. The README has no "Rules packs" section and the checklist stops at check 31.

- [ ] **Step 3: Edit `README.md`**

1. In the code block under "## Use", add after the `forgeflow add --specialists …` line:

```
forgeflow add common typescript --target claude  # rules packs
```

2. Insert this section immediately before the line `## Quality gates`:

````markdown
## Rules packs

A rules pack is a short file of coding standards for one stack. Install the ones your project uses; the harness then keeps them in front of the model for every task.

```bash
forgeflow add common typescript --target claude,codex
forgeflow list --type rule
```

| Pack | Covers | Applies to |
| --- | --- | --- |
| `common` | Naming, functions, errors, tests, security, comments, dependencies, version control | all work |
| `typescript` | TypeScript and JavaScript, Node | `.ts`, `.tsx`, `.js`, `.jsx` and the module variants |
| `python` | Typing, functions, errors, packaging, pytest | `.py`, `.pyi` |
| `php` | PHP, with a Laravel section | `.php` |
| `java` | Java, with a Spring section | `.java` |
| `csharp` | C#, with an ASP.NET Core section | `.cs`, `.cshtml`, `.razor` |
| `go` | Errors, interfaces, concurrency, packages, tests | `.go` |
| `react` | Components, state, effects, performance | `.tsx`, `.jsx` |
| `vue` | Single-file components, reactivity, composables | `.vue` |
| `angular` | Components, signals and RxJS, templates, dependency injection | Angular component, service, directive, pipe and module files |

The packs are a generic baseline. Where a pack and your project's established convention disagree, the pack itself says your convention wins. To make a rule your team's own, change it in the catalog; an edit to an installed copy is kept by `forgeflow update` but is not shared.

Install `standards-reviewer` to have a change checked against the installed packs. It quotes the rule each finding breaks, and the flows run it at REVIEW when it is installed.

### How each harness gets the rules

| Target | Rule files | Loaded by | Scoped to file types |
| --- | --- | --- | --- |
| `claude` | `.claude/rules/forgeflow/<name>.md` | Claude Code itself | yes |
| `cursor` | `.cursor/rules/forgeflow-<name>.mdc` | Cursor itself | yes |
| `codex` | `.codex/forgeflow/rules/<name>.md` | a block in `AGENTS.md` that lists them | the block says which files each pack is for |
| `opencode` | `.opencode/forgeflow/rules/<name>.md` | one entry in the `instructions` list of `opencode.json` | no: always loaded |

In `AGENTS.md`, forgeflow owns only the text between `<!-- forgeflow:rules:start -->` and `<!-- forgeflow:rules:end -->`, and rewrites it when you add or remove a pack. In `opencode.json` it adds one entry to `instructions` and touches nothing else, though the file is written back as two-space JSON. Removing the last pack takes the block or entry out again. If `AGENTS.md` is a symbolic link, forgeflow edits the file it points to and keeps the link.

### What rules do not do

- Rules are guidance. A model can ignore them; `standards-reviewer` checks, and it is a model too.
- On Codex the block asks the model to read the pack files. Nothing forces it to. An `AGENTS.override.md` in the repository root, or in `~/.codex/` for a global install, hides the block.
- On OpenCode every installed pack is in context for every task.
- forgeflow will not edit an `AGENTS.md` whose markers are damaged, an `opencode.json` it cannot parse, or a project that has only `opencode.jsonc`. It stops and prints the entry to add by hand, and carries on the next time it finds that entry there.
- Rules are not available with `--global` on Cursor, which keeps user-level rules in its settings.
- Claude Code, Cursor and OpenCode also read `AGENTS.md` in some setups, so in a project that has Codex installed too they may see the Codex block as well as their own rules.
````

3. Under "## Adding to the catalog", add these bullets after the bullet that begins "A skill body may use":

```markdown
- A rules pack is one file, `catalog/rules/<name>.md`, with an optional `paths` list of file patterns. Without `paths` it applies to all work. Keep it under 6,000 bytes.
- An agent body may use the same placeholders as a skill body, plus `{{rules-location}}` for where that harness keeps its rules packs.
```

and change the bullet "A skill body may use `{{agents-dir}}` and `{{global-agents-dir}}`." so that it begins "A skill or agent body may use `{{agents-dir}}` and `{{global-agents-dir}}`."

- [ ] **Step 4: Append to `docs/verification.md`**

Add at the end of the file:

```markdown

## Rules packs

Install two packs and the reviewer in the same scratch repository, which should contain a TypeScript file:

    forgeflow add common typescript standards-reviewer --target <harness>

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 32 | The harness starts with no warning about the rule files, `AGENTS.md` or `opencode.json` | | | | |
| 33 | Ask "which coding standards apply when you edit a .ts file here?" The answer quotes a rule from the `typescript` pack and one from `common` | | | | |
| 34 | Ask the same about a `.md` file. The answer uses `common` only (not OpenCode, which always loads every pack) | | | | |
| 35 | Ask the agent to add a function that uses `any` in a `.ts` file. It avoids `any`, or says the standards forbid it | | | | |
| 36 | Ask "use the standards-reviewer agent on the last commit" after committing a `.ts` file that uses `var`. Its findings name the pack and quote the rule | | | | |
| 37 | A quick-flow run with `standards-reviewer` installed creates `07-review-standards-reviewer.md` | | | | |
| 38 | `forgeflow remove common typescript --target <harness>` leaves `AGENTS.md` and `opencode.json` as they were before, or gone if forgeflow created them | | | | |

Check 33 is the one that shows whether the rules reach the model at all. On Codex it also shows whether the model follows the pointer in `AGENTS.md`: record what it did.

Two more checks test assumptions the automated tests cannot confirm:

| # | Check | Harness |
|---|---|---|
| 39 | After `forgeflow add common --target opencode --global`, check 33 passes in a project with no rules of its own. This shows OpenCode expands `~` in an `instructions` entry | OpenCode |
| 40 | The installed `.cursor/rules/forgeflow-typescript.mdc` shows in Cursor's rules settings as applying to specific files, with its patterns listed | Cursor |

If check 39 fails, replace `~` in the global entry with the full path and record it in the README. If check 40 fails, compare the file's frontmatter with a rule created in Cursor itself.
```

- [ ] **Step 5: Format, lint and run everything**

Run: `npx prettier --write README.md tests/rule-docs.test.js`

Run: `npx vitest run`
Expected: PASS, no failures.

Run: `npm run lint`
Expected: exit 0, no warnings.

Run: `npx prettier --check README.md src tests bin`
Expected: `All matched files use Prettier code style!`

Run: `node bin/forgeflow.js doctor`
Expected: `catalog is valid (39 items)`.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/verification.md tests/rule-docs.test.js
git commit -m "Document rules packs and add their manual checks"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| 2. Success criteria 1, 2, 3 | 4, 5 |
| 2. Success criterion 4 | 2, 7 |
| 2. Success criteria 5, 6 | 3, 8 |
| 3. The packs | 7 |
| 4. Catalog | 1 |
| 5.1 Claude Code, 5.2 Cursor | 2 |
| 5.3 Codex, 5.4 OpenCode | 2, 5 |
| 6. Editing files the user owns | 4, 5 |
| 7. Placeholders | 3 |
| 8. `standards-reviewer` | 8 |
| 9. CLI | 1, 6 |
| 10. Limits | 9 (README) |
| 11. Error handling | 1, 2, 3, 4, 5 |
| 12. Testing | every task; manual checks in 9 |
