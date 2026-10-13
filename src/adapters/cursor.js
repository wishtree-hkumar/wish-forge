import { stringify } from 'yaml';
import { filled, hookFiles, isHookItem, markdown, ruleFile, skillFiles } from './shared.js';

export const name = 'cursor';
export const agentDirs = { project: '.cursor/agents', global: '~/.cursor/agents' };
export const rulesLocation = '`.cursor/rules` in the project (the files named `forgeflow-*.mdc`)';
export const places = { agentDirs, rulesLocation };
// Cursor keeps user-level rules in its settings, not in files.
export const globalRules = false;

// Cursor runs project hooks from the project root.
const entry = { command: 'node .cursor/forgeflow/run.mjs cursor', timeout: 10 };

export const wiring = {
  path: '.cursor/hooks.json',
  runner: '.cursor/forgeflow/run.mjs',
  skeleton: { version: 1, hooks: {} },
  entries: { preToolUse: entry, beforeSubmitPrompt: entry, stop: entry },
};

export function root(scope, { cwd, home }) {
  return scope === 'global' ? home : cwd;
}

export function render(item, { version }) {
  if (isHookItem(item)) return hookFiles('.cursor/forgeflow', item, version);
  if (item.type === 'rule') {
    const lines = [stringify({ description: item.description }, { lineWidth: 0 }).trimEnd()];
    // Cursor reads globs as a bare comma-separated list, so they are not YAML-quoted.
    if (item.paths) lines.push(`globs: ${item.paths.join(', ')}`);
    lines.push(`alwaysApply: ${item.paths ? 'false' : 'true'}`);
    return ruleFile(`.cursor/rules/forgeflow-${item.name}.mdc`, item, version, {
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
