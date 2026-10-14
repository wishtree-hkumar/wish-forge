import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { readLock } from '../src/lock.js';
import { START, mergeBlock, stripBlock } from '../src/rules-wiring.js';
import { capture, ruleMd, tmpDir, writeTree } from './helpers.js';

let catalogDir;
let cwd;
let home;
const run = (...argv) => {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { cwd, home, stdout, stderr, catalogDir });
  return { code, out: stdout.text, err: stderr.text };
};
const read = (path, base = cwd) => readFileSync(join(base, path), 'utf8');
const ENTRY = '.opencode/forgeflow/rules/*.md';

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), { 'rules/common.md': ruleMd('common') });
  cwd = tmpDir();
  home = tmpDir();
});

describe('an AGENTS.md forgeflow cannot read', () => {
  it('is named in a clear message, with nothing written', () => {
    mkdirSync(join(cwd, 'AGENTS.md'));
    const { code, err } = run('add', 'common', '--target', 'codex');
    expect(code).toBe(1);
    expect(err).toContain('AGENTS.md cannot be read');
    expect(err).not.toContain('EISDIR: illegal');
  });
});

describe('an OpenCode config linked from outside the project', () => {
  const outside = () => {
    const dotfiles = tmpDir();
    return join(dotfiles, 'opencode.json');
  };

  it('is refused with the entry to add by hand, then accepted once it is there', () => {
    const target = outside();
    writeFileSync(target, '{\n  "model": "x"\n}\n');
    symlinkSync(target, join(cwd, 'opencode.json'));

    const refused = run('add', 'common', '--target', 'opencode');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('opencode.json is a symbolic link to a file outside the project');
    expect(refused.err).toContain(`add "${ENTRY}" to its "instructions" list by hand`);

    writeFileSync(target, `{\n  "model": "x",\n  "instructions": ["${ENTRY}"]\n}\n`);
    const accepted = run('add', 'common', '--target', 'opencode');
    expect(accepted.code).toBe(0);
    expect(accepted.out).toMatch(/by hand\s+opencode\.json/);
    expect(run('status').out).toMatch(/rules ok\s+opencode\.json/);

    const removed = run('remove', 'common', '--target', 'opencode');
    expect(removed.code).toBe(0);
    expect(removed.out).toContain(`remove "${ENTRY}" from its "instructions" list`);
    expect(read('opencode.json')).toContain(ENTRY);
  });

  it('says how to go on for an AGENTS.md linked from outside', () => {
    const target = join(tmpDir(), 'AGENTS.md');
    writeFileSync(target, '# Shared\n');
    symlinkSync(target, join(cwd, 'AGENTS.md'));
    const { code, err } = run('add', 'common', '--target', 'codex');
    expect(code).toBe(1);
    expect(err).toContain(
      'Replace the link with a regular file, or point it at a file inside the project'
    );
  });
});

describe('a block the user moved to the top of AGENTS.md', () => {
  it('leaves no blank line behind when it is removed', () => {
    const block = `${START}\n- x\n<!-- forgeflow:rules:end -->`;
    expect(stripBlock(`${block}\n\n# Mine\n`, 'AGENTS.md')).toBe('# Mine\n');
    expect(stripBlock(`\uFEFF${block}\n\n# Mine\n`, 'AGENTS.md')).toBe('\uFEFF# Mine\n');
    expect(stripBlock(mergeBlock(undefined, block, 'AGENTS.md'), 'AGENTS.md')).toBe('');
  });
});

describe('rule paths', () => {
  it.each([
    ['a comma', '**/*.{ts,tsx}'],
    ['a backtick', '**/`x`.ts'],
  ])('are refused when a pattern holds %s', (_case, pattern) => {
    const dir = writeTree(tmpDir(), { 'rules/r.md': ruleMd('r', `paths:\n  - "${pattern}"\n`) });
    expect(() => loadCatalog(dir)).toThrow('may not contain a comma or a backtick');
  });
});

describe('the shipped packs', () => {
  const real = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));

  it('typescript leaves CommonJS files alone', () => {
    expect(real.get('rule:typescript').body).toContain(
      'except in files that are CommonJS by design'
    );
  });

  it('react reaches hook files written in plain TypeScript or JavaScript', () => {
    expect(real.get('rule:react').paths).toEqual([
      '**/*.tsx',
      '**/*.jsx',
      '**/use*.ts',
      '**/use*.js',
    ]);
  });

  it('csharp does not rename what a framework names', () => {
    expect(real.get('rule:csharp').body).toContain('except where a framework sets the name');
  });
});

describe('the README', () => {
  it('says what happens to edits inside the block and to a deleted block', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    expect(readme).toContain('Text you change between the markers is replaced');
    expect(readme).toContain('a block you delete comes back');
  });
});

describe('ops level', () => {
  it('keeps a byte-order mark through add and remove', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '\uFEFF# Mine\n');
    run('add', 'common', '--target', 'codex');
    expect(read('AGENTS.md').startsWith('\uFEFF# Mine\n\n<!-- forgeflow')).toBe(true);
    run('remove', 'common', '--target', 'codex');
    expect(read('AGENTS.md')).toBe('\uFEFF# Mine\n');
  });

  it('removes the global Codex block and the global record', () => {
    writeTree(home, { '.codex/AGENTS.md': '# Mine\n' });
    run('add', 'common', '--target', 'codex', '--global');
    expect(read('.codex/AGENTS.md', home)).toContain('~/.codex/forgeflow/rules/common.md');
    expect(run('remove', 'common', '--target', 'codex', '--global').code).toBe(0);
    expect(read('.codex/AGENTS.md', home)).toBe('# Mine\n');
    expect(readLock(home).targets.codex).toBeUndefined();
  });
});
