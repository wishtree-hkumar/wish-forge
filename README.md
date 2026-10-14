# wish-forge

Wishtree's ready-to-use coding agents and development flows for Claude Code, Codex, OpenCode and Cursor. The command is `wishforge`.

Each item is written once and compiled into the native format of the harness you use: flow agents and the two flows that run them, specialist agents, rules packs of coding standards, quality-gate hooks, and session memory. Install one item, or a whole set.

wish-forge does not call a model. Your harness runs the agents; it only installs their definitions and the small hook scripts.

wish-forge has not yet been checked in the harnesses themselves: the automated tests prove the files it writes are well formed, not that each harness loads them as intended. `docs/verification.md` lists the checks to run in each harness.

## Install

Needs Node 20 or newer.

```bash
git clone git@github.com:wishtree-hkumar/forgeflow.git wish-forge
cd wish-forge && npm install && npm link   # puts `wishforge` on your PATH
```

wish-forge was called forgeflow until October 2026. The design documents in `docs/superpowers/` keep that name. A project that has forgeflow installed should run `forgeflow remove` with the old build before installing with `wishforge`.

## Use

Run these from the root of the project you want the agents in.

```bash
wishforge list                                   # what is available
wishforge info reviewer                          # one item in detail
wishforge add reviewer --target cursor           # one agent
wishforge add --flow quick --target claude       # a flow and the agents it needs
wishforge add --flow full --target claude,codex  # several harnesses at once
wishforge add security-reviewer --target claude  # one specialist
wishforge add --specialists --target claude      # every specialist
wishforge add common typescript --target claude  # rules packs
wishforge add --memory --target claude           # session memory
wishforge status                                 # what is installed here
wishforge update                                 # rewrite installed files from the current catalog
wishforge remove reviewer --target cursor
wishforge remove --specialists --target claude   # bundle flags work with remove too
wishforge doctor                                 # check Node, the catalog and what is installed
wishforge tokens                                 # what the installed items add to context
```

| Option      | Meaning                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--target`  | `claude`, `codex`, `opencode` or `cursor`. Required for `add` and `remove`. Separate several with commas.                           |
| `--global`  | Install for your user account instead of the current project. Not for gates, session memory or Cursor rules, which are per project. |
| `--dry-run` | Show what would change and write nothing.                                                                                           |
| `--force`   | Overwrite or delete files that you edited or that wishforge did not install.                                                        |

wishforge treats the directory you run it in as the project root. It will not treat your home folder as a project, since global installs live there: run it from a project folder, or add `--global`.

`update` refreshes what is installed and does not add items. A file you edited is left alone unless you pass `--force`; a bundle member that something else installed still needs is kept by `remove`, which says so.

## The flows

After installing a flow, start it inside your harness.

| Flow          | Stages                                                                                                                     | Start it with            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `forge-quick` | DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP                                                                             | `/forge-quick <request>` |
| `forge-full`  | REQUIREMENT → ANALYZE → PLAN → ARCHITECT → BUILD → TEST ⇄ FIX → REVIEW → RELEASE_GATE → HUMAN_APPROVAL → DEPLOY → FEEDBACK | `/forge-full <request>`  |

In Codex, start a flow by naming the skill: `$forge-quick <request>`.

The quick flow ends with a reviewed change you have confirmed; it does not deploy. The full flow stops at HUMAN_APPROVAL and continues to DEPLOY only when you approve in the conversation.

Each run keeps its stage outputs in `.wishforge/runs/<date>-<slug>/`. Point a flow at that directory to resume a run in a new session or a different harness.

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
| `mapper`                 | Reads the project and returns a map of it, for the `forge-map` command  | no               |

The five reviewers are also used by the flows. At REVIEW, a flow runs each one that is installed for that harness, saves its report as `07-review-<agent name>.md` in the run directory, and returns to BUILD if any of them requests changes. With none installed, a flow runs exactly as before. Each installed reviewer adds one subagent run to every review round, including for changes outside its subject.

A specialist is a prompt for your harness's model, not a tool: `security-reviewer` is not a scanner, and `accessibility-reviewer` reads the code without running the interface. Where a harness gives read-only agents a read-only sandbox (Codex does), `debugger` may be unable to run the failing command; it then works by reading and says its cause is unconfirmed.

## Rules packs

A rules pack is a short file of coding standards for one stack. Install the ones your project uses; the harness then keeps them in front of the model for every task.

```bash
wishforge add common typescript --target claude,codex
wishforge list --type rule
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
| `react`      | Components, state, effects, performance                                             | `.tsx`, `.jsx`, and hook files such as `useCart.ts`  |
| `vue`        | Single-file components, reactivity, composables                                     | `.vue`                                               |
| `angular`    | Components, signals and RxJS, templates, dependency injection                       | `.ts`, `.html` in an Angular project                 |

The packs are a generic baseline. Where a pack and your project's established convention disagree, the pack itself says your convention wins. To make a rule your team's own, change it in the catalog; an edit to an installed copy is kept by `wishforge update` but is not shared.

Install `standards-reviewer` to have a change checked against the installed packs. It quotes the rule each finding breaks, and the flows run it at REVIEW when it is installed.

### How each harness gets the rules

| Target     | Rule files                            | Loaded by                                               | Scoped to file types                        |
| ---------- | ------------------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `claude`   | `.claude/rules/wishforge/<name>.md`   | Claude Code itself                                      | yes                                         |
| `cursor`   | `.cursor/rules/wishforge-<name>.mdc`  | Cursor itself                                           | yes                                         |
| `codex`    | `.codex/wishforge/rules/<name>.md`    | a block in `AGENTS.md` that lists them                  | the block says which files each pack is for |
| `opencode` | `.opencode/wishforge/rules/<name>.md` | one entry in the `instructions` list of `opencode.json` | no: always loaded                           |

In `AGENTS.md`, wishforge owns only the text between `<!-- wishforge:rules:start -->` and `<!-- wishforge:rules:end -->`, and rewrites it when you add or remove a pack. In `opencode.json` it adds one entry to `instructions` and touches nothing else, though the file is written back as two-space JSON. Removing the last pack takes the block or entry out again. If `AGENTS.md` is a symbolic link, wishforge edits the file it points to and keeps the link. Text you change between the markers is replaced the next time you add, update or remove a pack for Codex, and a block you delete comes back the next time you add or update for Codex. Put your own instructions outside the markers.

### What rules do not do

- Rules are guidance. A model can ignore them; `standards-reviewer` checks, and it is a model too.
- On Codex the block asks the model to read the pack files. Nothing forces it to. An `AGENTS.override.md` in the repository root, or in `~/.codex/` for a global install, hides the block.
- On OpenCode every installed pack is in context for every task.
- wishforge will not edit an `AGENTS.md` whose markers are damaged, an `opencode.json` it cannot parse or that links to a file outside the project, or a project that has only `opencode.jsonc`. It stops and prints the entry to add by hand, and carries on the next time it finds that entry there.
- Rules are not available with `--global` on Cursor, which keeps user-level rules in its settings.
- Claude Code, Cursor and OpenCode also read `AGENTS.md` in some setups, so in a project that has Codex installed too they may see the Codex block as well as their own rules.

## Session memory

A new session starts cold, and a long one forgets its plan when the harness compacts it. Session memory gives the project a few small files that the harness loads by itself.

```bash
wishforge add --memory --target claude,codex
```

That installs one hook, three commands and the agent the map command uses:

| Item             | Does                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `session-memory` | Records what each session changes and is asked, and gives a new or compacted session the project's memory                              |
| `forge-lesson`   | Has the agent add one durable project fact to the lessons file. The agent also does this on its own when you correct it, and tells you |
| `forge-handoff`  | Has the agent write a note for the next session: done, in progress, next, decisions, open questions                                    |
| `forge-map`      | Builds or refreshes the project map, using the `mapper` agent. Only you can start it                                                   |

| File                           | Written by                              | Committed | Holds                                                                                                    |
| ------------------------------ | --------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `.wishforge/memory/lessons.md` | the agent                               | yes       | One line per lesson, shared with your team                                                               |
| `.wishforge/memory/map.md`     | the agent, when you run `forge-map`     | yes       | The project map                                                                                          |
| `.wishforge/local/session.md`  | the hook                                | no        | When the last two sessions ran, their branch, the files they changed and your last three prompts in each |
| `.wishforge/local/handoff.md`  | the agent, when you run `forge-handoff` | no        | The handoff note                                                                                         |

Each of the three commands brings the `session-memory` hook with it, since the hook is what loads what they write. `.wishforge/local/` ignores itself with its own `.gitignore`, so nothing in it is committed and your `.gitignore` is not edited. wishforge never deletes these files: removing the items leaves your memory where it is.

At session start the model receives the lessons, the project map, the handoff note and the last session's record, each capped in size, plus any flow run in progress. The handoff note and the record are skipped once they are a week old.

| Target     | At session start                                       | After compaction                                                                  |
| ---------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `claude`   | a hook adds the memory                                 | the hook adds it again, with this session's activity                              |
| `codex`    | a hook adds the memory                                 | as Claude Code                                                                    |
| `cursor`   | a hook adds the memory                                 | Cursor cannot add context here, so you are told which files to point the agent at |
| `opencode` | the files are listed in `opencode.json` `instructions` | the record is added to the compaction prompt                                      |

### The project map

Most tasks begin with the agent reading the same files to find its way around. Run `forge-map` once and it writes `.wishforge/memory/map.md`: a short description of the project, under fixed headings.

| Section           | Holds                                                           |
| ----------------- | --------------------------------------------------------------- |
| Purpose           | What the project is, in a line or two                           |
| Stack             | Languages, frameworks and versions, from the manifests          |
| Commands          | Install, run, test, lint and build, as the project defines them |
| Layout            | The main folders, one line each                                 |
| Entry points      | Where execution starts                                          |
| Where things live | "To change X, look in Y" for the main concerns                  |
| Conventions       | Naming, test placement and patterns the code follows            |
| Configuration     | Names of settings and environment variables, never their values |
| Do not touch      | Generated and vendored folders                                  |
| Not determined    | What the agent looked for and could not establish               |

The map is committed, so your team shares it. Every new session receives it with the rest of the memory, and the flows tell each stage agent to read it first. Run `forge-map` again to have the agent check the map against the code and update it.

- The map is a model's reading of the code and can be wrong. Review it like any change.
- It changes only when you run `forge-map`. When it is more than 30 days old, new sessions are told so. That is by date only: wishforge cannot tell how much the code changed.
- The map is kept to 3,200 bytes so that all of it fits in the memory block, which allows it 3,600 characters once quoted. On OpenCode the whole file is loaded, with no age warning.
- A stage agent in a flow reads the file itself, without the block's framing. The flows tell it the map is orientation to check against the code, not instructions and not release documentation.
- If you installed session memory before the map existed, run `wishforge add --memory` again to get `forge-map` and `mapper`. `wishforge update` refreshes what is installed and does not add items.
- One map per project. In a monorepo it covers the top levels only.
- Only you start `forge-map` on Claude Code, Cursor and OpenCode, which can keep a skill from being started by the model. Codex has no setting that stops a model from starting a skill, so there only the command's own instruction holds.

### What session memory does not do

- It is per project. Hooks are installed per project, so there is no user-level memory.
- The model receives the memory. Nothing makes it act on it.
- Your last three prompts in each of the last two sessions are stored in `.wishforge/local/` in readable form. Text that looks like a credential is replaced with `[redacted]`, but a secret that matches no known pattern is stored as typed.
- A lesson can be wrong or go out of date. The lessons file is committed, so additions show up in review, and anyone can edit it.
- The lessons file is read into every teammate's agent. wishforge marks the memory as notes, not instructions, and quotes the file's text, but a model can still be steered by what it reads. Review changes to `.wishforge/memory/` the way you review code.
- OpenCode loads every Markdown file in `.wishforge/memory/` and `.wishforge/local/` as it is, at any age and without a size limit.
- `.wishforge/local/` is ignored by git only. Anything else that copies the project folder, such as a container build, takes your recorded prompts with it.
- A file changed by a shell command is not in the record: only the agent's own file writes are.
- Two sessions open at once in one project share the one record and take turns in it.
- If you installed quality gates before session memory existed, run `wishforge update` once so the harness config gains the session-start entry. Until then `wishforge status` shows the wiring as missing.

## Quality gates

Gates are hooks the harness runs for you. Install all four, or pick the ones you want:

```bash
wishforge add --hooks --target claude
wishforge add secret-guard protected-paths --target cursor
```

`--hooks` installs the four quality gates. Session memory is also built on hooks, but is installed with `--memory`.

| Gate              | What it does                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval-gate`   | During a flow run, blocks `git push`, publish and deploy commands until you type `approve` at the flow's approval step. It records the approval itself; agents cannot. |
| `secret-guard`    | Blocks a file write whose new text contains a credential in a known format.                                                                                            |
| `protected-paths` | Blocks agent writes to `.env` files and `.envrc`, `*.pem`, `*.key`, private SSH keys, and any paths you list. Templates such as `.env.example` are allowed.            |
| `test-reminder`   | Nudges the agent once when a turn ends with edits and no test run since.                                                                                               |

Gates are installed per project, not with `--global`. wishforge copies a small runner into the harness's folder and adds its entries to the harness's hook config (`.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json`, or a plugin file for OpenCode). Your own hook entries are left alone, and `wishforge remove` takes out only what wishforge added. If the hook config is a symbolic link, wishforge edits the file it points to; if that file is outside the project, wishforge will not edit it and tells you what to change by hand. Teammates need Node 20 and nothing else.

### Configuring gates

Create `.wishforge/config.json` to add to the defaults:

```json
{
  "releaseCommands": ["\\bmake\\s+deploy\\b"],
  "protectedPaths": ["migrations/**", "package-lock.json"],
  "secretAllow": ["EXAMPLE_[A-Z0-9]+"],
  "testCommands": ["\\bmake\\s+check\\b"]
}
```

`protectedPaths` are globs. The other three are regular expressions. To allow one false positive from `secret-guard`, add `wishforge-allow-secret` to that line.

### What gates do not do

Gates raise the bar. They are not a sandbox.

- Shell commands are matched by pattern. A script that pushes, or an obfuscated command, is not caught.
- `secret-guard` and `protected-paths` see file-writing tools only, not files changed by a shell command.
- `approval-gate` applies only while a flow run is active. A run left running for 24 hours stops gating. A run waiting for your approval keeps gating until you type `approve` or set its status to `stopped` in its `state.md`.
- Any message starting with `approve` at the approval step counts, including `approve, but not yet`. To decline, say something else.
- `secret-guard` does not match Google API keys, because Firebase web keys share their format and are public by design.
- If the runner crashes, the action goes through. `wishforge doctor` checks the wiring.
- Agents can no longer edit the harness's hook config or `.wishforge/config.json`. You make those changes.
- Codex runs project hooks only after you trust them (`/hooks`), and needs the project to be a git repository.
- On OpenCode, `test-reminder` does nothing. On OpenCode and Cursor, a gate's advisory notes are not shown to the agent; blocks are.

## Context cost

`wishforge tokens` estimates what the installed items add to the model's context, for each harness installed in the project, or for your user account with `--global`. `--target` limits it to some harnesses, and `--json` gives the rows for a script.

It splits the text into two parts:

- **Every session**: what the harness gives the model whether or not the item is used. That is the list of agents and skills it can call, rules packs that always apply (every pack on OpenCode, and the `AGENTS.md` block on Codex), and the session memory block.
- **When used**: what an item adds only once it runs. An agent's instructions go into that agent's own context; a flow's instructions come in when you start it; a scoped rules pack comes in when the agent works on a matching file, or on Codex when it reads the pack.

The numbers are estimates, at about four characters per token: wishforge never calls a model, so it has no tokenizer. They leave out the harness's own system prompt and tools, and your own instruction files such as `CLAUDE.md`. To see what a session actually spends, use the harness: `/context` and `/cost` in Claude Code, `/status` in Codex, the usage shown in OpenCode, and the usage dashboard for Cursor.

## Where files go

| Target     | Agents              | Skills              | Gates                                                    |
| ---------- | ------------------- | ------------------- | -------------------------------------------------------- |
| `claude`   | `.claude/agents/`   | `.claude/skills/`   | `.claude/wishforge/`, entries in `.claude/settings.json` |
| `codex`    | `.codex/agents/`    | `.agents/skills/`   | `.codex/wishforge/`, entries in `.codex/hooks.json`      |
| `opencode` | `.opencode/agents/` | `.opencode/skills/` | `.opencode/wishforge/`, `.opencode/plugins/wishforge.js` |
| `cursor`   | `.cursor/agents/`   | `.cursor/skills/`   | `.cursor/wishforge/`, entries in `.cursor/hooks.json`    |

With `--global` these live under your home directory (`~/.config/opencode/` for OpenCode). Rules packs and memory files are described in their own sections above.

`.wishforge/` in the project holds wishforge's own files:

| Path                     | Holds                                               | Commit it                                    |
| ------------------------ | --------------------------------------------------- | -------------------------------------------- |
| `.wishforge/lock.json`   | What wishforge installed, for each harness          | yes, if your team shares the installed items |
| `.wishforge/config.json` | Your settings for the gates                         | yes                                          |
| `.wishforge/runs/`       | One folder per flow run                             | your choice                                  |
| `.wishforge/memory/`     | Lessons and the project map                         | yes                                          |
| `.wishforge/local/`      | The session record, the handoff note and gate state | no: it ignores itself                        |

wishforge records what it installed in `.wishforge/lock.json`. It never overwrites or deletes a file you edited unless you pass `--force`. Commit the lockfile if your team shares the installed agents.

## Adding to the catalog

- An agent is one file, `catalog/agents/<name>.md`.
- A skill is a folder, `catalog/skills/<name>/SKILL.md`.
- A gate is a folder, `catalog/hooks/<name>/`, with `HOOK.md` and `gate.mjs`. `gate.mjs` exports `check(event, ctx)` and may import only `node:` built-ins.
- An agent with no `stage` is a specialist. Add `joins: review` to a read-only specialist to mark it as one the flows run at REVIEW, and name it in both flow skills: a test fails if the two disagree.
- A rules pack is one file, `catalog/rules/<name>.md`, with an optional `paths` list of file patterns. Without `paths` it applies to all work. Keep it under 6,000 bytes, and list each pattern on its own: a pattern may not contain a comma or a backtick.
- A hook or skill with `group: memory` belongs to the `--memory` bundle; `--hooks` installs only hooks without a group. Hook events are `shell`, `write`, `prompt`, `stop`, `start` and `compact`.
- Agent and skill bodies may use `{{agents-dir}}`, `{{global-agents-dir}}` and `{{rules-location}}`. Each harness's installer replaces them with that harness's own folders. Any other `{{…}}` token, or one with a brace too few or too many, is a catalog error.

The frontmatter fields are described in the specs in `docs/superpowers/specs/`: the core spec, section 4, for agents and skills, and the later specs for hooks (`events`, `group`), specialists (`joins`) and rules (`paths`). Run `wishforge doctor` to validate the catalog, and `npm test` before committing.

To support another harness, add `src/adapters/<name>.js` and register it in `src/adapters/index.js`. An adapter exports `name`, `root(scope, dirs)`, `render(item, ctx)`, `agentDirs`, `rulesLocation`, `places`, and `wiring` (its hook config, or `null`). It may also export `rulesWiring(scope, ids)` when the harness needs a file such as `AGENTS.md` edited to load rules, and `globalRules = false` when it has no user-level rule files.

## Development

```bash
npm test          # run the tests
npm run lint      # oxlint
npm run format    # prettier
```
