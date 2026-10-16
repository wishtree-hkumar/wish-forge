import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adapters } from '../src/adapters/index.js';
import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { CatalogError } from '../src/errors.js';
import { agentMd, capture, tmpDir, writeTree } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const FLOWS = ['forge-quick', 'forge-full'];
const body = (id) => catalog.get(id).body;

describe('flows and review specialists', () => {
  it.each(FLOWS)('%s says a specialist that cannot be run may need a session restart', (flow) => {
    expect(body(`skill:${flow}`)).toContain(
      'it was probably installed after this session started: tell the user that restarting the session loads it'
    );
  });

  it.each(FLOWS)('%s removes a report left by a specialist that is no longer installed', (flow) => {
    expect(body(`skill:${flow}`)).toContain(
      'delete any `07-review-<agent name>.md` in the run directory whose specialist is not installed now'
    );
    expect(body(`skill:${flow}`)).toContain('not installed, earlier report removed');
  });

  it.each(FLOWS)('%s shows the specialists’ notes for the person who approves', (flow) => {
    expect(body(`skill:${flow}`)).toContain(
      'the Rollout notes, Not checked, Measurements wanted and Needs a manual check sections'
    );
  });

  it('docs-writer may change documentation comments and nothing executable', () => {
    const text = body('agent:docs-writer');
    expect(text).toContain('Documentation comments in source files are documentation');
    expect(text).toContain('Do not change executable code');
  });
});

describe('placeholders with the wrong number of braces', () => {
  const load = (text) =>
    loadCatalog(writeTree(tmpDir(), { 'agents/a.md': agentMd('a').replace('Body of a.', text) }));

  it.each([
    '{agents-dir}',
    '{{agents-dir}',
    '{agents-dir}}',
    '{rules-location}',
    '{global-agents-dir}}',
  ])('are refused: %s', (token) => {
    expect(() => load(`Look in ${token}.`)).toThrow(CatalogError);
    expect(() => load(`Look in ${token}.`)).toThrow(`unknown placeholder ${token}`);
  });

  it('do not catch single braces around anything else', () => {
    expect(load('Use {config} and {{agents-dir}}.').get('agent:a').body).toContain('{config}');
  });
});

describe('specialists on every harness', () => {
  const specialists = [...catalog.values()].filter(
    (item) => item.type === 'agent' && item.stage === undefined
  );

  it.each(Object.keys(adapters))(
    '%s: a global install lands in its user agents folder',
    (target) => {
      const io = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture() };
      expect(main(['add', 'security-reviewer', '--target', target, '--global'], io)).toBe(0);
      const folder = join(io.home, adapters[target].agentDirs.global.replace(/^~\//, ''));
      const names = readdirSync(folder).map((file) => file.replace(/\.(md|toml)$/, ''));
      expect(names).toEqual(['security-reviewer']);
    }
  );

  it.each(Object.keys(adapters))(
    '%s: removing every specialist leaves nothing behind',
    (target) => {
      const io = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture() };
      main(['add', '--specialists', '--target', target], io);
      const ids = specialists.map((agent) => agent.name);
      expect(main(['remove', ...ids, '--target', target], { ...io, stdout: capture() })).toBe(0);
      expect(existsSync(join(io.cwd, adapters[target].agentDirs.project))).toBe(false);
    }
  );
});
