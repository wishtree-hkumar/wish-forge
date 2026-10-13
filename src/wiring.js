import { ConfigError } from './errors.js';

export const RUNTIME_ID = 'runtime:hooks';

// Any hook entry that runs this path is forgeflow's. Everything else is the user's.
const OURS = 'forgeflow/run.mjs';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isOurs = (element) => JSON.stringify(element).includes(OURS);
const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function parseConfig(text, path) {
  const refuse = (problem) =>
    new ConfigError(`${path} ${problem}. forgeflow will not modify it: fix the file and re-run.`);
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

// Drops our elements. A list we emptied is removed; a list the user left empty stays.
function withoutOurs(hooks) {
  const kept = {};
  for (const [event, list] of Object.entries(hooks)) {
    const rest = list.filter((element) => !isOurs(element));
    if (rest.length > 0 || rest.length === list.length) kept[event] = rest;
  }
  return kept;
}

export function mergeWiring(config, wiring) {
  const base = clone(config ?? wiring.skeleton);
  const hooks = withoutOurs(base.hooks ?? {});
  for (const [event, entry] of Object.entries(wiring.entries)) {
    hooks[event] = [...(hooks[event] ?? []), clone(entry)];
  }
  return { ...base, hooks };
}

export function stripWiring(config, skeleton = {}) {
  const base = clone(config);
  if (base.hooks === undefined) return base;
  const hooks = withoutOurs(base.hooks);
  const emptiedByUs = Object.keys(hooks).length === 0 && Object.keys(base.hooks).length > 0;
  if (emptiedByUs && !('hooks' in skeleton)) delete base.hooks;
  else base.hooks = hooks;
  return base;
}

export function isWired(config, wiring) {
  return Object.entries(wiring.entries).every(([event, entry]) =>
    (config.hooks?.[event] ?? []).some((element) => same(element, entry))
  );
}

export function serialize(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}
