import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { CatalogError } from '../src/errors.js';
import { findId } from '../src/resolve.js';
import { agentMd, tmpDir, writeTree } from './helpers.js';
import { hookTree, runtimeTree } from './hook-helpers.js';

const load = (tree) => loadCatalog(writeTree(tmpDir(), tree));

describe('hook items', () => {
  it('loads a hook with its gate source and requires the runtime', () => {
    const catalog = load({ ...runtimeTree(), ...hookTree('guard', '[shell, write]') });
    expect(catalog.get('hook:guard')).toMatchObject({
      type: 'hook',
      name: 'guard',
      description: 'Gate guard.',
      events: ['shell', 'write'],
      requires: ['runtime:hooks'],
      body: 'About guard.',
      gate: 'export function check() {}\n// guard\n',
      files: [],
      source: 'hooks/guard/HOOK.md',
    });
  });

  it('does not list the runtime twice when a hook already requires it', () => {
    const tree = { ...runtimeTree(), ...hookTree('guard') };
    tree['hooks/guard/HOOK.md'] = tree['hooks/guard/HOOK.md'].replace(
      'events:',
      'requires: [runtime:hooks]\nevents:'
    );
    expect(load(tree).get('hook:guard').requires).toEqual(['runtime:hooks']);
  });

  it('loads the runtime item with its three sources', () => {
    const runtime = load(runtimeTree()).get('runtime:hooks');
    expect(runtime).toMatchObject({
      type: 'runtime',
      name: 'hooks',
      description: 'Hook runner.',
      requires: [],
      sources: {
        'run.mjs': '// run\n',
        'runtime.mjs': '// runtime\n',
        'opencode-plugin.js': '// plugin\n',
      },
    });
  });

  it('resolves a bare hook name', () => {
    const catalog = load({ ...runtimeTree(), ...hookTree('guard') });
    expect(findId(catalog, 'guard')).toBe('hook:guard');
  });

  it('reports a name shared by an agent and a hook as ambiguous', () => {
    const catalog = load({
      ...runtimeTree(),
      ...hookTree('twin'),
      'agents/twin.md': agentMd('twin'),
    });
    expect(() => findId(catalog, 'twin')).toThrow('use agent:twin or hook:twin');
  });

  const withHook = (edit) => {
    const tree = { ...runtimeTree(), ...hookTree('guard') };
    edit(tree);
    return tree;
  };
  const invalid = [
    [
      'a hook without gate.mjs',
      withHook((t) => delete t['hooks/guard/gate.mjs']),
      'hooks/guard: missing gate.mjs',
    ],
    [
      'a hook without HOOK.md',
      withHook((t) => delete t['hooks/guard/HOOK.md']),
      'hooks/guard: missing HOOK.md',
    ],
    [
      'a hook without events',
      withHook(
        (t) =>
          (t['hooks/guard/HOOK.md'] = t['hooks/guard/HOOK.md'].replace('events: [shell]\n', ''))
      ),
      'field "events"',
    ],
    [
      'an empty events list',
      withHook(
        (t) => (t['hooks/guard/HOOK.md'] = t['hooks/guard/HOOK.md'].replace('[shell]', '[]'))
      ),
      'field "events"',
    ],
    [
      'an unknown event',
      withHook(
        (t) =>
          (t['hooks/guard/HOOK.md'] = t['hooks/guard/HOOK.md'].replace('[shell]', '[shell, click]'))
      ),
      'field "events"',
    ],
    [
      'an agent field on a hook',
      withHook(
        (t) =>
          (t['hooks/guard/HOOK.md'] = t['hooks/guard/HOOK.md'].replace(
            'events:',
            'access: write\nevents:'
          ))
      ),
      'unknown field "access"',
    ],
    [
      'a hook name that differs from its folder',
      { ...runtimeTree(), ...renamed() },
      'must equal the folder name (other)',
    ],
    ['a hook with no runtime in the catalog', hookTree('guard'), 'unknown item "runtime:hooks"'],
    [
      'a runtime missing a source file',
      withHook((t) => delete t['runtime/hooks/run.mjs']),
      'runtime/hooks: missing run.mjs',
    ],
    [
      'a runtime not named hooks',
      withHook(
        (t) =>
          (t['runtime/hooks/RUNTIME.md'] = t['runtime/hooks/RUNTIME.md'].replace(
            'name: hooks',
            'name: other'
          ))
      ),
      'must equal the folder name (hooks)',
    ],
  ];

  function renamed() {
    const tree = hookTree('guard');
    return {
      'hooks/other/HOOK.md': tree['hooks/guard/HOOK.md'],
      'hooks/other/gate.mjs': tree['hooks/guard/gate.mjs'],
    };
  }

  it.each(invalid)('rejects %s', (_label, tree, message) => {
    expect(() => load(tree)).toThrow(CatalogError);
    expect(() => load(tree)).toThrow(message);
  });
});
