import { ConfigError } from './errors.js';

// Row id for the block or entry in install reports.
export const RULES_ID = 'rules';
export const START = '<!-- forgeflow:rules:start -->';
export const END = '<!-- forgeflow:rules:end -->';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const count = (text, needle) => text.split(needle).length - 1;

// Returns the block's { start, end } offsets, or null when the text has none.
function locate(text, path) {
  const starts = count(text, START);
  const ends = count(text, END);
  if (starts === 0 && ends === 0) return null;
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new ConfigError(
      `${path} has damaged forgeflow markers (expected one "${START}" followed by one "${END}"). ` +
        'forgeflow will not modify it: repair the markers, or delete them and the text between them, and re-run.'
    );
  }
  return { start, end: end + END.length };
}

export function hasBlock(text, path) {
  return locate(text, path) !== null;
}

// Only the text between the markers is forgeflow's. Everything else is kept.
export function mergeBlock(text, block, path) {
  if (text === undefined || text === '') return `${block}\n`;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const ours = block.replace(/\n/g, eol);
  const at = locate(text, path);
  if (at) return text.slice(0, at.start) + ours + text.slice(at.end);
  const gap = text.endsWith('\n') ? eol : eol + eol;
  return `${text}${gap}${ours}${eol}`;
}

export function stripBlock(text, path) {
  const at = locate(text, path);
  if (!at) return text;
  // Take back the line break after the block and the blank line added before it.
  const after = text.slice(at.end).replace(/^\r?\n/, '');
  const before = text.slice(0, at.start);
  return (/(\r?\n){2}$/.test(before) ? before.replace(/\r?\n$/, '') : before) + after;
}

export function parseInstructions(text, path, entry) {
  const refuse = (problem) =>
    new ConfigError(
      `${path} ${problem}. forgeflow will not modify it: fix the file, ` +
        `or add ${JSON.stringify(entry)} to its "instructions" list by hand, and re-run.`
    );
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw refuse(`is not valid JSON (${error.message})`);
  }
  if (!isObject(config)) throw refuse('must contain a JSON object');
  const list = config.instructions;
  if (list !== undefined && !(Array.isArray(list) && list.every((e) => typeof e === 'string'))) {
    throw refuse('has an "instructions" value that is not a list of strings');
  }
  return config;
}

// True when a config forgeflow cannot use already holds the entry as a string.
export function handWired(text, entry) {
  return text.includes(JSON.stringify(entry));
}

export function mergeInstructions(config, { entry, skeleton }) {
  const base = clone(config ?? skeleton);
  const list = base.instructions ?? [];
  if (!list.includes(entry)) base.instructions = [...list, entry];
  return base;
}

export function stripInstructions(config, entry) {
  const base = clone(config);
  if (!base.instructions?.includes(entry)) return base;
  const rest = base.instructions.filter((existing) => existing !== entry);
  if (rest.length > 0) base.instructions = rest;
  else delete base.instructions;
  return base;
}
