---
name: vue
description: Vue standards - single-file components, reactivity, props and events, composables and templates.
paths:
  - "**/*.vue"
---
# Vue standards

These assume Vue 3. In a Vue 2 project, follow the project's existing component style instead.

## Components

- Write single-file components with `<script setup>` and the Composition API, in TypeScript where the project uses it.
- Name components with two or more words in `PascalCase`, and name the file the same.
- Order the blocks script, template, style, the same way in every file.
- Keep a component to one job. When it fetches, decides and renders, split it.
- Scope component styles with `scoped` or CSS modules. Do not leak styles to other components.

## Props and events

- Declare props with `defineProps` and full types. Mark what is required, and give the rest defaults.
- Never mutate a prop. Emit an event and let the parent change the value.
- Declare every event with `defineEmits`, with the type of its payload.
- Use `v-model` with `defineModel` for two-way values instead of a hand-written prop and event pair.
- Pass data down with props and up with events. Use provide and inject only for values many levels need.
- Do not reach into a child through a template ref to change its state. Expose a method deliberately, or use props.

## Reactivity

- Use `ref` for single values and `reactive` for objects you never replace. Pick one habit per project.
- Never destructure a reactive object or props without `toRefs` or a getter. The result is no longer reactive.
- Compute derived values with `computed`. A computed getter has no side effects and does not change state.
- Use a watcher only to cause an effect outside the component's state: a request, storage, the document. Do not use one to keep two pieces of state in step.
- Clean up what a watcher or lifecycle hook starts: timers, listeners, subscriptions.
- Guard asynchronous watchers against a stale response when their source changes again.

## Composables

- Extract shared stateful logic into a composable named `useSomething` that returns refs.
- Call composables only at the top level of `<script setup>` or another composable.
- A composable takes its inputs as arguments, refs or getters. It does not read a component's internals.

## Templates

- Keep templates declarative. Move anything longer than a simple expression into a computed value or a function.
- Give every `v-for` item a `:key` that is stable and unique, from the data. Never the index for a list that can reorder, grow or shrink.
- Never put `v-if` and `v-for` on the same element. Filter in a computed value, or wrap with a `<template>`.
- Do not use `v-html` with content you did not write. If you must, sanitize it first.
- Use the shorthand forms `:` and `@` consistently.

## State and routing

- Keep state local until two distant components need it. Then use the project's store.
- In a store, change state only through its actions, and keep derived values in getters.
- Load route components lazily, and guard routes that need a signed-in user in the router, not in the component.

## Accessibility and tests

- Use the right element: a button for an action, a link for navigation, a label for every input.
- Every interactive element works with the keyboard and shows focus.
- Test a component through what it renders and emits. Do not assert on its internal state.
