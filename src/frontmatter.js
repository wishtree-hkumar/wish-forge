import { parse } from 'yaml';

export function parseFrontmatter(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') throw new Error('missing frontmatter: file must start with ---');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) throw new Error('unterminated frontmatter: no closing ---');

  let data;
  try {
    data = parse(lines.slice(1, end).join('\n')) ?? {};
  } catch (error) {
    throw new Error(`invalid YAML in frontmatter: ${error.message}`);
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('frontmatter must be a YAML mapping');
  }
  return { data, body: lines.slice(end + 1).join('\n').trim() };
}
