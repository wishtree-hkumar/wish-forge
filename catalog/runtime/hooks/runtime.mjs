// forgeflow hook runtime. Uses only node: built-ins, because it runs in
// projects that have not installed forgeflow.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY = 24 * 60 * 60 * 1000;
const CONFIG_KEYS = ['releaseCommands', 'protectedPaths', 'secretAllow', 'testCommands'];
// Harness folder → the file that wires forgeflow's hooks into that harness.
const WIRING_FILES = {
  '.claude': '.claude/settings.json',
  '.codex': '.codex/hooks.json',
  '.cursor': '.cursor/hooks.json',
  '.opencode': '.opencode/plugins/forgeflow.js',
};

const text = (value) => (typeof value === 'string' ? value : '');
const posix = (path) => path.split('\\').join('/');

export function toRelative(root, path, cwd) {
  const absolute = isAbsolute(path) ? path : resolve(cwd || root, path);
  const rel = relative(root, absolute);
  const outside = rel === '' || rel.startsWith('..') || isAbsolute(rel);
  return posix(outside ? absolute : rel);
}

export function parsePatch(patch) {
  const files = [];
  for (const line of text(patch).split(/\r?\n/)) {
    const header =
      /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line);
    if (header) files.push({ path: header[1].trim(), lines: [] });
    else if (files.length > 0 && line.startsWith('+')) files.at(-1).lines.push(line.slice(1));
  }
  return files.map(({ path, lines }) => ({ path, content: lines.join('\n') }));
}

// Supports *, ** and ?. A glob with no slash is matched against the file name.
export function matchesGlob(path, glob) {
  const subject = glob.includes('/') ? path : path.split('/').pop();
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

export function loadConfig(root) {
  const config = Object.fromEntries(CONFIG_KEYS.map((key) => [key, []]));
  const warnings = [];
  const warn = (problem) => warnings.push(`forgeflow: .forgeflow/config.json ${problem}`);
  const path = join(root, '.forgeflow', 'config.json');
  if (!existsSync(path)) return { config, warnings };

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    warn(`is not valid JSON and was ignored (${error.message}).`);
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
    raw[key].forEach((entry, index) => {
      if (typeof entry !== 'string' || entry === '') {
        warn(`has a "${key}[${index}]" entry that is not a string; it was ignored.`);
      } else if (key === 'protectedPaths') {
        config[key].push(entry);
      } else {
        try {
          config[key].push(new RegExp(entry, 'i'));
        } catch {
          warn(`has a "${key}[${index}]" entry that is not a valid regular expression; it was ignored.`);
        }
      }
    });
  }
  return { config, warnings };
}

// Reads "name: value" from state.md, tolerating bullets, backticks and bold.
function field(body, name) {
  // Spaces and tabs only, never \s: a newline here would let an empty value swallow the next line.
  const pattern = new RegExp(`^[ \\t\\-*\`]*${name}[\`*]*[ \\t]*:[ \\t\`*]*(.*?)[ \\t\`*]*$`, 'im');
  const match = pattern.exec(body);
  return match ? match[1].trim() : '';
}

export function findRun(root, now = Date.now()) {
  const runs = join(root, '.forgeflow', 'runs');
  if (!existsSync(runs)) return null;

  let best = null;
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
    const active = status.startsWith('running') || status.startsWith('waiting for user');
    if (!active || now - modified > DAY) continue;
    if (best && best.modified >= modified) continue;
    best = { dir, name, status, stage: field(body, 'current stage'), modified };
  }
  if (!best) return null;

  let approved = false;
  try {
    approved = /^decision:\s*approved\s*$/im.test(readFileSync(join(best.dir, '09-approval.md'), 'utf8'));
  } catch {
    // no approval record
  }
  return { dir: best.dir, name: best.name, status: best.status, stage: best.stage, approved };
}

function stateStore(root) {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const file = join(tmpdir(), `forgeflow-${key}.json`);
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
        writeFileSync(file, JSON.stringify(value));
      } catch {
        // state is best effort
      }
    },
  };
}

export function selfProtect(event, root) {
  const refuse = (what) =>
    `forgeflow: ${what} is protected while quality gates are installed. A person must make this change.`;

  if (event.kind === 'write') {
    const path = event.path;
    if (path === '.forgeflow/config.json' || path === '.forgeflow/lock.json') return refuse(path);
    for (const [dir, wiring] of Object.entries(WIRING_FILES)) {
      if (path.startsWith(`${dir}/forgeflow/`)) return refuse(path);
      if (path === wiring && existsSync(join(root, dir, 'forgeflow'))) return refuse(path);
    }
  }
  if (event.kind === 'shell') {
    if (/forgeflow\/(run\.mjs|runtime\.mjs|gates)\b/.test(event.command)) {
      return refuse('the forgeflow hook runner');
    }
    if (/\bforgeflow\b[^|;&\n]*\bremove\b/.test(event.command)) return refuse('"forgeflow remove"');
  }
  return undefined;
}

export function normalize(harness, payload, root) {
  const data = payload ?? {};
  const input = data.tool_input ?? {};
  const event = data.hook_event_name;
  const shell = (command) => (typeof command === 'string' ? [{ kind: 'shell', command }] : []);
  const write = (path, content) => ({
    kind: 'write',
    path: toRelative(root, path, data.cwd),
    content: text(content),
  });
  const patch = (body) => parsePatch(body).map((file) => write(file.path, file.content));

  if (harness === 'claude' || harness === 'codex') {
    if (event === 'UserPromptSubmit') return [{ kind: 'prompt', text: text(data.prompt) }];
    if (event === 'Stop') return data.stop_hook_active ? [] : [{ kind: 'stop' }];
    if (event !== 'PreToolUse') return [];
    if (data.tool_name === 'Bash') return shell(input.command);
    if (typeof input.file_path === 'string') {
      if (Array.isArray(input.edits)) {
        return [write(input.file_path, input.edits.map((edit) => text(edit?.new_string)).join('\n'))];
      }
      return [write(input.file_path, input.content ?? input.new_string)];
    }
    if (typeof input.notebook_path === 'string') return [write(input.notebook_path, input.new_source)];
    if (harness === 'codex') return patch(input.command);
    return [];
  }

  if (harness === 'cursor') {
    if (event === 'beforeSubmitPrompt') return [{ kind: 'prompt', text: text(data.prompt) }];
    if (event === 'stop') return data.loop_count ? [] : [{ kind: 'stop' }];
    if (event !== 'preToolUse') return [];
    if (data.tool_name === 'Shell') return shell(input.command);
    if (typeof input.file_path === 'string') {
      return [write(input.file_path, input.content ?? input.new_string)];
    }
    return [];
  }

  if (harness === 'opencode') {
    if (data.hook === 'prompt') return [{ kind: 'prompt', text: text(data.text) }];
    if (data.hook !== 'tool') return [];
    const args = data.args ?? {};
    if (data.tool === 'bash') return shell(args.command);
    if (data.tool === 'patch') return patch(args.patchText ?? args.patch);
    if ((data.tool === 'write' || data.tool === 'edit') && typeof args.filePath === 'string') {
      return [write(args.filePath, args.content ?? args.newString)];
    }
    return [];
  }

  return [];
}

export function evaluate({ harness, payload, root, gates, now = Date.now() }) {
  const events = normalize(harness, payload, root);
  const { config, warnings } = loadConfig(root);
  const notes = [];
  const ctx = {
    root,
    harness,
    config,
    run: findRun(root, now),
    state: stateStore(root),
    now,
    matchesGlob,
  };

  for (const event of events) {
    const guard = selfProtect(event, root);
    if (guard) return { events, block: guard, notes, warnings };
    for (const gate of gates) {
      let result;
      try {
        result = gate.check(event, ctx);
      } catch (error) {
        warnings.push(`forgeflow: gate ${gate.name} failed (${error.message}) and was skipped.`);
        continue;
      }
      if (result?.block) return { events, block: result.block, notes, warnings };
      if (result?.note) notes.push(result.note);
    }
  }
  return { events, notes, warnings };
}

export function respond(harness, payload, { events, block, notes, warnings }) {
  const allow = { code: 0, stdout: '', stderr: '' };
  const isStop = events.some((event) => event.kind === 'stop');
  // Warnings ride along with a prompt only: on tool calls they would repeat
  // constantly, and on stop they would keep the turn from ending.
  const isPrompt = events.some((event) => event.kind === 'prompt');
  const message = [...notes, ...(isPrompt ? warnings : [])].join('\n');

  if (harness === 'cursor') {
    if (block) {
      const deny = { permission: 'deny', user_message: block, agent_message: block };
      return { code: 2, stdout: JSON.stringify(deny), stderr: block };
    }
    if (isStop && message) return { ...allow, stdout: JSON.stringify({ followup_message: message }) };
    return allow;
  }

  if (block) return { code: 2, stdout: '', stderr: block };
  if (!message) return allow;
  if (isStop) return { ...allow, stdout: JSON.stringify({ decision: 'block', reason: message }) };
  const context = { hookEventName: payload?.hook_event_name, additionalContext: message };
  return { ...allow, stdout: JSON.stringify({ hookSpecificOutput: context }) };
}

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
  return loaded.filter(Boolean);
}

export async function handle(harness, payload, { root, gatesDir }) {
  const gates = await loadGates(gatesDir);
  return respond(harness, payload, evaluate({ harness, payload, root, gates }));
}
