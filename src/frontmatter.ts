import { parse } from 'yaml';

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') throw new Error('missing frontmatter: file must start with ---');
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
  if (end === -1) throw new Error('unterminated frontmatter: no closing ---');

  let data: unknown;
  try {
    data = parse(lines.slice(1, end).join('\n')) ?? {};
  } catch (error) {
    throw new Error(`invalid YAML in frontmatter: ${(error as Error).message}`, { cause: error });
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('frontmatter must be a YAML mapping');
  }
  return {
    data: data as Record<string, unknown>,
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  };
}
