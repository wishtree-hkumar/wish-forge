import { stringify } from 'yaml';

export function marker(item, version) {
  return `managed by forgeflow: ${item.id}@${version}`;
}

export function markdown(data, item, version) {
  const frontmatter = stringify(data, { lineWidth: 0 });
  return `---\n${frontmatter}---\n\n${item.body}\n\n<!-- ${marker(item, version)} -->\n`;
}

export function skillFiles(dir, item, version, extraFrontmatter = {}) {
  const data = { name: item.name, description: item.description, ...extraFrontmatter };
  return [
    { path: `${dir}/SKILL.md`, content: markdown(data, item, version) },
    ...item.files.map((file) => ({ path: `${dir}/${file.path}`, content: file.content })),
  ];
}
