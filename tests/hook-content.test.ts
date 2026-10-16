import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));

describe('shipped gates', () => {
  it.each([
    ['approval-gate', ['shell', 'write', 'prompt']],
    ['secret-guard', ['write']],
    ['protected-paths', ['write']],
    ['test-reminder', ['shell', 'write', 'stop']],
  ])('%s declares the events it handles', (name, events) => {
    const hook = catalog.get(`hook:${name}`);
    expect(hook.events).toEqual(events);
    expect(hook.requires).toEqual(['runtime:hooks']);
    expect(hook.gate).toContain('export function check(event, ctx)');
    expect(hook.gate).not.toMatch(/from '\.\.?\//);
  });

  it('ships exactly four gates, one memory hook and one runtime', () => {
    const hooks = [...catalog.values()].filter((item) => item.type === 'hook');
    expect(hooks.filter((hook) => hook.group === undefined)).toHaveLength(4);
    expect(hooks.filter((hook) => hook.group === 'memory').map((hook) => hook.name)).toEqual([
      'session-memory',
    ]);
    const types = [...catalog.values()].map((item) => item.type);
    expect(types.filter((type) => type === 'runtime')).toHaveLength(1);
  });

  it('session-memory handles the session events and imports only node built-ins', () => {
    const hook = catalog.get('hook:session-memory');
    expect(hook.events).toEqual(['start', 'compact', 'write', 'prompt']);
    expect(hook.requires).toEqual(['runtime:hooks']);
    expect(hook.gate).toContain('export function check(event, ctx)');
    const imports = [...hook.gate.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.every((specifier) => specifier.startsWith('node:'))).toBe(true);
  });

  it('shipped runtime code has no shebang and imports only node built-ins', () => {
    const { sources } = catalog.get('runtime:hooks');
    for (const [file, source] of Object.entries(sources)) {
      expect(source.startsWith('#!'), file).toBe(false);
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const specifier of imports)
        expect(specifier.startsWith('node:'), `${file}: ${specifier}`).toBe(true);
    }
  });
});

describe('flow skills and the approval gate', () => {
  it.each([
    ['forge-full', 'current stage: HUMAN_APPROVAL'],
    ['forge-quick', 'current stage: SHIP'],
  ])('%s sets the state the gate looks for, and asks for approve', (name, stage) => {
    const { body } = catalog.get(`skill:${name}`);
    expect(body).toContain('status: waiting for user');
    expect(body).toContain(stage);
    expect(body).toContain('reply with exactly `approve`');
    expect(body).toContain('decision: approved');
    expect(body).toContain('no bullets, backticks or other formatting');
  });

  it('deployer accepts the recorded approval line', () => {
    expect(catalog.get('agent:deployer').body).toContain('`decision: approved`');
  });
});
