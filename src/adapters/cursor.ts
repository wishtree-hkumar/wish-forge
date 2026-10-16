import { stringify } from 'yaml';
import { filled, hookFiles, isHookItem, markdown, ruleFile, skillFiles } from './shared.js';
import type { Dirs, HookWiring, Item, RenderedFile, Scope } from '../types.js';

export const name = 'cursor';
export const agentDirs = { project: '.cursor/agents', global: '~/.cursor/agents' };
export const rulesLocation = '`.cursor/rules` in the project (the files named `wishforge-*.mdc`)';
export const places = { agentDirs, rulesLocation };
// Cursor keeps user-level rules in its settings, not in files.
export const globalRules = false;

// Cursor runs project hooks from the project root.
const entry = { command: 'node .cursor/wishforge/run.mjs cursor', timeout: 10 };

export const wiring: HookWiring = {
  path: '.cursor/hooks.json',
  runner: '.cursor/wishforge/run.mjs',
  skeleton: { version: 1, hooks: {} },
  entries: {
    preToolUse: entry,
    beforeSubmitPrompt: entry,
    stop: entry,
    sessionStart: entry,
    preCompact: entry,
  },
};

export function root(scope: Scope, { cwd, home }: Dirs): string {
  return scope === 'global' ? home : cwd;
}

export function render(item: Item, { version }: { version: string }): RenderedFile[] {
  if (isHookItem(item)) return hookFiles('.cursor/wishforge', item, version);
  if (item.type === 'rule') {
    const lines = [stringify({ description: item.description }, { lineWidth: 0 }).trimEnd()];
    // Cursor reads globs as a bare comma-separated list, so they are not YAML-quoted.
    if (item.paths) lines.push(`globs: ${item.paths.join(', ')}`);
    lines.push(`alwaysApply: ${item.paths ? 'false' : 'true'}`);
    return ruleFile(`.cursor/rules/wishforge-${item.name}.mdc`, item, version, {
      frontmatter: `${lines.join('\n')}\n`,
    });
  }
  if (item.type === 'skill') {
    const extra = item.userInvocableOnly ? { 'disable-model-invocation': true } : {};
    return skillFiles(`.cursor/skills/${item.name}`, item, version, places, extra);
  }
  const data = {
    name: item.name,
    description: item.description,
    readonly: item.access === 'read-only',
  };
  return [
    {
      path: `${agentDirs.project}/${item.name}.md`,
      content: markdown(data, filled(item, places), version),
    },
  ];
}
