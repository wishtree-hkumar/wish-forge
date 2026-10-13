

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
