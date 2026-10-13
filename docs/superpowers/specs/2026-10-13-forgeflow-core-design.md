# forgeflow core — design spec (phase 1 of 4)

Date: 2026-10-13
Status: awaiting review

## 1. Purpose

forgeflow is an internal Wishtree pack of ready-to-use coding agents and
development flows that installs into the AI coding harnesses our teams use:
Claude Code, Codex, OpenCode and Cursor.

A developer should be able to:

- install one agent they need (`forgeflow add reviewer --target cursor`), or
- install a whole flow (`forgeflow add --flow full --target claude`), and
- get the same behavior from the same agent in whichever harness they use.

forgeflow does not call an LLM API. The harness runs the agents. forgeflow
only authors, compiles and installs their definitions. This is the difference
from `wishtree-adlc` and `LangGraph-ADLC`, which are standalone runners.

### Phases

| Phase | Scope | Spec |
|---|---|---|
| 1 | Canonical format, catalog, CLI, four adapters, flow agents, quick and full flows | this document |
| 2 | Quality-gate hooks compiled to all four hook systems | later |
| 3 | Specialist agents and rules packs | later |
| 4 | Session memory and context tools | later |

### Out of scope for phase 1

- Hooks of any kind. Gates are instruction-level until phase 2.
- Rules packs, specialist agents, memory, context tooling.
- A Claude Code plugin marketplace entry.
- Publishing to the public npm registry.
- Harnesses other than the four above. The adapter interface must allow
  adding one without touching the core.

## 2. Success criteria

1. `forgeflow add <agent> --target <harness>` writes a valid native agent
   file for each of the four harnesses, and the harness lists the agent.
2. `forgeflow add --flow quick|full --target <harness>` installs the flow
   skill and every agent it requires, and the flow can be started in that
   harness.
3. `forgeflow remove` deletes exactly the files forgeflow wrote and nothing
   else. `forgeflow update` rewrites them from the current catalog.
4. A file the user edited after install is never silently overwritten or
   deleted.
5. Adding a fifth harness requires one new adapter module and one registry
   line.
6. Catalog validation and every adapter are covered by automated tests that
   run without any harness installed.

## 3. Architecture

Approach: one canonical source per item, compiled to the native format at
install time.

```
catalog/ (canonical Markdown)
   │  load + validate
   ▼
Catalog ──► Resolver ──► Adapter(target) ──► Planner ──► Applier
              (requires)   (render files)     (diff vs    (write files,
                                               lockfile)   update lockfile)
```

Units and their single responsibilities:

| Unit | File | Does | Depends on |
|---|---|---|---|
| Frontmatter | `src/frontmatter.js` | Split and parse `---` YAML frontmatter and body | `yaml` |
| Catalog | `src/catalog.js` | Load `catalog/`, validate every item, return items by id | Frontmatter |
| Resolver | `src/resolve.js` | Expand requested ids to the full set via `requires`; detect unknown ids and cycles | Catalog |
| Adapters | `src/adapters/<target>.js` | Pure function: item + scope → list of `{path, content}` | nothing |
| Adapter registry | `src/adapters/index.js` | Map target name → adapter | Adapters |
| Lockfile | `src/lock.js` | Read and write the install record, hash content | `node:crypto` |
| Planner | `src/plan.js` | Compare rendered files with disk and lockfile; produce actions | Lockfile |
| Applier | `src/apply.js` | Execute actions on the filesystem | `node:fs` |
| CLI | `src/cli.js`, `bin/forgeflow.js` | Parse arguments, call the above, print results | all |

Adapters are pure and do no I/O, so they are tested by comparing output
strings. Only Applier and Lockfile touch the filesystem.

Stack: Node 20+, ESM JavaScript, `vitest`, `oxlint`, `prettier` (the same
toolchain as `wishtree-adlc`). Runtime dependencies: `yaml` only. Argument
parsing uses `node:util.parseArgs`. TOML output for Codex is produced by a
small local serializer, because only flat string keys and one multi-line
string are needed.

### Repository layout

```
forgeflow/
  bin/forgeflow.js
  src/
    cli.js  catalog.js  frontmatter.js  resolve.js
    plan.js apply.js    lock.js         doctor.js
    adapters/index.js claude.js codex.js opencode.js cursor.js
  catalog/
    agents/<name>.md
    skills/<name>/SKILL.md
  tests/
  docs/
  package.json
```

## 4. Canonical format

Two item types exist in phase 1: `agent` and `skill`. An item's id is
`<type>:<name>`. On the command line a bare name is accepted when it is
unambiguous.

### Agent — `catalog/agents/<name>.md`

```markdown
---
name: reviewer
description: Reviews a change for correctness, security and maintainability. Use after BUILD and VERIFY, or on any diff.
stage: review
access: read-only
model-tier: strong
requires: []
---
<system prompt body>
```

| Field | Required | Values | Meaning |
|---|---|---|---|
| `name` | yes | `[a-z][a-z0-9-]{0,62}`, equal to the file name | Identifier |
| `description` | yes | 1–1024 characters | When the harness should delegate to this agent |
| `stage` | no | one of the 12 stage names in lower case, or omitted | Flow stage it serves; omitted for standalone agents |
| `access` | yes | `read-only`, `write` | Whether the agent may modify files or run mutating commands |
| `model-tier` | no | `fast`, `balanced`, `strong`; default `balanced` | Neutral capability hint |
| `requires` | no | list of item ids | Items that must be installed with this one |

The body is harness-neutral prose. It must not name harness-specific tools
(`Edit`, `apply_patch`). It refers to capabilities: "read files", "run the
project's test command".

### Skill — `catalog/skills/<name>/SKILL.md`

Uses the Agent Skills format, which all four harnesses read natively:

```markdown
---
name: forge-quick
description: Run the forgeflow quick flow (DEFINE, PLAN, BUILD, VERIFY, REVIEW, SHIP) for a change.
user-invocable-only: true
requires: [agent:requirement-analyst, agent:planner, agent:builder, agent:tester, agent:fixer, agent:reviewer, agent:release-gate]
---
<orchestration instructions>
```

`requires` and `user-invocable-only` are forgeflow fields. Adapters strip
them and emit the harness's own equivalent. Other files in the skill folder
are copied unchanged.

### Validation

The catalog fails to load, with the file path and field named, when:
a required field is missing; a value is outside its allowed set; `name` does
not match the file or folder name; two items share an id; a `requires` entry
names an unknown item; `requires` forms a cycle.

## 5. Adapters

Interface:

```js
// src/adapters/<target>.js
export const name = "claude";
export function root(scope, { cwd, home }) → string      // base directory
export function render(item, { scope, version }) → [{ path, content }] // path relative to root
```

`scope` is `project` (default) or `global` (`--global`).

### Output paths

| Target | Agent | Skill | Project root | Global root |
|---|---|---|---|---|
| `claude` | `.claude/agents/<n>.md` | `.claude/skills/<n>/SKILL.md` | cwd | `~` |
| `codex` | `.codex/agents/<n>.toml` | `.agents/skills/<n>/SKILL.md` | cwd | `~` |
| `opencode` | `.opencode/agents/<n>.md` | `.opencode/skills/<n>/SKILL.md` | cwd | `~/.config/opencode/` (paths drop the `.opencode/` prefix) |
| `cursor` | `.cursor/agents/<n>.md` | `.cursor/skills/<n>/SKILL.md` | cwd | `~` |

Each target writes only to its own directories, although some harnesses also
read others' (Cursor reads `.claude/agents`). This keeps `remove` exact and
avoids duplicate agents when two targets are installed in one project.

### Field mapping for agents

| Canonical | claude | codex | opencode | cursor |
|---|---|---|---|---|
| `name` | `name` | `name` | file name | `name` |
| `description` | `description` | `description` | `description` | `description` |
| body | Markdown body | `developer_instructions` | Markdown body | Markdown body |
| `access: read-only` | `tools: Read, Grep, Glob, Bash` | `sandbox_mode = "read-only"` | `permission: { edit: deny }` | `readonly: true` |
| `access: write` | `tools` omitted (inherit) | `sandbox_mode = "workspace-write"` | no `permission` block | `readonly: false` |
| `model-tier` | `model: haiku / sonnet / opus` | omitted | omitted | omitted |
| (fixed) | — | — | `mode: subagent` | — |

Codex, OpenCode and Cursor agents inherit the session model, because model
ids there depend on the provider each developer has configured. `stage` and
`requires` are never emitted.

On Claude Code, a read-only agent keeps `Bash` so it can run tests and
`git diff`; its prompt states that it must not modify files. True
enforcement there arrives with phase 2 hooks.

### Field mapping for skills

| Canonical | claude | codex | opencode | cursor |
|---|---|---|---|---|
| `name`, `description` | same | same | same | same |
| `user-invocable-only: true` | `disable-model-invocation: true` | omitted | `metadata: { "opencode/autoinvoke": "false", "opencode/slash": "true" }` | `disable-model-invocation: true` |

### Generated-file marker

Every rendered file carries a marker so a human can tell it is managed:
a `# managed by forgeflow` comment as the first line of TOML, and an HTML
comment `<!-- managed by forgeflow: <id>@<version> -->` as the last line of
Markdown bodies.

## 6. Lockfile, planning and safety

The lockfile is `.forgeflow/lock.json` under the project root, or
`~/.forgeflow/lock.json` for `--global`:

```json
{
  "version": 1,
  "forgeflow": "0.1.0",
  "targets": {
    "cursor": {
      "items": {
        "agent:reviewer": {
          "explicit": true,
          "files": [{ "path": ".cursor/agents/reviewer.md", "sha256": "…" }]
        }
      }
    }
  }
}
```

`explicit` is true when the user named the item and false when it came in
through `requires`.

The planner classifies each rendered file:

| Disk state | Lockfile | Action |
|---|---|---|
| absent | — | `create` |
| present, content identical to the rendered file | any | `skip` (and recorded in the lockfile) |
| present, hash equals lockfile hash | recorded | `update` if content differs, else `skip` |
| present, hash differs from lockfile hash | recorded | `conflict` (user edited it) |
| present | not recorded | `conflict` (not ours) |

Rules:

- If any action is a `conflict`, nothing is written and the command exits 1
  listing the files. `--force` overwrites them.
- `remove <id>` deletes the item's recorded files whose hash still matches,
  reports edited ones and leaves them in place unless `--force`, then drops
  the lockfile entry. Items with `explicit: false` that no remaining item
  requires are removed too. Emptied directories that forgeflow created are
  removed.
- `remove` refuses an item that another installed item requires, and names
  the dependent.
- `--dry-run` on `add`, `update` and `remove` prints the plan and writes
  nothing.
- Writes go to a temporary file and are renamed into place. The lockfile is
  written last, so an interrupted run never leaves a lockfile that claims
  files which do not exist. Re-running the same command finishes the job:
  files already written are identical to the rendered ones and are adopted.

## 7. CLI

```
forgeflow list [--type agent|skill] [--json]
forgeflow info <id>
forgeflow add <id…> --target <t>[,<t>…] [--global] [--dry-run] [--force]
forgeflow add --flow quick|full --target <t>[,<t>…]   # alias for skill:forge-quick / skill:forge-full
forgeflow remove <id…> --target <t>[,<t>…] [--global] [--dry-run] [--force]
forgeflow update [<id…>] [--target <t>[,<t>…]] [--global] [--dry-run] [--force]
forgeflow status [--global]
forgeflow doctor
```

- `--target` is required for `add` and `remove`. There is no auto-detection,
  so an install never lands in an unexpected harness. `update` without
  `--target` covers every target in the lockfile.
- `list` shows id, stage, access and description. `status` shows what is
  installed per target and flags edited or missing files.
- `doctor` checks the Node version, that the catalog validates, and that
  every lockfile entry matches disk.
- Exit codes: 0 success, 1 conflict or failed check, 2 usage error (unknown
  id, unknown target, missing flag). Errors go to stderr as one line naming
  what is wrong and what to do.

Distribution: private Git repository. Developers run
`npx github:<org>/forgeflow …` or clone and `npm link`.

## 8. Flow content

### Agents

| Agent | Stage | Access | Tier | Produces |
|---|---|---|---|---|
| `requirement-analyst` | requirement | read-only | balanced | Structured requirement: goals, functional and non-functional requirements, acceptance criteria, open questions |
| `analyzer` | analyze | read-only | strong | Feasibility, affected code, risks, dependencies, effort |
| `planner` | plan | read-only | strong | Ordered tasks, each with files and a verification step |
| `architect` | architect | read-only | strong | Components, interfaces, data flow, key decisions with rationale |
| `builder` | build | write | balanced | Implementation of the plan, plus a change summary |
| `tester` | test | write | balanced | Tests for the acceptance criteria, the test run, a PASS/FAIL verdict with failures |
| `fixer` | fix | write | balanced | Minimal fix for reported failures, with root cause |
| `reviewer` | review | read-only | strong | Findings by severity, verdict APPROVE / CHANGES_REQUESTED |
| `release-gate` | release_gate | read-only | balanced | GO / NO_GO checklist: tests, review findings, breaking changes, version, changelog |
| `deployer` | deploy | write | balanced | Executes the project's documented release steps, records what ran |
| `feedback` | feedback | read-only | fast | Run retrospective and follow-up requirements |

HUMAN_APPROVAL is a gate in the flow skill, not an agent.

Every agent works standalone: given only a user request, it does its job and
returns its result in the conversation. When the caller supplies a run
directory, it also reads the earlier stage files from it. The flow skill,
not the agent, saves each stage's result to the run directory, because
read-only agents cannot write files. This is what makes per-agent install
useful.

Each agent prompt has the same sections: role, inputs, procedure, output
format, and limits (what it must not do, and when to stop and report instead
of guessing).

### Run directory

A flow run writes to `.forgeflow/runs/<YYYYMMDD-HHMM>-<slug>/`:

```
00-request.md   01-requirement.md  02-analysis.md   03-plan.md
04-architecture.md  05-build.md    06-test.md       07-review.md
08-release-gate.md  09-approval.md 10-deploy.md     11-feedback.md
state.md
```

`state.md` records the mode, current stage, fix-loop count and each stage's
verdict. The flow skill updates it after every stage, so a run can be
resumed in a new session or another harness by pointing the flow at the run
directory. Quick mode writes only the files for the stages it runs.

forgeflow never edits `.gitignore`. The flow skill tells the user the run
directory path and that committing it is their choice.

### Flow skills

Both are instructions to the harness's main thread, which delegates each
stage to the named subagent and passes it the run directory. Subagents do
not spawn subagents.

`forge-full`:

```
REQUIREMENT → ANALYZE → PLAN → ARCHITECT → BUILD → TEST ⇄ FIX → REVIEW
            → RELEASE_GATE → HUMAN_APPROVAL → DEPLOY → FEEDBACK
```

`forge-quick`:

| Phase | Agents |
|---|---|
| DEFINE | `requirement-analyst` |
| PLAN | `planner` |
| BUILD | `builder` |
| VERIFY | `tester` ⇄ `fixer` |
| REVIEW | `reviewer` |
| SHIP | `release-gate`, then human confirmation |

Quick mode ends at a reviewed, gated change that the user has confirmed. It
does not deploy.

Control rules, identical in both skills:

1. Open questions from REQUIREMENT are put to the user before continuing.
2. TEST ⇄ FIX repeats until the tester reports PASS, at most 3 fix attempts.
   On the fourth failure the flow stops and reports the failures.
3. REVIEW with CHANGES_REQUESTED returns to BUILD with the findings, at most
   2 times, then stops and reports.
4. RELEASE_GATE with NO_GO stops the flow and reports the failed checks.
5. HUMAN_APPROVAL: the flow presents the change summary, test result, review
   verdict and gate checklist, then stops and waits. It continues only on an
   explicit approval from the user in the conversation, and records the
   decision in `09-approval.md`. Nothing after this stage may run without it.
6. DEPLOY runs only steps the project documents. If none are documented, it
   stops and asks the user what deploying means for this project.
7. If a required agent is missing, the flow stops and prints the
   `forgeflow add` command that installs it.

In phase 1 these rules are enforced by instruction. Phase 2 adds hooks that
block DEPLOY when `09-approval.md` does not record an approval.

## 9. Error handling

| Situation | Behavior |
|---|---|
| Invalid catalog item | Load fails; message names file and field; exit 1 |
| Unknown id or target | Message lists the valid ones; exit 2 |
| Conflict on write | Nothing written; files listed; exit 1; `--force` documented in the message |
| Lockfile unreadable or wrong version | Stop with exit 1 and say so; never overwrite it |
| No write permission on target path | Stop before writing anything; exit 1 |
| Multiple targets, one fails | Each target is planned first; if any plan has a conflict, no target is written |

## 10. Testing

- **Catalog**: every validation rule has a failing fixture; the real
  `catalog/` must load cleanly.
- **Resolver**: transitive requires, unknown id, cycle.
- **Adapters**: for each target, render one read-only agent, one write agent
  and one skill, and compare to expected strings. Codex output is parsed
  back with a TOML parser (dev dependency) to prove it is valid, including
  bodies containing quotes, backslashes and triple quotes.
- **Planner**: each row of the action table, plus files a newer catalog no
  longer renders (deleted when unedited, kept when edited).
- **CLI end to end**, in a temporary directory: add, re-add (all `skip`),
  edit a file then update (conflict, then `--force`), remove with shared
  dependencies, `--dry-run` writes nothing, multi-target atomicity.
- **Content lint**: every agent body has the five required sections and
  names no harness-specific tool; every `requires` in the two flow skills
  matches the agents the skill text refers to.

Checking that each harness actually loads the files is a manual step,
listed per harness in `docs/verification.md`, done once before the first
internal release. It is not automated in phase 1.

## 11. Decisions and their reasons

| Decision | Reason |
|---|---|
| Compile at install, not committed per-harness copies | One source of truth; no drift between four copies |
| Flows are skills, not slash-command files | The Agent Skills format is read natively by all four harnesses; Cursor is migrating commands to skills and Codex has deprecated custom prompts |
| Each target writes only its own directories | Exact removal; no duplicate agents when harnesses read each other's folders |
| `--target` is mandatory | No surprise writes into a harness the user did not choose |
| Neutral `access` and `model-tier` fields | Each harness expresses permissions and models differently; a neutral field keeps content portable |
| Instruction-level gates in phase 1 | Hooks differ most across harnesses and get their own phase |

## 12. References

- ECC reference repository: https://github.com/affaan-m/ecc
- Codex subagents and hooks: https://developers.openai.com/codex/subagents, https://developers.openai.com/codex/hooks
- Codex skills: https://developers.openai.com/codex/skills
- OpenCode agents, skills, plugins: https://opencode.ai/docs/agents/, https://opencode.ai/docs/skills/, https://opencode.ai/docs/plugins/
- Cursor subagents, skills, hooks: https://cursor.com/docs/subagents, https://cursor.com/docs/context/skills, https://cursor.com/docs/hooks
