import {
  appliesHeader,
  commandWiring,
  filled,
  hookFiles,
  isHookItem,
  marker,
  ruleFile,
  skillFiles,
} from './shared.js';
import { END, START } from '../rules-wiring.js';

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
export const agentDirs = { project: '.codex/agents', global: '~/.codex/agents' };
export const rulesLocation =
  '`.codex/wishforge/rules` in the project and `~/.codex/wishforge/rules`';
export const places = { agentDirs, rulesLocation };

const RULES_INTRO =
  'These standards are installed by wishforge. Before you write or review code, ' +
  'read each file below that applies to the files you are working on, and follow it.';

// Codex reads only AGENTS.md, so the rule files are listed there. rules is
// [{ name, applies }] in name order; applies is unknown for a rule that has
// left the catalog.
export function rulesWiring(scope) {
  const dir = scope === 'global' ? '~/.codex/wishforge/rules' : '.codex/wishforge/rules';
  return {
    kind: 'block',
    path: scope === 'global' ? '.codex/AGENTS.md' : 'AGENTS.md',
    block: (rules) =>
      [
        START,
        '## Coding standards',
        '',
        RULES_INTRO,
        '',
        ...rules.map(
          (rule) => `- \`${dir}/${rule.name}.md\`${rule.applies ? `: ${rule.applies}` : ''}`
        ),
        END,
      ].join('\n'),
  };
}

// Codex runs hooks from the session's working directory, so the runner is
// located through git rather than a relative path.
export const wiring = commandWiring(
  '.codex/hooks.json',
  '.codex/wishforge/run.mjs',
  'node "$(git rev-parse --show-toplevel)/.codex/wishforge/run.mjs" codex',
  'Bash|apply_patch|Edit|Write'
);

export function root(scope, { cwd, home }) {
  return scope === 'global' ? home : cwd;
}

export function render(item, { version }) {
  if (isHookItem(item)) return hookFiles('.codex/wishforge', item, version);
  if (item.type === 'rule') {
    return ruleFile(`.codex/wishforge/rules/${item.name}.md`, item, version, {
      header: appliesHeader(item),
    });
  }
  if (item.type === 'skill') {
    return skillFiles(`.agents/skills/${item.name}`, item, version, places);
  }
  const sandbox = item.access === 'read-only' ? 'read-only' : 'workspace-write';
  const content = [
    `# ${marker(item, version)}`,
    `name = ${basic(item.name)}`,
    `description = ${basic(item.description)}`,
    `sandbox_mode = ${basic(sandbox)}`,
    'developer_instructions = """',
    multiline(filled(item, places).body),
    '"""',
    '',
  ].join('\n');
  return [{ path: `${agentDirs.project}/${item.name}.toml`, content }];
}
