import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { readLock } from '../src/lock.js';
import { END, START, handWired } from '../src/rules-wiring.js';
import { capture, ruleMd, tmpDir, writeTree } from './helpers.js';

let catalogDir;
let cwd;
let home;

function run(...argv) {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { cwd, home, stdout, stderr, catalogDir });
  return { code, out: stdout.text, err: stderr.text };
}
const read = (path) => readFileSync(join(cwd, path), 'utf8');
const mode = (path) => statSync(join(cwd, path)).mode & 0o777;
const ENTRY = '.opencode/forgeflow/rules/*.md';

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), {
    'rules/common.md': ruleMd('common'),
    'rules/ts.md': ruleMd('ts', 'paths:\n  - "**/*.ts"\n'),
  });
  cwd = tmpDir();
  home = tmpDir();
});

describe('file permissions', () => {
  it('keeps the mode of a config it rewrites', () => {
    writeFileSync(join(cwd, 'opencode.json'), '{"provider":{"key":"secret"}}');
    chmodSync(join(cwd, 'opencode.json'), 0o600);
    writeFileSync(join(cwd, 'AGENTS.md'), '# Mine\n');
    chmodSync(join(cwd, 'AGENTS.md'), 0o640);

    expect(run('add', 'common', '--target', 'codex,opencode').code).toBe(0);
    expect(mode('opencode.json')).toBe(0o600);
    expect(mode('AGENTS.md')).toBe(0o640);

    expect(run('remove', 'common', '--target', 'codex,opencode').code).toBe(0);
    expect(mode('opencode.json')).toBe(0o600);
    expect(mode('AGENTS.md')).toBe(0o640);
  });
});

describe('an OpenCode config wired by hand', () => {
  it.each([
    ['commented out', `{\n  // "instructions": ["${ENTRY}"]\n  "model": "x"\n}\n`],
    ['a string, not a list', `{\n  // mine\n  "instructions": "${ENTRY}"\n}\n`],
    ['under another key', `{\n  // mine\n  "other": ["${ENTRY}"]\n}\n`],
  ])('is not accepted when the entry is %s', (_case, text) => {
    expect(handWired(text, [ENTRY])).toBe(false);
    writeFileSync(join(cwd, 'opencode.json'), text);
    const { code, err } = run('add', 'common', '--target', 'opencode');
    expect(code).toBe(1);
    expect(err).toContain('opencode.json is not valid JSON');
    expect(existsSync(join(cwd, '.opencode'))).toBe(false);
  });

  it('is accepted with comments and trailing commas, and shown as by hand', () => {
    const text = `{\n  /* mine */\n  "model": "x", // why\n  "instructions": [\n    "a.md",\n    "${ENTRY}", // forgeflow\n  ],\n}\n`;
    expect(handWired(text, [ENTRY])).toBe(true);
    writeFileSync(join(cwd, 'opencode.jsonc'), text);

    const added = run('add', 'common', '--target', 'opencode');
    expect(added.code).toBe(0);
    expect(added.out).toMatch(/by hand\s+opencode\.jsonc/);
    expect(readLock(cwd).targets.opencode.rules).toEqual({
      path: 'opencode.jsonc',
      created: false,
      manual: true,
    });
    expect(run('status').out).toMatch(/^ {2}rules ok\s+opencode\.jsonc$/m);
    expect(run('doctor').code).toBe(0);

    const removed = run('remove', 'common', '--target', 'opencode');
    expect(removed.code).toBe(0);
    expect(removed.out).toMatch(/by hand\s+opencode\.jsonc/);
    expect(removed.out).toContain(`remove "${ENTRY}" from its "instructions" list`);
    expect(read('opencode.jsonc')).toBe(text);
  });

  it('is flagged by status and doctor when the user takes the entry out again', () => {
    const text = `{\n  // mine\n  "instructions": ["${ENTRY}"]\n}\n`;
    writeFileSync(join(cwd, 'opencode.json'), text);
    run('add', 'common', '--target', 'opencode');
    writeFileSync(join(cwd, 'opencode.json'), '{\n  // mine\n}\n');
    expect(run('status').out).toMatch(/^ {2}rules unreadable\s+opencode\.json$/m);
    expect(run('doctor').code).toBe(1);
  });
});

describe('removing rules after the config stopped parsing', () => {
  const broken = `{\n  // added later\n  "instructions": ["${ENTRY}"]\n}\n`;

  it('removes the last rule and says what to take out by hand', () => {
    run('add', 'common', '--target', 'opencode');
    writeFileSync(join(cwd, 'opencode.json'), broken);

    const { code, out } = run('remove', 'common', '--target', 'opencode');
    expect(code).toBe(0);
    expect(out).toMatch(/by hand\s+opencode\.json/);
    expect(out).toContain(`remove "${ENTRY}" from its "instructions" list`);
    expect(existsSync(join(cwd, '.opencode'))).toBe(false);
    expect(read('opencode.json')).toBe(broken);
  });

  it('behaves the same when another rule is removed first', () => {
    run('add', 'common', 'ts', '--target', 'opencode');
    writeFileSync(join(cwd, 'opencode.json'), broken);

    expect(run('remove', 'ts', '--target', 'opencode').code).toBe(0);
    expect(readLock(cwd).targets.opencode.rules).toMatchObject({ path: 'opencode.json' });

    const { code, out } = run('remove', 'common', '--target', 'opencode');
    expect(code).toBe(0);
    expect(out).toContain(`remove "${ENTRY}" from its "instructions" list`);
    expect(read('opencode.json')).toBe(broken);
  });
});

describe('markers the user only mentions', () => {
  it('are not taken for the block', () => {
    const mine = `# Notes\n\nforgeflow writes between \`${START}\` and \`${END}\`.\n`;
    writeFileSync(join(cwd, 'AGENTS.md'), mine);

    expect(run('add', 'common', '--target', 'codex').code).toBe(0);
    const text = read('AGENTS.md');
    expect(text.startsWith(`${mine}\n${START}\n`)).toBe(true);
    expect(text).toContain('- `.codex/forgeflow/rules/common.md`: all work');

    expect(run('remove', 'common', '--target', 'codex').code).toBe(0);
    expect(read('AGENTS.md')).toBe(mine);
  });

  it('do not block an install when only one is mentioned', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), `The block starts at \`${START}\`.\n`);
    expect(run('add', 'common', '--target', 'codex').code).toBe(0);
    expect(run('status').out).toMatch(/rules ok\s+AGENTS\.md/);
  });
});

describe('shipped content', () => {
  const real = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
  const body = (id) => real.get(id).body;

  it('packs govern code being added or changed, not untouched code', () => {
    expect(body('rule:common')).toContain('code you add or change');
    expect(body('rule:common')).toContain('Do not rewrite code a task does not touch');
  });

  it('php does not tell the model to add strict_types to existing files', () => {
    expect(body('rule:php')).toContain(
      'New PHP source files start with `declare(strict_types=1);`'
    );
    expect(body('rule:php')).toContain('Do not add it to an existing file or to a template');
    expect(body('rule:php')).not.toContain('Start every file with');
  });

  it('angular reaches files named without the old suffixes', () => {
    expect(real.get('rule:angular').paths).toEqual(['**/*.ts', '**/*.html']);
    expect(body('rule:angular')).toContain('These apply only in an Angular project');
  });

  it('vue allows destructured props where they stay reactive', () => {
    expect(body('rule:vue')).toContain('Vue 3.5 or later');
  });

  it('common does not tell the model to keep harness folders out of version control', () => {
    expect(body('rule:common')).toContain('personal editor settings');
  });

  it('standards-reviewer treats a pack with no stated coverage as covering all work', () => {
    const text = body('agent:standards-reviewer');
    expect(text).toContain('A pack with none of these covers all work.');
    expect(text.indexOf('List the files in')).toBeLessThan(
      text.indexOf('this includes the case where no pack is installed')
    );
  });
});
