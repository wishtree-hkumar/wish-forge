import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as cursor from '../src/adapters/cursor.js';
import * as opencode from '../src/adapters/opencode.js';
import { appliesTo } from '../src/adapters/shared.js';
import { main } from '../src/cli.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { capture, ruleMd, tmpDir, writeTree } from './helpers.js';

const project = { scope: 'project', version: '0.1.0' };
const global = { scope: 'global', version: '0.1.0' };
const BODY = '# TypeScript\n\n- Prefer `unknown` to `any`.';
const scoped = {
  id: 'rule:ts',
  type: 'rule',
  name: 'ts',
  description: 'TypeScript: standards',
  paths: ['**/*.ts', '**/*.tsx'],
  requires: [],
  body: BODY,
  files: [],
};
const always = { ...scoped, id: 'rule:common', name: 'common', paths: undefined };
const MARK = '\n\n<!-- managed by wishforge: rule:ts@0.1.0 -->\n';

describe('appliesTo', () => {
  it('describes patterns, or all work', () => {
    expect(appliesTo(scoped)).toBe('files matching `**/*.ts`, `**/*.tsx`');
    expect(appliesTo(always)).toBe('all work');
  });
});

describe('claude', () => {
  it('writes a scoped rule into its own subfolder with a paths list', () => {
    const [file, ...rest] = claude.render(scoped, project);
    expect(rest).toEqual([]);
    expect(file.path).toBe('.claude/rules/wishforge/ts.md');
    const { data, body } = parseFrontmatter(file.content);
    expect(data).toEqual({ paths: ['**/*.ts', '**/*.tsx'] });
    expect(body.startsWith(BODY)).toBe(true);
    expect(file.content.endsWith(MARK)).toBe(true);
  });

  it('writes an always-on rule with no frontmatter at all', () => {
    const [file] = claude.render(always, project);
    expect(file.path).toBe('.claude/rules/wishforge/common.md');
    expect(file.content).toBe(`${BODY}\n\n<!-- managed by wishforge: rule:common@0.1.0 -->\n`);
  });

  it('uses the same relative path at global scope', () => {
    expect(claude.render(scoped, global)[0].path).toBe('.claude/rules/wishforge/ts.md');
  });
});

describe('cursor', () => {
  it('writes a scoped rule as .mdc with bare comma-separated globs', () => {
    const [file] = cursor.render(scoped, project);
    expect(file.path).toBe('.cursor/rules/wishforge-ts.mdc');
    expect(file.content).toBe(
      '---\n' +
        'description: "TypeScript: standards"\n' +
        'globs: **/*.ts, **/*.tsx\n' +
        'alwaysApply: false\n' +
        `---\n\n${BODY}${MARK}`
    );
  });

  it('marks a rule without paths as always applied, with no globs line', () => {
    const { content } = cursor.render(always, project)[0];
    expect(content).toContain('alwaysApply: true\n');
    expect(content).not.toContain('globs');
  });

  it('declares that it has no user-level rule files', () => {
    expect(cursor.globalRules).toBe(false);
  });
});

describe('codex', () => {
  it('writes the rule beside the gates, starting with what it applies to', () => {
    const [file] = codex.render(scoped, project);
    expect(file.path).toBe('.codex/wishforge/rules/ts.md');
    expect(file.content).toBe(
      `Applies to: files matching \`**/*.ts\`, \`**/*.tsx\`.\n\n${BODY}${MARK}`
    );
  });

  it('says all work for a rule without paths', () => {
    expect(codex.render(always, project)[0].content.startsWith('Applies to: all work.\n\n')).toBe(
      true
    );
  });
});

describe('opencode', () => {
  it('writes the rule under .opencode in a project', () => {
    const [file] = opencode.render(scoped, project);
    expect(file.path).toBe('.opencode/wishforge/rules/ts.md');
    expect(file.content).toBe(
      `Applies to: files matching \`**/*.ts\`, \`**/*.tsx\`.\n\n${BODY}${MARK}`
    );
  });

  it('drops the .opencode prefix under the global config directory', () => {
    expect(opencode.render(scoped, global)[0].path).toBe('wishforge/rules/ts.md');
  });
});

describe('rulesLocation', () => {
  it.each([
    [claude, '`.claude/rules/wishforge` in the project and `~/.claude/rules/wishforge`'],
    [cursor, '`.cursor/rules` in the project (the files named `wishforge-*.mdc`)'],
    [codex, '`.codex/wishforge/rules` in the project and `~/.codex/wishforge/rules`'],
    [
      opencode,
      '`.opencode/wishforge/rules` in the project and `~/.config/opencode/wishforge/rules`',
    ],
  ])('names where each harness keeps its rules', (adapter, phrase) => {
    expect(adapter.rulesLocation).toBe(phrase);
  });
});

describe('a rule for Cursor with --global', () => {
  it('is refused, and nothing is installed for any target', () => {
    const catalogDir = writeTree(tmpDir(), { 'rules/common.md': ruleMd('common') });
    const io = { cwd: tmpDir(), home: tmpDir(), stdout: capture(), stderr: capture(), catalogDir };
    const code = main(['add', 'common', '--target', 'claude,cursor', '--global'], io);
    expect(code).toBe(2);
    expect(io.stderr.text).toContain('Cursor keeps user-level rules in its settings');
    expect(existsSync(join(io.home, '.claude'))).toBe(false);
    expect(existsSync(join(io.home, '.cursor'))).toBe(false);
  });
});
