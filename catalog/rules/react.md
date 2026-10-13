---
name: react
description: React standards - components, state, effects, performance and accessibility.
paths:
  - "**/*.tsx"
  - "**/*.jsx"
---
# React standards

## Components

- Write function components. One component per file, named in `PascalCase`, with the file named after it.
- Keep a component to one job. When it fetches, decides and renders, split it.
- Give props an explicit type, and destructure them in the parameter list.
- Never define a component inside another component's body. It is recreated on every render and loses its state.
- Components and hooks are pure during render: no mutation of props, state or outside variables, and no side effects.
- Prefer composition through `children` and props to configuration flags that switch a component between modes.
- Do not pass a prop through more than two components that do not use it. Compose differently, or use context.

## State

- Keep state as close as possible to where it is used, and lift it only as far as the nearest common parent.
- Do not store what you can compute. Derive it during render from props and state.
- Never copy a prop into state unless it is explicitly an initial value, and name it that way.
- Never mutate state. Create a new object or array.
- Use the updater form, `setCount(c => c + 1)`, when the next state depends on the previous one.
- Use a reducer when several values change together or the next state depends on an action.
- Use context for values many components read and that change rarely. It is not a general state store.

## Effects

- Use an effect only to synchronize with something outside React: the network, the document, a subscription, a timer.
- Do not use an effect to compute a value from props or state, or to respond to a user event. Do the first during render and the second in the event handler.
- List every reactive value an effect reads in its dependency array. Never silence the lint rule.
- Return a cleanup function for every subscription, timer and listener.
- Guard asynchronous effects against a stale response: ignore or abort a request whose inputs have changed.

## Hooks

- Call hooks only at the top level of a component or a custom hook, never in a condition or a loop.
- Name custom hooks `useSomething`, and extract one when stateful logic is shared.
- Do not reach for a ref to hold a value that should cause a render.

## Lists and rendering

- Give list items a `key` that is stable and unique among siblings, from the data. Never the array index for a list that can reorder, grow or shrink.
- Render conditionally with a ternary or an early return. Beware `&&` with a number: `0` is rendered.
- Do not inject markup from a string. If you must, sanitize it first and say where it came from.

## Performance

- Measure before optimizing. Do not add memoization by default.
- Memoize a value or a callback only when it is expensive to make or its identity is a dependency of something else.
- Load large routes and rarely used components lazily.

## Accessibility and tests

- Use the right element: a button for an action, a link for navigation, a label for every input.
- Every interactive element works with the keyboard and shows focus.
- Test what the user sees and does, by role and text. Do not assert on component internals or implementation details.
