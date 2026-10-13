---
name: session-memory
description: Keeps a local record of what each session changed and was asked, and gives a new or compacted session the project's lessons, handoff note and last activity. It never blocks.
events: [start, compact, write, prompt]
group: memory
---
As the agent works, this records the files it writes and your last three prompts in `.forgeflow/local/session.json` and a readable copy, `session.md`. That folder ignores itself, so nothing in it is committed. Credentials in a prompt are replaced with `[redacted]` before it is stored.

When a session starts, it adds one block to the model's context: the shared lessons in `.forgeflow/memory/lessons.md`, the handoff note if it is less than a week old, what the last session did, and any flow run in progress. On Claude Code and Codex the block is added again after a compaction, with what the current session has done so far.

Cursor cannot add context after a compaction, so there it tells you which files to point the agent at. OpenCode has no session-start hook: the memory files are listed in `opencode.json` instead, and the record is added to the compaction prompt.

Install it with the two commands that write the handoff note and the lessons: `forgeflow add --memory --target <harness>`.
