// forgeflow session-memory: keeps a record of what a session changed and was
// asked, and gives a new or compacted session the project's memory. It only
// records and informs; it never blocks.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The patterns secret-guard blocks on. A gate may import nothing from another
// gate, so the list is repeated here; a test keeps the two identical.
export const SECRET_PATTERNS = [
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\b[sr]k_live_[A-Za-z0-9]{16,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
];

const HOUR = 60 * 60 * 1000;
const IDLE = 2 * HOUR;
const STALE = 7 * 24 * HOUR;
const MAX_FILES = 30;
const MAX_PROMPTS = 3;
const PROMPT_CHARS = 300;
const LIMITS = { lessons: 3000, handoff: 1500, activity: 1200 };

const LOCAL = '.forgeflow/local';
const LESSONS = '.forgeflow/memory/lessons.md';
const HANDOFF = `${LOCAL}/handoff.md`;
const RECORD = `${LOCAL}/session.json`;
const READABLE = `${LOCAL}/session.md`;
// An approval is the approval gate's business and says nothing about the work.
const APPROVAL = /^approved?[\s.!]*$/i;
const CURSOR_TELL =
  'forgeflow: this conversation is being compacted. If the agent loses its place, ' +
  `ask it to read ${READABLE} and ${HANDOFF}.`;

const stamp = (iso) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function redact(text) {
  return SECRET_PATTERNS.reduce(
    (out, pattern) => out.replace(new RegExp(pattern.source, 'g'), '[redacted]'),
    text
  );
}

// Redacted first, so a credential at the cut is never stored in part.
const tidy = (text) => redact(text).replace(/\s+/g, ' ').trim().slice(0, PROMPT_CHARS);

const isSession = (value) =>
  typeof value === 'object' &&
  value !== null &&
  typeof value.started === 'string' &&
  typeof value.updated === 'string' &&
  Array.isArray(value.files) &&
  Array.isArray(value.prompts);

function readRecord(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, RECORD), 'utf8'));
    if (isSession(raw?.current)) {
      return { current: raw.current, previous: isSession(raw.previous) ? raw.previous : null };
    }
  } catch {
    // a missing or damaged record is replaced
  }
  return { current: null, previous: null };
}

function branchOf(root) {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
    return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? '';
  } catch {
    return ''; // no repository, or a worktree
  }
}

// The record with a current session that this event belongs to. A new session
// begins when the harness's session id changes, or, when it sends none, after
// two idle hours.
function touch({ current, previous }, ctx) {
  const now = new Date(ctx.now).toISOString();
  const same =
    current !== null &&
    (ctx.session ? current.id === ctx.session : ctx.now - Date.parse(current.updated) <= IDLE);
  if (same) {
    const next = { ...current, harness: ctx.harness, updated: now, branch: branchOf(ctx.root) };
    return { current: next, previous };
  }
  const fresh = {
    id: ctx.session,
    harness: ctx.harness,
    started: now,
    updated: now,
    branch: branchOf(ctx.root),
    files: [],
    prompts: [],
  };
  // A session that did nothing is not worth remembering in place of one that did.
  const worked = current !== null && (current.files.length > 0 || current.prompts.length > 0);
  return { current: fresh, previous: worked ? current : previous };
}

function lines(session) {
  const where = session.branch ? `, on branch ${session.branch}` : '';
  const out = [
    `Started ${stamp(session.started)}, last active ${stamp(session.updated)}, ` +
      `in ${session.harness || 'an unknown harness'}${where}.`,
  ];
  if (session.files.length > 0)
    out.push('', 'Files changed:', ...session.files.map((f) => `- ${f}`));
  if (session.prompts.length > 0) out.push('', 'Prompts:', ...session.prompts.map((p) => `- ${p}`));
  return out.join('\n');
}

function readable({ current, previous }) {
  const parts = ['# Recent activity'];
  if (current) parts.push(`## This session\n${lines(current)}`);
  if (previous) parts.push(`## Previous session\n${lines(previous)}`);
  return `${parts.join('\n\n')}\n`;
}

function save(root, record) {
  try {
    mkdirSync(join(root, LOCAL), { recursive: true });
    // The folder ignores itself, so the project's own .gitignore is never edited.
    const ignore = join(root, LOCAL, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
    // Written whole and renamed: two tool calls at once must not leave half a file.
    const tmp = join(root, `${RECORD}.tmp-${process.pid}`);
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, join(root, RECORD));
    writeFileSync(join(root, READABLE), readable(record));
  } catch {
    // recording is best effort and must never stop the agent
  }
}

function readText(root, path) {
  try {
    const text = readFileSync(join(root, path), 'utf8').trim();
    return text ? { text, modified: statSync(join(root, path)).mtimeMs } : null;
  } catch {
    return null;
  }
}

function clip(text, limit, path) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const end = cut.lastIndexOf('\n');
  return `${end > 0 ? cut.slice(0, end) : cut}\n(cut: read ${path} for the rest)`;
}

const activity = (title, session) =>
  `## Recent activity (${title})\n${clip(lines(session), LIMITS.activity, READABLE)}`;

function memoryBlock(ctx, source) {
  const { root, now } = ctx;
  const parts = [];

  const lessons = readText(root, LESSONS);
  if (lessons) {
    const body = lessons.text.replace(/^# .*\n+/, '');
    if (body) parts.push(`## Project lessons\n${clip(body, LIMITS.lessons, LESSONS)}`);
  }

  const handoff = readText(root, HANDOFF);
  if (handoff && now - handoff.modified <= STALE) {
    const written = stamp(new Date(handoff.modified).toISOString());
    parts.push(
      `## Handoff note (written ${written})\n${clip(handoff.text, LIMITS.handoff, HANDOFF)}`
    );
  }

  const { current, previous } = readRecord(root);
  const compacted = source === 'compact';
  // To a new session the record's current session is the last one, unless
  // this session has already written to it.
  const mine = current !== null && ctx.session !== '' && current.id === ctx.session;
  const shown = compacted || !mine ? current : previous;
  const worked = shown && (shown.files.length > 0 || shown.prompts.length > 0);
  if (worked && now - Date.parse(shown.updated) <= STALE) {
    parts.push(activity(compacted ? 'this session so far' : 'last session', shown));
  }

  if (ctx.run) {
    const { name, stage, status } = ctx.run;
    parts.push(
      `## Flow run in progress\n${name}: stage ${stage || 'unknown'}, status ${status}. ` +
        `Its files are in .forgeflow/runs/${name}.`
    );
  }
  return parts.length > 0 ? `# forgeflow memory\n\n${parts.join('\n\n')}` : '';
}

const outside = (path) =>
  path.startsWith('.forgeflow/') || path.startsWith('/') || /^[A-Za-z]:/.test(path);

export function check(event, ctx) {
  if (event.kind === 'write') {
    if (outside(event.path)) return undefined;
    const record = touch(readRecord(ctx.root), ctx);
    const { files } = record.current;
    if (!files.includes(event.path)) {
      record.current.files = [...files, event.path].slice(-MAX_FILES);
    }
    save(ctx.root, record);
    return undefined;
  }

  if (event.kind === 'prompt') {
    const text = tidy(event.text);
    if (!text || APPROVAL.test(text)) return undefined;
    const record = touch(readRecord(ctx.root), ctx);
    record.current.prompts = [...record.current.prompts, text].slice(-MAX_PROMPTS);
    save(ctx.root, record);
    return undefined;
  }

  if (event.kind === 'start') {
    const block = memoryBlock(ctx, event.source);
    return block ? { context: block } : undefined;
  }

  if (event.kind === 'compact') {
    // Claude Code and Codex get the block again at the session start that
    // follows compaction. These two cannot do that.
    if (ctx.harness === 'cursor') return { tell: CURSOR_TELL };
    if (ctx.harness === 'opencode') {
      const { current } = readRecord(ctx.root);
      return current ? { context: activity('this session so far', current) } : undefined;
    }
  }
  return undefined;
}
