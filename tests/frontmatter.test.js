import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter.js';

describe('parseFrontmatter', () => {
  it('splits data and body', () => {
    const { data, body } = parseFrontmatter('---\nname: a\nrequires: [x, y]\n---\n\nHello\nworld\n');
    expect(data).toEqual({ name: 'a', requires: ['x', 'y'] });
    expect(body).toBe('Hello\nworld');
  });

  it('accepts CRLF line endings and a BOM', () => {
    const { data, body } = parseFrontmatter('\uFEFF---\r\nname: a\r\n---\r\nLine 1\r\nLine 2\r\n');
    expect(data).toEqual({ name: 'a' });
    expect(body).toBe('Line 1\nLine 2');
  });

  it('keeps a --- line that appears inside the body', () => {
    const { body } = parseFrontmatter('---\nname: a\n---\nBefore\n---\nAfter\n');
    expect(body).toBe('Before\n---\nAfter');
  });

  it('treats empty frontmatter as an empty mapping', () => {
    expect(parseFrontmatter('---\n---\nBody').data).toEqual({});
  });

  it('rejects a file with no frontmatter', () => {
    expect(() => parseFrontmatter('Just text')).toThrow('must start with ---');
  });

  it('rejects unterminated frontmatter', () => {
    expect(() => parseFrontmatter('---\nname: a\n')).toThrow('no closing ---');
  });

  it('rejects invalid YAML', () => {
    expect(() => parseFrontmatter('---\nname: [unclosed\n---\nBody')).toThrow('invalid YAML');
  });

  it('rejects frontmatter that is not a mapping', () => {
    expect(() => parseFrontmatter('---\n- a\n- b\n---\nBody')).toThrow('must be a YAML mapping');
  });
});
