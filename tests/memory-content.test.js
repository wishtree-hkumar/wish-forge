import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { capture, tmpDir } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const body = (name) => catalog.get(`skill:${name}`).body;
const HARNESS_TOOL =
  /`(Edit|Write|Read|Grep|Glob|Bash|Task|MultiEdit|TodoWrite|apply_patch|str_replace)`|\b(apply_patch|MultiEdit|TodoWrite|str_replace)\b/;

describe('the memory group', () => {
  it('is the hook and the three skills', () => {
    const group = [...catalog.values()].filter((item) => item.group === 'memory');
    expect(group.map((item) => item.id).sort()).toEqual([
      'hook:session-memory',
      'skill:forge-handoff',
      'skill:forge-lesson',
      'skill:forge-map',
    ]);
  });

  it.each(['forge-lesson', 'forge-handoff'])('%s may be followed without being asked', (name) => {
    const skill = catalog.get(`skill:${name}`);
    expect(skill.userInvocableOnly).toBe(false);
    expect(skill.requires).toEqual(['hook:session-memory']);
    expect(skill.description).toMatch(/\bUse when\b/);
    expect(skill.body).not.toMatch(HARNESS_TOOL);
  });
});

describe('forge-lesson', () => {
  it.each([
    '`.forgeflow/memory/lessons.md`',
    '# Project lessons',
    'When the user corrects you about this project',
    '- (YYYY-MM-DD)',
    'At most 200 characters',
    'will still be true next month',
    'not a secret',
    'replace that line',
    'more than 50 lessons',
    'Tell the user the exact line',
  ])('says: %s', (phrase) => {
    expect(body('forge-lesson')).toContain(phrase);
  });
});

describe('forge-handoff', () => {
  it.each([
    '`.forgeflow/local/handoff.md`',
    '`.forgeflow/local/.gitignore`',
    'the single line `*`',
    'at most 40 lines',
    '## Done',
    '## In progress',
    '## Next',
    '## Decisions',
    '## Open questions',
    'not what was intended',
    'Replace the whole note',
    'No secrets',
  ])('says: %s', (phrase) => {
    expect(body('forge-handoff')).toContain(phrase);
  });
});

describe('installing memory from the real catalog', () => {
  const io = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture() };
  const code = main(['add', '--memory', '--target', 'claude,codex,opencode,cursor'], io);
  const has = (path) => existsSync(join(io.cwd, path));
  const json = (path) => JSON.parse(readFileSync(join(io.cwd, path), 'utf8'));

  it('installs the hook and both skills for every harness', () => {
    expect(io.stderr.text).toBe('');
    expect(code).toBe(0);
    for (const dir of ['.claude', '.codex', '.cursor', '.opencode']) {
      expect(has(`${dir}/forgeflow/gates/session-memory.mjs`), dir).toBe(true);
    }
    for (const dir of ['.claude/skills', '.agents/skills', '.cursor/skills', '.opencode/skills']) {
      expect(readdirSync(join(io.cwd, dir)).sort(), dir).toEqual([
        'forge-handoff',
        'forge-lesson',
        'forge-map',
      ]);
    }
  });

  it('wires the session events and the OpenCode entries', () => {
    expect(json('.claude/settings.json').hooks.SessionStart).toHaveLength(1);
    expect(json('.codex/hooks.json').hooks.SessionStart).toHaveLength(1);
    expect(Object.keys(json('.cursor/hooks.json').hooks)).toContain('sessionStart');
    expect(json('opencode.json').instructions).toEqual([
      '.forgeflow/memory/*.md',
      '.forgeflow/local/*.md',
    ]);
    expect(has('AGENTS.md')).toBe(false);
  });

  it('is not part of --hooks', () => {
    const other = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture() };
    expect(main(['add', '--hooks', '--target', 'claude'], other)).toBe(0);
    expect(readdirSync(join(other.cwd, '.claude/forgeflow/gates')).sort()).toEqual([
      'approval-gate.mjs',
      'protected-paths.mjs',
      'secret-guard.mjs',
      'test-reminder.mjs',
    ]);
  });

  it('removes cleanly and leaves no forgeflow file behind', () => {
    const removal = { ...io, stdout: capture(), stderr: capture() };
    const ids = ['session-memory', 'forge-handoff', 'forge-lesson', 'forge-map'];
    expect(main(['remove', ...ids, '--target', 'claude,codex,opencode,cursor'], removal)).toBe(0);
    for (const path of ['.claude', '.codex', '.cursor', '.opencode', '.agents', 'opencode.json']) {
      expect(has(path), path).toBe(false);
    }
  });
});
