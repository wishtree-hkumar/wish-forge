// A test command is recognized where a command starts: after any environment
// settings, and after a runner such as npx or "python -m". A test tool named
// anywhere else, as in "cat jest.config.js" or "npm install jest", is not a run.
const TEST_START = [
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/,
  /^(vitest|jest|pytest|phpunit|rspec|mocha|ava)(\s|$)/,
  /^(go|cargo|dotnet|swift)\s+test\b/,
  /^(mvn|mvnw|gradle|gradlew)\b.*\btest\b/,
  /^make\s+test\b/,
];
const RUNNER =
  /^(?:(?:npx|bunx|pnpx)\s+|(?:pnpm|yarn)\s+(?:exec\s+|dlx\s+)?|bundle\s+exec\s+|(?:uv|poetry|pipenv|hatch)\s+run\s+|python3?\s+-m\s+|\.?\/?node_modules\/\.bin\/|(?:\.\/)?vendor\/bin\/|\.\/)/;
const SETTINGS = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
const NUDGE =
  'forgeflow test-reminder: files were changed and no test command has run since. ' +
  "Run the project's tests now, or tell the user why you did not.";

const isSource = (path) => !path.startsWith('.forgeflow/') && !path.endsWith('.md');

function ranTests(command, extra) {
  if (extra.some((pattern) => pattern.test(command))) return true;
  return command.split(/&&|\|\||[;|\n]/).some((part) => {
    let rest = part.trim().replace(SETTINGS, '');
    // Each runner is stripped in turn, and the command checked before and after.
    for (let step = 0; step < 4; step += 1) {
      if (TEST_START.some((pattern) => pattern.test(rest))) return true;
      const next = rest.replace(RUNNER, '');
      if (next === rest) return false;
      rest = next;
    }
    return false;
  });
}

export function check(event, ctx) {
  let state = ctx.state.get();
  // A new session starts with nothing to remind about.
  if (ctx.session && state.session !== ctx.session) state = { session: ctx.session };

  if (event.kind === 'write') {
    if (isSource(event.path) && !state.dirty) ctx.state.set({ ...state, dirty: true });
    return undefined;
  }

  if (event.kind === 'shell') {
    if (ranTests(event.command, ctx.config.testCommands) && (state.dirty || state.reminded)) {
      ctx.state.set({ ...state, dirty: false, reminded: false });
    }
    return undefined;
  }

  if (event.kind === 'stop' && state.dirty && !state.reminded) {
    ctx.state.set({ ...state, dirty: true, reminded: true });
    return { note: NUDGE };
  }
  return undefined;
}
