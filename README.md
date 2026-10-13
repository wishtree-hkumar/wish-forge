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
forgeflow add security-reviewer --target claude  # one specialist
forgeflow add --specialists --target claude      # every specialist
forgeflow add common typescript --target claude  # rules packs
forgeflow add --memory --target claude           # session memory
forgeflow status                                 # what is installed here
forgeflow update                                 # rewrite installed files from the current catalog
forgeflow remove reviewer --target cursor
```

| Option      | Meaning                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `--target`  | `claude`, `codex`, `opencode` or `cursor`. Required for `add` and `remove`. Separate several with commas. |
| `--global`  | Install for your user account instead of the current project.                                             |
| `--dry-run` | Show what would change and write nothing.                                                                 |
| `--force`   | Overwrite or delete files that you edited or that forgeflow did not install.                              |

forgeflow treats the directory you run it in as the project root.

## The flows

After installing a flow, start it inside your harness.

| Flow          | Stages                                                                                                                     | Start it with            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `forge-quick` | DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP                                                                             | `/forge-quick <request>` |
| `forge-full`  | REQUIREMENT → ANALYZE → PLAN → ARCHITECT → BUILD → TEST ⇄ FIX → REVIEW → RELEASE_GATE → HUMAN_APPROVAL → DEPLOY → FEEDBACK | `/forge-full <request>`  |

In Codex, start a flow by naming the skill: `$forge-quick <request>`.

The quick flow ends with a reviewed change you have confirmed; it does not deploy. The full flow stops at HUMAN_APPROVAL and continues to DEPLOY only when you approve in the conversation.

Each run keeps its stage outputs in `.forgeflow/runs/<date>-<slug>/`. Point a flow at that directory to resume a run in a new session or a different harness.

The stops in a flow are instructions to the model. Install the quality gates below to have the harness enforce them.

## The agents

| Agent                 | Stage        | Can change files |
| --------------------- | ------------ | ---------------- |
| `requirement-analyst` | REQUIREMENT  | no               |
| `analyzer`            | ANALYZE      | no               |
| `planner`             | PLAN         | no               |
| `architect`           | ARCHITECT    | no               |
| `builder`             | BUILD        | yes              |
| `tester`              | TEST         | yes (tests only) |
| `fixer`               | FIX          | yes              |
| `reviewer`            | REVIEW       | no               |
| `release-gate`        | RELEASE_GATE | no               |
| `deployer`            | DEPLOY       | yes              |
| `feedback`            | FEEDBACK     | no               |

Every agent also works on its own, outside a flow.

### Specialists

Specialists own a subject instead of a stage. Install the ones you want; none comes with a flow.

| Agent                    | Does                                                                    | Can change files |
| ------------------------ | ----------------------------------------------------------------------- | ---------------- |
| `security-reviewer`      | Reviews a change for security defects and gives a verdict               | no               |
| `performance-reviewer`   | Reviews a change for performance defects and gives a verdict            | no               |
| `database-reviewer`      | Reviews schema changes, migrations and queries and gives a verdict      | no               |
| `accessibility-reviewer` | Reviews interface changes for accessibility and gives a verdict         | no               |
| `standards-reviewer`     | Reviews a change against the installed rules packs and gives a verdict  | no               |
| `api-designer`           | Designs an interface before it is built                                 | no               |
| `test-strategist`        | Says what to test, at which level, and what is missing                  | no               |
| `dependency-auditor`     | Audits dependencies and recommends an action for each                   | no               |
| `debugger`               | Finds the root cause of a failure and proposes a fix, without applying  | no               |
| `docs-writer`            | Writes or updates documentation for code that exists                    | yes (docs only)  |
| `refactorer`             | Restructures code without changing behavior, tests run before and after | yes              |

The five reviewers are also used by the flows. At REVIEW, a flow runs each one that is installed for that harness, saves its report as `07-review-<agent name>.md` in the run directory, and returns to BUILD if any of them requests changes. With none installed, a flow runs exactly as before. Each installed reviewer adds one subagent run to every review round, including for changes outside its subject.

A specialist is a prompt for your harness's model, not a tool: `security-reviewer` is not a scanner, and `accessibility-reviewer` reads the code without running the interface. Where a harness gives read-only agents a read-only sandbox (Codex does), `debugger` may be unable to run the failing command; it then works by reading and says its cause is unconfirmed.

## Rules packs

A rules pack is a short file of coding standards for one stack. Install the ones your project uses; the harness then keeps them in front of the model for every task.

```bash
forgeflow add common typescript --target claude,codex
forgeflow list --type rule
```

| Pack         | Covers                                                                              | Applies to                                           |
| ------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `common`     | Naming, functions, errors, tests, security, comments, dependencies, version control | all work                                             |
| `typescript` | TypeScript and JavaScript, Node                                                     | `.ts`, `.tsx`, `.js`, `.jsx` and the module variants |
| `python`     | Typing, functions, errors, packaging, pytest                                        | `.py`, `.pyi`                                        |
| `php`        | PHP, with a Laravel section                                                         | `.php`                                               |
| `java`       | Java, with a Spring section                                                         | `.java`                                              |
| `csharp`     | C#, with an ASP.NET Core section                                                    | `.cs`, `.cshtml`, `.razor`                           |
| `go`         | Errors, interfaces, concurrency, packages, tests                                    | `.go`                                                |
| `react`      | Components, state, effects, performance                                             | `.tsx`, `.jsx`                                       |
| `vue`        | Single-file components, reactivity, composables                                     | `.vue`                                               |
| `angular`    | Components, signals and RxJS, templates, dependency injection                       | `.ts`, `.html` in an Angular project                 |

The packs are a generic baseline. Where a pack and your project's established convention disagree, the pack itself says your convention wins. To make a rule your team's own, change it in the catalog; an edit to an installed copy is kept by `forgeflow update` but is not shared.

Install `standards-reviewer` to have a change checked against the installed packs. It quotes the rule each finding breaks, and the flows run it at REVIEW when it is installed.

### How each harness gets the rules

| Target     | Rule files                            | Loaded by                                               | Scoped to file types                        |
| ---------- | ------------------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `claude`   | `.claude/rules/forgeflow/<name>.md`   | Claude Code itself                                      | yes                                         |
| `cursor`   | `.cursor/rules/forgeflow-<name>.mdc`  | Cursor itself                                           | yes                                         |
| `codex`    | `.codex/forgeflow/rules/<name>.md`    | a block in `AGENTS.md` that lists them                  | the block says which files each pack is for |
| `opencode` | `.opencode/forgeflow/rules/<name>.md` | one entry in the `instructions` list of `opencode.json` | no: always loaded                           |

In `AGENTS.md`, forgeflow owns only the text between `<!-- forgeflow:rules:start -->` and `<!-- forgeflow:rules:end -->`, and rewrites it when you add or remove a pack. In `opencode.json` it adds one entry to `instructions` and touches nothing else, though the file is written back as two-space JSON. Removing the last pack takes the block or entry out again. If `AGENTS.md` is a symbolic link, forgeflow edits the file it points to and keeps the link.

### What rules do not do

- Rules are guidance. A model can ignore them; `standards-reviewer` checks, and it is a model too.
- On Codex the block asks the model to read the pack files. Nothing forces it to. An `AGENTS.override.md` in the repository root, or in `~/.codex/` for a global install, hides the block.
- On OpenCode every installed pack is in context for every task.
- forgeflow will not edit an `AGENTS.md` whose markers are damaged, an `opencode.json` it cannot parse, or a project that has only `opencode.jsonc`. It stops and prints the entry to add by hand, and carries on the next time it finds that entry there.
- Rules are not available with `--global` on Cursor, which keeps user-level rules in its settings.
- Claude Code, Cursor and OpenCode also read `AGENTS.md` in some setups, so in a project that has Codex installed too they may see the Codex block as well as their own rules.

## Session memory

A new session starts cold, and a long one forgets its plan when the harness compacts it. Session memory gives the project three small files that the harness loads by itself.

```bash
forgeflow add --memory --target claude,codex
```

That installs one hook and two commands:

| Item             | Does                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `session-memory` | Records what each session changes and is asked, and gives a new or compacted session the project's memory                              |
| `forge-lesson`   | Has the agent add one durable project fact to the lessons file. The agent also does this on its own when you correct it, and tells you |
| `forge-handoff`  | Has the agent write a note for the next session: done, in progress, next, decisions, open questions                                    |

| File                           | Written by                              | Committed | Holds                                                                                                    |
| ------------------------------ | --------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `.forgeflow/memory/lessons.md` | the agent                               | yes       | One line per lesson, shared with your team                                                               |
| `.forgeflow/local/session.md`  | the hook                                | no        | When the last two sessions ran, their branch, the files they changed and your last three prompts in each |
| `.forgeflow/local/handoff.md`  | the agent, when you run `forge-handoff` | no        | The handoff note                                                                                         |

`.forgeflow/local/` ignores itself with its own `.gitignore`, so nothing in it is committed and your `.gitignore` is not edited. forgeflow never deletes these files: removing the items leaves your memory where it is.

At session start the model receives the lessons, the handoff note and the last session's record, each capped in size, plus any flow run in progress. The handoff note and the record are skipped once they are a week old.

| Target     | At session start                                       | After compaction                                                                  |
| ---------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `claude`   | a hook adds the memory                                 | the hook adds it again, with this session's activity                              |
| `codex`    | a hook adds the memory                                 | as Claude Code                                                                    |
| `cursor`   | a hook adds the memory                                 | Cursor cannot add context here, so you are told which files to point the agent at |
| `opencode` | the files are listed in `opencode.json` `instructions` | the record is added to the compaction prompt                                      |

### What session memory does not do

- It is per project. Hooks are installed per project, so there is no user-level memory.
- The model receives the memory. Nothing makes it act on it.
- Your last three prompts in each of the last two sessions are stored in `.forgeflow/local/` in readable form. Text that looks like a credential is replaced with `[redacted]`, but a secret that matches no known pattern is stored as typed.
- A lesson can be wrong or go out of date. The lessons file is committed, so additions show up in review, and anyone can edit it.
- A file changed by a shell command is not in the record: only the agent's own file writes are.
- Two sessions open at once in one project share the one record and take turns in it.
- If you installed quality gates before session memory existed, run `forgeflow update` once so the harness config gains the session-start entry. Until then `forgeflow status` shows the wiring as missing.

## Quality gates

Gates are hooks the harness runs for you. Install all four, or pick the ones you want:

```bash
forgeflow add --hooks --target claude
forgeflow add secret-guard protected-paths --target cursor
```

`--hooks` installs the four quality gates. Session memory is also built on hooks, but is installed with `--memory`.

| Gate              | What it does                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval-gate`   | During a flow run, blocks `git push`, publish and deploy commands until you type `approve` at the flow's approval step. It records the approval itself; agents cannot. |
| `secret-guard`    | Blocks a file write whose new text contains a credential in a known format.                                                                                            |
| `protected-paths` | Blocks agent writes to `.env` files, `*.pem`, `*.key`, and any paths you list.                                                                                         |
| `test-reminder`   | Nudges the agent once when a turn ends with edits and no test run since.                                                                                               |

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
- `approval-gate` applies only while a flow run is active. A run left running for 24 hours stops gating. A run waiting for your approval keeps gating until you type `approve` or set its status to `stopped` in its `state.md`.
- Any message starting with `approve` at the approval step counts, including `approve, but not yet`. To decline, say something else.
- `secret-guard` does not match Google API keys, because Firebase web keys share their format and are public by design.
- If the runner crashes, the action goes through. `forgeflow doctor` checks the wiring.
- Agents can no longer edit the harness's hook config or `.forgeflow/config.json`. You make those changes.
- Codex runs project hooks only after you trust them (`/hooks`), and needs the project to be a git repository.
- On OpenCode, `test-reminder` does nothing. On OpenCode and Cursor, a gate's advisory notes are not shown to the agent; blocks are.

## Where files go

| Target     | Agents              | Skills              | Gates                                                    |
| ---------- | ------------------- | ------------------- | -------------------------------------------------------- |
| `claude`   | `.claude/agents/`   | `.claude/skills/`   | `.claude/forgeflow/`, entries in `.claude/settings.json` |
| `codex`    | `.codex/agents/`    | `.agents/skills/`   | `.codex/forgeflow/`, entries in `.codex/hooks.json`      |
| `opencode` | `.opencode/agents/` | `.opencode/skills/` | `.opencode/forgeflow/`, `.opencode/plugins/forgeflow.js` |
| `cursor`   | `.cursor/agents/`   | `.cursor/skills/`   | `.cursor/forgeflow/`, entries in `.cursor/hooks.json`    |

With `--global` these live under your home directory (`~/.config/opencode/` for OpenCode).

forgeflow records what it installed in `.forgeflow/lock.json`. It never overwrites or deletes a file you edited unless you pass `--force`. Commit the lockfile if your team shares the installed agents.

## Adding to the catalog

- An agent is one file, `catalog/agents/<name>.md`.
- A skill is a folder, `catalog/skills/<name>/SKILL.md`.
- A gate is a folder, `catalog/hooks/<name>/`, with `HOOK.md` and `gate.mjs`. `gate.mjs` exports `check(event, ctx)` and may import only `node:` built-ins.
- An agent with no `stage` is a specialist. Add `joins: review` to a read-only specialist to mark it as one the flows run at REVIEW, and name it in both flow skills: a test fails if the two disagree.
- A skill or agent body may use `{{agents-dir}}` and `{{global-agents-dir}}`. Each harness's installer replaces them with that harness's agents folders.
- A rules pack is one file, `catalog/rules/<name>.md`, with an optional `paths` list of file patterns. Without `paths` it applies to all work. Keep it under 6,000 bytes.
- An agent body may use the same placeholders as a skill body, plus `{{rules-location}}` for where that harness keeps its rules packs.

The frontmatter fields are described in `docs/superpowers/specs/2026-10-13-forgeflow-core-design.md`, section 4. Run `forgeflow doctor` to validate the catalog, and `npm test` before committing.

To support another harness, add `src/adapters/<name>.js` exporting `name`, `root` and `render`, and register it in `src/adapters/index.js`.

## Development

```bash
npm test          # run the tests
npm run lint      # oxlint
npm run format    # prettier
```
