import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { readLock } from '../src/lock.js';
import { status } from '../src/ops.js';
import { END, START } from '../src/rules-wiring.js';
import { agentMd, capture, ruleMd, tmpDir, writeTree } from './helpers.js';

let catalogDir;
let cwd;
let home;

function run(...argv) {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { cwd, home, stdout, stderr, catalogDir });
  return { code, out: stdout.text, err: stderr.text };
}
const read = (path, base = cwd) => readFileSync(join(base, path), 'utf8');
const has = (path, base = cwd) => existsSync(join(base, path));
const TS = ruleMd('ts', 'paths:\n  - "**/*.ts"\n');
const ENTRY = '.opencode/wishforge/rules/*.md';
const LINE = {
  common: '- `.codex/wishforge/rules/common.md`: all work',
  ts: '- `.codex/wishforge/rules/ts.md`: files matching `**/*.ts`',
};

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), {
    'agents/alpha.md': agentMd('alpha'),
    'rules/common.md': ruleMd('common'),
    'rules/ts.md': TS,
  });
  cwd = tmpDir();
  home = tmpDir();
});

describe('codex', () => {
  it('creates AGENTS.md with a block listing the rule', () => {
    const { code, out, err } = run('add', 'common', '--target', 'codex');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toMatch(/create\s+\.codex\/wishforge\/rules\/common\.md/);
    expect(out).toMatch(/wired\s+AGENTS\.md/);

    const text = read('AGENTS.md');
    expect(text.startsWith(`${START}\n## Coding standards\n\n`)).toBe(true);
    expect(text).toContain('read each file below that applies to the files you are working on');
    expect(text).toContain(`\n${LINE.common}\n${END}\n`);
    expect(readLock(cwd).targets.codex.rules).toEqual({ path: 'AGENTS.md', created: true });
  });

  it('lists every installed rule in name order, and shrinks on remove', () => {
    run('add', 'ts', '--target', 'codex');
    run('add', 'common', '--target', 'codex');
    expect(read('AGENTS.md')).toContain(`\n${LINE.common}\n${LINE.ts}\n${END}\n`);

    const { out } = run('remove', 'ts', '--target', 'codex');
    expect(out).toMatch(/updated\s+AGENTS\.md/);
    expect(read('AGENTS.md')).toContain(`\n\n${LINE.common}\n${END}\n`);
    expect(read('AGENTS.md')).not.toContain('ts.md');
    expect(has('.codex/wishforge/rules/ts.md')).toBe(false);
    expect(readLock(cwd).targets.codex.rules).toEqual({ path: 'AGENTS.md', created: true });
  });

  it('deletes an AGENTS.md it created when the last rule goes', () => {
    run('add', 'common', '--target', 'codex');
    const { code, out } = run('remove', 'common', '--target', 'codex');
    expect(code).toBe(0);
    expect(out).toMatch(/delete\s+AGENTS\.md/);
    expect(has('AGENTS.md')).toBe(false);
    expect(has('.wishforge/lock.json')).toBe(false);
  });

  it('keeps the user text byte for byte through add and remove', () => {
    const mine = '# My project\r\n\r\nUse tabs.\r\n';
    writeFileSync(join(cwd, 'AGENTS.md'), mine);
    run('add', 'common', 'ts', '--target', 'codex');
    expect(read('AGENTS.md').startsWith(`${mine}\r\n${START}\r\n`)).toBe(true);
    expect(readLock(cwd).targets.codex.rules.created).toBe(false);

    run('remove', 'common', 'ts', '--target', 'codex');
    expect(read('AGENTS.md')).toBe(mine);
  });

  it('keeps an AGENTS.md it created if the user wrote in it since', () => {
    run('add', 'common', '--target', 'codex');
    writeFileSync(join(cwd, 'AGENTS.md'), `${read('AGENTS.md')}\nMine.\n`);
    expect(run('remove', 'common', '--target', 'codex').out).toMatch(/unwired\s+AGENTS\.md/);
    // The block was at the top, so the blank line after it goes with it.
    expect(read('AGENTS.md')).toBe('Mine.\n');
  });

  it('reports unchanged when nothing in the block changes', () => {
    run('add', 'common', '--target', 'codex');
    expect(run('add', 'common', '--target', 'codex').out).toMatch(/unchanged\s+AGENTS\.md/);
    expect(run('add', 'alpha', '--target', 'codex').out).toMatch(/unchanged\s+AGENTS\.md/);
  });

  it('refreshes the block on update when the catalog changes', () => {
    run('add', 'ts', '--target', 'codex');
    writeTree(catalogDir, { 'rules/ts.md': ruleMd('ts', 'paths:\n  - "**/*.mts"\n') });
    expect(run('update').out).toMatch(/wired\s+AGENTS\.md/);
    expect(read('AGENTS.md')).toContain('ts.md`: files matching `**/*.mts`');
  });

  it('keeps a rule that left the catalog listed by path only', () => {
    writeTree(catalogDir, { 'rules/old.md': ruleMd('old') });
    run('add', 'common', 'old', '--target', 'codex');
    rmSync(join(catalogDir, 'rules/old.md'));

    expect(run('add', 'ts', '--target', 'codex').code).toBe(0);
    const text = read('AGENTS.md');
    expect(text).toContain(`${LINE.common}\n- \`.codex/wishforge/rules/old.md\`\n${LINE.ts}\n`);
    expect(has('.codex/wishforge/rules/old.md')).toBe(true);
  });

  it('installs under ~/.codex with --global and names the files from the home folder', () => {
    expect(run('add', 'common', '--target', 'codex', '--global').code).toBe(0);
    expect(has('.codex/wishforge/rules/common.md', home)).toBe(true);
    expect(read('.codex/AGENTS.md', home)).toContain(
      '- `~/.codex/wishforge/rules/common.md`: all work'
    );
    expect(has('AGENTS.md')).toBe(false);
  });

  it('writes nothing on a dry run', () => {
    const { out } = run('add', 'common', '--target', 'codex', '--dry-run');
    expect(out).toMatch(/wired\s+AGENTS\.md/);
    expect(has('AGENTS.md')).toBe(false);
    expect(has('.codex')).toBe(false);
  });
});

describe('opencode', () => {
  it('creates opencode.json with the one entry, which never changes', () => {
    const { code, out } = run('add', 'common', '--target', 'opencode');
    expect(code).toBe(0);
    expect(out).toMatch(/wired\s+opencode\.json/);
    expect(JSON.parse(read('opencode.json'))).toEqual({
      $schema: 'https://opencode.ai/config.json',
      instructions: [ENTRY],
    });
    expect(has('.opencode/wishforge/rules/common.md')).toBe(true);

    expect(run('add', 'ts', '--target', 'opencode').out).toMatch(/unchanged\s+opencode\.json/);
    expect(run('remove', 'ts', '--target', 'opencode').out).toMatch(/unchanged\s+opencode\.json/);
    expect(JSON.parse(read('opencode.json')).instructions).toEqual([ENTRY]);
  });

  it('deletes a config it created when the last rule goes', () => {
    run('add', 'common', '--target', 'opencode');
    expect(run('remove', 'common', '--target', 'opencode').out).toMatch(/delete\s+opencode\.json/);
    expect(has('opencode.json')).toBe(false);
  });

  it('adds to and removes from a config the user owns, touching nothing else', () => {
    const mine = { model: 'x', instructions: ['a.md'], agent: { build: { mode: 'primary' } } };
    writeFileSync(join(cwd, 'opencode.json'), JSON.stringify(mine));
    run('add', 'common', '--target', 'opencode');
    expect(JSON.parse(read('opencode.json'))).toEqual({ ...mine, instructions: ['a.md', ENTRY] });
    expect(readLock(cwd).targets.opencode.rules).toEqual({ path: 'opencode.json', created: false });

    expect(run('remove', 'common', '--target', 'opencode').out).toMatch(/unwired\s+opencode\.json/);
    expect(JSON.parse(read('opencode.json'))).toEqual(mine);
  });

  it('uses the home-relative entry with --global', () => {
    expect(run('add', 'common', '--target', 'opencode', '--global').code).toBe(0);
    expect(has('.config/opencode/wishforge/rules/common.md', home)).toBe(true);
    expect(JSON.parse(read('.config/opencode/opencode.json', home)).instructions).toEqual([
      '~/.config/opencode/wishforge/rules/*.md',
    ]);
  });

  it('refuses a lone opencode.jsonc, then accepts it once the entry is added by hand', () => {
    writeFileSync(join(cwd, 'opencode.jsonc'), '{\n  // mine\n  "model": "x"\n}\n');
    const refused = run('add', 'common', '--target', 'opencode');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('opencode.jsonc');
    expect(refused.err).toContain(`add "${ENTRY}" to its "instructions" list`);
    expect(has('.opencode')).toBe(false);
    expect(has('opencode.json')).toBe(false);

    const byHand = `{\n  // mine\n  "model": "x",\n  "instructions": ["${ENTRY}"]\n}\n`;
    writeFileSync(join(cwd, 'opencode.jsonc'), byHand);
    const accepted = run('add', 'common', '--target', 'opencode');
    expect(accepted.code).toBe(0);
    expect(accepted.out).toMatch(/by hand\s+opencode\.jsonc/);
    expect(has('.opencode/wishforge/rules/common.md')).toBe(true);
    expect(has('opencode.json')).toBe(false);
    expect(read('opencode.jsonc')).toBe(byHand);
    expect(readLock(cwd).targets.opencode.rules).toMatchObject({
      path: 'opencode.jsonc',
      manual: true,
    });

    expect(run('remove', 'common', '--target', 'opencode').code).toBe(0);
    expect(read('opencode.jsonc')).toBe(byHand);
  });

  it('treats an unparsable opencode.json the same way', () => {
    writeFileSync(join(cwd, 'opencode.json'), '{\n  // mine\n}\n');
    expect(run('add', 'common', '--target', 'opencode').code).toBe(1);
    expect(has('.opencode')).toBe(false);

    const byHand = `{\n  // mine\n  "instructions": ["${ENTRY}"]\n}\n`;
    writeFileSync(join(cwd, 'opencode.json'), byHand);
    expect(run('add', 'common', '--target', 'opencode').code).toBe(0);
    expect(read('opencode.json')).toBe(byHand);
  });
});

describe('claude and cursor', () => {
  it('need no wiring: the harness loads the rule files itself', () => {
    const { code, out } = run('add', 'common', 'ts', '--target', 'claude,cursor');
    expect(code).toBe(0);
    expect(out).not.toMatch(/wired/);
    expect(has('.claude/rules/wishforge/ts.md')).toBe(true);
    expect(has('.cursor/rules/wishforge-common.mdc')).toBe(true);
    expect(has('AGENTS.md')).toBe(false);
    expect(has('opencode.json')).toBe(false);
    expect(readLock(cwd).targets.claude.rules).toBeUndefined();
  });
});

describe('several targets', () => {
  it('shrinks the Codex block, keeps the OpenCode entry, and restores both at the end', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# Mine\n');
    writeFileSync(join(cwd, 'opencode.json'), '{\n  "model": "x"\n}\n');
    run('add', 'common', 'ts', '--target', 'codex,opencode');

    run('remove', 'ts', '--target', 'codex,opencode');
    expect(read('AGENTS.md')).toContain(LINE.common);
    expect(read('AGENTS.md')).not.toContain(LINE.ts);
    expect(JSON.parse(read('opencode.json')).instructions).toEqual([ENTRY]);

    run('remove', 'common', '--target', 'codex,opencode');
    expect(read('AGENTS.md')).toBe('# Mine\n');
    expect(read('opencode.json')).toBe('{\n  "model": "x"\n}\n');
  });

  it('writes nothing for any target when one user file is damaged', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), `# Mine\n${START}\nhalf a block\n`);
    const { code, err } = run('add', 'common', '--target', 'claude,codex,opencode');
    expect(code).toBe(1);
    expect(err).toContain('AGENTS.md has damaged wishforge markers');
    for (const path of ['.claude', '.codex', '.opencode', 'opencode.json', '.wishforge']) {
      expect(has(path), path).toBe(false);
    }
    expect(run('add', 'common', '--target', 'codex', '--force').code).toBe(1);
  });
});

describe('symbolic links', () => {
  it('edits the file AGENTS.md points to and keeps the link', () => {
    writeTree(cwd, { 'docs/INSTRUCTIONS.md': '# Shared\n' });
    symlinkSync('docs/INSTRUCTIONS.md', join(cwd, 'AGENTS.md'));

    const { code, out } = run('add', 'common', '--target', 'codex');
    expect(code).toBe(0);
    expect(out).toMatch(/wired\s+docs\/INSTRUCTIONS\.md/);
    expect(lstatSync(join(cwd, 'AGENTS.md')).isSymbolicLink()).toBe(true);
    expect(read('docs/INSTRUCTIONS.md')).toContain(LINE.common);
    expect(readLock(cwd).targets.codex.rules).toEqual({ path: 'AGENTS.md', created: false });

    run('remove', 'common', '--target', 'codex');
    expect(lstatSync(join(cwd, 'AGENTS.md')).isSymbolicLink()).toBe(true);
    expect(read('docs/INSTRUCTIONS.md')).toBe('# Shared\n');
  });

  it('refuses a link that leaves the project, and a broken one', () => {
    const outside = join(tmpDir(), 'OUTSIDE.md');
    writeFileSync(outside, '# Elsewhere\n');
    symlinkSync(outside, join(cwd, 'AGENTS.md'));
    const leaving = run('add', 'common', '--target', 'codex');
    expect(leaving.code).toBe(1);
    expect(leaving.err).toContain('AGENTS.md is a symbolic link to a file outside');
    expect(readFileSync(outside, 'utf8')).toBe('# Elsewhere\n');
    expect(has('.codex')).toBe(false);

    cwd = tmpDir();
    symlinkSync('nowhere.md', join(cwd, 'AGENTS.md'));
    const broken = run('add', 'common', '--target', 'codex');
    expect(broken.code).toBe(1);
    expect(broken.err).toContain('AGENTS.md is a broken symbolic link');
  });
});

describe('status', () => {
  const state = (target) =>
    status({ scope: 'project', cwd, home }).find((row) => row.target === target).rules;

  it('reports the block and the entry', () => {
    run('add', 'common', '--target', 'claude,codex,opencode');
    expect(state('codex')).toEqual({ path: 'AGENTS.md', state: 'ok' });
    expect(state('opencode')).toEqual({ path: 'opencode.json', state: 'ok' });
    expect(state('claude')).toBeNull();
  });

  it('reports missing and unreadable', () => {
    run('add', 'common', '--target', 'codex,opencode');
    writeFileSync(join(cwd, 'AGENTS.md'), '# Rewritten by hand\n');
    writeFileSync(join(cwd, 'opencode.json'), '{ not json');
    expect(state('codex').state).toBe('missing');
    expect(state('opencode').state).toBe('unreadable');

    writeFileSync(join(cwd, 'AGENTS.md'), `${START}\n`);
    expect(state('codex').state).toBe('unreadable');
  });
});

describe('lockfile', () => {
  it('rejects a rules record with an unsafe path or a missing flag', () => {
    run('add', 'common', '--target', 'codex');
    const path = join(cwd, '.wishforge/lock.json');
    const lock = JSON.parse(readFileSync(path, 'utf8'));

    lock.targets.codex.rules = { path: '../AGENTS.md', created: true };
    writeFileSync(path, JSON.stringify(lock));
    expect(run('status').err).toContain('unsafe file path');

    lock.targets.codex.rules = { path: 'AGENTS.md' };
    writeFileSync(path, JSON.stringify(lock));
    expect(run('status').err).toContain('malformed rules record');
  });
});
