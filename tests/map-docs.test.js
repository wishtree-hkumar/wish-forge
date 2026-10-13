import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

describe('README', () => {
  const readme = read('README.md');

  it('explains the project map and how to make one', () => {
    for (const phrase of [
      '### The project map',
      '`forge-map`',
      '`mapper`',
      '.forgeflow/memory/map.md',
      'more than 30 days old',
      'Where things live',
    ]) {
      expect(readme, phrase).toContain(phrase);
    }
  });

  it('states the limits of a map', () => {
    for (const phrase of [
      'reading of the code and can be wrong',
      'never their values',
      'One map per project',
      'only when you run `forge-map`',
    ]) {
      expect(readme, phrase).toContain(phrase);
    }
  });
});

describe('verification checklist', () => {
  const checks = read('docs/verification.md');

  it('keeps the earlier checks and adds the map ones', () => {
    for (const number of [1, 40, 53, 54, 58]) {
      expect(checks, `check ${number}`).toMatch(new RegExp(`^\\| ${number} \\|`, 'm'));
    }
    expect(checks).toContain('## Project map');
  });
});
