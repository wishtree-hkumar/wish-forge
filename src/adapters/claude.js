import { stringify } from 'yaml';
import { commandWiring, hookFiles, isHookItem, markdown, ruleFile, skillFiles } from './shared.js';

const MODELS = { fast: 'haiku', balanced: 'sonnet', strong: 'opus' };

export const name = 'claude';
export const agentDirs = { project: '.claude/agents', global: '~/.claude/agents' };
export const rulesLocation =
  '`.claude/rules/forgeflow` in the project and `~/.claude/rules/forgeflow`';

export const wiring = commandWiring(
  '.claude/settings.json',
  '.claude/forgeflow/run.mjs',
  'node "$CLAUDE_PROJECT_DIR/.claude/forgeflow/run.mjs" claude',
  'Bash|Write|Edit|MultiEdit|NotebookEdit'
);

export function root(scope, { cwd, home }) {
  return scope === 'global' ? home : cwd;
}

export function render(item, { version }) {
  if (isHookItem(item)) return hookFiles('.claude/forgeflow', item, version);
  if (item.type === 'rule') {
    // A rule without paths loads for every session, so it gets no frontmatter.
    const frontmatter = item.paths ? stringify({ paths: item.paths }, { lineWidth: 0 }) : '';
    return ruleFile(`.claude/rules/forgeflow/${item.name}.md`, item, version, { frontmatter });
  }
  if (item.type === 'skill') {
    const extra = item.userInvocableOnly ? { 'disable-model-invocation': true } : {};
    return skillFiles(`.claude/skills/${item.name}`, item, version, agentDirs, extra);
  }
  const data = { name: item.name, description: item.description };
  // Read-only agents keep Bash so they can run tests and git diff.
  if (item.access === 'read-only') data.tools = 'Read, Grep, Glob, Bash';
  data.model = MODELS[item.modelTier];
  return [{ path: `${agentDirs.project}/${item.name}.md`, content: markdown(data, item, version) }];
}
