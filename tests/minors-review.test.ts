import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { check as memory } from '../catalog/hooks/session-memory/gate.mjs';
import { check as testReminder } from '../catalog/hooks/test-reminder/gate.mjs';
import { loadCatalog } from '../src/catalog';
import { main } from '../src/cli';
import { CatalogError } from '../src/errors';
import { agentMd, capture, tmpDir, writeTree } from './helpers';

const real = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
let cwd;
let home;
const run = (...argv) => {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { cwd, home, stdout, stderr });
  return { code, out: stdout.text, err: stderr.text };
};
const lockOf = (base) => JSON.parse(readFileSync(join(base, '.wishforge/lock.json'), 'utf8'));

beforeEach(() => {
  cwd = tmpDir();
  home = tmpDir();
});

describe('update', () => {
  it('refreshes what is installed and adds nothing newly required', () => {
    // An install from before the memory commands required the hook.
    run('add', 'forge-lesson', '--target', 'claude');
    run('remove', 'forge-lesson', '--target', 'claude');
    writeTree(cwd, {
      '.claude/skills/forge-lesson/SKILL.md': 'old\n',
      '.wishforge/lock.json': JSON.stringify({
        version: 1,
        wishforge: '0.1.0',
        targets: {
          claude: {
            items: {
              'skill:forge-lesson': {
                explicit: true,
                files: [{ path: '.claude/skills/forge-lesson/SKILL.md', sha256: 'x' }],
              },
            },
          },
        },
      }),
    });
    const { code, err } = run('update', '--force');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(existsSync(join(cwd, '.claude/wishforge'))).toBe(false);
    expect(existsSync(join(cwd, '.claude/settings.json'))).toBe(false);
    expect(Object.keys(lockOf(cwd).targets.claude.items)).toEqual(['skill:forge-lesson']);
  });

  it('still works on a global install of a memory command made before it required the hook', () => {
    writeTree(home, {
      '.claude/skills/forge-lesson/SKILL.md': 'old\n',
      '.wishforge/lock.json': JSON.stringify({
        version: 1,
        wishforge: '0.1.0',
        targets: {
          claude: {
            items: {
              'skill:forge-lesson': {
                explicit: true,
                files: [{ path: '.claude/skills/forge-lesson/SKILL.md', sha256: 'x' }],
              },
            },
          },
        },
      }),
    });
    const { code, err } = run('update', '--global', '--force');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(readFileSync(join(home, '.claude/skills/forge-lesson/SKILL.md'), 'utf8')).toContain(
      'record a lesson'
    );
  });

  it('names the hook when a memory command is added with --global', () => {
    const { code, err } = run('add', 'forge-lesson', '--target', 'claude', '--global');
    expect(code).toBe(2);
    expect(err).toContain(
      'skill:forge-lesson requires hook:session-memory, which is installed per project only'
    );
  });
});

describe('a hook config link', () => {
  it('that dangles does not stop the gates from being removed', () => {
    run('add', '--hooks', '--target', 'claude');
    const settings = join(cwd, '.claude/settings.json');
    rmSync(settings);
    symlinkSync('/nonexistent/x.json', settings);
    expect(run('status').out).toMatch(/wiring missing/);
    expect(run('remove', '--hooks', '--target', 'claude').code).toBe(0);
    expect(existsSync(join(cwd, '.claude/wishforge'))).toBe(false);
  });

  it('to a file outside the project is left alone on removal, with what to take out', () => {
    run('add', '--hooks', '--target', 'claude');
    const outside = join(tmpDir(), 'settings.json');
    writeFileSync(outside, readFileSync(join(cwd, '.claude/settings.json')));
    rmSync(join(cwd, '.claude/settings.json'));
    symlinkSync(outside, join(cwd, '.claude/settings.json'));
    const { code, out } = run('remove', '--hooks', '--target', 'claude');
    expect(code).toBe(0);
    expect(out).toMatch(/by hand\s+\.claude\/settings\.json/);
    expect(out).toContain('.claude/wishforge/run.mjs');
  });
});

describe('remove --specialists', () => {
  it('keeps a specialist that another installed item requires, and says so', () => {
    run('add', '--memory', '--target', 'claude');
    run('add', '--specialists', '--target', 'claude');
    const { code, out } = run('remove', '--specialists', '--target', 'claude');
    expect(code).toBe(0);
    expect(out).toContain('agent:mapper is kept: skill:forge-map requires it');
    expect(existsSync(join(cwd, '.claude/agents/mapper.md'))).toBe(true);
    expect(existsSync(join(cwd, '.claude/agents/security-reviewer.md'))).toBe(false);
  });

  it('prints nothing for a target where none of the members is installed', () => {
    run('add', '--hooks', '--target', 'claude');
    const { code, out } = run('remove', '--hooks', '--target', 'claude,codex');
    expect(code).toBe(0);
    expect(out).not.toMatch(/^codex /m);
  });
});

describe('test-reminder', () => {
  const ctx = () => {
    let value = {};
    return {
      config: { testCommands: [] },
      session: 's-1',
      state: { get: () => value, set: (next) => (value = next) },
    };
  };
  const after = (command) => {
    const c = ctx();
    testReminder({ kind: 'write', path: 'src/a.js', content: 'x' }, c);
    testReminder({ kind: 'shell', command }, c);
    return testReminder({ kind: 'stop' }, c);
  };

  it.each([
    'env FOO=1 npm test',
    'sudo npm test',
    'time npm test',
    'timeout 600 npm test',
    'nice -n 10 npm test',
    'npx -y vitest run',
    'npx --yes jest',
    'npm exec vitest',
    'python3.12 -m pytest',
    'py -m pytest',
    '.venv/bin/pytest',
    'uvx pytest',
    'cross-env CI=1 jest',
    'docker compose run app pytest',
    'php vendor/bin/phpunit',
    'bash -lc "npm test"',
    "sh -c 'npm test'",
    'npm --prefix web test',
    'pnpm -r test',
    'pnpm --filter web test',
    'yarn workspace web test',
    'turbo run test',
    'nx test',
    'deno test',
    'tox',
    'php artisan test',
    'rails test',
    'bundle exec rake test',
    'npm t',
    'npx playwright test',
  ])('counts %j as a test run', (command) => {
    expect(after(command)).toBeUndefined();
  });

  it.each([
    'git commit -m "fix | pytest flake"',
    "echo 'npm test' > notes.txt",
    'npm install',
    'pnpm -r build',
  ])('does not count %j as a test run', (command) => {
    expect(after(command)?.note).toContain('test-reminder');
  });
});

describe('the react pack', () => {
  it('reaches hook files and not every file that starts with "use"', () => {
    expect(real.get('rule:react').paths).toEqual([
      '**/*.tsx',
      '**/*.jsx',
      '**/use[A-Z]*.ts',
      '**/use[A-Z]*.js',
    ]);
  });
});

describe('the session record', () => {
  const T0 = Date.parse('2026-10-13T09:00:00.000Z');
  const ctx = (root) => ({
    root,
    harness: 'claude',
    session: 's-1',
    now: T0,
    run: null,
    runs: [],
    config: {},
  });

  it('says more files were written without a count it cannot keep right', () => {
    const root = tmpDir();
    for (let i = 1; i <= 31; i += 1)
      memory({ kind: 'write', path: `src/f${i}.js`, content: '' }, ctx(root));
    memory({ kind: 'write', path: 'src/f1.js', content: '' }, ctx(root));
    const text = readFileSync(join(root, '.wishforge/local/session.md'), 'utf8');
    expect(text).toContain('- and more files written earlier, not listed');
    expect(text).not.toMatch(/and \d+ earlier files/);
  });
});

describe('a full uninstall after the gates have run', () => {
  it('leaves no .wishforge folder behind', async () => {
    run('add', 'test-reminder', '--target', 'claude');
    const { evaluate, loadGates } = await import(join(cwd, '.claude/wishforge/runtime.mjs'));
    const gates = await loadGates(join(cwd, '.claude/wishforge/gates'));
    evaluate({
      harness: 'claude',
      payload: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(cwd, 'a.js'), content: 'x' },
        cwd,
      },
      root: cwd,
      gates,
    });
    expect(existsSync(join(cwd, '.wishforge/local/gate-state.json'))).toBe(true);
    expect(run('remove', 'test-reminder', '--target', 'claude').code).toBe(0);
    expect(existsSync(join(cwd, '.wishforge'))).toBe(false);
  });
});

describe('placeholders with extra braces', () => {
  it.each(['{{{agents-dir}}}', '{{{agents-dir}}', '{{agents-dir}}}'])(
    'are refused: %s',
    (token) => {
      const dir = writeTree(tmpDir(), {
        'agents/a.md': agentMd('a').replace('Body of a.', `See ${token}.`),
      });
      expect(() => loadCatalog(dir)).toThrow(CatalogError);
    }
  );
});

describe('the flows', () => {
  it.each(['forge-quick', 'forge-full'])(
    '%s clears stale reports even when no specialist is installed',
    (name) => {
      const { body } = real.get(`skill:${name}`);
      expect(body).toContain('Before running specialists, even when none is installed now');
      expect(body).toContain('This record is not mentioning a skipped specialist');
    }
  );
});

describe('status of an OpenCode config linked from outside', () => {
  it('says missing, not unreadable, when it was read and lacks the entries', () => {
    const target = join(tmpDir(), 'opencode.json');
    writeFileSync(target, `{\n  "instructions": [".opencode/wishforge/rules/*.md"]\n}\n`);
    symlinkSync(target, join(cwd, 'opencode.json'));
    run('add', 'common', '--target', 'opencode');
    writeFileSync(target, '{\n  "instructions": []\n}\n');
    expect(run('status').out).toMatch(/rules missing\s+opencode\.json/);
  });
});
