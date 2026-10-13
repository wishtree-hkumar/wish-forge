

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
