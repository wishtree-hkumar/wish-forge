import { ConfigError } from './errors.js';

// Row id for the block or entry in install reports.
export const RULES_ID = 'rules';
export const START = '<!-- forgeflow:rules:start -->';
export const END = '<!-- forgeflow:rules:end -->';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A marker counts only when it is a whole line, so text that mentions one is left alone.
const lineOf = (marker) => new RegExp(`^${escaped(marker)}[ \\t]*\\r?$`, 'gm');
const offsets = (text, marker) => [...text.matchAll(lineOf(marker))].map((match) => match.index);

// Returns the block's { start, end } offsets, or null when the text has none.
function locate(text, path) {
  const starts = offsets(text, START);
  const ends = offsets(text, END);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new ConfigError(
      `${path} has damaged forgeflow markers (expected one "${START}" followed by one "${END}"). ` +
        'forgeflow will not modify it: repair the markers, or delete them and the text between them, and re-run.'
    );
  }
  return { start: starts[0], end: ends[0] + END.length };
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

// JSON with comments and trailing commas, reduced to plain JSON. String
// literals are kept whole, so a "//" inside one is not taken for a comment.
function plainJson(text) {
  const pieces =
    text.match(/"(?:[^"\\]|\\.)*"?|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[^"/]+|\//g) ?? [];
  let out = '';
  let code = '';
  const flush = () => {
    out += code.replace(/,(?=\s*[}\]])/g, '');
    code = '';
  };
  for (const piece of pieces) {
    if (piece.startsWith('//') || piece.startsWith('/*')) continue;
    if (piece.startsWith('"')) {
      flush();
      out += piece;
    } else {
      code += piece;
    }
  }
  flush();
  return out;
}

// True when a config forgeflow will not edit (it has comments, or is a .jsonc
// file) really holds the entry in its "instructions" list.
export function handWired(text, entry) {
  try {
    const config = JSON.parse(plainJson(text));
    return isObject(config) && Array.isArray(config.instructions)
      ? config.instructions.includes(entry)
      : false;
  } catch {
    return false;
  }
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
