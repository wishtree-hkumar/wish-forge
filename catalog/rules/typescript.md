---
name: typescript
description: TypeScript and JavaScript standards - types, modules, async code, errors and Node.
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mts"
  - "**/*.cts"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mjs"
  - "**/*.cjs"
---
# TypeScript and JavaScript standards

The typing rules apply to TypeScript files. The rest apply to JavaScript as well.

## Types

- Keep `strict` on. Do not weaken compiler options to make an error go away.
- Do not use `any`. Use `unknown` for a value you have not checked, and narrow it before use.
- Do not silence the compiler with `as`, `!` or an ignore comment. If you must, say why on the same line.
- Give every exported function explicit parameter and return types. Let local variables be inferred.
- Model a value that can take several shapes as a union with a discriminating field, and handle every case; make the default branch a compile error with `never`.
- Prefer `readonly` properties and arrays for data that should not change after creation.
- Validate data from outside the program at run time. A type annotation on parsed JSON proves nothing.
- Use `undefined` for "absent" unless an interface you do not control requires `null`. Do not mix the two for one meaning.
- Prefer a union of string literals to an `enum`.

## Language

- Use `const` by default and `let` only when the binding is reassigned. Never `var`.
- Compare with `===` and `!==`.
- Use `??` for defaults and `?.` for optional access. Do not use `||` where `0`, `''` or `false` is a valid value.
- Do not mutate a parameter or shared object. Return a new value.
- Prefer `map`, `filter` and `for…of` to an index loop, and never use `for…in` on an array.

## Modules

- Use ES modules, except in files that are CommonJS by design: a `.cjs` file, or a project that uses CommonJS throughout. Prefer named exports to a default export.
- Import types with `import type`.
- No import cycles. A module that needs two others to import each other is doing two jobs.
- Do not reach into another package's internal files. Import from its public entry point.

## Async

- Every promise is awaited, returned or explicitly handled. A floating promise is a defect.
- Use `async` and `await` instead of chained `then` calls.
- Run independent work together with `Promise.all`. Do not await in a loop unless order matters.
- Give every network and timer wait a timeout or a cancellation signal.

## Errors

- Throw `Error` objects, never strings or plain objects. Add a `cause` when wrapping.
- A caught value is `unknown`. Check what it is before reading its fields.
- Do not use an exception for an outcome the caller expects. Return a result the type system makes them handle.

## Node

- Read configuration from the environment in one place at start-up, validate it, and pass it on as values.
- Use the asynchronous file and network functions in request handlers. Synchronous ones block every request.
- Never pass unchecked input to a child process, a file path or a dynamic `import`.
