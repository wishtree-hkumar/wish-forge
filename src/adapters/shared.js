import { stringify } from 'yaml';
import { fillPlaceholders } from '../placeholders.js';

export function marker(item, version) {
  return `managed by forgeflow: ${item.id}@${version}`;
}

export function markdown(data, item, version) {
  const frontmatter = stringify(data, { lineWidth: 0 });
  return `---\n${frontmatter}---\n\n${item.body}\n\n<!-- ${marker(item, version)} -->\n`;
}

// agentDirs is the adapter's { project, global } pair; only SKILL.md is filled.
export function skillFiles(dir, item, version, agentDirs, extraFrontmatter = {}) {
  const data = { name: item.name, description: item.description, ...extraFrontmatter };
  const filled = { ...item, body: fillPlaceholders(item.body, agentDirs) };
  return [
    { path: `${dir}/SKILL.md`, content: markdown(data, filled, version) },
    ...item.files.map((file) => ({ path: `${dir}/${file.path}`, content: file.content })),
  ];
}

export const isHookItem = (item) => item.type === 'hook' || item.type === 'runtime';

// Shipped JavaScript carries the marker as its first line.
export function stamp(source, item, version) {
  return `// ${marker(item, version)}\n${source}`;
}

// dir is the target's forgeflow folder, such as ".claude/forgeflow".
export function hookFiles(dir, item, version) {
  if (item.type === 'hook') {
    return [{ path: `${dir}/gates/${item.name}.mjs`, content: stamp(item.gate, item, version) }];
  }
  return ['run.mjs', 'runtime.mjs'].map((file) => ({
    path: `${dir}/${file}`,
    content: stamp(item.sources[file], item, version),
  }));
}

// Wiring in the shape Claude Code and Codex share.
export function commandWiring(path, runner, command, matcher) {
  const handler = { type: 'command', command, timeout: 10 };
  return {
    path,
    runner,
    skeleton: {},
    entries: {
      PreToolUse: { matcher, hooks: [handler] },
      UserPromptSubmit: { hooks: [handler] },
      Stop: { hooks: [handler] },
    },
  };
}
