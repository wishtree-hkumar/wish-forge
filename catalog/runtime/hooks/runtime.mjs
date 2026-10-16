// wishforge hook runtime. Uses only node: built-ins, because it runs in
// projects that have not installed wishforge.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * An event in the same shape whichever harness sent it.
 * @typedef {{ kind: 'shell', command: string }
 *   | { kind: 'write', path: string, content: string }
 *   | { kind: 'prompt', text: string }
 *   | { kind: 'start', source: string }
 *   | { kind: 'stop' }
 *   | { kind: 'compact' }} GateEvent
 * @typedef {{ dir: string, name: string, status: string, stage: string, approved: boolean }} Run
 * @typedef {{
 *   releaseCommands: RegExp[],
 *   protectedPaths: string[],
 *   secretAllow: RegExp[],
 *   testCommands: RegExp[],
 * }} Config
 * @typedef {{ get(): Record<string, any>, set(value: Record<string, unknown>): void }} StateStore
 * @typedef {{
 *   root: string,
 *   harness: string,
 *   config: Config,
 *   run: Run | null,
 *   runs: Run[],
 *   state: StateStore,
 *   session: string,
 *   now: number,
 *   matchesGlob: typeof matchesGlob,
 * }} GateContext
 * @typedef {{ block?: string, note?: string, context?: string, tell?: string }} GateResult
 * @typedef {{ name: string, check: (event: GateEvent, ctx: GateContext) => GateResult | void }} Gate
 * @typedef {{
 *   events: GateEvent[],
 *   block?: string,
 *   notes: string[],
 *   contexts?: string[],
 *   tells?: string[],
 *   warnings: string[],
 * }} Outcome
 * @typedef {{ code: number, stdout: string, stderr: string }} Response
 */

const DAY = 24 * 60 * 60 * 1000;
const CONFIG_KEYS = ['releaseCommands', 'protectedPaths', 'secretAllow', 'testCommands'];
// Harness folder → the file that wires wishforge's hooks into that harness.
const WIRING_FILES = {
  '.claude': '.claude/settings.json',
  '.codex': '.codex/hooks.json',
  '.cursor': '.cursor/hooks.json',
  '.opencode': '.opencode/plugins/wishforge.js',
};

const text = (/** @type {unknown} */ value) => (typeof value === 'string' ? value : '');
const posix = (/** @type {string} */ path) => path.split('\\').join('/');
// The new text of a list of edits, or undefined when there is no list.
const joined = (/** @type {unknown} */ edits, /** @type {string} */ key) =>
  Array.isArray(edits) ? edits.map((edit) => text(edit?.[key])).join('\n') : undefined;

const CURSOR_WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'StrReplace',
  'MultiEdit',
  'Delete',
  'EditNotebook',
]);
const OPENCODE_WRITE_TOOLS = new Set(['write', 'edit', 'multiedit']);
// A resumed or forked session already holds what its first start was given.
const START_SOURCES = new Set(['startup', 'clear', 'compact']);
const HOOK_DIR = /\.(claude|codex|cursor|opencode)\/wishforge\b/i;
const SHELL_CHANGE =
  /(^|[\s;&|(])(rm|mv|cp|sed|tee|chmod|chown|truncate|ln|dd|install|rmdir|unlink|touch|rsync)\b|>/;

// Resolves symlinks in the part of a path that exists, so a file reached
// through a link is recognised as the file it is.
/** @param {string} path */
function real(path) {
  /** @type {string[]} */
  const rest = [];
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...rest);
  } catch {
    return path;
  }
}

/**
 * @param {string} root
 * @param {string} path
 * @param {string} [cwd]
 */
export function toRelative(root, path, cwd) {
  const absolute = real(isAbsolute(path) ? path : resolve(cwd || root, path));
  const rel = relative(real(root), absolute);
  const outside = rel === '' || rel.startsWith('..') || isAbsolute(rel);
  return posix(outside ? absolute : rel);
}

/** @param {unknown} patch */
export function parsePatch(patch) {
  /** @type {{ path: string, lines: string[] }[]} */
  const files = [];
  for (const line of text(patch).split(/\r?\n/)) {
    const header =
      /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line);
    if (header) files.push({ path: header[1].trim(), lines: [] });
    else if (files.length > 0 && line.startsWith('+')) files.at(-1)?.lines.push(line.slice(1));
  }
  return files.map(({ path, lines }) => ({ path, content: lines.join('\n') }));
}

// Supports *, ** and ?. A glob with no slash is matched against the file name.
/**
 * @param {string} path
 * @param {string} glob
 */
export function matchesGlob(path, glob) {
  const subject = glob.includes('/') ? path : /** @type {string} */ (path.split('/').pop());
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(subject);
}

/**
 * @param {string} root
 * @returns {{ config: Config, warnings: string[] }}
 */
export function loadConfig(root) {
  const config = /** @type {Config & Record<string, any[]>} */ (
    Object.fromEntries(CONFIG_KEYS.map((key) => [key, /** @type {any[]} */ ([])]))
  );
  /** @type {string[]} */
  const warnings = [];
  const warn = (/** @type {string} */ problem) =>
    warnings.push(`wishforge: .wishforge/config.json ${problem}`);
  const path = join(root, '.wishforge', 'config.json');
  if (!existsSync(path)) return { config, warnings };

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    warn(`is not valid JSON and was ignored (${/** @type {Error} */ (error).message}).`);
    return { config, warnings };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warn('must contain a JSON object; it was ignored.');
    return { config, warnings };
  }

  for (const key of CONFIG_KEYS) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key])) {
      warn(`has a "${key}" value that is not a list; it was ignored.`);
      continue;
    }
    raw[key].forEach((/** @type {unknown} */ entry, /** @type {number} */ index) => {
      if (typeof entry !== 'string' || entry === '') {
        warn(`has a "${key}[${index}]" entry that is not a string; it was ignored.`);
      } else if (key === 'protectedPaths') {
        config[key].push(entry);
      } else {
        try {
          config[key].push(new RegExp(entry, 'i'));
        } catch {
          warn(
            `has a "${key}[${index}]" entry that is not a valid regular expression; it was ignored.`
          );
        }
      }
    });
  }
  return { config, warnings };
}

// Reads "name: value" from state.md. Models format this file loosely, so list
// markers, numbering, headings, quotes, backticks, bold and table cells are tolerated.
/**
 * @param {string} body
 * @param {string} name
 */
function field(body, name) {
  // Spaces and tabs only, never \s: a newline here would let an empty value swallow the next line.
  const pattern = new RegExp(
    `^[ \\t\\-*>#|\`]*(?:\\d+[.)][ \\t]*)?[\`*"']*${name}[\`*"']*[ \\t]*[:|][ \\t\`*"'|]*(.*?)[ \\t\`*"'|]*$`,
    'im'
  );
  const match = pattern.exec(body);
  return match ? match[1].trim() : '';
}

/** @param {string} dir */
function isApproved(dir) {
  try {
    return /^decision:\s*approved\s*$/im.test(readFileSync(join(dir, '09-approval.md'), 'utf8'));
  } catch {
    return false; // no approval record
  }
}

// Every active run, most recently updated first.
/**
 * @param {string} root
 * @returns {Run[]}
 */
export function findRuns(root, now = Date.now()) {
  const runs = join(root, '.wishforge', 'runs');
  if (!existsSync(runs)) return [];

  const active = [];
  for (const name of readdirSync(runs)) {
    const dir = join(runs, name);
    let body;
    let modified;
    try {
      const state = join(dir, 'state.md');
      body = readFileSync(state, 'utf8');
      modified = statSync(state).mtimeMs;
    } catch {
      continue;
    }
    const status = field(body, 'status').toLowerCase();
    const waiting = status.startsWith('waiting for user');
    if (!waiting && !status.startsWith('running')) continue;
    // A run left running for a day is treated as abandoned. A run waiting for
    // its person is not: approvals can take longer than a day.
    if (!waiting && now - modified > DAY) continue;
    active.push({ dir, name, status, stage: field(body, 'current stage'), modified });
  }
  return active
    .sort((a, b) => b.modified - a.modified)
    .map(({ dir, name, status, stage }) => ({
      dir,
      name,
      status,
      stage,
      approved: isApproved(dir),
    }));
}

/** @param {string} root */
export function findRun(root, now = Date.now()) {
  return findRuns(root, now)[0] ?? null;
}

// Small per-project state for gates, kept in the project's own folder that
// ignores itself, not under a predictable name in the shared temp directory.
/**
 * @param {string} root
 * @returns {StateStore}
 */
function stateStore(root) {
  const dir = join(root, '.wishforge', 'local');
  const file = join(dir, 'gate-state.json');
  return {
    get() {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return {};
      }
    },
    set(value) {
      try {
        mkdirSync(dir, { recursive: true });
        const ignore = join(dir, '.gitignore');
        const kept = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
        // The folder ignores itself; a .gitignore there that lost its "*" gets it back.
        if (!kept.split(/\r?\n/).some((line) => line.trim() === '*')) {
          writeFileSync(ignore, `*\n${kept}`);
        }
        writeFileSync(file, JSON.stringify(value));
      } catch {
        // state is best effort
      }
    },
  };
}

/**
 * @param {GateEvent} event
 * @param {string} root
 */
export function selfProtect(event, root) {
  const refuse = (/** @type {string} */ what) =>
    `wishforge: ${what} is protected while quality gates are installed. A person must make this change.`;

  if (event.kind === 'write') {
    // Compared in lower case: on macOS and Windows .Claude and .claude are one folder.
    const path = event.path.toLowerCase();
    if (path === '.wishforge/config.json' || path === '.wishforge/lock.json') {
      return refuse(event.path);
    }
    for (const [dir, wiring] of Object.entries(WIRING_FILES)) {
      if (path.startsWith(`${dir}/wishforge/`)) return refuse(event.path);
      if (path === wiring && existsSync(join(root, dir, 'wishforge'))) return refuse(event.path);
    }
  }
  if (event.kind === 'shell') {
    // Reading or staging the hook files is fine; changing them is not.
    if (HOOK_DIR.test(event.command) && SHELL_CHANGE.test(event.command)) {
      return refuse('the wishforge hook runner');
    }
    if (/\bwishforge(\.js)?\s+remove\b/.test(event.command)) return refuse('"wishforge remove"');
  }
  return undefined;
}

/**
 * @param {string} harness
 * @param {any} payload what the harness sent, as it sent it
 * @param {string} root
 * @returns {GateEvent[]}
 */
export function normalize(harness, payload, root) {
  const data = payload ?? {};
  const input = data.tool_input ?? {};
  const event = data.hook_event_name;
  /** @type {(command: unknown) => GateEvent[]} */
  const shell = (command) => (typeof command === 'string' ? [{ kind: 'shell', command }] : []);
  /** @type {(path: string, content: unknown) => GateEvent} */
  const write = (path, content) => ({
    kind: 'write',
    path: toRelative(root, path, data.cwd),
    content: text(content),
  });
  const patch = (/** @type {unknown} */ body) =>
    parsePatch(body).map((file) => write(file.path, file.content));

  if (harness === 'claude' || harness === 'codex') {
    if (event === 'SessionStart') {
      const source = text(data.source) || 'startup';
      return START_SOURCES.has(source) ? [{ kind: 'start', source }] : [];
    }
    if (event === 'UserPromptSubmit') return [{ kind: 'prompt', text: text(data.prompt) }];
    if (event === 'Stop') return data.stop_hook_active ? [] : [{ kind: 'stop' }];
    if (event !== 'PreToolUse') return [];
    if (data.tool_name === 'Bash') return shell(input.command);
    if (typeof input.file_path === 'string') {
      return [
        write(
          input.file_path,
          input.content ?? input.new_string ?? joined(input.edits, 'new_string')
        ),
      ];
    }
    if (typeof input.notebook_path === 'string')
      return [write(input.notebook_path, input.new_source)];
    if (harness === 'codex') return patch(input.command);
    return [];
  }

  if (harness === 'cursor') {
    if (event === 'sessionStart') return [{ kind: 'start', source: 'startup' }];
    if (event === 'preCompact') return [{ kind: 'compact' }];
    if (event === 'beforeSubmitPrompt') return [{ kind: 'prompt', text: text(data.prompt) }];
    if (event === 'stop') return data.loop_count ? [] : [{ kind: 'stop' }];
    if (event !== 'preToolUse') return [];
    if (data.tool_name === 'Shell') return shell(input.command);
    if (typeof input.file_path === 'string') {
      // Read tools also carry file_path. A call is a write only when it brings
      // new text, or is a tool known to change files.
      const body = input.content ?? input.new_string ?? joined(input.edits, 'new_string');
      if (body !== undefined || CURSOR_WRITE_TOOLS.has(data.tool_name)) {
        return [write(input.file_path, body)];
      }
    }
    return [];
  }

  if (harness === 'opencode') {
    if (data.hook === 'compact') return [{ kind: 'compact' }];
    if (data.hook === 'prompt') return [{ kind: 'prompt', text: text(data.text) }];
    if (data.hook !== 'tool') return [];
    const args = data.args ?? {};
    if (data.tool === 'bash') return shell(args.command);
    // Any tool that carries a patch writes files, whatever it is called.
    const patchText = args.patchText ?? args.patch;
    if (typeof patchText === 'string') return patch(patchText);
    if (OPENCODE_WRITE_TOOLS.has(data.tool) && typeof args.filePath === 'string') {
      return [
        write(args.filePath, args.content ?? args.newString ?? joined(args.edits, 'newString')),
      ];
    }
    return [];
  }

  return [];
}

/**
 * @param {{ harness: string, payload: any, root: string, gates: Gate[], now?: number }} options
 * @returns {Outcome}
 */
export function evaluate({ harness, payload, root, gates, now = Date.now() }) {
  const events = normalize(harness, payload, root);
  const { config, warnings } = loadConfig(root);
  /** @type {{ notes: string[], contexts: string[], tells: string[] }} */
  const said = { notes: [], contexts: [], tells: [] };
  const runs = findRuns(root, now);
  const ctx = {
    root,
    harness,
    config,
    run: runs[0] ?? null,
    runs,
    state: stateStore(root),
    // Claude Code and Codex send session_id, Cursor conversation_id, the OpenCode plugin session.
    session: text(payload?.session_id) || text(payload?.conversation_id) || text(payload?.session),
    now,
    matchesGlob,
  };

  for (const event of events) {
    const guard = selfProtect(event, root);
    if (guard) return { events, block: guard, ...said, warnings };
    for (const gate of gates) {
      let result;
      try {
        result = gate.check(event, ctx);
      } catch (error) {
        const { message } = /** @type {Error} */ (error);
        warnings.push(`wishforge: gate ${gate.name} failed (${message}) and was skipped.`);
        continue;
      }
      if (result?.block) return { events, block: result.block, ...said, warnings };
      if (result?.note) said.notes.push(result.note);
      // context is background for the model; tell is a message for the person.
      if (result?.context) said.contexts.push(result.context);
      if (result?.tell) said.tells.push(result.tell);
    }
  }
  return { events, ...said, warnings };
}

/**
 * @param {string} harness
 * @param {any} payload
 * @param {Outcome} outcome
 * @returns {Response}
 */
export function respond(
  harness,
  payload,
  { events, block, notes, contexts = [], tells = [], warnings }
) {
  const allow = { code: 0, stdout: '', stderr: '' };
  const has = (/** @type {GateEvent['kind']} */ kind) =>
    events.some((event) => event.kind === kind);
  const isStop = has('stop');
  // Warnings ride along with a prompt only: on tool calls they would repeat
  // constantly, and on stop they would keep the turn from ending.
  const message = [...notes, ...(has('prompt') ? warnings : [])].join('\n');
  // Context is delivered only as a session starts; anywhere else it is dropped.
  const added = [...(has('start') ? contexts : []), message].filter(Boolean).join('\n\n');

  if (harness === 'cursor') {
    if (block) {
      const deny = { permission: 'deny', user_message: block, agent_message: block };
      return { code: 2, stdout: JSON.stringify(deny), stderr: block };
    }
    if (has('start') && added) {
      return { ...allow, stdout: JSON.stringify({ additional_context: added }) };
    }
    // Cursor's compaction hook can show the person a message and nothing more.
    if (has('compact') && tells.length > 0) {
      return { ...allow, stdout: JSON.stringify({ user_message: tells.join('\n') }) };
    }
    if (isStop && message)
      return { ...allow, stdout: JSON.stringify({ followup_message: message }) };
    return allow;
  }

  if (block) return { code: 2, stdout: '', stderr: block };
  if (isStop) {
    return message
      ? { ...allow, stdout: JSON.stringify({ decision: 'block', reason: message }) }
      : allow;
  }
  if (!added) return allow;
  const context = { hookEventName: payload?.hook_event_name, additionalContext: added };
  return { ...allow, stdout: JSON.stringify({ hookSpecificOutput: context }) };
}

/**
 * @param {string} dir
 * @returns {Promise<Gate[]>}
 */
export async function loadGates(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.mjs'))
    .sort();
  const loaded = await Promise.all(
    files.map(async (file) => {
      try {
        const module = await import(pathToFileURL(join(dir, file)).href);
        return typeof module.check === 'function'
          ? { name: file.slice(0, -4), check: module.check }
          : null;
      } catch {
        return null; // a gate that cannot load is skipped
      }
    })
  );
  return loaded.filter((gate) => gate !== null);
}

/**
 * @param {string} harness
 * @param {any} payload
 * @param {{ root: string, gatesDir: string }} dirs
 */
export async function handle(harness, payload, { root, gatesDir }) {
  const gates = await loadGates(gatesDir);
  return respond(harness, payload, evaluate({ harness, payload, root, gates }));
}
