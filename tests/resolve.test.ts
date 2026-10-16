import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors';
import { findId, resolve } from '../src/resolve';
import { item, skill } from './helpers';

const catalog = new Map(
  [
    item({ id: 'agent:a', name: 'a' }),
    item({ id: 'agent:b', name: 'b', requires: ['agent:a'] }),
    item({ id: 'agent:twin', name: 'twin' }),
    skill({ id: 'skill:twin', name: 'twin' }),
    skill({ id: 'skill:flow', name: 'flow', requires: ['agent:b', 'agent:a'] }),
  ].map((entry) => [entry.id, entry])
);

describe('findId', () => {
  it('accepts a full id', () => {
    expect(findId(catalog, 'agent:a')).toBe('agent:a');
  });

  it('accepts an unambiguous bare name', () => {
    expect(findId(catalog, 'flow')).toBe('skill:flow');
  });

  it('rejects an unknown item', () => {
    expect(() => findId(catalog, 'ghost')).toThrow(UsageError);
    expect(() => findId(catalog, 'agent:ghost')).toThrow('unknown item "agent:ghost"');
  });

  it('rejects an ambiguous bare name and names the choices', () => {
    expect(() => findId(catalog, 'twin')).toThrow('use agent:twin or skill:twin');
  });
});

describe('resolve', () => {
  const ids = (entries) => entries.map(({ item: entry, explicit }) => [entry.id, explicit]);

  it('returns a single item with no requirements', () => {
    expect(ids(resolve(catalog, ['a']))).toEqual([['agent:a', true]]);
  });

  it('puts transitive requirements first and marks them implicit', () => {
    expect(ids(resolve(catalog, ['flow']))).toEqual([
      ['agent:a', false],
      ['agent:b', false],
      ['skill:flow', true],
    ]);
  });

  it('marks an item explicit when it is both named and required', () => {
    expect(ids(resolve(catalog, ['flow', 'agent:a']))).toEqual([
      ['agent:a', true],
      ['agent:b', false],
      ['skill:flow', true],
    ]);
  });

  it('lists a repeated ref once', () => {
    expect(resolve(catalog, ['a', 'agent:a'])).toHaveLength(1);
  });
});
