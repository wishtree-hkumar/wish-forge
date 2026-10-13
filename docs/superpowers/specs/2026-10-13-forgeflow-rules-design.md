# forgeflow rules packs and standards reviewer — design spec (phase 3b of 4)

Date: 2026-10-13
Status: awaiting review
Builds on: `2026-10-13-forgeflow-core-design.md` (phase 1),
`2026-10-13-forgeflow-hooks-design.md` (phase 2) and
`2026-10-13-forgeflow-specialists-design.md` (phase 3a)

## 1. Purpose

Agents and flows say how to do a piece of work. Rules packs say what good
code looks like in a stack, and stay in force for every task. Phase 3b adds:

- a `rule` catalog type, compiled to each harness's own rules mechanism;
- ten rules packs, each installable on its own;
- one agent, `standards-reviewer`, that reviews a change against whichever
  packs are installed and joins the flows at REVIEW.

### Out of scope

- A language expert agent per stack. `standards-reviewer` replaces them.
- Per-project overrides or settings for a pack. A team changes the catalog.
- Stacks other than the ten below.
- User-level rules on Cursor, which has no rule files outside a project.
- Enforcing rules. Rules are guidance to the model; gates are phase 2.
- Memory and context tools (phase 4).

## 2. Success criteria

1. `forgeflow add common typescript --target <harness>` makes both packs
   reach the model on all four harnesses, and `forgeflow remove` takes them
   out and leaves the user's own instructions exactly as they were.
2. forgeflow changes nothing in `AGENTS.md` outside its own marked block, and
   nothing in `opencode.json` except its own `instructions` entry.
3. forgeflow never rewrites an `AGENTS.md` whose markers are damaged or an
   `opencode.json` it cannot parse. It stops and says what to add by hand.
4. Where the harness supports it (Claude Code, Cursor), a stack pack applies
   only to that stack's files.
5. `standards-reviewer` reads only the packs installed for the harness it
   runs in, and cites the pack and rule for each finding.
6. With `standards-reviewer` installed, a flow runs it at REVIEW like the
   other review specialists. With it absent, the flows are unchanged.

## 3. The packs

| Rule | Covers | Applies to |
|---|---|---|
| `common` | Naming, functions, errors, tests, security, comments, dependencies, version control | all work |
| `typescript` | TypeScript and JavaScript, Node | `**/*.ts`, `**/*.tsx`, `**/*.mts`, `**/*.cts`, `**/*.js`, `**/*.jsx`, `**/*.mjs`, `**/*.cjs` |
| `python` | Python: typing, packaging, pytest | `**/*.py`, `**/*.pyi` |
| `php` | PHP, with a Laravel section | `**/*.php` |
| `java` | Java, with a Spring section | `**/*.java` |
| `csharp` | C#, with an ASP.NET Core section | `**/*.cs`, `**/*.cshtml`, `**/*.razor` |
| `go` | Go | `**/*.go` |
| `react` | React components and hooks | `**/*.tsx`, `**/*.jsx` |
| `vue` | Vue single-file components | `**/*.vue` |
| `angular` | Angular components, services, templates | `**/*.ts`, `**/*.html` (the pack says it applies only in an Angular project; current Angular no longer names files `*.component.ts`) |

Content contract for every pack:

- The body starts with one `# ` heading and groups its rules under `## `
  headings. Each rule is one bullet: specific, and checkable by reading code.
- At most 6,000 bytes, because some harnesses keep it in context always.
- No harness-specific tool names, and no rule a formatter or linter already
  settles ("use the project's formatter" is the rule, not its settings).
- Framework sections say they apply only when the project uses the framework.
- `common` states that where a pack and the project's established convention
  disagree, the project's convention wins. `standards-reviewer` honours this.

Packs do not require one another. The packs are a generic baseline written
for this project, not a record of any team's existing standards.

## 4. Catalog

A rule is one file, `catalog/rules/<name>.md`:

```yaml
---
name: typescript
description: TypeScript and JavaScript standards.
paths:
  - "**/*.ts"
  - "**/*.tsx"
---
```

- `name`, `description` and `requires` follow the rules for every item.
- `paths` is optional. When present it is a non-empty list of non-empty
  strings. When absent the rule applies to all work.
- The item id is `rule:<name>`. A bare name resolves across agents, skills,
  hooks and rules, and is ambiguous if two types share it.
- Rule bodies are not placeholder-filled.

## 5. Harness integration

| Harness | Rule file | Loaded by | Scoped to `paths` | `--global` |
|---|---|---|---|---|
| Claude Code | `.claude/rules/forgeflow/<name>.md` | the harness | yes | `~/.claude/rules/forgeflow/` |
| Cursor | `.cursor/rules/forgeflow-<name>.mdc` | the harness | yes | refused |
| Codex | `.codex/forgeflow/rules/<name>.md` | a pointer block in `AGENTS.md` | by instruction | `~/.codex/`, block in `~/.codex/AGENTS.md` |
| OpenCode | `.opencode/forgeflow/rules/<name>.md` | an `instructions` entry in `opencode.json` | no | `~/.config/opencode/forgeflow/rules/`, entry in `~/.config/opencode/opencode.json` |

Every rule file ends with the forgeflow marker comment, like agents.

### 5.1 Claude Code

Frontmatter holds `paths` as a YAML list when the rule has paths, and nothing
otherwise (a rule without `paths` loads for every session).

### 5.2 Cursor

Frontmatter: `description`; `globs` as one comma-separated string when the
rule has paths; `alwaysApply: true` when it has none, otherwise `false`.
`forgeflow add <rule> --target cursor --global` is a usage error that says
Cursor keeps user-level rules in its settings, not in files.

### 5.3 Codex

Codex reads only `AGENTS.md`, with a 32 KiB cap across all of them, so the
packs stay in their own files and `AGENTS.md` carries a short block:

```
<!-- forgeflow:rules:start -->
## Coding standards

These standards are installed by forgeflow. Before you write or review code, read each file below that applies to the files you are working on, and follow it.

- `.codex/forgeflow/rules/common.md`: all work
- `.codex/forgeflow/rules/typescript.md`: files matching `**/*.ts`, `**/*.tsx`
<!-- forgeflow:rules:end -->
```

- The list holds every rule installed for Codex at that scope, in name order.
  It is rewritten whenever a rule is added, updated or removed.
- At global scope the paths read `~/.codex/forgeflow/rules/<name>.md`.
- A rule that is installed but no longer in the catalog stays listed, by path
  only.
- Each Codex rule file starts with an `Applies to:` line carrying the same
  wording as its list entry.

### 5.4 OpenCode

forgeflow adds one string to the `instructions` list in `opencode.json`:
`.opencode/forgeflow/rules/*.md` at project scope,
`~/.config/opencode/forgeflow/rules/*.md` at global scope. The entry is the
same whichever rules are installed.

- A missing `opencode.json` is created as
  `{ "$schema": "https://opencode.ai/config.json", "instructions": [<entry>] }`.
- If `opencode.jsonc` exists and `opencode.json` does not, forgeflow refuses:
  it will not create a second config beside the first.
- OpenCode does not scope instruction files, so each OpenCode rule file
  starts with the same `Applies to:` line as on Codex.

## 6. Editing files the user owns

One set of rules for both `AGENTS.md` and `opencode.json`, matching the hook
wiring of phase 2.

**Merging**

- `AGENTS.md`: only the text from the start marker to the end marker is
  forgeflow's. A marker counts only when it is a whole line, so text that
  mentions one is left alone. With no block present, the block is appended after one blank
  line. With a block present, it is replaced in place. All other bytes are
  kept, including a byte-order mark; a file that uses CRLF gets the block in
  CRLF.
- `opencode.json`: the entry is appended to `instructions` if absent. No
  other key or entry is added, removed or reordered. The file is written back
  as two-space JSON.
- A rewritten file keeps its permissions.
- A file that is a symbolic link is edited through the link: the link stays,
  its target changes. If the target is outside the install root, forgeflow
  refuses.

**Refusing** (a `ConfigError`, before anything is written, and `--force` does
not override it)

- `AGENTS.md` with a start marker and no end marker, an end before a start,
  or more than one of either.
- `opencode.json` that is not valid JSON, is not an object, or whose
  `instructions` is not a list of strings.
- `opencode.jsonc` without `opencode.json`.

The message names the file and the problem, and for OpenCode prints the
entry to add by hand.

**Wired by hand.** If forgeflow cannot use the OpenCode config (it does not
parse, or only `opencode.jsonc` exists) but the file's text already contains
the entry in its `instructions` list (read as JSON with comments and trailing
commas allowed), forgeflow treats the rules as wired by the user: it installs
the rule files, leaves the config alone, reports the file as `by hand`, and
records it with `manual: true`. This is what makes the printed instruction
work on the next run. Removing rules is never stopped by an OpenCode config
forgeflow cannot edit: the rule files go, the config is left alone, and
forgeflow says which entry to take out by hand.

**Removing**

- Removing a rule while others remain rewrites the Codex block and leaves the
  OpenCode entry.
- Removing the last rule for a target removes the block, with the blank line
  forgeflow added, or the entry; an `instructions` list left empty is dropped.
  An `AGENTS.md` that did not end in a newline before forgeflow added its
  block ends in one afterwards.
- The file is deleted only if forgeflow created it and nothing else is left:
  an `AGENTS.md` with only whitespace, or an `opencode.json` holding only
  `$schema`.
- The block or entry is updated before rule files are deleted and after they
  are created, so it never points at files that are not there.

**Recording**

The lockfile records, per target, `rules: { path, created }` beside `items`.
`path` is validated like every lockfile path. Lockfile version stays 1:
older forgeflow versions ignore the key.

## 7. Placeholders

Phase 3a filled placeholders in skill bodies only. Phase 3b:

- adds the token `{{rules-location}}`;
- validates and fills all three tokens in agent bodies as well as skill
  bodies. Rule bodies, hook files and supporting skill files stay unfilled.

Each adapter exports `rulesLocation`, a phrase that reads correctly after
"in":

| Harness | `{{rules-location}}` |
|---|---|
| Claude Code | `` `.claude/rules/forgeflow` in the project and `~/.claude/rules/forgeflow` `` |
| Cursor | `` `.cursor/rules` in the project (the files named `forgeflow-*.mdc`) `` |
| Codex | `` `.codex/forgeflow/rules` in the project and `~/.codex/forgeflow/rules` `` |
| OpenCode | `` `.opencode/forgeflow/rules` in the project and `~/.config/opencode/forgeflow/rules` `` |

## 8. `standards-reviewer`

A read-only agent with `joins: review` and model tier `balanced`. It keeps
the review-specialist contract of phase 3a (same inputs, severities, verdict
line, "could not see the change" rule) with these differences:

- **Finding the standards.** It lists the files in `{{rules-location}}` and
  reads each pack whose `Applies to` or path patterns match the changed files,
  plus any pack that applies to all work.
- **No packs.** If none is installed, it says so in one line and ends with
  `VERDICT: APPROVE`.
- **Changed code only.** It reports a broken rule only in lines the change
  adds or alters, not in code that was already there.
- **Citing.** Each finding names the pack and quotes the rule.
- **Project convention wins.** Where the surrounding code consistently does
  otherwise, it reports the difference as a note, not a defect.
- **Not a linter.** It does not report what the project's formatter or linter
  already checks.

Both flow skills name it as the fifth review specialist, run last. Nothing
else in the flows changes: detection, reports (`07-review-standards-reviewer.md`),
the review loop and fail-closed behaviour are those of phase 3a.

## 9. CLI

- `forgeflow list --type rule` filters to rules. In the listing a rule shows
  `rule` in the stage column and `-` for access.
- `forgeflow info <rule>` prints `paths`, or `paths: all work`.
- `forgeflow list --json` rows gain `paths`.
- `forgeflow status` prints one line per target with a rules record:
  `rules ok|missing|unreadable <path>`. `forgeflow doctor` reports a state
  other than `ok` as a problem.
- `add`, `remove` and `update` print `wired` or `unwired` with the file's
  path when the block or entry changes, as for hook wiring.
- The usage text mentions rules. There is no "all rules" flag.

State: `ok` when the block is present with sound markers, or the entry is in
`instructions`; `missing` when it is not; `unreadable` when the file would be
refused under section 6.

## 10. Limits

- **Codex depends on the model.** The block asks the model to read the files.
  Nothing makes it do so.
- **Codex overrides.** A `~/.codex/AGENTS.override.md` hides the global
  block; an `AGENTS.override.md` at the repository root hides the project one.
- **OpenCode keeps every installed pack in context**, whatever is being
  edited, and the global entry relies on OpenCode expanding `~`.
- **Other harnesses read `AGENTS.md` too.** Claude Code (when there is no
  `CLAUDE.md`), Cursor and OpenCode read it, so in a project that also has
  Codex installed they see the pointer as well as their own rules.
- **Rules are guidance.** A model can ignore them; only `standards-reviewer`
  checks, and it is a model too.
- **Reformatting.** `opencode.json` is rewritten as two-space JSON.
- **Nested `AGENTS.md` files** are not touched: only the one at the install
  root.
- **Gates protect some rule files and not others.** With the phase 2 gates
  installed, an agent cannot edit rule files under `.codex/forgeflow/` or
  `.opencode/forgeflow/`, because that folder is protected. Rule files for
  Claude Code and Cursor live in the harness's own rules folder and are not.

## 11. Error handling

| Condition | Result |
|---|---|
| `paths` empty, not a list, or holding a non-string or empty string | Catalog error naming the file |
| Unknown placeholder in an agent or skill body | Catalog error |
| Rule with `--target cursor --global` | Usage error; nothing installed for any target |
| Damaged markers, unparsable `opencode.json`, lone `opencode.jsonc` | `ConfigError`; nothing written for any target |
| Symbolic link whose target is outside the install root | `ConfigError` |
| Rule file edited by the user | Existing conflict handling: kept unless `--force` |

## 12. Testing

- **Catalog**: rule loading; each invalid `paths` shape; a bare name shared by
  two types is ambiguous; placeholder validation in agent bodies.
- **Adapters**: each harness's rule file exactly, with and without `paths`,
  at both scopes; `rulesLocation`; agent bodies filled.
- **Block merging**: absent file, file without a block, file with a block,
  CRLF, byte-order mark, no trailing newline; every refused marker shape;
  strip restores the original bytes of a file that ended in a newline;
  idempotent.
- **`instructions` merging**: absent file, no key, existing entries kept in
  order, entry already present; every refused shape; strip; lone `.jsonc`.
- **Ops**: add one rule, add a second (Codex block grows, OpenCode entry
  unchanged), remove one, remove the last (file restored or deleted);
  refusal stops every target before any write; Cursor global refused;
  symbolic link edited through; update refreshes the block.
- **CLI**: list, info, status and doctor output.
- **Content**: every pack meets section 3's contract; `standards-reviewer`
  meets section 8's; both flows name five review specialists in order.

Loading in real harnesses is added to `docs/verification.md` as manual checks.

## 13. Decisions and their reasons

| Decision | Reason |
|---|---|
| One file per pack, not one per topic | A project installs a stack in one step; ten items stay easy to list |
| Pointer block for Codex, not inlined text | Codex caps `AGENTS.md` at 32 KiB in total |
| Explicit list in the block, not "read the folder" | One step for the model to follow instead of two |
| `instructions` entry for OpenCode | The harness loads the files itself; nothing depends on the model |
| One constant OpenCode entry | Adding a pack never edits the user's config again |
| Own subfolder or `forgeflow-` prefix for rule files | The user's own rules live beside them and stay untouched |
| Refuse rather than repair a damaged file | A file the user broke by hand should be fixed by the user |
| Edit through symbolic links | `AGENTS.md` is often a link to another instructions file; replacing the link would break that setup |
| One `standards-reviewer`, not an expert per stack | Ten near-identical agents; one works for packs added later |
| Placeholders in agent bodies | The reviewer must look only in its own harness's folder |
| No "all rules" flag | No project uses every stack |
| Record kept per target, not on an item | Unlike hook wiring there is no runtime item to carry it |
