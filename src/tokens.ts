import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findRun } from '../catalog/runtime/hooks/runtime.mjs';
import { getAdapter } from './adapters/index';
import { appliesTo } from './adapters/shared';
import { readLock } from './lock';
import type { Context, Item, LockFileEntry } from './types';

export interface TokenRow {
  label: string;
  chars: number;
}

export interface TargetTokens {
  target: string;
  root: string;
  always: TokenRow[];
  onUse: TokenRow[];
}

// The session-memory hook's limits, mirrored because shipped hook code may
// import nothing. A test keeps the two in step.
export const MEMORY_LIMITS = {
  parts: { lessons: 2400, map: 3600, handoff: 1400, activity: 1200 },
  block: 9800,
  staleDays: 7,
};
// The block's fixed text: its title, the notice and a heading per section.
const NOTICE_CHARS = 250;
const HEADING_CHARS = 60;
// A gate speaks only when it blocks or reminds: about a sentence.
const GATE_SENTENCE = 160;

const MEMORY_HOOK = 'hook:session-memory';
const DAY = 24 * 60 * 60 * 1000;

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

// Text from a memory file as the hook quotes it, within its limit.
function quotedLength(text: string | undefined, limit: number): number {
  if (!text) return 0;
  const lines = text.trim().split('\n');
  const length = lines.reduce((sum, line) => sum + line.length + 3, 0);
  return Math.min(length, limit) + HEADING_CHARS;
}

// The memory block a new session would be given now, by size.
function memoryBlock(root: string, now: number): number {
  const memory = (name: string) => readText(join(root, '.wishforge', 'memory', name));
  const withoutTitle = (text: string | undefined) => text?.replace(/^# .*(\n+|$)/, '');
  const { parts } = MEMORY_LIMITS;
  let chars = 0;
  chars += quotedLength(withoutTitle(memory('lessons.md')), parts.lessons);
  chars += quotedLength(withoutTitle(memory('map.md')), parts.map);

  const handoff = join(root, '.wishforge', 'local', 'handoff.md');
  if (
    existsSync(handoff) &&
    Math.abs(now - statSync(handoff).mtimeMs) <= MEMORY_LIMITS.staleDays * DAY
  ) {
    chars += quotedLength(readText(handoff), parts.handoff);
  }
  const record = readText(join(root, '.wishforge', 'local', 'session.md'));
  const latest = record?.split(/^## /m)[1];
  if (latest) chars += Math.min(latest.length, parts.activity) + HEADING_CHARS;

  const run = findRun(root, now);
  if (run) chars += HEADING_CHARS + 2 * run.name.length + 80;
  return chars === 0 ? 0 : Math.min(chars + NOTICE_CHARS, MEMORY_LIMITS.block);
}

// OpenCode loads the memory files as they are.
function memoryFiles(root: string): number {
  let chars = 0;
  for (const dir of ['memory', 'local']) {
    const folder = join(root, '.wishforge', dir);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      if (name.endsWith('.md')) chars += readText(join(folder, name))?.length ?? 0;
    }
  }
  return chars;
}

// File patterns, short enough for one line: "*.ts *.tsx *.mts…".
function patterns(paths: string[]): string {
  const text = paths.map((pattern) => pattern.replace(/^\*\*\//, '')).join(' ');
  return text.length > 20 ? `${text.slice(0, 19)}…` : text;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const sum = <T>(items: T[], size: (item: T) => number) =>
  items.reduce((total, item) => total + size(item), 0);
// Skills a person must start themselves are not offered to the model, except
// on Codex, which has no such setting.
const offered = (skill: Item, target: string) => !skill.userInvocableOnly || target === 'codex';

function fileSizes(root: string, files: LockFileEntry[]): number {
  return sum(files, (file) => readText(join(root, file.path))?.length ?? 0);
}

// For each target installed at this scope: what its items add to the model's
// context every session, and what they add when used. Sizes are in characters.
export function estimateTokens(ctx: Context, targets: string[] | undefined): TargetTokens[] {
  const base = ctx.scope === 'global' ? ctx.home : ctx.cwd;
  const lock = readLock(base);
  const now = ctx.now ?? Date.now();
  return (targets ?? Object.keys(lock.targets))
    .filter((target) => lock.targets[target])
    .map((target) => {
      const adapter = getAdapter(target);
      const root = adapter.root(ctx.scope, ctx);
      const installed = lock.targets[target].items;
      const items = Object.keys(installed)
        .map((id) => ctx.catalog.get(id))
        .filter((item): item is Item => Boolean(item));
      const of = (type: Item['type']) => items.filter((item) => item.type === type);
      const always: TokenRow[] = [];
      const onUse: TokenRow[] = [];

      const agents = of('agent');
      if (agents.length > 0) {
        always.push({
          label: `agent list (${plural(agents.length, 'agent')})`,
          chars: sum(agents, (agent) => agent.name.length + agent.description.length),
        });
        for (const agent of agents) {
          onUse.push({ label: `${agent.name} agent (own context)`, chars: agent.body.length });
        }
      }

      const skills = of('skill');
      if (skills.length > 0) {
        const shown = skills.filter((skill) => offered(skill, target));
        // A skill only a person starts is not offered, so it costs nothing here.
        const count =
          shown.length === skills.length
            ? plural(skills.length, 'skill')
            : shown.length === 0
              ? `none offered: ${plural(skills.length, 'skill')} you start yourself`
              : `${shown.length} of ${plural(skills.length, 'skill')}`;
        always.push({
          label: `skill list (${count})`,
          chars: sum(shown, (skill) => skill.name.length + skill.description.length),
        });
        for (const skill of skills) {
          onUse.push({ label: `${skill.name} (when started)`, chars: skill.body.length });
        }
      }

      const rules = of('rule').sort((a, b) => a.name.localeCompare(b.name));
      if (rules.length > 0 && target === 'codex') {
        // Codex lists its rules in a block of AGENTS.md.
        const wiring = adapter.rulesWiring!(ctx.scope);
        const listed = rules.map((rule) => ({ name: rule.name, applies: appliesTo(rule) }));
        if (wiring.kind === 'block') {
          always.push({ label: 'AGENTS.md rules block', chars: wiring.block(listed).length });
        }
      }
      for (const rule of rules) {
        const chars = rule.body.length;
        if (
          target === 'opencode' ||
          ((target === 'claude' || target === 'cursor') && !rule.paths)
        ) {
          always.push({ label: `rules: ${rule.name}`, chars });
        } else if (target === 'codex') {
          onUse.push({ label: `rules: ${rule.name} (when read)`, chars });
        } else {
          onUse.push({ label: `rules: ${rule.name} (on ${patterns(rule.paths!)})`, chars });
        }
      }

      const gates = of('hook').filter((hook) => !hook.group);
      if (gates.length > 0) {
        onUse.push({
          label: `quality gates (${gates.length}): a sentence when one blocks or reminds`,
          chars: GATE_SENTENCE,
        });
      }
      if (installed[MEMORY_HOOK] && ctx.scope === 'project') {
        if (target === 'opencode') {
          always.push({ label: 'memory files (loaded as they are)', chars: memoryFiles(ctx.cwd) });
        } else {
          always.push({ label: 'memory block (now)', chars: memoryBlock(ctx.cwd, now) });
        }
      }

      for (const id of Object.keys(installed).filter((key) => !ctx.catalog.has(key))) {
        onUse.push({
          label: `${id} (no longer in the catalog)`,
          chars: fileSizes(root, installed[id].files),
        });
      }
      return { target, root, always, onUse };
    });
}

export const tokensOf = (chars: number) => Math.round(chars / 4);
