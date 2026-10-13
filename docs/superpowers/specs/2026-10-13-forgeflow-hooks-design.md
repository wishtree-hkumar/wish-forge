# forgeflow quality-gate hooks — design spec (phase 2 of 4)

Date: 2026-10-13
Status: awaiting review
Builds on: `2026-10-13-forgeflow-core-design.md` (phase 1)

## 1. Purpose

Phase 1 gates are instructions to the model. Phase 2 adds gates that the
harness enforces: small scripts that run on tool calls, prompts and turn ends
in Claude Code, Codex, Cursor and OpenCode, and can block an action.

Four gates ship, each installable on its own:

| Item | Does |
|---|---|
| `approval-gate` | Blocks release commands during a flow run until a person types `approve`; records that approval itself |
| `secret-guard` | Blocks a file write whose new text contains a credential |
| `protected-paths` | Blocks writes to files a project marks off-limits |
| `test-reminder` | Nudges the agent once when a turn ends with edits and no test run since |

These gates raise the bar. They are not a sandbox: section 9 lists what gets
past them.

### Out of scope

- Global (`--global`) installation of hooks.
- Gates beyond these four; specialist agents and rules packs (phase 3);
  memory and context tools (phase 4).
- Enforcing which subagent may act. Gates apply to every agent alike.
- Parsing shell commands to find the files they change.

## 2. Success criteria

1. `forgeflow add approval-gate --target <harness>` installs the gate, the
   runner and the wiring; `forgeflow remove` takes all three out and leaves
   the user's other hook entries untouched.
2. With `approval-gate` installed and a flow run active and unapproved, an
   agent's `git push` is blocked on all four harnesses, and an agent cannot
   create the approval record.
3. Typing `approve` while a run waits at HUMAN_APPROVAL (full flow) or SHIP
   (quick flow) records the approval without the model's involvement.
4. forgeflow never rewrites a harness config file it cannot parse, and never
   removes or alters a hook entry it did not add.
5. A project where forgeflow hooks are installed works for a teammate who has
   Node 20+ and has not installed forgeflow.
6. Gate logic and harness translation are covered by automated tests that run
   without any harness installed, including end-to-end runs of the installed
   runner script with real harness-shaped input.

## 3. Architecture

```
harness event ──► run.mjs <harness> ──► runtime.mjs
  (stdin JSON)                            1. normalize → neutral events
                                          2. self-protection check
                                          3. each installed gate: check(event, ctx)
                                          4. combine → respond in the harness's format
```

OpenCode has no hook config file. There a generated plugin imports
`runtime.mjs` and calls the same steps in-process.

New and changed units:

| Unit | File | Responsibility |
|---|---|---|
| Runtime (shipped) | `catalog/runtime/hooks/runtime.mjs` | Normalize harness payloads, load config, find the active run, run gates, combine decisions, format responses |
| Runner (shipped) | `catalog/runtime/hooks/run.mjs` | Process entry: read stdin, call runtime, write stdout/stderr, set exit code; fail open |
| OpenCode plugin (shipped) | `catalog/runtime/hooks/opencode-plugin.js` | Adapt OpenCode plugin hooks to the runtime |
| Gates (shipped) | `catalog/hooks/<name>/gate.mjs` | One `check(event, ctx)` function each |
| Catalog | `src/catalog.js` | Load `hook` items and the `runtime:hooks` item |
| Wiring | `src/wiring.js` | Pure merge and strip of forgeflow's entries in a harness hook config |
| Adapters | `src/adapters/*.js` | Render hook and runtime files; describe the wiring |
| Planner, applier, ops | `src/plan.js`, `src/apply.js`, `src/ops.js` | Plan and apply wiring changes; record them in the lockfile |
| CLI, doctor | `src/cli.js`, `src/doctor.js` | `--hooks`, `--type hook`, wiring status and checks |
| Flow skills | `catalog/skills/forge-*/SKILL.md` | Ask the user to type `approve`; read the record instead of writing it |

Shipped code (`runtime.mjs`, `run.mjs`, the plugin, every `gate.mjs`) is
dependency-free ESM using only `node:` built-ins, because it runs in projects
that have not installed forgeflow.

## 4. Catalog

### Hook item — `catalog/hooks/<name>/`

```
HOOK.md      frontmatter + a description of the gate for people
gate.mjs     the gate
```

`HOOK.md` frontmatter:

| Field | Required | Values |
|---|---|---|
| `name` | yes | same rule as agents; equals the folder name |
| `description` | yes | 1–1024 characters |
| `events` | yes | non-empty list drawn from `shell`, `write`, `prompt`, `stop` |
| `requires` | no | list of item ids |

The item id is `hook:<name>`. The loader adds `runtime:hooks` to every hook's
`requires`. `gate.mjs` must exist. Other files in the folder are not shipped.

### Runtime item — `catalog/runtime/hooks/`

One internal item with id `runtime:hooks`, built from `RUNTIME.md`
(frontmatter `name: hooks`, `description`) and the three shipped files. It is
installed only as a requirement, is omitted from `forgeflow list`, and is
swept by the existing rule when the last hook is removed.

### Gate contract

```js
// gate.mjs
export function check(event, ctx) → undefined | { block: string } | { note: string }
```

`event` is one of:

| `kind` | Fields | Meaning |
|---|---|---|
| `shell` | `command` | The agent is about to run a shell command |
| `write` | `path`, `content` | The agent is about to create or change a file. `path` is relative to the project root with `/` separators. `content` is the new text being written (whole file, replacement text, or added lines) |
| `prompt` | `text` | The person submitted a prompt |
| `stop` | — | The agent is ending its turn |

`ctx` is `{ root, harness, config, run, state }`:

- `root`: absolute project root.
- `config`: parsed `.forgeflow/config.json` merged over defaults (section 7).
- `run`: the active flow run, or `null`. `{ dir, status, stage, approved }`.
- `state`: `get()` / `set(object)` for small per-project state, stored in the
  OS temp directory under a name derived from a hash of `root`.

A gate returns `{ block }` to stop the action with a message for the agent,
`{ note }` to add a message without stopping, or nothing. A `write` event for
a path outside the project root is passed to gates with the absolute path.

### Combining decisions

The runtime checks self-protection first (section 6), then calls every
installed gate. The first `block` wins and ends evaluation. Otherwise all
notes are joined. A gate that throws is skipped and reported as a warning
note; it does not block.

## 5. Harness integration

### Installed layout (project scope)

| Target | Runner and gates | Wiring |
|---|---|---|
| `claude` | `.claude/forgeflow/{run.mjs,runtime.mjs,gates/<name>.mjs}` | merged into `.claude/settings.json` |
| `codex` | `.codex/forgeflow/…` | merged into `.codex/hooks.json` |
| `cursor` | `.cursor/forgeflow/…` | merged into `.cursor/hooks.json` |
| `opencode` | `.opencode/forgeflow/{runtime.mjs,gates/<name>.mjs}` | whole file `.opencode/plugins/forgeflow.js` |

The runtime finds the project root from its own location (two directories
up), and its gates by listing `gates/` beside it. Adding or removing a gate
therefore changes only whole files; the wiring is identical whichever gates
are installed.

### Wiring entries

Every forgeflow entry runs one command, with a 10-second timeout:

| Target | Command |
|---|---|
| `claude` | `node "$CLAUDE_PROJECT_DIR/.claude/forgeflow/run.mjs" claude` |
| `codex` | `node "$(git rev-parse --show-toplevel)/.codex/forgeflow/run.mjs" codex` |
| `cursor` | `node .cursor/forgeflow/run.mjs cursor` |

| Target | Events wired |
|---|---|
| `claude` | `PreToolUse` (matcher `Bash\|Write\|Edit\|MultiEdit\|NotebookEdit`), `UserPromptSubmit`, `Stop` |
| `codex` | `PreToolUse` (matcher `Bash\|apply_patch\|Edit\|Write`), `UserPromptSubmit`, `Stop` |
| `cursor` | `preToolUse`, `beforeSubmitPrompt`, `stop` |

Claude Code and Codex entries have the shape
`{ matcher?, hooks: [{ type: "command", command, timeout }] }`. Cursor entries
have the shape `{ command, timeout }`, and a file forgeflow creates there
starts as `{ "version": 1, "hooks": {} }`.

### Merging rules (`src/wiring.js`)

- A hook handler is forgeflow's if its `command` contains that target's
  runner path (for example `.claude/forgeflow/run.mjs`). Everything else
  belongs to the user, including a handler the user added inside a group
  forgeflow created.
- Install: for each wired event, drop forgeflow's handlers and append the
  current entry. Events forgeflow does not wire are never touched. All other
  keys, events and elements are kept in order.
- Remove: drop forgeflow's elements; delete event arrays and a `hooks` object
  that become empty. If forgeflow created the file and nothing but the
  starting skeleton remains, delete the file.
- A config file that is not valid JSON, is not an object, or has a `hooks`
  value or wired event of the wrong type is never written. The command stops
  with exit 1 and names the file. `--force` does not override this.
- Files are rewritten with two-space indentation and a trailing newline.

### Translating harness input to events

| Harness | Input | Events |
|---|---|---|
| Claude Code | `PreToolUse` `Bash` | `shell(tool_input.command)` |
| | `Write` | `write(file_path, content)` |
| | `Edit` | `write(file_path, new_string)` |
| | `MultiEdit` | `write(file_path, all edits' new_string joined)` |
| | `NotebookEdit` | `write(notebook_path, new_source)` |
| | `UserPromptSubmit` | `prompt(prompt)` |
| | `Stop` | `stop`, unless `stop_hook_active` is true |
| Codex | `PreToolUse` `Bash` | `shell(tool_input.command)` |
| | `apply_patch` | one `write` per `*** Add File:` / `*** Update File:` / `*** Delete File:` section, with that section's added (`+`) lines as content |
| | `Edit`, `Write` | as Claude Code when `tool_input.file_path` is present, otherwise as `apply_patch` |
| | `UserPromptSubmit`, `Stop` | as Claude Code |
| Cursor | `preToolUse` `Shell` | `shell(tool_input.command)` |
| | `preToolUse`, a tool whose `tool_input` has `file_path` and carries new text (`content`, `new_string`, `edits`), or a known write tool (`Write`, `Edit`, `StrReplace`, `MultiEdit`, `Delete`, `EditNotebook`) | `write(file_path, that text, empty for a delete)`. Read tools also carry `file_path` and produce no event |
| | `beforeSubmitPrompt` | `prompt(prompt)` |
| | `stop` | `stop`, when `loop_count` is 0 |
| OpenCode | `tool.execute.before` `bash` | `shell(args.command)` |
| | `write` / `edit` / `multiedit` | `write(args.filePath, args.content, args.newString, or the edits' newString joined)` |
| | any tool with a `patchText` or `patch` argument | as Codex `apply_patch` |
| | `chat.message` | `prompt(text parts joined)` |

Unrecognized input produces no events and is allowed.

### Responding

| Harness | Block | Note | Stop nudge |
|---|---|---|---|
| Claude Code, Codex | message on stderr, exit 2 | stdout `{ hookSpecificOutput: { hookEventName, additionalContext } }`, exit 0 | stdout `{ decision: "block", reason }` |
| Cursor | stdout `{ permission: "deny", user_message, agent_message }`, exit 2 | not delivered | stdout `{ followup_message }` |
| OpenCode | `throw new Error(message)` | not delivered | not supported |

### Failure mode

If the runner cannot read its input, load the runtime, or finish within the
timeout, it prints a one-line warning to stderr and exits 1. Every harness
treats that as a non-blocking error, so the action proceeds. A broken hook
must not stall every tool call; `forgeflow doctor` reports broken wiring.

## 6. Self-protection

With the runtime installed, these are blocked before any gate runs, whichever
gates are installed:

- `write` events to the target's `forgeflow/` directory, its wiring file,
  `.opencode/plugins/forgeflow.js`, `.forgeflow/config.json` and
  `.forgeflow/lock.json`.
- `shell` events that name a harness's `forgeflow` folder together with a
  command that changes files (`rm`, `mv`, `cp`, `sed`, `tee`, a redirect and
  the like), or that run `forgeflow remove`. Reading or staging those files
  (`ls`, `cat`, `git add`) is allowed.

Paths are compared after resolving symlinks and without regard to letter
case, so a file reached through a link or as `.Claude/…` is still protected.

The block message says that a person must make this change. A consequence is
that agents cannot edit `.claude/settings.json`, `.codex/hooks.json` or
`.cursor/hooks.json` in a project with gates installed.

## 7. Project configuration

`.forgeflow/config.json` is optional and written by people, never by
forgeflow:

```json
{
  "releaseCommands": ["\\bmake\\s+deploy\\b"],
  "protectedPaths": ["migrations/**", "package-lock.json"],
  "secretAllow": ["EXAMPLE_[A-Z0-9]+"],
  "testCommands": ["\\bmake\\s+check\\b"]
}
```

Each key is a list of strings added to that gate's defaults.
`releaseCommands`, `secretAllow` and `testCommands` are regular expressions
(case-insensitive). `protectedPaths` are globs supporting `*`, `**` and `?`;
a glob with no `/` matches the file name in any directory.

A missing file means defaults. An unreadable file, wrong types or an invalid
regular expression are ignored entry by entry, and the runtime adds a warning
note naming the problem.

## 8. The gates

### `approval-gate` (events: `shell`, `write`, `prompt`)

**Active run.** A run directory under `.forgeflow/runs/` is active when its
`state.md` has a `status:` of `waiting for user`, or of `running` with the
file modified within the last 24 hours. A waiting run does not expire,
because approvals can take longer than a day. The run is approved when its
`09-approval.md` contains the line `decision: approved`. `state.md` is read
tolerantly: list markers, numbering, headings, quotes, backticks, bold and
table cells around `key: value` are accepted.

Several runs can be active at once. A release command is blocked while any
active run is unapproved. A typed approval goes to the most recently updated
unapproved run that is at its approval step.

**Rules:**

1. `write` to any `.forgeflow/runs/*/09-approval.md`: block. Only the prompt
   hook writes this file.
2. `shell` whose command contains `09-approval.md`: block, with a message to
   read it with the file-reading capability instead.
3. `shell` matching a release command, while a run is active and not
   approved: block. The message names the run and says a person approves by
   typing `approve` when the flow asks.
4. `prompt` whose trimmed text is `approve` or `approved`, or starts with
   `approve` followed by a space or punctuation (case-insensitive), while the active run has status
   `waiting for user`, a stage containing `HUMAN_APPROVAL` or `SHIP` (any
   case; spaces or hyphens for the underscore), and is not approved: write
   `09-approval.md` and return a note that approval was recorded. If runs are
   active but none is at its approval step, return a note saying the approval
   was not recorded and why. With no unapproved active run, the prompt passes
   untouched.

The record:

```
decision: approved
recorded-by: forgeflow approval-gate (<harness> prompt hook)
date: <ISO 8601 timestamp>
user-message: <the prompt text>
```

Default release commands: `git push`, `npm publish`, `pnpm publish`,
`yarn publish`, `yarn npm publish`, `gh release create`, `gh pr merge`,
`docker push`, `kubectl apply`, `terraform apply`, `helm upgrade`,
`helm install`.

Outside an active run this gate blocks nothing except rules 1 and 2.

### `secret-guard` (events: `write`)

Blocks when `content` has a line matching a credential pattern, unless that
line contains `forgeflow-allow-secret` or the matched text matches a
`secretAllow` pattern. The message names the pattern kind and the file, never
the matched text.

Patterns: AWS access key id (`AKIA`/`ASIA` + 16), GitHub tokens (`ghp_`,
`gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Slack tokens (`xox[baprs]-`),
Stripe live keys (`sk_live_`, `rk_live_`), Anthropic keys (`sk-ant-`), OpenAI
keys (`sk-`, optionally `proj-`, `svcacct-` or `admin-`, then 20 or more key
characters including a digit and a capital), and PEM private key headers
(`-----BEGIN … PRIVATE KEY-----`). A match ending in `EXAMPLE` is a vendor's
documentation sample and is allowed. Google API keys are not matched: Firebase
web keys share the format and are public by design.

### `protected-paths` (events: `write`)

Blocks a `write` whose path matches a protected glob. Defaults: `.env`,
`.env.*` except `.env.example`, `.env.sample` and `.env.template`; `*.pem`;
`*.key`. The message names the path and says a person must change it or
remove it from `protectedPaths`.

### `test-reminder` (events: `shell`, `write`, `stop`)

State: `{ dirty, reminded }`.

- `write` to a source file sets `dirty`. Files under `.forgeflow/` and files
  ending in `.md` are not source files.
- `shell` matching a test command clears `dirty` and `reminded`. Defaults:
  `npm test`, `npm run test`, `pnpm test`, `yarn test`, `bun test`, `vitest`,
  `jest`, `pytest`, `go test`, `cargo test`, `phpunit`, `mvn test`,
  `gradle test`, `gradlew test`, `dotnet test`, `rspec`, `make test`.
- `stop` while `dirty` and not `reminded`: set `reminded` and return a note
  asking the agent to run the tests or tell the user why it did not. On a
  `stop` event a note is delivered as the harness's stop nudge.

It never blocks, and nudges at most once per stretch of untested edits.

## 9. Limits

Stated in the README, not hidden:

- Shell commands are matched by pattern. An obfuscated or indirect command
  (a script that pushes, an alias) is not caught.
- `secret-guard` and `protected-paths` see file-writing tools only. A file
  changed by a shell command is not seen.
- The approval gate applies only while a run is active. An agent that edits
  the run's `state.md` to a finished status is no longer gated. A run left
  `running` for 24 hours stops gating. A run left `waiting for user` gates
  until a person approves it or sets its status to `stopped`.
- A runner that crashes lets the action through.
- Codex runs project hooks only after the user trusts them, and needs the
  project to be a git repository to locate the runner.
- OpenCode: notes are not delivered and `test-reminder` does nothing.
- Cursor: notes are not delivered. Whether partial edits reach a pre-tool
  hook with their new text is unconfirmed until the manual check; until then
  `secret-guard` on Cursor is only known to cover whole-file writes.
- Agents cannot edit the harness hook config in a project with gates
  installed.

## 10. Installer changes

### Adapters

`render(item, ctx)` handles two more item types:

- `hook`: one file, `<dir>/gates/<name>.mjs`: `gate.mjs` with the marker
  line prepended.
- `runtime`: `run.mjs` and `runtime.mjs` under `<dir>/` (OpenCode: only
  `runtime.mjs`, plus the plugin at `.opencode/plugins/forgeflow.js`).

Each adapter also exports `wiring`: `null` for OpenCode, otherwise
`{ path, skeleton, entries }`, where `entries` maps each wired event to the
element to append and `skeleton` is the content of a file forgeflow creates.

Shipped `.mjs` and `.js` files carry the marker as a first-line comment,
`// managed by forgeflow: <id>@<version>`.

### Planner, applier, lockfile

Installing `runtime:hooks` for a target with wiring adds one action for the
config file: `wire` (file changes), `skip` (already as wanted), or stops with
an error under the merging rules. Removing it adds `unwire` or `delete`.
Wiring actions never produce conflicts and are not affected by `--force`.

The lockfile entry for `runtime:hooks` gains
`"wiring": { "path": ".claude/settings.json", "created": true }`. The format
version stays 1; `readLock` validates the new field with the same path rules.
Wiring is checked for write permission and parseability during planning, for
every target, before anything is written.

### Scope

Installing a `hook` or `runtime` item with `--global` is a usage error
(exit 2) that says hooks are per project.

### CLI

- `forgeflow add --hooks --target <t>` installs the four gates.
- `forgeflow list --type hook`; `list` shows the events in the stage column.
- `forgeflow status` shows, per target, `wiring ok` or `wiring missing`.
- `forgeflow doctor` fails when a target has the runtime installed and its
  wiring entries are absent or the config file cannot be parsed, and notes
  that Codex hooks need trusting.
- `forgeflow add --flow …` does not install gates; the README says to add
  them.

## 11. Flow skill changes

Both skills, at the approval step:

- Set `status: waiting for user` and `current stage:` to `HUMAN_APPROVAL`
  (full) or `SHIP` (quick) in `state.md` before asking.
- Ask the user to type `approve` to approve, or to say what they want
  changed.
- After the reply, read `09-approval.md`. If it contains `decision: approved`,
  continue. If the file is absent and the user's reply is an approval, write
  the record yourself; if a hook blocks that write, tell the user to reply
  with exactly `approve`.
- Record a decline or change request in `state.md`, not in `09-approval.md`.

The `deployer` agent accepts `decision: approved` as the approval line.

## 12. Error handling

| Situation | Behavior |
|---|---|
| Harness config is not valid JSON or has the wrong shape | Nothing written to any target; exit 1; file named |
| Harness config not writable | Stop before writing anything; exit 1 |
| `--global` with a hook | Exit 2 |
| Hook folder without `gate.mjs`, or bad `events` | Catalog fails to load; file and field named |
| Runner cannot run (no Node, crash, timeout) | Action proceeds; warning on stderr |
| Gate throws | Gate skipped; warning note; other gates still run |
| `.forgeflow/config.json` invalid | Bad entries ignored; warning note |
| `state.md` missing or unreadable in a run directory | That run is not active |

## 13. Testing

- **Wiring** (`src/wiring.js`): install into empty, into a file with user
  entries, twice (idempotent), after a command change (replaced, not
  duplicated); strip leaves user entries and order intact; created file is
  deleted when only the skeleton remains; every malformed shape is refused.
- **Catalog**: hook validation fixtures; `runtime:hooks` added to requires.
- **Adapters**: hook and runtime files and `wiring` per target.
- **Ops**: add a gate (files, wiring, lock); add a second gate (wiring
  unchanged); remove one gate (runtime stays); remove the last (runtime,
  wiring and created file gone; user entries kept); malformed config stops
  every target; `--global` refused.
- **Runtime**: normalization for each harness row in section 5, including
  multi-file patches; decision combining; a throwing gate; bad config;
  active-run selection and the 24-hour rule.
- **Gates**: each rule in section 8, with allow and block cases; every secret
  pattern with a true and a near-miss sample; glob matching.
- **Runner end to end**: install into a temp project, then spawn
  `node <dir>/forgeflow/run.mjs <harness>` with harness-shaped stdin and
  assert exit code, stdout and stderr for block, note, allow, malformed
  input, and the approval sequence (push blocked, `approve` typed, record
  written, push allowed).
- **OpenCode plugin**: import the generated plugin in a temp project and call
  its hooks directly.
- **Content**: both skills mention typing `approve` and `decision: approved`.

Loading in real harnesses is added to `docs/verification.md` as manual checks.

## 14. Decisions and their reasons

| Decision | Reason |
|---|---|
| Gates are catalog items | Same per-item install model as agents |
| One runner, neutral events | Four harness formats handled in one place; gates stay a few lines each |
| Runner and gates copied into the target's folder | Teammates need only Node; each target still owns only its directories |
| Wiring identical whatever gates are installed | Adding a gate never edits the user's config again |
| Forgeflow's entries identified by the runner path | No extra marker keys in files other tools parse |
| Malformed config is a hard stop, even with `--force` | A hook config the user broke by hand should be fixed by the user, not replaced |
| Approval recorded by the prompt hook | Only real user input reaches it, so the model cannot approve for itself |
| Fail open on runner errors | A broken hook must not stall all work |
| 24-hour activity window | An abandoned run should not block pushes indefinitely |
| Hooks are project scope only | Global hook paths and working directories differ per harness; no need yet |

## 15. References

- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Codex hooks: https://learn.chatgpt.com/docs/hooks
- Cursor hooks: https://cursor.com/docs/hooks
- OpenCode plugins: https://opencode.ai/docs/plugins/
