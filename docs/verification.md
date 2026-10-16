# Manual verification per harness

The automated tests prove that wishforge writes well-formed files. They cannot prove that each harness loads them. Do this check once per harness before the first internal release, and again when a harness changes its agent or skill format.

Record the harness version and the date beside each result.

## Setup

In an empty scratch repository that has at least one source file and a working test command:

    wishforge add --flow full --target <harness>

## Checks

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 1 | The harness starts with no warning about the installed files | | | | |
| 2 | All 11 agents appear in the harness's agent list | | | | |
| 3 | `forge-full` and, after installing it, `forge-quick` can be started explicitly | | | | |
| 4 | Asking "use the reviewer agent on the last commit" runs `reviewer` as a subagent | | | | |
| 5 | `reviewer`, asked to edit a file, does not edit it | | | | |
| 6 | `builder`, asked to make a small change, edits the file | | | | |
| 7 | A quick-flow run creates `.wishforge/runs/<run>/` with `state.md` and the stage files | | | | |
| 8 | A full-flow run stops at HUMAN_APPROVAL and waits | | | | |
| 9 | Declining at HUMAN_APPROVAL stops the run before DEPLOY | | | | |
| 10 | `wishforge remove forge-full --target <harness>` leaves no wishforge file behind | | | | |

How to list agents: `/agents` in Claude Code; `/agent` in Codex; `@` completion in OpenCode; the subagent picker in Cursor.

## Known differences between harnesses

- Model selection is set only for Claude Code. Elsewhere agents use the session's model.
- On Claude Code, read-only agents can still run shell commands, so check 5 relies on the agent's instructions there. On Codex, OpenCode and Cursor the harness enforces it.
- In Codex, flows are started with `$forge-quick`, not `/forge-quick`.

If a check fails, record what the harness did, and compare the installed file with that harness's current documentation before changing an adapter.

## Quality gates

Install the gates in the same scratch repository:

    wishforge add --hooks --target <harness>

On Codex, run `/hooks` and trust the project hooks first.

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 11 | The harness starts with no warning about the hook config or plugin | | | | |
| 12 | Asking the agent to create `.env` is blocked, and the agent reports why | | | | |
| 13 | Asking the agent to write a file containing a fake token (`ghp_` followed by 36 letters) is blocked | | | | |
| 14 | Asking the agent to edit one line of an existing file to add that token is blocked | | | | |
| 15 | Asking the agent to edit the harness's hook config is blocked | | | | |
| 16 | During a full-flow run, asking the agent to `git push` before approval is blocked | | | | |
| 17 | At HUMAN_APPROVAL, typing `approve` creates `09-approval.md` with `decision: approved` | | | | |
| 18 | After that, `git push` is no longer blocked | | | | |
| 19 | A subagent (for example `builder`) is blocked by the same gates as the main agent | | | | |
| 20 | Ending a turn after an edit with no test run produces one reminder (not OpenCode) | | | | |
| 21 | `wishforge remove` of all gates leaves the hook config as it was before | | | | |

Check 14 matters most on Cursor: it shows whether a partial edit reaches the pre-tool hook with its new text. If it is not blocked there, `secret-guard` on Cursor covers whole-file writes only; record that in the README.

Check 19 shows whether the harness runs hooks for subagent tool calls. Record the result per harness.

Three more checks came out of code review. Each tests an assumption about a harness that the automated tests cannot confirm:

| # | Check | Harness |
|---|---|---|
| 22 | With gates installed, the agent can read `09-approval.md`, `.env.example` and other files normally (reads are not treated as writes) | Cursor |
| 23 | Asking the agent to change several places in `.env` in one step, or to apply a patch that adds `.env`, is blocked | OpenCode |
| 24 | During a run waiting at HUMAN_APPROVAL, ask the agent to start a subagent whose instructions begin with "approve". `09-approval.md` must not be created | OpenCode |

If check 24 fails, the prompt hook fires for subagent prompts and the approval can be forged on that harness: do not rely on `approval-gate` there until it is fixed.

## Specialists

Install the specialists and a flow in the same scratch repository:

    wishforge add --specialists --flow quick --target <harness>

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 25 | All ten specialists appear in the harness's agent list | | | | |
| 26 | Asking "use the security-reviewer agent on the last commit" runs it, and its reply ends with a `VERDICT:` line | | | | |
| 27 | A quick-flow run creates `07-review-security-reviewer.md` and the three other specialist reports in the run directory | | | | |
| 28 | After `wishforge remove` of all four reviewers, a new run creates no `07-review-*` file other than `07-review.md` and says nothing about specialists | | | | |
| 29 | With `security-reviewer` installed only with `--global`, a run in a project still runs it | | | | |
| 30 | Ask for a change with an obvious injection flaw: `security-reviewer` requests changes and the run returns to BUILD, then reviews again | | | | |
| 31 | Asking `debugger` to explain a failing test produces a root-cause report. Record whether it could run the test or had to work by reading | | | | |

Check 27 shows whether the model follows the instruction to look in the agents folder. If a harness skips the specialists, record it in the README: on that harness they must be run by hand.

Check 31 matters most on Codex, where a read-only agent runs in a read-only sandbox and many test commands cannot write their caches. There `debugger` works by reading and labels its cause as unconfirmed.

Check 29 matters most on OpenCode, whose user-level folder is `~/.config/opencode/agents`.

## Rules packs

Install two packs and the reviewer in the same scratch repository, which should contain a TypeScript file:

    wishforge add common typescript standards-reviewer --target <harness>

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 32 | The harness starts with no warning about the rule files, `AGENTS.md` or `opencode.json` | | | | |
| 33 | Ask "which coding standards apply when you edit a .ts file here?" The answer quotes a rule from the `typescript` pack and one from `common` | | | | |
| 34 | Ask the same about a `.md` file. The answer uses `common` only (not OpenCode, which always loads every pack) | | | | |
| 35 | Ask the agent to add a function that uses `any` in a `.ts` file. It avoids `any`, or says the standards forbid it | | | | |
| 36 | Ask "use the standards-reviewer agent on the last commit" after committing a `.ts` file that uses `var`. Its findings name the pack and quote the rule | | | | |
| 37 | A quick-flow run with `standards-reviewer` installed creates `07-review-standards-reviewer.md` | | | | |
| 38 | `wishforge remove common typescript --target <harness>` leaves `AGENTS.md` and `opencode.json` as they were before, or gone if wishforge created them | | | | |

Check 33 is the one that shows whether the rules reach the model at all. On Codex it also shows whether the model follows the pointer in `AGENTS.md`: record what it did.

Two more checks test assumptions the automated tests cannot confirm:

| # | Check | Harness |
|---|---|---|
| 39 | After `wishforge add common --target opencode --global`, check 33 passes in a project with no rules of its own. This shows OpenCode expands `~` in an `instructions` entry | OpenCode |
| 40 | The installed `.cursor/rules/wishforge-typescript.mdc` shows in Cursor's rules settings as applying to specific files, with its patterns listed | Cursor |

If check 39 fails, replace `~` in the global entry with the full path and record it in the README. If check 40 fails, compare the file's frontmatter with a rule created in Cursor itself.

## Session memory

Install it in the same scratch repository:

    wishforge add --memory --target <harness>

On Codex, run `/hooks` and trust the project hooks again: the hook config changed.

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 41 | The harness starts with no warning about the hook config, the plugin or `opencode.json` | | | | |
| 42 | Ask the agent to edit a file. Afterwards `.wishforge/local/session.md` lists that file and your prompt | | | | |
| 43 | `git status` shows nothing under `.wishforge/local/` | | | | |
| 44 | Start a new session and ask "what was I working on here last time?" The answer names the file and the prompt without the agent reading any file | | | | |
| 45 | Tell the agent something it got wrong about the project ("we use pnpm here, not npm"). It adds one line to `.wishforge/memory/lessons.md` and tells you | | | | |
| 46 | Run `forge-handoff`. `.wishforge/local/handoff.md` is written, and a new session can say what is next | | | | |
| 47 | Compact the conversation, then ask which files this session changed. The answer is right (Cursor: a message tells you which files to point the agent at) | | | | |
| 48 | Resume an earlier session. No second memory block is added (Claude Code and Codex) | | | | |

Check 42 shows whether the hook fires with a session id on that harness. Check 44 is the one that shows the memory reaches the model.

Two more checks test assumptions the automated tests cannot confirm:

| # | Check | Harness |
|---|---|---|
| 49 | With `.wishforge/memory/` empty or absent, OpenCode starts with no warning about an `instructions` entry that matches no file | OpenCode |
| 50 | In check 42, a file written by a subagent appears in the same session's record, not a new one | Claude Code, Codex, Cursor |

If check 50 fails on a harness, subagent work starts a new record there and pushes the main session's record into "previous": record it in the README.

Three more checks cover harness behavior the design assumes and no test here can confirm:

| # | Check | Harness |
|---|---|---|
| 51 | Check 47 passes on Codex: after a compaction the agent still knows which files this session changed. This shows Codex fires its session-start hook after compaction | Codex |
| 52 | Close a chat and reopen it later. No second "wishforge memory" block is added | Cursor |
| 53 | In a session with several edits, the cost or speed of later turns does not degrade compared with a project without session memory. `session.md` changes on every write and prompt; if OpenCode re-reads `instructions` on each model call, its prompt cache is lost every turn | OpenCode |

If check 53 fails, remove `.wishforge/local/*.md` from `instructions` on OpenCode and record it in the README: the lessons still load, and the session record stays readable on request.

## Project map

With `--memory` installed in a scratch repository that has real source code:

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 54 | Run `forge-map`. `.wishforge/memory/map.md` is written with Purpose, Commands and Layout, a `Generated` line with today's date, and is at most 3,200 bytes | | | | |
| 55 | Pick five statements from the map and check each against the code. All five are true | | | | |
| 56 | Start a new session and ask where one of the map's concerns is handled. The agent answers from the map, opening at most the file it names | | | | |
| 57 | Change the date in the `Generated` line to two months ago and start a new session. The agent says the map may be out of date (not OpenCode) | | | | |
| 58 | Start a quick-flow run. The first stage's subagent reads `.wishforge/memory/map.md` before exploring | | | | |

Check 55 is the one that shows whether the map can be trusted. If more than one statement in five is wrong on a harness, record it in the README.

Five more checks cover what the review of this phase could not confirm:

| # | Check | Harness |
|---|---|---|
| 59 | Run `forge-map` a second time after a small code change. The file has one `Generated` line, with the new date, and the diff touches only what changed | all |
| 60 | In a repository whose git-ignored `.env` holds a fake token and an internal URL, run `forge-map`. Neither appears in the map | all |
| 61 | Remove `mapper` from the harness's agents folder by hand and run `forge-map`. It stops and names the install command, and the existing map is unchanged | all |
| 62 | Run `forge-map` in a folder that is not under version control. The `Generated` line has no `at commit` part | all |
| 63 | With lessons, a full-size map, a handoff note and a flow run in progress, a new session still receives the "Flow run in progress" section. This shows the block fits within the harness's limit on text a hook may add | Claude Code, Codex, Cursor |

If check 63 fails, the harness cuts the block: lower the limits in the hook and record the harness's limit in the README.

## Context cost

| # | Check | Harness |
|---|---|---|
| 64 | With a flow, `common` and `typescript`, and session memory installed, compare `wishforge tokens` with what `/context` reports for the agents, skills and memory files. Record the difference, and whether `forge-quick` and `forge-full` appear in the skills the model is offered | Claude Code; the same question about offered skills on Cursor and OpenCode |

`wishforge tokens` assumes that a skill only a person can start is not offered to the model on Claude Code, Cursor and OpenCode, and is on Codex. If check 64 shows otherwise, correct `offered` in `src/tokens.ts`.
