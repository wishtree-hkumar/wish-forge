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

In this version the gates are instructions to the model. They are not enforced by hooks.

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

## Where files go

| Target     | Agents              | Skills              |
| ---------- | ------------------- | ------------------- |
| `claude`   | `.claude/agents/`   | `.claude/skills/`   |
| `codex`    | `.codex/agents/`    | `.agents/skills/`   |
| `opencode` | `.opencode/agents/` | `.opencode/skills/` |
| `cursor`   | `.cursor/agents/`   | `.cursor/skills/`   |

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
