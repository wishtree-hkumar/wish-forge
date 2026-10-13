import { hookFiles, isHookItem, markdown, skillFiles } from './shared.js';

export const name = 'cursor';
export const agentDirs = { project: '.cursor/agents', global: '~/.cursor/agents' };

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
  if (item.type === 'skill') {
    const extra = item.userInvocableOnly ? { 'disable-model-invocation': true } : {};
    return skillFiles(`.cursor/skills/${item.name}`, item, version, agentDirs, extra);
  }
  const data = {
    name: item.name,
    description: item.description,
    readonly: item.access === 'read-only',
  };
  return [{ path: `${agentDirs.project}/${item.name}.md`, content: markdown(data, item, version) }];
}
