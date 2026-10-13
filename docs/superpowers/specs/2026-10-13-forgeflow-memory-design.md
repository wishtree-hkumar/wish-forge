# forgeflow session memory — design spec (phase 4a of 4)

Date: 2026-10-13
Status: awaiting review
Builds on: `2026-10-13-forgeflow-hooks-design.md` (phase 2) and
`2026-10-13-forgeflow-rules-design.md` (phase 3b)

## 1. Purpose

Every new session starts cold, and a long session forgets its plan when the
harness compacts it. Phase 4a gives a project a small memory that the harness
loads by itself:

- **lessons**: durable project facts, shared through git;
- **a session record**: what the last session changed and was asked, kept
  mechanically by a hook;
- **a handoff note**: what is done and what is next, written by the agent
  when asked.

Phase 4 was split in two. This document is 4a. Phase 4b adds a generated
project map, loaded by the mechanism defined here.

### Out of scope

- The project map (phase 4b).
- User-level memory. Hooks are per project, so memory is too.
- Having the model write anything when a session ends. No harness can ask the
  model for output from a session-end hook.
- Searching, embedding or summarizing memory. Memory is a few small text
  files, loaded whole.
- A switch to turn prompt recording off. Not installing `session-memory`
  is the switch.
- Reading a harness's own transcript files.

## 2. Success criteria

1. After `forgeflow add --memory --target <harness>`, a new session in that
   project receives the lessons, the handoff note and the last session's
   record without the user doing anything, on all four harnesses.
2. The session record is kept current by a hook, with no model involvement
   and no extra model turns.
3. After a compaction on Claude Code and Codex, the model receives the memory
   again, including what the current session has done.
4. A credential typed into a prompt is not written to disk in readable form.
5. Nothing under `.forgeflow/local/` can be committed by accident, and
   forgeflow does not edit the project's `.gitignore`.
6. A project without `session-memory` installed behaves exactly as before,
   apart from the hook runner being started once per session.
7. Removing the memory items leaves the harness configs as they were. Memory
   files the user or the agent wrote are never deleted by forgeflow.

## 3. Files

| File | Written by | In git | Holds |
|---|---|---|---|
| `.forgeflow/memory/lessons.md` | the agent, following `forge-lesson` | yes | One line per lesson |
| `.forgeflow/local/session.json` | the hook | no | The session record, as data |
| `.forgeflow/local/session.md` | the hook | no | The same record, readable |
| `.forgeflow/local/handoff.md` | the agent, following `forge-handoff` | no | The handoff note |
| `.forgeflow/local/.gitignore` | the hook or either skill | no | The single line `*` |

`.forgeflow/local/.gitignore` makes the folder ignore itself, including the
`.gitignore` file. Whoever first writes into the folder creates it.

These are data, not installed items: the lockfile does not list them, and
`forgeflow remove` leaves them in place.

### 3.1 The session record

`session.json`:

```json
{
  "current": {
    "id": "<harness session id, or empty>",
    "harness": "claude",
    "started": "2026-10-13T09:00:00.000Z",
    "updated": "2026-10-13T09:40:00.000Z",
    "branch": "feature/x",
    "files": ["src/a.js", "src/b.js"],
    "prompts": ["add a retry to the fetch helper", "now add a test"]
  },
  "previous": { "…the same shape, or null…": "" }
}
```

- **A new session** begins when an event carries a session id different from
  `current.id`, or, when no id is known, when more than two hours have passed
  since `current.updated`. `current` then moves to `previous` and a fresh
  `current` starts. Only one previous session is kept.
- **`files`**: project-relative paths the agent wrote, in first-seen order,
  without duplicates, at most 30. Paths under `.forgeflow/` are not recorded.
- **`prompts`**: the last three prompts, each cut to 300 characters, with
  credentials replaced (section 6). A prompt that is exactly an approval
  (`approve`) is not recorded.
- **`branch`**: read from `.git/HEAD`. Empty when that is not a plain branch
  reference (detached head, worktree, no repository).
- A file that cannot be read or parsed is replaced by a fresh record.

`session.md` is rewritten from the data on every change:

```
# Recent activity

## This session
Started 2026-10-13 09:00 UTC, last active 09:40 UTC, in claude, on branch feature/x.

Files changed:
- src/a.js
- src/b.js

Prompts:
- add a retry to the fetch helper
- now add a test

## Previous session
…
```

### 3.2 Lessons

`lessons.md` starts with a header that is itself the instruction, so it works
on every harness, including those that load the file without a hook:

```
# Project lessons

One line per lesson: a fact about this project that a later session needs.
When the user corrects you about this project, or you find such a fact, add
a line here and tell the user. Keep it to durable facts, not task status.
```

Each lesson is one bullet, at most 200 characters, starting with its date:
`- (2026-10-13) Run tests with npm test, not vitest directly.`

### 3.3 The handoff note

At most 40 lines, replaced whole each time, with these headings: Done, In
progress, Next, Decisions, Open questions.

## 4. Catalog items

| Item | Type | Does |
|---|---|---|
| `session-memory` | hook | Keeps the session record; adds memory to a new or compacted session |
| `forge-handoff` | skill | Has the agent write the handoff note |
| `forge-lesson` | skill | Has the agent add one lesson |

### 4.1 `group`

Hooks and skills gain one optional frontmatter field, `group`, whose only
allowed value is `memory`. All three items above carry it.

- `forgeflow add --memory` installs every item with `group: memory`.
- `forgeflow add --hooks` installs every hook without a `group`, so it still
  means "every quality gate".

### 4.2 The skills

Neither is user-invocable-only: the agent may follow them when the situation
calls for it.

**`forge-lesson`**

- Creates `lessons.md` with the header of section 3.2 if it is missing.
- Adds one line in the format of 3.2, and tells the user the line it added.
- A lesson must be about this project, must still be true next month, and
  must not be a secret, a task status or a preference of one person.
- A lesson that contradicts an existing one replaces it.
- Above 50 lessons, the agent merges duplicates and removes lessons that are
  no longer true, and tells the user what it changed.

**`forge-handoff`**

- Writes `handoff.md` in the form of 3.3, from what happened in this session.
- States only what was done or decided, not what was intended.
- Names files and commands exactly, and includes no secrets.
- Creates `.forgeflow/local/.gitignore` if it is missing.

## 5. Hook runtime changes

### 5.1 Events

Two event kinds join `shell`, `write`, `prompt` and `stop`:

| `kind` | Fields | Meaning |
|---|---|---|
| `start` | `source`: `startup`, `clear` or `compact` | A session is starting, or continuing after compaction |
| `compact` | — | The harness is about to compact the conversation |

A session-end event is not added: the record is already current after every
change, so there is nothing left to do at the end.

### 5.2 Results and context

A gate's `check` may also return:

- `{ context: string }`: text for the model's context. Delivered on `start`
  where the harness allows, and on `compact` for OpenCode.
- `{ tell: string }`: a message for the person. Delivered only where the
  harness can show one at that event.

`ctx` gains `session`: the harness's session id, or `''`.

### 5.3 Wiring

| Target | Added | Not added, and why |
|---|---|---|
| `claude` | `SessionStart`, matcher `startup\|clear\|compact` | `PreCompact`: it cannot add context; the restart after compaction does |
| `codex` | `SessionStart`, matcher `startup\|clear\|compact` | as Claude Code |
| `cursor` | `sessionStart`, `preCompact` | — |
| `opencode` | the plugin handles `experimental.session.compacting` | a session-start hook: none can add context |

`resume` is left out of the matcher: a resumed session already holds the
memory it was given at its start.

A project that installed gates before this phase gets the new entries from
`forgeflow update`. Until then `forgeflow status` shows its wiring as
`missing`.

### 5.4 Translating and responding

| Harness | Input | Event | A gate's `context` | A gate's `tell` |
|---|---|---|---|---|
| Claude Code, Codex | `SessionStart` | `start(source)` | `hookSpecificOutput.additionalContext` | dropped |
| Cursor | `sessionStart` | `start(startup)` | `additional_context` | dropped |
| Cursor | `preCompact` | `compact` | dropped | `user_message` |
| OpenCode | `experimental.session.compacting` | `compact` | pushed to `output.context` | dropped |

The session id comes from `session_id`, or `conversation_id` on Cursor, or
the plugin's `sessionID` on OpenCode.

### 5.5 OpenCode loading

OpenCode has no hook that can add context to a new session, so the memory
files are loaded the way rules are: through `instructions` in `opencode.json`.
With `session-memory` installed, forgeflow adds two entries:
`.forgeflow/memory/*.md` and `.forgeflow/local/*.md`.

Phase 3b managed one entry. This phase generalizes that: the entries forgeflow
wants are a function of what is installed for OpenCode (the rules glob when
any rule is installed, the two memory globs when `session-memory` is), and
forgeflow adds the missing ones and removes its own that are no longer
wanted. Every rule of phase 3b section 6 still holds: refusal, hand-wiring,
symbolic links, permissions, deletion of a file forgeflow created. The
lockfile record keeps its name, `rules`.

## 6. The `session-memory` hook

Events: `start`, `compact`, `write`, `prompt`.

| Event | Does |
|---|---|
| `write` | Adds the path to the record |
| `prompt` | Adds the prompt to the record |
| `start` | Returns the memory block as `context` |
| `compact` | OpenCode: returns the session record as `context`. Cursor: returns a `tell` |

Recording never blocks and never returns a note. A failure to write the
record is ignored.

**Credentials.** Before a prompt is stored, every match of the patterns
`secret-guard` uses is replaced with `[redacted]`. A private key is replaced
whole, from its first line to its last, or to the end of the prompt when the
last line is missing. The pattern list is
duplicated in the two gates, because a gate may import nothing from another;
a test keeps the two lists identical.

**The memory block** returned on `start`:

```
# forgeflow memory

## Project lessons
<lessons.md, up to 3,000 characters>

## Handoff note (written <date>)
<handoff.md, up to 1,500 characters>

## Recent activity
<session.md, up to 1,200 characters>

## Flow run in progress
<run name>: stage <stage>, status <status>. Its files are in <run directory>.
```

- A section is left out when its file is missing or empty. The handoff note
  and recent activity are also left out when older than seven days. With
  nothing to say, the hook returns nothing.
- Text over a section's limit is cut at a line end and followed by
  `(cut: read <path> for the rest)`.
- On `startup` and `clear`, "Recent activity" shows the previous session. On
  `compact` it shows the current one, and only when the record belongs to
  this session or the harness sends no session id.

**Cursor on compaction** tells the person: "forgeflow: this conversation is
being compacted. If the agent loses its place, ask it to read
`.forgeflow/local/session.md` and `.forgeflow/local/handoff.md`."

## 7. CLI

- `forgeflow add --memory --target <t>` installs the three items. It combines
  with names and the other bundle flags. With `--global` it fails with the
  existing gate error, since it includes a hook.
- `forgeflow info` prints `group` when set. `list --json` rows gain `group`.
- The usage text mentions `--memory`.

## 8. Limits

- **Loading is not obeying.** The model receives the memory. Nothing makes it
  act on it.
- **Lessons can be wrong or stale.** They are committed, so they appear in
  review, and anyone may edit the file.
- **The lessons file is a way into every teammate's agent.** The block opens
  by saying it is notes to check against the code, not instructions, and text
  from the lessons and handoff files is quoted line by line so it cannot pass
  for one of the block's own headings. A model can still be steered by what
  it reads, so changes to `.forgeflow/memory/` need review like code.
  `forge-lesson` records only what the user said or the code shows.
- **Unverified harness behavior.** The design assumes that Codex fires
  `SessionStart` with `source: compact` after a compaction, that Cursor does
  not fire `sessionStart` when an old chat is reopened, and that OpenCode does
  not re-read `instructions` on every model call (the session record changes
  on every write and prompt, which would then change the system prompt each
  turn). Each is a manual check.
- **Prompts are stored locally.** The last three prompts of the current and
  previous session sit in `.forgeflow/local/` in readable form. Credential
  patterns are replaced, but a secret that matches no pattern is stored.
- **Cursor cannot restore memory after compaction.** It can only tell the
  person.
- **OpenCode loads the files as they are**, whatever their age, and keeps
  them in context for the whole session. It has no start event, so on
  OpenCode a new session is recognized at its first prompt or tool call.
- **One record per project.** Two sessions open at once in the same project
  take turns being "current", and the record alternates between them.
- **Subagents.** Whether a harness reports a subagent's file writes under the
  parent session's id decides whether they land in the same record.
- **Every session start runs the hook runner**, for every project with any
  forgeflow hook installed, whether or not `session-memory` is.
- **Shell commands are not recorded.** A file changed by a shell command does
  not appear in the record.

## 9. Error handling

| Condition | Result |
|---|---|
| `group` with a value other than `memory`, or on an agent or rule | Catalog error naming the file |
| `--memory --global` | Usage error from the gate rule; nothing installed |
| Record file unreadable or malformed | Replaced by a fresh record |
| Record cannot be written | Ignored; the action proceeds |
| Memory file unreadable | That section is left out |
| Gate throws | Existing rule: skipped with a warning, never blocks |
| `opencode.json` unusable | Phase 3b rules: refused on add, never blocks removal |

## 10. Testing

- **Catalog**: `group` accepted on hooks and skills, rejected elsewhere and
  with other values; `start` and `compact` accepted as events.
- **Runtime**: normalization of each row in 5.4; `context` and `tell`
  delivered or dropped per harness; `resume` produces no event; session id
  extraction; existing gate behavior unchanged.
- **Wiring**: new entries for each target; an install from before this phase
  is upgraded by `update` and reports `missing` until then; removal restores
  the config.
- **Hook**: record creation, rotation by id and by idle time, file and prompt
  limits, `.forgeflow/` paths and approvals skipped, branch detection, a
  corrupt record replaced; every credential pattern redacted; the memory
  block for each combination of present, missing, stale and oversized files,
  and for `startup` against `compact`; the self-ignoring folder.
- **Runner end to end**: spawn the installed runner with harness-shaped input
  for a session start on each harness and assert the output; the OpenCode
  plugin's compaction hook.
- **OpenCode instructions**: entries for rules only, memory only and both;
  removing one kind keeps the other's entries; hand-wired configs.
- **CLI**: `--memory`, `--hooks` excluding memory, `--global` refused.
- **Content**: both skills state the rules of 4.2.

Loading in real harnesses is added to `docs/verification.md` as manual checks.

## 11. Decisions and their reasons

| Decision | Reason |
|---|---|
| Mechanical record, no model at session end | No harness lets a session-end hook get output from the model |
| No nudges to write a handoff | Each nudge costs a model turn and interrupts the end of a task |
| Record under the project, not the temp directory | It must survive a reboot and be readable by the agent and by OpenCode |
| Data and readable copy both written | The hook needs data to update; OpenCode and people need text |
| Rotation by session id, with an idle fallback | Works on harnesses with and without a start event |
| Folder ignores itself | No edit to the user's `.gitignore` |
| Instruction inside `lessons.md` itself | It reaches the model on every harness, hook or not |
| `resume` not wired | The resumed conversation already contains the block |
| No `PreCompact` on Claude Code and Codex | It cannot add context; the session start after compaction can |
| No session-end event | The record is current after every change |
| `group` field | `--hooks` keeps meaning "quality gates" without a list of names in the CLI |
| OpenCode entries derived from what is installed | One mechanism for rules and memory, and removal of one kind cannot drop the other |
| Credential patterns duplicated, with a parity test | Gates are self-contained files that import only built-ins |
