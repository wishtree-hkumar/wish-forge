# Manual verification per harness

The automated tests prove that forgeflow writes well-formed files. They cannot prove that each harness loads them. Do this check once per harness before the first internal release, and again when a harness changes its agent or skill format.

Record the harness version and the date beside each result.

## Setup

In an empty scratch repository that has at least one source file and a working test command:

    forgeflow add --flow full --target <harness>

## Checks

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 1 | The harness starts with no warning about the installed files | | | | |
| 2 | All 11 agents appear in the harness's agent list | | | | |
| 3 | `forge-full` and, after installing it, `forge-quick` can be started explicitly | | | | |
| 4 | Asking "use the reviewer agent on the last commit" runs `reviewer` as a subagent | | | | |
| 5 | `reviewer`, asked to edit a file, does not edit it | | | | |
| 6 | `builder`, asked to make a small change, edits the file | | | | |
| 7 | A quick-flow run creates `.forgeflow/runs/<run>/` with `state.md` and the stage files | | | | |
| 8 | A full-flow run stops at HUMAN_APPROVAL and waits | | | | |
| 9 | Declining at HUMAN_APPROVAL stops the run before DEPLOY | | | | |
| 10 | `forgeflow remove forge-full --target <harness>` leaves no forgeflow file behind | | | | |

How to list agents: `/agents` in Claude Code; `/agent` in Codex; `@` completion in OpenCode; the subagent picker in Cursor.

## Known differences between harnesses

- Model selection is set only for Claude Code. Elsewhere agents use the session's model.
- On Claude Code, read-only agents can still run shell commands, so check 5 relies on the agent's instructions there. On Codex, OpenCode and Cursor the harness enforces it.
- In Codex, flows are started with `$forge-quick`, not `/forge-quick`.

If a check fails, record what the harness did, and compare the installed file with that harness's current documentation before changing an adapter.

## Quality gates

Install the gates in the same scratch repository:

    forgeflow add --hooks --target <harness>

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
| 21 | `forgeflow remove` of all gates leaves the hook config as it was before | | | | |

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

    forgeflow add --specialists --flow quick --target <harness>

| # | Check | Claude Code | Codex | OpenCode | Cursor |
|---|---|---|---|---|---|
| 25 | All ten specialists appear in the harness's agent list | | | | |
| 26 | Asking "use the security-reviewer agent on the last commit" runs it, and its reply ends with a `VERDICT:` line | | | | |
| 27 | A quick-flow run creates `07-review-security-reviewer.md` and the three other specialist reports in the run directory | | | | |
| 28 | After `forgeflow remove` of all four reviewers, a new run creates no `07-review-*` file other than `07-review.md` and says nothing about specialists | | | | |
| 29 | With `security-reviewer` installed only with `--global`, a run in a project still runs it | | | | |
| 30 | Ask for a change with an obvious injection flaw: `security-reviewer` requests changes and the run returns to BUILD, then reviews again | | | | |
| 31 | Asking `debugger` to explain a failing test produces a root-cause report. Record whether it could run the test or had to work by reading | | | | |

Check 27 shows whether the model follows the instruction to look in the agents folder. If a harness skips the specialists, record it in the README: on that harness they must be run by hand.

Check 31 matters most on Codex, where a read-only agent runs in a read-only sandbox and many test commands cannot write their caches. There `debugger` works by reading and labels its cause as unconfirmed.

Check 29 matters most on OpenCode, whose user-level folder is `~/.config/opencode/agents`.
