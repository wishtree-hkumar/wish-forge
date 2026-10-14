import { stringify } from 'yaml';
import { fillPlaceholders } from '../placeholders.js';

export function marker(item, version) {
  return `managed by wishforge: ${item.id}@${version}`;
}

export function markdown(data, item, version) {
  const frontmatter = stringify(data, { lineWidth: 0 });
  return `---\n${frontmatter}---\n\n${item.body}\n\n<!-- ${marker(item, version)} -->\n`;
}

// places is the adapter's { agentDirs, rulesLocation }.
export const filled = (item, places) => ({ ...item, body: fillPlaceholders(item.body, places) });

// Only SKILL.md is filled; supporting files are copied as they are.
export function skillFiles(dir, item, version, places, extraFrontmatter = {}) {
  const data = { name: item.name, description: item.description, ...extraFrontmatter };
  return [
    { path: `${dir}/SKILL.md`, content: markdown(data, filled(item, places), version) },
    ...item.files.map((file) => ({ path: `${dir}/${file.path}`, content: file.content })),
  ];
}

// How a rule's reach is put into words where the harness cannot scope it.
export function appliesTo(item) {
  if (!item.paths) return 'all work';
  return `files matching ${item.paths.map((pattern) => `\`${pattern}\``).join(', ')}`;
}

export const appliesHeader = (item) => `Applies to: ${appliesTo(item)}.\n\n`;

// frontmatter is the text between the fences, ending in a newline, or '' for none.
export function ruleFile(path, item, version, { frontmatter = '', header = '' } = {}) {
  const front = frontmatter ? `---\n${frontmatter}---\n\n` : '';
  const content = `${front}${header}${item.body}\n\n<!-- ${marker(item, version)} -->\n`;
  return [{ path, content }];
}

export const isHookItem = (item) => item.type === 'hook' || item.type === 'runtime';

// Shipped JavaScript carries the marker as its first line.
export function stamp(source, item, version) {
  return `// ${marker(item, version)}\n${source}`;
}

// dir is the target's wishforge folder, such as ".claude/wishforge".
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
      // Not resume: a resumed session already holds what its first start was given.
      SessionStart: { matcher: 'startup|clear|compact', hooks: [handler] },
    },
  };
}
