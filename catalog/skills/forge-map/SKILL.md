---
name: forge-map
description: Build or refresh the project map, a short committed description of what the project is, how it is laid out and where things live. Use when the user asks to map the project or to refresh the map.
user-invocable-only: true
group: memory
requires:
  - agent:mapper
---
# forgeflow: map the project

The project map is one short file, `.forgeflow/memory/map.md`, that tells a new session what the project is and where things live, so it does not have to explore first. It is committed, and given to every new session.

You run the mapping. The `mapper` subagent reads the project and writes the map; you save it.

## Steps

1. If `.forgeflow/memory/map.md` exists, read it. You will pass it to `mapper` as the existing map, to be checked and updated. If it does not exist, you will ask for a new map.
2. Delegate to `mapper`. If that subagent is not available, stop and tell the user to install it with `forgeflow add --memory --target <their harness>`.
3. Take the map from its reply. Under the title line, insert a blank line and then this line, with today's date and the short hash of the current commit from the project's version control:

   ```
   Generated YYYY-MM-DD at commit <short hash> by forge-map. Check it against the code before relying on it.
   ```

   If the project is not under version control, leave out `at commit <short hash>`.
4. If the result is over 6,000 bytes, ask `mapper` once to shorten it, and use what it returns.
5. Save the result as `.forgeflow/memory/map.md`, replacing the old file.
6. Tell the user, briefly: which sections changed, what is listed under "Not determined", and that the file should be reviewed and committed like any other change.

## Rules

- Do not write or correct the map yourself. If something in it looks wrong, send it back to `mapper` with what you noticed.
- Do not change the form of the generated line. The age warning new sessions get is read from it.
- Do not run this unless the user asked for it. A refreshed map is a change to a committed file.
