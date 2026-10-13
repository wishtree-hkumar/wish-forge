import { commandWiring, hookFiles, isHookItem, marker, skillFiles } from './shared.js';

// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const escapeControl = (text) =>
  text.replace(CONTROL, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

// JSON string escapes are a subset of TOML basic-string escapes.
const basic = (text) => JSON.stringify(text).replace(/\u007f/g, '\\u007f');

// Body of a TOML multi-line basic string: keep newlines and single quotes
// readable, escape only what would end or corrupt the string.
const multiline = (text) => escapeControl(text.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"'));

export const name = 'codex';

// Codex runs hooks from the session's working directory, so the runner is
// located through git rather than a relative path.
export const wiring = commandWiring(
  '.codex/hooks.json',
  'node "$(git rev-parse --show-toplevel)/.codex/forgeflow/run.mjs" codex',
  'Bash|apply_patch|Edit|Write'
);

export function root(scope, { cwd, home }) {
  return scope === 'global' ? home : cwd;
}

export function render(item, { version }) {
  if (isHookItem(item)) return hookFiles('.codex/forgeflow', item, version);
  if (item.type === 'skill') return skillFiles(`.agents/skills/${item.name}`, item, version);
  const sandbox = item.access === 'read-only' ? 'read-only' : 'workspace-write';
  const content = [
    `# ${marker(item, version)}`,
    `name = ${basic(item.name)}`,
    `description = ${basic(item.description)}`,
    `sandbox_mode = ${basic(sandbox)}`,
    'developer_instructions = """',
    multiline(item.body),
    '"""',
    '',
  ].join('\n');
  return [{ path: `.codex/agents/${item.name}.toml`, content }];
}
