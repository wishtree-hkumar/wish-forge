import { join } from 'node:path';
import {
  appliesHeader,
  filled,
  hookFiles,
  markdown,
  ruleFile,
  skillFiles,
  stamp,
} from './shared.js';
import type { Dirs, HookWiring, Item, JsonRulesWiring, RenderedFile, Scope } from '../types.js';

export const name = 'opencode';
// The global folder has no ".opencode/" prefix: see root().
export const agentDirs = { project: '.opencode/agents', global: '~/.config/opencode/agents' };
export const rulesLocation =
  '`.opencode/wishforge/rules` in the project and `~/.config/opencode/wishforge/rules`';
export const places = { agentDirs, rulesLocation };

const MEMORY_HOOK = 'hook:session-memory';

// OpenCode loads every file its "instructions" list names. Which entries
// wishforge wants there depends on what is installed: ids is every item the
// target will have after the operation.
export function rulesWiring(scope: Scope, ids: string[] = []): JsonRulesWiring {
  const rules =
    scope === 'global'
      ? '~/.config/opencode/wishforge/rules/*.md'
      : '.opencode/wishforge/rules/*.md';
  // Hooks are per project, so memory is too.
  const memory = scope === 'global' ? [] : ['.wishforge/memory/*.md', '.wishforge/local/*.md'];
  const entries: string[] = [];
  if (ids.some((id) => id.startsWith('rule:'))) entries.push(rules);
  if (ids.includes(MEMORY_HOOK)) entries.push(...memory);
  return {
    kind: 'json',
    path: 'opencode.json',
    alternative: 'opencode.jsonc',
    entries,
    known: [rules, ...memory],
    skeleton: { $schema: 'https://opencode.ai/config.json' },
  };
}

// OpenCode has no hook config file: the plugin below is the wiring.
export const wiring: HookWiring | null = null;

export function root(scope: Scope, { cwd, home }: Dirs): string {
  return scope === 'global' ? join(home, '.config', 'opencode') : cwd;
}

export function render(
  item: Item,
  { scope, version }: { scope: Scope; version: string }
): RenderedFile[] {
  if (item.type === 'hook') return hookFiles('.opencode/wishforge', item, version);
  if (item.type === 'runtime') {
    return [
      {
        path: '.opencode/wishforge/runtime.mjs',
        content: stamp(item.sources!['runtime.mjs'], item, version),
      },
      {
        path: '.opencode/plugins/wishforge.js',
        content: stamp(item.sources!['opencode-plugin.js'], item, version),
      },
    ];
  }
  const prefix = scope === 'global' ? '' : '.opencode/';
  if (item.type === 'rule') {
    return ruleFile(`${prefix}wishforge/rules/${item.name}.md`, item, version, {
      header: appliesHeader(item),
    });
  }
  if (item.type === 'skill') {
    const extra = item.userInvocableOnly
      ? { metadata: { 'opencode/autoinvoke': 'false', 'opencode/slash': 'true' } }
      : {};
    return skillFiles(`${prefix}skills/${item.name}`, item, version, places, extra);
  }
  const data: Record<string, unknown> = { description: item.description, mode: 'subagent' };
  if (item.access === 'read-only') data.permission = { edit: 'deny' };
  return [
    {
      path: `${prefix}agents/${item.name}.md`,
      content: markdown(data, filled(item, places), version),
    },
  ];
}
