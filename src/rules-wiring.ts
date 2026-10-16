import { ConfigError } from './errors.js';
import type { HarnessConfig, JsonRulesWiring } from './types.js';

// Row id for the block or entry in install reports.
export const RULES_ID = 'rules';
export const START = '<!-- wishforge:rules:start -->';
export const END = '<!-- wishforge:rules:end -->';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A marker counts only when it is a whole line, so text that mentions one is left alone.
const lineOf = (marker: string) => new RegExp(`^\uFEFF?${escaped(marker)}[ \\t]*\\r?$`, 'gm');
// The offset of the marker itself, after a byte-order mark that may open the file.
const offsets = (text: string, marker: string) =>
  [...text.matchAll(lineOf(marker))].map(
    (match) => match.index + (match[0].startsWith('\uFEFF') ? 1 : 0)
  );

// Returns the block's { start, end } offsets, or null when the text has none.
function locate(text: string, path: string): { start: number; end: number } | null {
  const starts = offsets(text, START);
  const ends = offsets(text, END);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new ConfigError(
      `${path} has damaged wishforge markers (expected one "${START}" followed by one "${END}"). ` +
        'wishforge will not modify it: repair the markers, or delete them and the text between them, and re-run.'
    );
  }
  return { start: starts[0], end: ends[0] + END.length };
}

export function hasBlock(text: string, path: string): boolean {
  return locate(text, path) !== null;
}

// Only the text between the markers is wishforge's. Everything else is kept.
export function mergeBlock(text: string | undefined, block: string, path: string): string {
  if (text === undefined || text === '') return `${block}\n`;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const ours = block.replace(/\n/g, eol);
  const at = locate(text, path);
  if (at) return text.slice(0, at.start) + ours + text.slice(at.end);
  const gap = text.endsWith('\n') ? eol : eol + eol;
  return `${text}${gap}${ours}${eol}`;
}

export function stripBlock(text: string, path: string): string {
  const at = locate(text, path);
  if (!at) return text;
  // Take back the line break after the block and the blank line added before it.
  let after = text.slice(at.end).replace(/^\r?\n/, '');
  const before = text.slice(0, at.start);
  // A block at the very top had a blank line after it, not before: take that one.
  if (before.replace(/^\uFEFF/, '') === '') after = after.replace(/^\r?\n/, '');
  return (/(\r?\n){2}$/.test(before) ? before.replace(/\r?\n$/, '') : before) + after;
}

// JSON with comments and trailing commas, reduced to plain JSON. String
// literals are kept whole, so a "//" inside one is not taken for a comment.
function plainJson(text: string): string {
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

const quoted = (entries: string[]) => entries.map((entry) => JSON.stringify(entry)).join(' and ');

export function parseInstructions(text: string, path: string, entries: string[]): HarnessConfig {
  const refuse = (problem: string) =>
    new ConfigError(
      `${path} ${problem}. wishforge will not modify it: fix the file, ` +
        `or add ${quoted(entries)} to its "instructions" list by hand, and re-run.`
    );
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw refuse(`is not valid JSON (${(error as Error).message})`);
  }
  if (!isObject(config)) throw refuse('must contain a JSON object');
  const list = config.instructions;
  if (list !== undefined && !(Array.isArray(list) && list.every((e) => typeof e === 'string'))) {
    throw refuse('has an "instructions" value that is not a list of strings');
  }
  return config as HarnessConfig;
}

// Which of the candidates a config wishforge will not edit (it has comments,
// or is a .jsonc file) really holds in its "instructions" list.
export function foundEntries(text: string, candidates: string[]): string[] {
  try {
    const config = JSON.parse(plainJson(text));
    const list = isObject(config) && Array.isArray(config.instructions) ? config.instructions : [];
    return candidates.filter((candidate) => list.includes(candidate));
  } catch {
    return [];
  }
}

export function handWired(text: string, entries: string[]): boolean {
  return entries.length > 0 && foundEntries(text, entries).length === entries.length;
}

// entries are the ones wanted now; known is every entry wishforge ever adds.
// Wanted entries stay where they are, missing ones go last, and wishforge's own
// entries that are no longer wanted are dropped.
export function mergeInstructions(
  config: HarnessConfig | undefined,
  { entries, known, skeleton }: Pick<JsonRulesWiring, 'entries' | 'known' | 'skeleton'>
): HarnessConfig {
  const base = clone(config ?? skeleton);
  const kept = (base.instructions ?? []).filter(
    (existing) => !known.includes(existing) || entries.includes(existing)
  );
  base.instructions = [...kept, ...entries.filter((entry) => !kept.includes(entry))];
  return base;
}

export function stripInstructions(config: HarnessConfig, known: string[]): HarnessConfig {
  const base = clone(config);
  if (!Array.isArray(base.instructions)) return base;
  const rest = base.instructions.filter((existing) => !known.includes(existing));
  if (rest.length === base.instructions.length) return base;
  if (rest.length > 0) base.instructions = rest;
  else delete base.instructions;
  return base;
}
