import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { check } from '../catalog/hooks/session-memory/gate.mjs';
import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { add } from '../src/ops.js';
import { capture, ruleMd, tmpDir, writeTree } from './helpers.js';
import { hookTree, runtimeTree } from './hook-helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const T0 = Date.parse('2026-10-13T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const ctx = (root, extra = {}) => ({
  root,
  harness: 'claude',
  session: 's-1',
  now: T0,
  run: null,
  runs: [],
  config: {},
  ...extra,
});
const write = (path) => ({ kind: 'write' as const, path, content: 'x' });
const record = (root) =>
  JSON.parse(readFileSync(join(root, '.wishforge/local/session.json'), 'utf8'));
const readable = (root) => readFileSync(join(root, '.wishforge/local/session.md'), 'utf8');

describe('hook calls at the same moment', () => {
  it('all land in the record', async () => {
    const cwd = tmpDir();
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
      ['claude']
    );
    const runner = join(cwd, '.claude/wishforge/run.mjs');
    const fire = (i) =>
      new Promise((done) => {
        const child = spawn(process.execPath, [runner, 'claude'], { cwd });
        child.on('close', done);
        child.stdin.end(
          JSON.stringify({
            hook_event_name: 'PreToolUse',
            tool_name: 'Write',
            tool_input: { file_path: join(cwd, `src/f${i}.js`), content: 'x' },
            cwd,
            session_id: 's-1',
          })
        );
      });
    await Promise.all(Array.from({ length: 12 }, (_, i) => fire(i)));
    expect(record(cwd).current.files).toHaveLength(12);
    expect(readdirSync(join(cwd, '.wishforge/local')).sort()).toEqual([
      '.gitignore',
      'session.json',
      'session.md',
    ]);
  }, 20000);
});

describe('the record', () => {
  it('says when earlier files were left out', () => {
    const root = tmpDir();
    for (let i = 1; i <= 33; i += 1) check(write(`src/f${i}.js`), ctx(root));
    expect(record(root).current.more).toBe(true);
    expect(readable(root)).toContain('- and more files written earlier, not listed');
  });

  it('says the files are those the agent set out to change', () => {
    const root = tmpDir();
    check(write('src/a.js'), ctx(root));
    expect(readable(root)).toContain('Files the agent set out to change:\n- src/a.js');
  });

  it('does not let a clock that moved back keep one session forever', () => {
    const root = tmpDir();
    const anon = (now) => ctx(root, { session: '', now });
    check(write('src/a.js'), anon(T0 + 5 * HOUR));
    check(write('src/b.js'), anon(T0));
    expect(record(root)).toMatchObject({
      current: { files: ['src/b.js'] },
      previous: { files: ['src/a.js'] },
    });
  });

  it('treats a handoff note dated in the future as stale', () => {
    const root = tmpDir();
    writeTree(root, { '.wishforge/local/handoff.md': 'note\n' });
    const later = new Date(T0 + 30 * 24 * HOUR);
    utimesSync(join(root, '.wishforge/local/handoff.md'), later, later);
    expect(check({ kind: 'start', source: 'startup' }, ctx(root))).toBeUndefined();
  });

  it('puts the ignore rule back when the folder’s .gitignore lost it', () => {
    const root = tmpDir();
    writeTree(root, { '.wishforge/local/.gitignore': '!keep.md\n' });
    check(write('src/a.js'), ctx(root));
    expect(readFileSync(join(root, '.wishforge/local/.gitignore'), 'utf8')).toBe('*\n!keep.md\n');
  });

  it('leaves no temporary file behind when it cannot save', () => {
    const root = tmpDir();
    writeTree(root, { '.wishforge/local/session.json/x': '' });
    check(write('src/a.js'), ctx(root));
    check(write('src/b.js'), ctx(root));
    expect(readdirSync(join(root, '.wishforge/local')).filter((f) => f.includes('tmp'))).toEqual(
      []
    );
  });
});

describe('removing memory from OpenCode while rules stay', () => {
  it('reports the config as updated, not wired', () => {
    const cwd = tmpDir();
    const catalogDir = writeTree(tmpDir(), {
      ...runtimeTree(),
      ...hookTree('session-memory', '[start, compact, write, prompt]'),
      'rules/common.md': ruleMd('common'),
    });
    const run = (...argv) => {
      const stdout = capture();
      main(argv, { cwd, home: tmpDir(), stdout, stderr: capture(), catalogDir });
      return stdout.text;
    };
    run('add', 'common', 'session-memory', '--target', 'opencode');
    const out = run('remove', 'session-memory', '--target', 'opencode');
    expect(out).toMatch(/updated\s+opencode\.json/);
    expect(out).not.toMatch(/\bwired\s+opencode\.json/);
  });
});

describe('the memory commands', () => {
  it.each(['forge-lesson', 'forge-handoff', 'forge-map'])(
    '%s brings the hook that loads what it writes',
    (name) => {
      expect(catalog.get(`skill:${name}`).requires).toContain('hook:session-memory');
      const io = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture() };
      expect(main(['add', name, '--target', 'claude'], io)).toBe(0);
      expect(existsSync(join(io.cwd, '.claude/wishforge/gates/session-memory.mjs'))).toBe(true);
    }
  );

  it('cannot be installed where the hook cannot, with --global', () => {
    const io = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture() };
    expect(main(['add', 'forge-lesson', '--target', 'claude', '--global'], io)).toBe(2);
    expect(existsSync(join(io.home, '.claude'))).toBe(false);
  });
});
