---
name: java
description: Java standards - types, immutability, errors, concurrency and tests, with a section for Spring projects.
paths:
  - "**/*.java"
---
# Java standards

## Language

- Use the language level the build declares, and its features: records for data carriers, sealed types for closed hierarchies, switch expressions, pattern matching.
- Make fields `private final` unless they must change. Make classes `final` unless they are designed for extension.
- Never return `null` for a collection or an array. Return an empty one.
- Return `Optional<T>` from a method that may have no result. Do not use `Optional` for fields or parameters.
- Do not pass or return `null` across a public method without saying so in the contract. Check arguments at the boundary with `Objects.requireNonNull`.
- Use generics fully. No raw types and no unchecked casts without a comment saying why it is safe.
- Override `equals` and `hashCode` together, or use a record.
- Use `var` only where the type is obvious from the right-hand side.
- Compare strings and objects with `equals`, and enums with `==`.

## Structure

- Program to interfaces at module boundaries, and to concrete classes inside them.
- Inject dependencies through the constructor. No field injection and no static singletons holding state.
- Keep a class to one responsibility. A class named Manager, Helper or Util is usually several.
- Return unmodifiable collections from a class that owns the data. Copy what you are handed if you keep it.
- Use `java.time` for dates and times, and `BigDecimal` for money.

## Errors

- Throw the most specific exception that fits. Use unchecked exceptions for programming errors and for failures the caller cannot recover from.
- Never catch `Exception` or `Throwable` except at a top-level boundary that logs and reports. Never leave a catch block empty.
- Keep the cause when wrapping: pass the original exception to the new one.
- Close resources with try-with-resources.
- Restore the interrupt flag when you catch `InterruptedException` and cannot rethrow it.

## Concurrency

- Prefer immutable objects and the `java.util.concurrent` classes to hand-written locking.
- Do not share a mutable object between threads without stating how access is guarded.
- Run tasks on an executor you can shut down. Do not create threads directly.
- Give every blocking call on another service a timeout.

## Logging and tests

- Log through the project's logging facade with parameter placeholders, not string concatenation. Never log secrets or personal data.
- Write tests with the project's test framework, one behavior per test, with a name that states it.
- Use parameterized tests for the same check over several inputs.

## Spring

These apply only when the project uses Spring.

- Use constructor injection. A class with one constructor needs no annotation on it.
- Keep controllers thin. They map requests to a service call and a response, and hold no business logic.
- Never expose a persistence entity in a request or a response. Map to and from separate request and response types.
- Validate request bodies with bean validation annotations and `@Valid`.
- Put `@Transactional` on service methods, not on controllers or repositories, and mark reads as read-only.
- Do not call a transactional or cached method from another method of the same class: the proxy is bypassed.
- Bind configuration to typed properties classes. Do not scatter `@Value` through the code.
- Handle errors in one place with a controller advice, and return one consistent error shape.
- Avoid loading relations lazily outside a transaction, and fetch what a use case needs in one query.
- Never build a query by concatenating input. Use parameters or derived query methods.
