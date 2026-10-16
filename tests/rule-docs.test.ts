import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const rules = [...catalog.values()].filter((item) => item.type === 'rule');

describe('README', () => {
  const readme = read('README.md');

  it.each(rules.map((rule) => rule.name))('lists the rules pack %s', (name) => {
    expect(readme).toMatch(new RegExp(`^\\| \`${name}\` +\\|`, 'm'));
  });

  it('says how to install a pack and where each harness keeps it', () => {
    expect(readme).toContain('## Rules packs');
    expect(readme).toContain('wishforge add common typescript --target');
    for (const path of [
      '.claude/rules/wishforge/',
      '.cursor/rules/wishforge-',
      '.codex/wishforge/rules/',
      '.opencode/wishforge/rules/',
      'AGENTS.md',
      'opencode.json',
    ]) {
      expect(readme, path).toContain(path);
    }
  });

  it('states the limits a user needs before relying on rules', () => {
    for (const phrase of [
      'AGENTS.override.md',
      'opencode.jsonc',
      'wishforge:rules:start',
      'not available with `--global` on Cursor',
    ]) {
      expect(readme, phrase).toContain(phrase);
    }
  });

  it('explains how to add a rule to the catalog', () => {
    expect(readme).toContain('catalog/rules/<name>.md');
    expect(readme).toContain('`{{rules-location}}`');
  });
});

describe('verification checklist', () => {
  const checks = read('docs/verification.md');

  it('keeps the earlier checks and adds the rules ones', () => {
    for (const number of [1, 10, 11, 24, 25, 31, 32, 38]) {
      expect(checks, `check ${number}`).toMatch(new RegExp(`^\\| ${number} \\|`, 'm'));
    }
    expect(checks).toContain('## Rules packs');
    expect(checks).toContain('07-review-standards-reviewer.md');
  });
});
