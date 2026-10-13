---
name: go
description: Go standards - errors, interfaces, concurrency, packages and tests.
paths:
  - "**/*.go"
---
# Go standards

## Style

- Format with `gofmt` and keep `go vet` clean. Do not argue with the formatter.
- Use short names for short scopes and descriptive names for package-level identifiers. No underscores, no `Get` prefix on getters.
- Name a package for what it provides, in one lower-case word. Avoid `util`, `common` and `helpers`.
- Do not repeat the package name in its identifiers: `http.Server`, not `http.HTTPServer`.
- Make the zero value of a type useful, or provide a constructor and say so.
- Return early on error and keep the main path unindented.
- Document every exported identifier with a comment that starts with its name.

## Errors

- Check every error. Assign to `_` only with a comment saying why it is safe to ignore.
- Wrap an error with context using `fmt.Errorf("doing x: %w", err)`. Say what you were doing, not "failed to".
- Compare with `errors.Is` and `errors.As`, never by matching the message text.
- Handle an error once: either log it or return it, not both.
- Do not `panic` for a failure a caller could handle. Reserve it for states that mean the program is wrong.
- Return a nil error with a usable value, and a non-nil error with a zero value.

## Interfaces and types

- Accept interfaces, return concrete types.
- Define an interface where it is used, not where it is implemented, and keep it to the methods that user needs.
- Do not add an interface for a type with one implementation and no test double.
- Use a pointer receiver when the method changes the value or the value is large, and be consistent across a type's methods.
- Do not use `any` where a concrete type or a type parameter would do.

## Concurrency

- Pass `context.Context` as the first parameter of anything that does input, output or waits. Never store it in a struct.
- Never start a goroutine without knowing how it stops. Tie it to a context or a done channel, and wait for it.
- The sender closes a channel, never the receiver.
- Guard shared state with a mutex kept next to the data it protects, or confine the state to one goroutine.
- Use `errgroup` or a wait group to run and collect concurrent work. Do not sleep to wait for a goroutine.
- Run the tests with the race detector.

## Resources

- Close what you open with `defer`, immediately after checking the error from opening it.
- Check the error from closing something you wrote to.
- Give every outbound network call a timeout. Do not use the default HTTP client for calls that leave the process.
- Do not `defer` inside a long loop. Move the body into a function.

## Packages

- Keep `main` small: parse configuration, build dependencies, start, and handle shutdown.
- No package-level mutable state and no `init` functions with side effects. Pass dependencies in.
- Put code that other modules must not import under `internal`.
- Keep `go.mod` tidy, and commit `go.sum`.

## Tests

- Use table-driven tests with named cases run through `t.Run`.
- Mark helpers with `t.Helper()`, and use `t.Cleanup` and `t.TempDir` rather than manual teardown.
- Compare with the standard library or the project's chosen helper, and print both got and want on failure.
- Test through exported behavior. Put tests in the `_test` package when they need only the public interface.
