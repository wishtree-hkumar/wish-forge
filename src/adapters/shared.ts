import { stringify } from 'yaml';
import { fillPlaceholders } from '../placeholders';
import type { HookWiring, Item, Places, RenderedFile } from '../types';

export function marker(item: Pick<Item, 'id'>, version: string): string {
  return `managed by wishforge: ${item.id}@${version}`;
}

export function markdown(data: Record<string, unknown>, item: Item, version: string): string {
  const frontmatter = stringify(data, { lineWidth: 0 });
  return `---\n${frontmatter}---\n\n${item.body}\n\n<!-- ${marker(item, version)} -->\n`;
}

// places is the adapter's { agentDirs, rulesLocation }.
export const filled = (item: Item, places: Places): Item => ({
  ...item,
  body: fillPlaceholders(item.body, places),
});

// Only SKILL.md is filled; supporting files are copied as they are.
export function skillFiles(
  dir: string,
  item: Item,
  version: string,
  places: Places,
  extraFrontmatter: Record<string, unknown> = {}
): RenderedFile[] {
  const data = { name: item.name, description: item.description, ...extraFrontmatter };
  return [
    { path: `${dir}/SKILL.md`, content: markdown(data, filled(item, places), version) },
    ...item.files.map((file) => ({ path: `${dir}/${file.path}`, content: file.content })),
  ];
}

// How a rule's reach is put into words where the harness cannot scope it.
export function appliesTo(item: Pick<Item, 'paths'>): string {
  if (!item.paths) return 'all work';
  return `files matching ${item.paths.map((pattern) => `\`${pattern}\``).join(', ')}`;
}

export const appliesHeader = (item: Item) => `Applies to: ${appliesTo(item)}.\n\n`;

// frontmatter is the text between the fences, ending in a newline, or '' for none.
export function ruleFile(
  path: string,
  item: Item,
  version: string,
  { frontmatter = '', header = '' }: { frontmatter?: string; header?: string } = {}
): RenderedFile[] {
  const front = frontmatter ? `---\n${frontmatter}---\n\n` : '';
  const content = `${front}${header}${item.body}\n\n<!-- ${marker(item, version)} -->\n`;
  return [{ path, content }];
}

export const isHookItem = (item: Item) => item.type === 'hook' || item.type === 'runtime';

// Shipped JavaScript carries the marker as its first line.
export function stamp(source: string, item: Item, version: string): string {
  return `// ${marker(item, version)}\n${source}`;
}

// dir is the target's wishforge folder, such as ".claude/wishforge". A hook
// item carries its gate, and the runtime its sources.
export function hookFiles(dir: string, item: Item, version: string): RenderedFile[] {
  if (item.type === 'hook') {
    return [{ path: `${dir}/gates/${item.name}.mjs`, content: stamp(item.gate!, item, version) }];
  }
  return ['run.mjs', 'runtime.mjs'].map((file) => ({
    path: `${dir}/${file}`,
    content: stamp(item.sources![file], item, version),
  }));
}

// Wiring in the shape Claude Code and Codex share.
export function commandWiring(
  path: string,
  runner: string,
  command: string,
  matcher: string
): HookWiring {
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
