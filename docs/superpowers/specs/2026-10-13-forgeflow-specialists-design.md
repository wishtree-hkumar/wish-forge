# forgeflow specialist agents — design spec (phase 3a of 4)

Date: 2026-10-13
Status: awaiting review
Builds on: `2026-10-13-forgeflow-core-design.md` (phase 1) and
`2026-10-13-forgeflow-hooks-design.md` (phase 2)

## 1. Purpose

The eleven flow agents each own one stage of a flow. Phase 3a adds ten
specialist agents that own a subject instead: security, performance,
databases, accessibility, API design, test strategy, dependencies, debugging,
documentation and refactoring. Each installs on its own and works outside a
flow. Four of them, the review specialists, are also run by the flows at
REVIEW when they are installed.

Phase 3 was split in two. This document is 3a. Phase 3b (a `rule` catalog
type, merging into `AGENTS.md`, rules packs for seven stacks and a language
expert agent per stack) gets its own spec.

### Out of scope

- Rules packs and language expert agents (phase 3b).
- Memory and context tools (phase 4).
- Running specialists at any flow stage other than REVIEW.
- Choosing specialists by what a change touches. A flow runs every installed
  review specialist; one whose subject the change does not touch says so.
- Giving specialists tools of their own (scanners, browsers, profilers). They
  use what the project and the harness already provide.

## 2. Success criteria

1. `forgeflow add security-reviewer --target <harness>` installs a valid
   native agent on all four harnesses, and `forgeflow remove` takes it out.
2. `forgeflow add --specialists --target <harness>` installs all ten.
3. With no specialist installed, a flow run does exactly what it does today.
4. With a review specialist installed, a flow runs it at REVIEW, saves its
   report, and returns to BUILD when it requests changes.
5. A flow never treats a review specialist that was run and gave no verdict
   as a pass.
6. The catalog and the two flow skills cannot disagree about which agents are
   review specialists: an automated test fails if they do.

## 3. The agents

| Agent | Produces | Access | Model tier | Joins REVIEW |
|---|---|---|---|---|
| `security-reviewer` | findings and a verdict | read-only | strong | yes |
| `performance-reviewer` | findings and a verdict | read-only | strong | yes |
| `database-reviewer` | findings and a verdict | read-only | strong | yes |
| `accessibility-reviewer` | findings and a verdict | read-only | balanced | yes |
| `api-designer` | an API design | read-only | strong | no |
| `test-strategist` | a test plan | read-only | balanced | no |
| `dependency-auditor` | an audit report | read-only | balanced | no |
| `debugger` | a root-cause report | read-only | strong | no |
| `docs-writer` | documentation changes | write | balanced | no |
| `refactorer` | behaviour-preserving code changes | write | balanced | no |

Every agent body has the five sections the flow agents have: Role, Inputs,
Procedure, Output, Limits. None has a `stage`.

### 3.1 Review specialists

The four review specialists share one contract so a flow can treat them alike:

- **Scope.** Each reviews its own subject only and leaves general correctness
  to `reviewer`.
- **Inputs.** The change, from the caller. When the caller names a run
  directory, the same files `reviewer` reads.
- **Findings.** The severities `reviewer` uses: blocker, major, minor, note.
  Each finding names a file and line, what is wrong and what to do.
- **Verdict.** The last line is exactly `VERDICT: APPROVE` or
  `VERDICT: CHANGES_REQUESTED`. Changes are requested when there is a blocker
  or major finding.
- **Nothing in scope.** When the change does not touch the subject (for
  example no database code), the agent says so in one line and approves.
- **Could not see the change.** The agent says so and does not approve.
- **No edits.** It reports; it changes no file.

Subjects:

- `security-reviewer`: untrusted input, authentication and authorization,
  secrets, injection, unsafe file and network access, cryptography misuse,
  dependency risk introduced by the change.
- `performance-reviewer`: algorithmic cost, queries in loops, unbounded
  memory or result sets, blocking calls on hot paths, missing pagination,
  caching mistakes. It asks for a measurement where a claim needs one; it
  does not guess numbers.
- `database-reviewer`: schema changes, migration safety (locks, backfills,
  reversibility, order against deploys), indexes, query correctness,
  transactions and isolation, data loss.
- `accessibility-reviewer`: semantic markup, keyboard operation, focus
  management, names and labels, contrast defined in code, motion, form
  errors. It reviews code and says plainly that it did not run the interface.

### 3.2 The other six

- `api-designer`: given a need, designs an interface (HTTP, RPC, library or
  command line) consistent with the project's existing ones. Output:
  resources or functions, request and response shapes, errors, versioning and
  compatibility notes, open questions. Changes no file.
- `test-strategist`: given a change or an area, says what to test at which
  level, the cases that matter, the gaps in existing tests, and what not to
  test. Changes no file.
- `dependency-auditor`: lists outdated, unmaintained, duplicated and unused
  dependencies and known advisories, using the project's own package-manager
  commands where they exist. Output: a ranked list with a recommended action
  for each. It installs, upgrades and removes nothing, and says when it could
  not reach an advisory source.
- `debugger`: given a failure, finds the root cause: reproduces it, narrows
  it, and states the cause with the evidence. Output: reproduction, cause,
  evidence, a proposed fix and how to confirm it. It does not apply the fix.
- `docs-writer`: writes or updates documentation for code that exists, in the
  project's own format and voice. It documents what the code does, verified
  by reading it, and changes no code.
- `refactorer`: restructures code without changing behaviour. It runs the
  tests before and after, works in small steps, stops and reports when the
  code has no tests covering what it would change, and adds no features.

## 4. Catalog

### 4.1 `joins`

Agents gain one optional frontmatter field:

```yaml
joins: review
```

- The only allowed value is `review`.
- An agent with `joins` must be `access: read-only` and must not have a
  `stage`. Anything else is a catalog error.
- The built item carries `joins` (`'review'` or `undefined`).

`stage` is already optional, so the other six specialists need no catalog
change.

### 4.2 The `{{agents-dir}}` placeholder

A flow needs to know whether a specialist is installed for the harness it is
running in. A project may have forgeflow installed for several harnesses, so
the skill cannot list every harness's folder: the skill installed for Claude
Code must look only in `.claude/agents`.

Skill bodies may contain the placeholder `{{agents-dir}}`. When an adapter
renders a skill, it replaces every occurrence with that harness's agents
folder, relative to the install root:

| Harness | Value |
|---|---|
| Claude Code | `.claude/agents` |
| Codex | `.codex/agents` |
| OpenCode | `.opencode/agents` |
| Cursor | `.cursor/agents` |

- Each adapter exports the value as `agentsDir`, and its agent output path is
  built from the same constant.
- The catalog rejects any other `{{…}}` token in a skill body, so a typo
  cannot ship as literal text.
- Agent bodies, supporting skill files and hook files are not substituted.

## 5. Flow changes

Both flow skills change the same way. Neither adds a specialist to its
`requires`: installing a flow still installs only the flow agents.

### 5.1 REVIEW stage

After delegating to `reviewer` and saving `07-review.md`, the orchestrator
handles the review specialists, in this order: `security-reviewer`,
`performance-reviewer`, `database-reviewer`, `accessibility-reviewer`.

1. **Installed?** A specialist is installed when a file named for it (any
   extension) exists in `{{agents-dir}}` in the project or in the user's home
   directory. The orchestrator checks by listing those folders.
2. **Run.** It delegates to each installed specialist with the run directory
   path and saves the full reply as `07-review-<agent name>.md`.
3. **Not installed.** It skips the specialist without comment and without
   telling the user to install it.
4. **Record.** It adds each verdict to the `stages` list in `state.md`, for
   example `security-reviewer: APPROVE`.

The orchestrator collects every verdict before deciding what happens next.

### 5.2 Control rules

- **Review loop.** The run returns to BUILD when `reviewer` or any specialist
  that ran ends with `VERDICT: CHANGES_REQUESTED`. The builder receives the
  findings of everyone who requested changes, together. After the rebuild and
  TEST, `reviewer` and every installed specialist run again, each replacing
  its own report file.
- **Limit.** `review returns` still counts rounds, not reviewers, and the
  limit of 2 stands.
- **Fail closed.** The existing rule already covers a reply with no verdict
  line. Its wording is extended to name the specialists, and to cover a
  specialist that is installed but cannot be delegated to: the flow stops and
  reports it.
- **Human approval.** The summary shown to the user lists each reviewer's
  verdict, not only `reviewer`'s.

### 5.3 `release-gate`

`release-gate` reads `07-review.md` today. It now also reads every
`07-review-*.md` in the run directory, and its review item passes only when
every one of them ends in APPROVE with no open blocker or major finding.

## 6. CLI

- `forgeflow add --specialists --target <t>` adds every agent that has no
  `stage`. It combines with item names, `--flow` and `--hooks`, and works
  with `--global`.
- `forgeflow list` prints `specialist` in the stage column for an agent with
  no stage (today it prints `-`). `--json` output gains `joins`.
- `forgeflow info <agent>` prints `joins` when set.
- The usage text and the "name at least one item" error mention
  `--specialists`.

Install, update, remove, status and doctor need no change: specialists are
ordinary agent items.

## 7. Limits

- **Detection is an instruction.** Whether a specialist is installed is
  decided by the orchestrating model reading a folder. No code enforces it. A
  model that skips the check runs the flow as if none were installed.
- **Specialists are prompts.** They find what a careful reader with the
  project's own tools finds. `security-reviewer` is not a scanner and
  `accessibility-reviewer` does not render the page.
- **Cost.** Each installed review specialist adds one subagent run to every
  review round, including when the change is outside its subject.
- **Same model, same blind spots.** A specialist is the harness's model with
  a narrower brief, not an independent check.
- **Plugins and other agent sources.** An agent with a specialist's name that
  comes from somewhere other than the agents folder (a plugin, for example)
  is not detected.

## 8. Error handling

| Condition | Result |
|---|---|
| `joins` has a value other than `review` | Catalog error naming the file |
| `joins` on an agent with `stage` or with `access: write` | Catalog error |
| Unknown `{{…}}` token in a skill body | Catalog error |
| `--specialists` with no `--target` | Same usage error as any `add` |
| Installed specialist returns no verdict, or cannot be run | Flow stops and reports (fail closed) |

## 9. Testing

- **Catalog**: `joins` accepted on a read-only agent with no stage; rejected
  with a bad value, with a stage, and with write access; unknown placeholder
  rejected; `{{agents-dir}}` accepted.
- **Adapters**: each harness renders a skill with the placeholder replaced by
  its own folder, in every occurrence; an agent body containing the same text
  is left alone; `agentsDir` matches the path agents are written to.
- **CLI**: `add --specialists` installs exactly the agents with no stage;
  combines with `--flow`; `list` shows `specialist`; `list --json` and `info`
  show `joins`.
- **Ops, end to end**: add and remove a specialist on all four harnesses;
  installing a flow does not install any specialist; the installed flow skill
  contains no unreplaced placeholder.
- **Content**: each of the ten agents has the five sections; the four review
  specialists carry `joins: review`, are read-only and name both verdict
  lines; the two write agents are exactly `docs-writer` and `refactorer`;
  both skills name exactly the agents that carry `joins: review` and the
  `07-review-<agent name>.md` file pattern; `release-gate` mentions
  `07-review-*.md`.

Whether each harness's model finds and runs installed specialists is added to
`docs/verification.md` as manual checks.

## 10. Decisions and their reasons

| Decision | Reason |
|---|---|
| Specialists are ordinary agent items | The whole install pipeline already works for them |
| Flows do not require specialists | Installing a flow stays the same size; the user chooses the extra cost |
| Detection by a file in the harness's own agents folder | Works for project and global installs, and for a project installed on several harnesses |
| Placeholder filled by the adapter | Only the adapter knows the harness's folder; the skill text stays one source |
| Not reading `.forgeflow/lock.json` to detect | It records project installs only, and one lock covers several harnesses |
| Every installed review specialist runs every round | No per-change selection logic to get wrong; the agent itself says "nothing in scope" |
| `joins` field in the catalog | One source for "which agents the flows call", checked against the skills by a test |
| An installed specialist that fails stops the flow | A security review that silently did not happen is worse than a stopped run |
| `debugger` reports and does not fix | The flow's `fixer` and the user decide on the change; the specialist stays safe to run anywhere |
| `--specialists` means "agents with no stage" | No list to maintain; phase 3b decides whether language experts belong under it |
