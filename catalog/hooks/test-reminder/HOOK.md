---
name: test-reminder
description: Nudges the agent once when a turn ends with source edits and no test run since. Advisory only; it never blocks.
events: [shell, write, stop]
---
It notes when an agent changes a source file and when it runs a test command. If the agent ends its turn with edits and no test run since, it is asked once to run the tests or tell you why it did not.

Recognized test commands include `npm test`, `pnpm test`, `yarn test`, `bun test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `phpunit`, `mvn test`, `gradle test`, `dotnet test`, `rspec` and `make test`. Add your own under `testCommands` in `.wishforge/config.json`.

Markdown files and anything under `.wishforge/` do not count as source edits.

Not supported on OpenCode, which cannot send a message back to the agent at the end of a turn.
