const TEST_COMMANDS = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/i,
  /\b(vitest|jest|pytest|phpunit|rspec)\b/i,
  /\b(go|cargo|dotnet)\s+test\b/i,
  /\b(mvn|gradle|gradlew)\b.*\btest\b/i,
  /\bmake\s+test\b/i,
];
const NUDGE =
  'forgeflow test-reminder: files were changed and no test command has run since. ' +
  "Run the project's tests now, or tell the user why you did not.";

const isSource = (path) => !path.startsWith('.forgeflow/') && !path.endsWith('.md');

export function check(event, ctx) {
  const state = ctx.state.get();

  if (event.kind === 'write') {
    if (isSource(event.path) && !state.dirty) ctx.state.set({ ...state, dirty: true });
    return undefined;
  }

  if (event.kind === 'shell') {
    const ranTests = [...TEST_COMMANDS, ...ctx.config.testCommands].some((pattern) =>
      pattern.test(event.command)
    );
    if (ranTests && (state.dirty || state.reminded))
      ctx.state.set({ dirty: false, reminded: false });
    return undefined;
  }

  if (event.kind === 'stop' && state.dirty && !state.reminded) {
    ctx.state.set({ dirty: true, reminded: true });
    return { note: NUDGE };
  }
  return undefined;
}
