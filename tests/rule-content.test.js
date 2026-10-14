import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/cli.js';
import { capture, tmpDir } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const rules = [...catalog.values()].filter((item) => item.type === 'rule');

const EXPECTED = [
  ['common', undefined],
  [
    'typescript',
    ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
  ],
  ['python', ['**/*.py', '**/*.pyi']],
  ['php', ['**/*.php']],
  ['java', ['**/*.java']],
  ['csharp', ['**/*.cs', '**/*.cshtml', '**/*.razor']],
  ['go', ['**/*.go']],
  ['react', ['**/*.tsx', '**/*.jsx', '**/use*.ts', '**/use*.js']],
  ['vue', ['**/*.vue']],
  ['angular', ['**/*.ts', '**/*.html']],
];
const NAMES = EXPECTED.map(([name]) => name);
const HARNESS_TOOL =
  /`(Edit|Write|Read|Grep|Glob|Bash|Task|MultiEdit|TodoWrite|apply_patch|str_replace)`|\b(apply_patch|MultiEdit|TodoWrite|str_replace)\b/;
const body = (name) => catalog.get(`rule:${name}`).body;
const lines = (name) => body(name).split('\n');

describe('rules packs', () => {
  it('are exactly the ten the spec lists', () => {
    expect(rules.map((rule) => rule.name).sort()).toEqual([...NAMES].sort());
  });

  it.each(EXPECTED)('%s applies to the patterns the spec gives', (name, paths) => {
    const rule = catalog.get(`rule:${name}`);
    expect(rule.paths).toEqual(paths);
    expect(rule.requires).toEqual([]);
    expect(rule.description.endsWith('.')).toBe(true);
    expect(rule.description.length).toBeLessThanOrEqual(200);
  });

  it.each(NAMES)('%s is one titled document of grouped bullets', (name) => {
    expect(lines(name)[0]).toMatch(/^# \S/);
    expect(lines(name).filter((line) => line.startsWith('# '))).toHaveLength(1);
    expect(lines(name).filter((line) => line.startsWith('## ')).length).toBeGreaterThanOrEqual(3);
    expect(lines(name).filter((line) => line.startsWith('- ')).length).toBeGreaterThanOrEqual(15);
  });

  it.each(NAMES)('%s holds nothing but its title, headings, bullets and one intro line', (name) => {
    const other = lines(name).filter(
      (line) => line !== '' && !line.startsWith('#') && !line.startsWith('- ')
    );
    expect(other.length).toBeLessThanOrEqual(1);
  });

  it.each(NAMES)('%s stays within 6,000 bytes', (name) => {
    expect(Buffer.byteLength(body(name))).toBeLessThanOrEqual(6000);
  });

  it.each(NAMES)('%s names no harness-specific tool', (name) => {
    expect(body(name)).not.toMatch(HARNESS_TOOL);
  });

  it('common lets the project convention win', () => {
    expect(body('common')).toContain("the project's convention wins");
  });

  it.each([
    ['php', '## Laravel'],
    ['java', '## Spring'],
    ['csharp', '## ASP.NET Core'],
  ])('%s keeps its framework rules in a section that says when it applies', (name, heading) => {
    const at = lines(name).indexOf(heading);
    expect(at).toBeGreaterThan(0);
    expect(lines(name)[at + 2]).toContain('only when the project uses');
  });
});

describe('installing the real packs', () => {
  const io = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture() };
  const code = main(['add', ...NAMES, '--target', 'claude,codex,opencode,cursor'], io);
  const read = (path) => readFileSync(join(io.cwd, path), 'utf8');

  it('writes every pack for every harness', () => {
    expect(io.stderr.text).toBe('');
    expect(code).toBe(0);
    for (const name of NAMES) {
      for (const path of [
        `.claude/rules/forgeflow/${name}.md`,
        `.cursor/rules/forgeflow-${name}.mdc`,
        `.codex/forgeflow/rules/${name}.md`,
        `.opencode/forgeflow/rules/${name}.md`,
      ]) {
        expect(existsSync(join(io.cwd, path)), path).toBe(true);
      }
    }
  });

  it('lists all ten in the Codex block, well inside the 32 KiB cap', () => {
    const text = read('AGENTS.md');
    expect(text.match(/^- `\.codex\/forgeflow\/rules\//gm)).toHaveLength(10);
    expect(text).toContain('- `.codex/forgeflow/rules/common.md`: all work');
    expect(text).toContain('- `.codex/forgeflow/rules/vue.md`: files matching `**/*.vue`');
    expect(Buffer.byteLength(text)).toBeLessThan(4096);
  });

  it('scopes stack packs and leaves common always on', () => {
    expect(read('.claude/rules/forgeflow/common.md').startsWith('# ')).toBe(true);
    expect(read('.claude/rules/forgeflow/go.md').startsWith('---\npaths:\n')).toBe(true);
    expect(read('.cursor/rules/forgeflow-common.mdc')).toContain('alwaysApply: true');
    expect(read('.cursor/rules/forgeflow-go.mdc')).toContain('globs: **/*.go\nalwaysApply: false');
    expect(read('.opencode/forgeflow/rules/go.md').startsWith('Applies to: files matching')).toBe(
      true
    );
  });
});
