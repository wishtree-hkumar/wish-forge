import { ConfigError } from './errors.js';

export const RUNTIME_ID = 'runtime:hooks';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function parseConfig(text, path) {
  const refuse = (problem) =>
    new ConfigError(
      `${path} ${problem}. wishforge will not modify it: fix the file and re-run. ` +
        'If the file holds nothing you need, deleting it also works.'
    );
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw refuse(`is not valid JSON (${error.message})`);
  }
  if (!isObject(config)) throw refuse('must contain a JSON object');
  if (config.hooks !== undefined) {
    if (!isObject(config.hooks)) throw refuse('has a "hooks" value that is not an object');
    for (const [event, list] of Object.entries(config.hooks)) {
      if (!Array.isArray(list)) throw refuse(`has a "hooks.${event}" value that is not a list`);
    }
  }
  return config;
}

// A hook handler is wishforge's when its command runs this target's runner
// (wiring.runner, such as ".claude/wishforge/run.mjs"). Everything else is the user's.
const isOurs = (handler, wiring) =>
  isObject(handler) &&
  typeof handler.command === 'string' &&
  handler.command.includes(wiring.runner);

// Removes our handler from one event's list. A group that held only our handler
// goes; a group the user added handlers to keeps theirs.
function withoutOurs(list, wiring) {
  const kept = [];
  for (const element of list) {
    if (isOurs(element, wiring)) continue;
    if (isObject(element) && Array.isArray(element.hooks)) {
      const handlers = element.hooks.filter((handler) => !isOurs(handler, wiring));
      if (handlers.length === element.hooks.length) kept.push(element);
      else if (handlers.length > 0) kept.push({ ...element, hooks: handlers });
    } else {
      kept.push(element);
    }
  }
  return kept;
}

// Only the events wishforge wires are touched.
export function mergeWiring(config, wiring) {
  const base = clone(config ?? wiring.skeleton);
  const hooks = { ...base.hooks };
  for (const [event, entry] of Object.entries(wiring.entries)) {
    hooks[event] = [...withoutOurs(hooks[event] ?? [], wiring), clone(entry)];
  }
  return { ...base, hooks };
}

export function stripWiring(config, wiring) {
  const base = clone(config);
  if (base.hooks === undefined) return base;
  let removed = false;
  for (const event of Object.keys(wiring.entries)) {
    const list = base.hooks[event];
    if (list === undefined) continue;
    const rest = withoutOurs(list, wiring);
    if (same(rest, list)) continue;
    removed = true;
    if (rest.length > 0) base.hooks[event] = rest;
    else delete base.hooks[event];
  }
  // A hooks object wishforge emptied goes, even where the skeleton has one: the
  // user's file may never have had it.
  if (removed && Object.keys(base.hooks).length === 0) delete base.hooks;
  return base;
}

// True when nothing but the skeleton is left, an empty hooks object aside.
export function isBare(config, skeleton) {
  const trim = ({ hooks, ...rest }) =>
    hooks === undefined || (isObject(hooks) && Object.keys(hooks).length === 0)
      ? rest
      : { ...rest, hooks };
  return same(trim(config), trim(skeleton));
}

export function isWired(config, wiring) {
  return Object.entries(wiring.entries).every(([event, entry]) =>
    (config.hooks?.[event] ?? []).some((element) => same(element, entry))
  );
}

export function serialize(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}
