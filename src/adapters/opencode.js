import { join } from 'node:path';
import { appliesHeader, hookFiles, markdown, ruleFile, skillFiles, stamp } from './shared.js';

export const name = 'opencode';
// The global folder has no ".opencode/" prefix: see root().
export const agentDirs = { project: '.opencode/agents', global: '~/.config/opencode/agents' };
export const rulesLocation =
  '`.opencode/forgeflow/rules` in the project and `~/.config/opencode/forgeflow/rules`';

// OpenCode has no hook config file: the plugin below is the wiring.
export const wiring = null;

export function root(scope, { cwd, home }) {
  return scope === 'global' ? join(home, '.config', 'opencode') : cwd;
}

export function render(item, { scope, version }) {
  if (item.type === 'hook') return hookFiles('.opencode/forgeflow', item, version);
  if (item.type === 'runtime') {
    return [
      {
        path: '.opencode/forgeflow/runtime.mjs',
        content: stamp(item.sources['runtime.mjs'], item, version),
      },
      {
        path: '.opencode/plugins/forgeflow.js',
        content: stamp(item.sources['opencode-plugin.js'], item, version),
      },
    ];
  }
  const prefix = scope === 'global' ? '' : '.opencode/';
  if (item.type === 'rule') {
    return ruleFile(`${prefix}forgeflow/rules/${item.name}.md`, item, version, {
      header: appliesHeader(item),
    });
  }
  if (item.type === 'skill') {
    const extra = item.userInvocableOnly
      ? { metadata: { 'opencode/autoinvoke': 'false', 'opencode/slash': 'true' } }
      : {};
    return skillFiles(`${prefix}skills/${item.name}`, item, version, agentDirs, extra);
  }
  const data = { description: item.description, mode: 'subagent' };
  if (item.access === 'read-only') data.permission = { edit: 'deny' };
  return [{ path: `${prefix}agents/${item.name}.md`, content: markdown(data, item, version) }];
}
