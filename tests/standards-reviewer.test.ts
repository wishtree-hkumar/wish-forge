import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { adapters } from '../src/adapters/index';
import { loadCatalog } from '../src/catalog';
import { main } from '../src/cli';
import { capture, tmpDir } from './helpers';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const agent = catalog.get('agent:standards-reviewer');
const ORDER = [
  'security-reviewer',
  'performance-reviewer',
  'database-reviewer',
  'accessibility-reviewer',
  'standards-reviewer',
];

describe('standards-reviewer', () => {
  it('is a read-only review specialist on the balanced tier', () => {
    expect(agent).toMatchObject({
      access: 'read-only',
      modelTier: 'balanced',
      joins: 'review',
      requires: [],
    });
    expect(agent.stage).toBeUndefined();
  });

  it.each([
    'List the files in {{rules-location}}',
    'A folder that does not exist has none',
    'this includes the case where no pack is installed',
    'Do not report code the change did not touch',
    "the project's convention wins",
    'formatter or linter',
    'quote the rule',
    '**Standards used**',
    '**Not covered**',
    'Not your own preferences',
  ])('says: %s', (phrase) => {
    expect(agent.body).toContain(phrase);
  });

  it('uses no placeholder other than the rules location', () => {
    expect(agent.body.match(/\{\{[^{}]*\}\}/g)).toEqual(['{{rules-location}}']);
  });
});

describe('installed for each harness', () => {
  const io = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture() };
  const targets = Object.keys(adapters);
  const code = main(['add', 'standards-reviewer', '--target', targets.join(',')], io);

  it.each(targets)('%s names only its own rules folder', (target) => {
    expect(code).toBe(0);
    const { agentDirs, rulesLocation } = adapters[target];
    const extension = target === 'codex' ? 'toml' : 'md';
    const raw = readFileSync(
      join(io.cwd, agentDirs.project, `standards-reviewer.${extension}`),
      'utf8'
    );
    const text = target === 'codex' ? parseToml(raw).developer_instructions : raw;
    expect(text).toContain(`List the files in ${rulesLocation}.`);
    expect(text).not.toContain('{{');
    for (const other of targets.filter((name) => name !== target)) {
      expect(text, `${target} names ${other}`).not.toContain(adapters[other].rulesLocation);
    }
  });
});

describe('flows', () => {
  it.each(['forge-quick', 'forge-full'])('%s names five review specialists in order', (flow) => {
    const { body } = catalog.get(`skill:${flow}`);
    expect(body).toContain('Five optional agents each review one subject');
    expect(body).not.toContain('Four optional agents');
    const positions = ORDER.map((name) => body.indexOf(`\`${name}\``));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(catalog.get(`skill:${flow}`).requires).not.toContain('agent:standards-reviewer');
  });
});
