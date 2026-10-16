import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

describe('README', () => {
  const readme = read('README.md');

  it('explains session memory, how to install it and what it stores', () => {
    for (const phrase of [
      '## Session memory',
      'wishforge add --memory --target',
      '`session-memory`',
      '`forge-handoff`',
      '`forge-lesson`',
      '.wishforge/memory/lessons.md',
      '.wishforge/local/session.md',
      '.wishforge/local/handoff.md',
    ]) {
      expect(readme, phrase).toContain(phrase);
    }
  });

  it('states the limits a user needs before relying on it', () => {
    for (const phrase of [
      'last three prompts',
      '[redacted]',
      'Cursor cannot',
      'wishforge update',
      'never deletes',
      'per project',
    ]) {
      expect(readme, phrase).toContain(phrase);
    }
  });

  it('says --hooks means the quality gates only', () => {
    expect(readme).toContain('`--hooks` installs the four quality gates');
  });
});

describe('verification checklist', () => {
  const checks = read('docs/verification.md');

  it('keeps the earlier checks and adds the memory ones', () => {
    for (const number of [1, 24, 31, 40, 41, 50]) {
      expect(checks, `check ${number}`).toMatch(new RegExp(`^\\| ${number} \\|`, 'm'));
    }
    expect(checks).toContain('## Session memory');
  });
});
