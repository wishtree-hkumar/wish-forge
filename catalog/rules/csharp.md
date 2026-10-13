---
name: csharp
description: C# standards - nullability, async code, errors, data and tests, with a section for ASP.NET Core projects.
paths:
  - "**/*.cs"
  - "**/*.cshtml"
  - "**/*.razor"
---
# C# standards

## Language

- Keep nullable reference types enabled, and treat their warnings as errors. Do not silence one with `!` unless you say why.
- Use `PascalCase` for types, methods and properties, `camelCase` for locals and parameters, and prefix interfaces with `I`.
- Use records for data carriers and value objects. Use `init` or `required` properties instead of a settable property that should not change.
- Use file-scoped namespaces and one public type per file.
- Use `var` where the type is obvious from the right-hand side, and the explicit type otherwise.
- Prefer pattern matching and switch expressions to chains of `if` and casts.
- Mark classes `sealed` unless they are designed for inheritance.
- Use `decimal` for money, and `DateTimeOffset` with an injected time provider for the clock.
- Return an empty collection, never `null`, and expose `IReadOnlyList<T>` or `IEnumerable<T>` rather than a mutable list.

## Async

- Async all the way: never block on asynchronous work with `.Result`, `.Wait()` or `GetAwaiter().GetResult()`.
- Suffix asynchronous methods with `Async`, and return a task type. Use `async void` only for event handlers.
- Accept a `CancellationToken` in every asynchronous public method and pass it on to every call that takes one.
- Do not start work and forget it. Await it, or hand it to a background service that owns its lifetime.
- Do not wrap synchronous code in a thread-pool call to make it look asynchronous.

## Errors and resources

- Throw the most specific exception type. Validate arguments at public boundaries with the guard helpers the framework provides.
- Catch only what you can handle. Rethrow with `throw;` so the stack trace is kept.
- Never leave a catch block empty, and never catch the base exception type except at a top-level boundary that logs and reports.
- Dispose what you create with `using` or `await using`.

## Data

- Enumerate a query once. Materialize it when you need to read it more than once.
- Never build SQL by joining strings with input. Use parameters or the query provider.
- Do not load an entity only to read one field. Project to what you need.
- Read-only queries do not track changes.

## Structure and tests

- Depend on abstractions at module boundaries and inject them through the constructor. No service locator and no static mutable state.
- Log with message templates and named placeholders, not interpolated strings. Never log secrets or personal data.
- Write tests with the project's test framework, one behavior per test, arranged as setup, action and check.

## ASP.NET Core

These apply only when the project uses ASP.NET Core.

- Keep controllers and endpoint handlers thin: bind, validate, call a service, map the result.
- Never bind a request directly to a persistence entity, and never return one. Use separate request and response types.
- Validate every request model, and return problem details in one consistent shape for errors.
- Register services with the narrowest lifetime that works. Never inject a scoped service into a singleton.
- Bind configuration to typed options classes and validate them at start-up. Do not read configuration keys by string through the code.
- Require authorization by default, and opt endpoints out explicitly.
- Create HTTP clients through the client factory, with timeouts. Do not create one per call.
- Take the request's cancellation token in every handler and pass it down.
- Change the schema only through migrations kept in version control.
- Do slow work in a hosted background service or a queue, not inside the request.
