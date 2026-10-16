import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const specialists = [...catalog.values()].filter(
  (item) => item.type === 'agent' && item.stage === undefined
);

describe('README', () => {
  const readme = read('README.md');

  it.each(specialists.map((agent) => agent.name))('lists the specialist %s', (name) => {
    expect(readme).toContain(`\`${name}\``);
  });

  it('shows how to install specialists and what the flows do with them', () => {
    expect(readme).toContain('wishforge add --specialists --target');
    expect(readme).toContain('07-review-');
    expect(readme).toContain('`joins: review`');
    expect(readme).toContain('`{{agents-dir}}`');
  });
});

describe('verification checklist', () => {
  const checks = read('docs/verification.md');

  it('keeps the earlier checks and adds the specialist ones', () => {
    for (const number of [1, 10, 11, 24, 25, 30]) {
      expect(checks, `check ${number}`).toMatch(new RegExp(`^\\| ${number} \\|`, 'm'));
    }
    expect(checks).toContain('## Specialists');
    expect(checks).toContain('07-review-security-reviewer.md');
  });
});
