---
name: forge-handoff
description: Write a handoff note for the next session - what is done, what is in progress and what comes next. Use when the user asks for a handoff, before stopping work that is unfinished, or when told the conversation is being compacted.
group: memory
requires:
  - hook:session-memory
---
# wishforge: write a handoff note

The note is for whoever continues this work in a new session that has none of this conversation. It is saved as `.wishforge/local/handoff.md`, which is not committed, and is given to the next session if it is less than a week old.

## Steps

1. If `.wishforge/local/.gitignore` does not exist, create it containing the single line `*`.
2. Establish what actually happened. Look at the files changed in this session with the project's version control, at the tests that were run and their results, and at what the user decided.
3. Replace `.wishforge/local/handoff.md` with a note of at most 40 lines, under the headings below. Leave out a heading that has nothing under it.
4. Tell the user the note is saved, and repeat its "Next" section in a line or two.

## The note

```
## Done
## In progress
## Next
## Decisions
## Open questions
```

- **Done**: what is finished, and how it was verified. If it was not verified, say so.
- **In progress**: what was started and not finished: the exact file, what is missing, and whether the tests pass right now.
- **Next**: the next steps in order. Make the first one specific enough to start on without asking.
- **Decisions**: choices that were made and why, above all the user's, and anything that was tried and did not work.
- **Open questions**: what the user still has to decide.

## Rules

- State what was done or decided, not what was intended. If something was not run, say it was not run.
- Name files, commands and branches exactly.
- No secrets, tokens or personal data.
- Replace the whole note. Do not append to the old one.
- A durable fact about the project belongs in `.wishforge/memory/lessons.md`, not here.
