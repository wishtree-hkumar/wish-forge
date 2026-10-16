import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { CatalogError } from '../src/errors.js';
import { agentMd, skillMd, tmpDir, writeTree } from './helpers.js';

const load = (tree) => loadCatalog(writeTree(tmpDir(), tree));

describe('loadCatalog', () => {
  it('loads agents and skills keyed by id', () => {
    const catalog = load({
      'agents/reviewer.md': agentMd('reviewer', 'stage: review\nmodel-tier: strong\n'),
      'agents/builder.md':
        '---\nname: builder\ndescription: Builds.\naccess: write\n---\nBuild it.\n',
      'skills/flow/SKILL.md': skillMd(
        'flow',
        'user-invocable-only: true\nrequires: [agent:reviewer, agent:builder]\n'
      ),
      'skills/flow/notes/extra.md': 'extra',
    });

    expect([...catalog.keys()].sort()).toEqual(['agent:builder', 'agent:reviewer', 'skill:flow']);
    expect(catalog.get('agent:reviewer')).toMatchObject({
      type: 'agent',
      name: 'reviewer',
      description: 'Does reviewer things.',
      stage: 'review',
      access: 'read-only',
      modelTier: 'strong',
      requires: [],
      body: 'Body of reviewer.',
      source: 'agents/reviewer.md',
    });
    expect(catalog.get('agent:builder')).toMatchObject({ access: 'write', modelTier: 'balanced' });
    expect(catalog.get('agent:builder').stage).toBeUndefined();

    const flow = catalog.get('skill:flow');
    expect(flow).toMatchObject({
      type: 'skill',
      userInvocableOnly: true,
      requires: ['agent:reviewer', 'agent:builder'],
      body: 'Steps of flow.',
    });
    expect(flow.files).toEqual([{ path: 'notes/extra.md', content: Buffer.from('extra') }]);
  });

  it('returns an empty catalog for an empty directory', () => {
    expect(loadCatalog(tmpDir()).size).toBe(0);
  });

  it('ignores non-Markdown files in agents/', () => {
    expect(load({ 'agents/README.txt': 'x', 'agents/a.md': agentMd('a') }).size).toBe(1);
  });

  const invalid: [string, Record<string, string>, string][] = [
    [
      'missing name',
      { 'agents/a.md': '---\ndescription: D.\naccess: write\n---\nB' },
      'agents/a.md: field "name"',
    ],
    ['bad name characters', { 'agents/A_b.md': agentMd('A_b') }, 'field "name"'],
    ['name differs from file', { 'agents/a.md': agentMd('b') }, 'must equal the file name (a)'],
    [
      'name differs from folder',
      { 'skills/a/SKILL.md': skillMd('b') },
      'must equal the folder name (a)',
    ],
    [
      'missing description',
      { 'agents/a.md': '---\nname: a\naccess: write\n---\nB' },
      'field "description"',
    ],
    [
      'description too long',
      { 'agents/a.md': `---\nname: a\ndescription: ${'x'.repeat(1025)}\naccess: write\n---\nB` },
      'field "description"',
    ],
    [
      'missing access',
      { 'agents/a.md': '---\nname: a\ndescription: D.\n---\nB' },
      'field "access"',
    ],
    [
      'bad access',
      { 'agents/a.md': '---\nname: a\ndescription: D.\naccess: admin\n---\nB' },
      'field "access"',
    ],
    ['bad stage', { 'agents/a.md': agentMd('a', 'stage: launch\n') }, 'field "stage"'],
    ['bad model tier', { 'agents/a.md': agentMd('a', 'model-tier: huge\n') }, 'field "model-tier"'],
    [
      'requires not a list',
      { 'agents/a.md': agentMd('a', 'requires: agent:b\n') },
      'field "requires"',
    ],
    ['unknown field', { 'agents/a.md': agentMd('a', 'acess: write\n') }, 'unknown field "acess"'],
    [
      'agent field on a skill',
      { 'skills/a/SKILL.md': skillMd('a', 'access: write\n') },
      'unknown field "access"',
    ],
    [
      'non-boolean user-invocable-only',
      { 'skills/a/SKILL.md': skillMd('a', 'user-invocable-only: sometimes\n') },
      'field "user-invocable-only"',
    ],
    [
      'empty body',
      { 'agents/a.md': '---\nname: a\ndescription: D.\naccess: write\n---\n\n' },
      'body is empty',
    ],
    ['no frontmatter', { 'agents/a.md': 'plain' }, 'agents/a.md: missing frontmatter'],
    ['skill folder without SKILL.md', { 'skills/a/notes.md': 'x' }, 'skills/a: missing SKILL.md'],
    [
      'unknown requires',
      { 'agents/a.md': agentMd('a', 'requires: [agent:ghost]\n') },
      'unknown item "agent:ghost"',
    ],
    [
      'requires cycle',
      {
        'agents/a.md': agentMd('a', 'requires: [agent:b]\n'),
        'agents/b.md': agentMd('b', 'requires: [agent:a]\n'),
      },
      'forms a cycle: agent:a → agent:b → agent:a',
    ],
  ];

  it.each(invalid)('rejects %s', (_label, tree, message) => {
    expect(() => load(tree)).toThrow(CatalogError);
    expect(() => load(tree)).toThrow(message);
  });
});
