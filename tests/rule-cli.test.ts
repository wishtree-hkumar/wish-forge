import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli';
import { capture, ruleMd, tmpDir, writeTree } from './helpers';

let catalogDir;
let cwd;
let home;

function run(...argv) {
  const stdout = capture();
  const stderr = capture();
  const code = main(argv, { cwd, home, stdout, stderr, catalogDir });
  return { code, out: stdout.text, err: stderr.text };
}

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), { 'rules/common.md': ruleMd('common') });
  cwd = tmpDir();
  home = tmpDir();
  run('add', 'common', '--target', 'claude,codex,opencode');
});

describe('status', () => {
  it('shows the state of the block and the entry, and nothing for Claude Code', () => {
    const { out } = run('status');
    expect(out).toMatch(/^ {2}rules ok\s+AGENTS\.md$/m);
    expect(out).toMatch(/^ {2}rules ok\s+opencode\.json$/m);
    expect(out.match(/rules ok/g)).toHaveLength(2);
  });

  it('shows a block that was removed by hand as missing', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# Mine\n');
    expect(run('status').out).toMatch(/^ {2}rules missing\s+AGENTS\.md$/m);
  });
});

describe('doctor', () => {
  it('passes when the wiring is in place', () => {
    const { code, out } = run('doctor');
    expect(code).toBe(0);
    expect(out).toContain('project install matches lockfile (no differences)');
  });

  it('fails and names the file when the wiring is gone or unreadable', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# Mine\n');
    writeFileSync(join(cwd, 'opencode.json'), '{ not json');
    const { code, out } = run('doctor');
    expect(code).toBe(1);
    expect(out).toContain('[codex] rules wiring in AGENTS.md is missing');
    expect(out).toContain('[opencode] rules wiring in opencode.json is unreadable');
  });
});
