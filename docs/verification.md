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
