import { beforeEach, describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog';
import { main } from '../src/cli';
import { CatalogError, UsageError } from '../src/errors';
import { findId } from '../src/resolve';
import { agentMd, capture, ruleMd, tmpDir, writeTree } from './helpers';

const load = (tree) => loadCatalog(writeTree(tmpDir(), tree));
const TS = ruleMd('ts', 'paths:\n  - "**/*.ts"\n  - "**/*.tsx"\n');

describe('rule items', () => {
  it('load from rules/ with their paths', () => {
    const catalog = load({ 'rules/ts.md': TS, 'rules/common.md': ruleMd('common') });
    expect(catalog.get('rule:ts')).toMatchObject({
      id: 'rule:ts',
      type: 'rule',
      name: 'ts',
      description: 'ts standards.',
      paths: ['**/*.ts', '**/*.tsx'],
      requires: [],
      body: '# ts\n\n- A rule of ts.',
      source: 'rules/ts.md',
    });
    expect(catalog.get('rule:common').paths).toBeUndefined();
  });

  it.each([
    ['an empty list', 'paths: []\n'],
    ['a string', 'paths: "**/*.ts"\n'],
    ['a list holding a number', 'paths: [1]\n'],
    ['a list holding an empty string', 'paths: [""]\n'],
  ])('reject paths that is %s', (_case, extra) => {
    const attempt = () => load({ 'rules/ts.md': ruleMd('ts', extra) });
    expect(attempt).toThrow(CatalogError);
    expect(attempt).toThrow('rules/ts.md: field "paths" must be a non-empty list of file patterns');
  });

  it('reject agent fields and a name that differs from the file', () => {
    expect(() => load({ 'rules/ts.md': ruleMd('ts', 'access: read-only\n') })).toThrow(
      'unknown field "access" (allowed: name, description, paths, requires)'
    );
    expect(() => load({ 'rules/ts.md': ruleMd('js') })).toThrow(
      'field "name" (js) must equal the file name (ts)'
    );
  });

  it('do not have their bodies checked for placeholders', () => {
    const text = ruleMd('ts').replace('- A rule of ts.', '- Write `{{ value }}` in templates.');
    expect(load({ 'rules/ts.md': text }).get('rule:ts').body).toContain('{{ value }}');
  });
});

describe('finding a rule by name', () => {
  it('resolves a bare name to the rule', () => {
    expect(findId(load({ 'rules/ts.md': TS }), 'ts')).toBe('rule:ts');
  });

  it('is ambiguous when an agent has the same name', () => {
    const catalog = load({ 'rules/ts.md': TS, 'agents/ts.md': agentMd('ts') });
    expect(() => findId(catalog, 'ts')).toThrow(UsageError);
    expect(() => findId(catalog, 'ts')).toThrow('"ts" is ambiguous: use agent:ts or rule:ts.');
  });
});

describe('cli', () => {
  let catalogDir;
  const run = (...argv) => {
    const stdout = capture();
    const stderr = capture();
    const io = { cwd: tmpDir(), home: tmpDir(), stdout, stderr, catalogDir };
    return { code: main(argv, io), out: stdout.text, err: stderr.text };
  };

  beforeEach(() => {
    catalogDir = writeTree(tmpDir(), {
      'agents/alpha.md': agentMd('alpha', 'stage: review\n'),
      'rules/common.md': ruleMd('common'),
      'rules/ts.md': TS,
    });
  });

  it('lists rules with the rule label', () => {
    const { out } = run('list');
    expect(out).toMatch(
      /^Rules packs\n {2}common\s+all work\s+common standards\.\n {2}ts\s+\*\.ts \*\.tsx\s+ts standards\.$/m
    );
    expect(out).toContain('3 items.');
  });

  it('filters to rules and shows paths in JSON', () => {
    const rows = JSON.parse(run('list', '--type', 'rule', '--json').out);
    expect(rows.map((row) => row.id)).toEqual(['rule:common', 'rule:ts']);
    expect(rows[1].paths).toEqual(['**/*.ts', '**/*.tsx']);
    expect('paths' in rows[0]).toBe(false);
  });

  it('shows what a rule applies to in info', () => {
    expect(run('info', 'ts').out).toMatch(/^paths:\s+\*\*\/\*\.ts, \*\*\/\*\.tsx$/m);
    expect(run('info', 'common').out).toMatch(/^paths:\s+all work$/m);
    expect(run('info', 'alpha').out).not.toContain('paths');
  });

  it('offers rule as a type in the usage text and the error', () => {
    expect(run('--help').out).toContain('--type agent|skill|hook|rule');
    expect(run('list', '--type', 'bogus').err).toContain('agent, skill, hook, rule');
  });
});
