---
name: common
description: Coding standards for every language - naming, functions, errors, tests, security, comments, dependencies and version control.
---
# Common standards

These apply to all code you add or change. Do not rewrite code a task does not touch to make it comply, unless you are asked to. Where a rule here differs from what this project already does consistently, the project's convention wins: match the code around you.

## Naming and structure

- Name things for what they mean in the problem, not for their type or how they are built.
- Use one word for one idea across the codebase. Do not introduce a second name for something that already has one.
- A function does one thing. If you need "and" to describe it, split it.
- Keep a function short enough to read without scrolling, and nest no deeper than three levels. Return early instead.
- Pass what a function needs as parameters. Do not reach for global or shared mutable state.
- Delete dead code, unused parameters and commented-out code. Version control remembers them.
- Do not add an abstraction, an option or a layer until there is a second real use for it.

## Errors

- Handle an error where you can do something about it. Otherwise let it travel up unchanged.
- Never swallow an error. An empty handler, or one that only logs and carries on as if nothing happened, is a defect.
- Fail fast on input that cannot be right. Validate at the boundary, then trust the value inside.
- Make error messages say what happened and what was expected, with the value that caused it, but never a secret.
- Release what you acquire, on every path, including the failing ones.

## Tests

- Every change in behavior comes with a test that fails without it.
- Test behavior through the public interface, not private details. A refactor should not break tests.
- One test checks one behavior, and its name says which.
- Replace a real dependency with a stand-in only when it is slow, random or external. Never assert only that a stand-in was called.
- Tests do not depend on each other, on order, on the clock or on the network.

## Security

- Treat everything from outside the process as untrusted: requests, files, environment, other services.
- Never build a query, a command, a path or markup by joining strings with untrusted input. Use parameters and the escaping the platform provides.
- Keep secrets out of code, logs, error messages and version control. Read them from configuration at run time.
- Check that the caller may act on this particular object, not only that they are signed in.
- Deny by default. When a check fails or errors, refuse.

## Comments and documentation

- Comment why, not what. If a comment restates the code, delete it and improve the name.
- Keep comments true. Change the comment in the same edit that changes the code.
- Document every public interface: what it does, its inputs, its result and its failures.

## Dependencies

- Add a dependency only when writing the code yourself would be clearly worse. Prefer the standard library.
- Pin versions the way the project already does, and commit the lockfile.

## Version control

- One logical change per commit, with a message that says why.
- Do not commit generated files, build output, personal editor settings or secrets.
- Use the project's formatter and linter, and leave no warnings behind.
