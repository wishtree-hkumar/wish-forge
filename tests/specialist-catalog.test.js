import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { CatalogError } from '../src/errors.js';
import { agentMd, skillMd, tmpDir, writeTree } from './helpers.js';

const load = (tree) => loadCatalog(writeTree(tmpDir(), tree));
const writer = (extra) =>
  `---\nname: sec\ndescription: Does sec things.\naccess: write\n${extra}---\nBody.\n`;

describe('joins', () => {
  it('is carried on a read-only agent that has no stage', () => {
    const catalog = load({ 'agents/sec.md': agentMd('sec', 'joins: review\n') });
    expect(catalog.get('agent:sec').joins).toBe('review');
    expect(catalog.get('agent:sec').stage).toBeUndefined();
  });

  it('is undefined when the agent does not set it', () => {
    expect(load({ 'agents/sec.md': agentMd('sec') }).get('agent:sec').joins).toBeUndefined();
  });

  it.each([
    [
      'a value other than review',
      agentMd('sec', 'joins: build\n'),
      'field "joins" must be one of: review',
    ],
    [
      'an agent that has a stage',
      agentMd('sec', 'stage: review\njoins: review\n'),
      'field "joins" is not allowed on an agent that has a stage',
    ],
    [
      'an agent with write access',
      writer('joins: review\n'),
      'field "joins" requires access: read-only',
    ],
  ])('is rejected on %s', (_case, text, message) => {
    const attempt = () => load({ 'agents/sec.md': text });
    expect(attempt).toThrow(CatalogError);
    expect(attempt).toThrow(`agents/sec.md: ${message}`);
  });

  it('is not a skill field', () => {
    const attempt = () => load({ 'skills/flow/SKILL.md': skillMd('flow', 'joins: review\n') });
    expect(attempt).toThrow('unknown field "joins"');
  });
});
