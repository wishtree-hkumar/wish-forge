import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { add } from '../src/ops.js';
import { tmpDir, writeTree } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const MAP =
  '# Project map\n\nGenerated 2026-10-10 at commit abc1234 by forge-map. Check it against the code before relying on it.\n\n## Purpose\nA CLI that installs agents.\n';

describe('forge-map', () => {
  const { body } = catalog.get('skill:forge-map');

  it('says when the map was made from uncommitted changes', () => {
    expect(body).toContain('plus uncommitted changes');
    expect(body).toContain(
      'Generated YYYY-MM-DD at commit <short hash> plus uncommitted changes by forge-map.'
    );
  });
});

describe('the README', () => {
  it('says Codex cannot be stopped from starting forge-map on its own', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    expect(readme).toContain('Codex has no setting that stops a model from starting a skill');
  });
});

describe.each([
  ['codex', '.codex', { hook_event_name: 'SessionStart', source: 'startup', session_id: 's-1' }],
  ['cursor', '.cursor', { hook_event_name: 'sessionStart', session_id: 'c-1' }],
])('installed runner on %s', (harness, dir, payload) => {
  it('hands a new session the map', () => {
    const cwd = writeTree(tmpDir(), { '.forgeflow/memory/map.md': MAP });
    add(
      {
        catalog,
        version: '0.1.0',
        scope: 'project',
        cwd,
        home: tmpDir(),
        force: false,
        dryRun: false,
      },
      ['session-memory'],
      [harness]
    );
    const result = spawnSync(process.execPath, [join(cwd, dir, 'forgeflow/run.mjs'), harness], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      cwd,
    });
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    const context =
      harness === 'cursor' ? out.additional_context : out.hookSpecificOutput.additionalContext;
    expect(context).toContain('## Project map (from .forgeflow/memory/map.md)');
    expect(context).toContain('> A CLI that installs agents.');
  });
});
