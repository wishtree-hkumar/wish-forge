import { join } from 'node:path';
import { hookFiles, markdown, skillFiles, stamp } from './shared.js';

export const name = 'opencode';

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
  if (item.type === 'skill') {
    const extra = item.userInvocableOnly
      ? { metadata: { 'opencode/autoinvoke': 'false', 'opencode/slash': 'true' } }
      : {};
    return skillFiles(`${prefix}skills/${item.name}`, item, version, extra);
  }
  const data = { description: item.description, mode: 'subagent' };
  if (item.access === 'read-only') data.permission = { edit: 'deny' };
  return [{ path: `${prefix}agents/${item.name}.md`, content: markdown(data, item, version) }];
}
