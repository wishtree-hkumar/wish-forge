---
name: angular
description: Angular standards - components, signals and RxJS, templates, dependency injection and tests.
paths:
  - "**/*.ts"
  - "**/*.html"
---
# Angular standards

These apply only in an Angular project, and follow current Angular. Where the project is on an older version, keep to the style its code already uses.

## Components

- Write standalone components. Do not add a new module to hold one.
- Use `ChangeDetectionStrategy.OnPush` for every component.
- Keep a component to presentation and wiring. Put data access and business rules in services.
- Follow the file naming the project uses, with one component, directive, pipe or service per file.
- Split a component that both fetches data and renders it into a container and a presentational part.
- Keep a selector prefix that is consistent across the application.

## Inputs, outputs and state

- Declare inputs and outputs with the `input()`, `output()` and `model()` functions in new code, and mark required inputs as required.
- Never mutate an input. Emit an output and let the parent change the value.
- Hold component state in signals. Derive values with `computed`, never by copying state.
- Use an `effect` only to synchronize with something outside the signal graph. Do not set other signals from one.
- Keep state local until two distant components need it. Then use a service or the project's store.

## RxJS

- Every subscription ends. Use the `async` pipe, `takeUntilDestroyed`, or convert to a signal, and never leave a manual subscription without teardown.
- Do not nest subscriptions. Combine with `switchMap`, `mergeMap`, `concatMap` or `combineLatest`, and choose the one whose cancellation behavior you want.
- Use `switchMap` for a request that a newer one replaces, such as search.
- Handle errors inside the inner stream, so one failure does not end the outer one.
- Expose observables from services as read-only. Keep subjects private.
- Do not subscribe in a service just to copy a value into a field.

## Templates

- Use the built-in control flow, `@if`, `@for` and `@switch`, in new templates.
- Give every `@for` a `track` expression that is stable and unique, from the data.
- Never call a method that does work from a template binding. Use a signal, a computed value or a pure pipe.
- Do not bind markup from a string unless it has been sanitized, and never bypass the sanitizer for content you did not write.
- Keep templates free of logic longer than a simple expression.

## Dependency injection and services

- Provide application-wide services in the root injector, and feature services where the feature is loaded.
- Inject with `inject()` or the constructor, consistently within a file.
- Depend on an abstraction or an injection token where a service has more than one implementation.
- Make HTTP calls only in services, type their responses, and handle shared concerns such as authentication in interceptors.

## Forms and routing

- Use typed reactive forms for anything beyond a single field, and keep validation in validators, not in the template.
- Load feature routes lazily, and protect routes with functional guards.
- Read route parameters as observables or signals, since a component can be reused across navigations.

## Types, accessibility and tests

- Keep strict TypeScript and strict template checking on. No `any` in component, service or template types.
- Use the right element: a button for an action, a link for navigation, a label for every input, and make every control work with the keyboard.
- Test components through the rendered output and user interaction, and test services with their HTTP calls replaced by the testing controller.
