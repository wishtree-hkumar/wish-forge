// A test command is recognized where a command starts: after environment
// settings, after wrappers such as sudo or timeout, and after a runner such as
// npx or "python -m". A test tool named anywhere else, as in
// "cat jest.config.js" or "npm install jest", is not a run.
const TEST_START = [
  // npm, pnpm, yarn and bun, with options or a workspace before the script name.
  /^(?:npm|pnpm|yarn|bun)(?:\s+(?:workspace|--filter|--prefix|-C|--dir)\s+\S+|\s+-\S+)*\s+(?:run\s+)?(?:test|t)\b/,
  /^(?:vitest|jest|pytest|phpunit|rspec|mocha|ava|tox)(?:\s|$)/,
  /^(?:playwright|cypress)\s+(?:test|run)\b/,
  /^(?:go|cargo|dotnet|swift|deno|bun|rails|mix)\s+test\b/,
  /^(?:artisan|rake)\s+test\b/,
  /^(?:turbo|nx)\s+(?:run\s+)?test\b/,
  /^(?:mvn|mvnw|gradle|gradlew)\b.*\btest\b/,
  /^make\s+test\b/,
];
// One wrapper or runner at the start of a command; stripped one at a time.
const PREFIX = new RegExp(
  '^(?:' +
    [
      '[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+',
      '(?:env|sudo|time|nice|nohup|exec)\\s+(?:-\\S+\\s+(?:\\d+\\s+)?)*',
      'timeout\\s+(?:-\\S+\\s+)*\\S+\\s+',
      'cross-env\\s+',
      '(?:npx|bunx|pnpx)\\s+(?:(?:-y|--yes|--no-install)\\s+|(?:-p|--package)[=\\s]\\S+\\s+)*',
      '(?:pnpm|yarn)\\s+(?:exec\\s+|dlx\\s+)?',
      'npm\\s+exec\\s+(?:--\\s+)?',
      'bundle\\s+exec\\s+',
      '(?:uv|poetry|pipenv|hatch|pdm)\\s+run\\s+',
      'uvx\\s+',
      '(?:python[\\d.]*|py)\\s+-m\\s+',
      'docker(?:\\s+compose|-compose)?\\s+(?:run|exec)\\s+(?:-\\S+\\s+)*\\S+\\s+',
      'php\\s+',
      '(?:\\.\\/)?\\.?venv\\/bin\\/',
      '\\.?\\/?node_modules\\/\\.bin\\/',
      '(?:\\.\\/)?vendor\\/bin\\/',
      '\\.\\/',
    ].join('|') +
    ')'
);
// The body of `sh -c "..."` or `bash -lc '...'` is a command of its own.
const SHELL_BODY = /\b(?:ba|z)?sh\s+-l?c\s+(["'])(.*?)\1/g;
const NUDGE =
  'wishforge test-reminder: files were changed and no test command has run since. ' +
  "Run the project's tests now, or tell the user why you did not.";

// The events the runtime sends, and the parts of its context this gate reads.
// A gate imports nothing, so they are described here.
/**
 * @typedef {{ kind: 'shell', command: string }
 *   | { kind: 'write', path: string, content: string }
 *   | { kind: 'prompt', text: string }
 *   | { kind: 'start', source: string }
 *   | { kind: 'stop' }
 *   | { kind: 'compact' }} Event
 * @typedef {{
 *   session: string,
 *   config: { testCommands: RegExp[] },
 *   state: { get(): Record<string, any>, set(value: Record<string, unknown>): void },
 * }} Context
 */

const isSource = (/** @type {string} */ path) =>
  !path.startsWith('.wishforge/') && !path.endsWith('.md');

/** @param {string} part */
function startsWithTest(part) {
  let rest = part.trim();
  for (let step = 0; step < 8; step += 1) {
    if (TEST_START.some((pattern) => pattern.test(rest))) return true;
    const next = rest.replace(PREFIX, '');
    if (next === rest) return false;
    rest = next;
  }
  return false;
}

/**
 * @param {string} command
 * @param {RegExp[]} extra
 */
function ranTests(command, extra) {
  if (extra.some((pattern) => pattern.test(command))) return true;
  const bodies = [...command.matchAll(SHELL_BODY)].map((match) => match[2]);
  // Quoted text is an argument, not a command: "fix | pytest flake" runs nothing.
  return [command, ...bodies]
    .map((text) => text.replace(/"[^"]*"|'[^']*'/g, '""'))
    .flatMap((text) => text.split(/&&|\|\||[;|\n]/))
    .some(startsWithTest);
}

/**
 * @param {Event} event
 * @param {Context} ctx
 */
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
