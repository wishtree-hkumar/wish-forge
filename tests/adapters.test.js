import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as cursor from '../src/adapters/cursor.js';
import { getAdapter, targetNames } from '../src/adapters/index.js';
import * as opencode from '../src/adapters/opencode.js';
import { UsageError } from '../src/errors.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { item, skill } from './helpers.js';

const ctx = { scope: 'project', version: '0.1.0' };
const dirs = { cwd: '/work/app', home: '/home/dev' };
const reader = item();
const writer = item({ id: 'agent:builder', name: 'builder', access: 'write', modelTier: 'balanced' });
const tricky = 'Reviews: "quoted" text # not a comment, it\'s fine';

describe('registry', () => {
  it('lists the four targets', () => {
    expect(targetNames).toEqual(['claude', 'codex', 'opencode', 'cursor']);
  });

  it('rejects an unknown target and names the valid ones', () => {
    expect(() => getAdapter('vim')).toThrow(UsageError);
    expect(() => getAdapter('vim')).toThrow('claude, codex, opencode, cursor');
  });
});

describe('claude', () => {
  it('renders a read-only agent exactly', () => {
    expect(claude.render(reader, ctx)).toEqual([
      {
        path: '.claude/agents/reviewer.md',
        content:
          '---\n' +
          'name: reviewer\n' +
          'description: Reviews a change.\n' +
          'tools: Read, Grep, Glob, Bash\n' +
          'model: opus\n' +
          '---\n\n' +
          'You review code.\n\n' +
          '<!-- managed by forgeflow: agent:reviewer@0.1.0 -->\n',
      },
    ]);
  });

  it('omits tools for a write agent and maps the model tier', () => {
    const { data } = parseFrontmatter(claude.render(writer, ctx)[0].content);
    expect(data).toEqual({ name: 'builder', description: 'Reviews a change.', model: 'sonnet' });
  });

  it('maps the fast tier to haiku', () => {
    const { data } = parseFrontmatter(claude.render(item({ modelTier: 'fast' }), ctx)[0].content);
    expect(data.model).toBe('haiku');
  });

  it('renders a skill with extra files and explicit-only invocation', () => {
    const extra = { path: 'refs/states.md', content: Buffer.from('x') };
    const files = claude.render(skill({ files: [extra] }), ctx);
    expect(files.map((file) => file.path)).toEqual([
      '.claude/skills/forge-quick/SKILL.md',
      '.claude/skills/forge-quick/refs/states.md',
    ]);
    expect(files[1].content).toEqual(Buffer.from('x'));
    const { data, body } = parseFrontmatter(files[0].content);
    expect(data).toEqual({
      name: 'forge-quick',
      description: 'Run the quick flow.',
      'disable-model-invocation': true,
    });
    expect(body).toBe('Follow the steps.\n\n<!-- managed by forgeflow: skill:forge-quick@0.1.0 -->');
  });

  it('leaves model invocation on when the skill allows it', () => {
    const { data } = parseFrontmatter(claude.render(skill({ userInvocableOnly: false }), ctx)[0].content);
    expect(data).toEqual({ name: 'forge-quick', description: 'Run the quick flow.' });
  });

  it('uses cwd for project scope and home for global scope', () => {
    expect(claude.root('project', dirs)).toBe('/work/app');
    expect(claude.root('global', dirs)).toBe('/home/dev');
  });
});

describe('codex', () => {
  it('renders an agent as TOML', () => {
    const [file] = codex.render(reader, ctx);
    expect(file.path).toBe('.codex/agents/reviewer.toml');
    expect(file.content.split('\n')[0]).toBe('# managed by forgeflow: agent:reviewer@0.1.0');
    expect(parseToml(file.content)).toEqual({
      name: 'reviewer',
      description: 'Reviews a change.',
      sandbox_mode: 'read-only',
      developer_instructions: 'You review code.\n',
    });
  });

  it('gives a write agent the workspace-write sandbox', () => {
    expect(parseToml(codex.render(writer, ctx)[0].content).sandbox_mode).toBe('workspace-write');
  });

  it('escapes quotes, backslashes, triple quotes and control characters', () => {
    const body = 'Use "quotes", a \\ backslash, """triple""", """"four"""" and a bell \u0007.\nEnd"';
    const parsed = parseToml(codex.render(item({ body, description: tricky }), ctx)[0].content);
    expect(parsed.developer_instructions).toBe(`${body}\n`);
    expect(parsed.description).toBe(tricky);
  });

  it('renders a skill under .agents/skills with plain frontmatter', () => {
    const [file] = codex.render(skill(), ctx);
    expect(file.path).toBe('.agents/skills/forge-quick/SKILL.md');
    expect(parseFrontmatter(file.content).data).toEqual({
      name: 'forge-quick',
      description: 'Run the quick flow.',
    });
  });

  it('uses home for global scope', () => {
    expect(codex.root('global', dirs)).toBe('/home/dev');
  });
});

describe('opencode', () => {
  it('renders a read-only agent as a subagent that cannot edit', () => {
    const [file] = opencode.render(reader, ctx);
    expect(file.path).toBe('.opencode/agents/reviewer.md');
    expect(parseFrontmatter(file.content).data).toEqual({
      description: 'Reviews a change.',
      mode: 'subagent',
      permission: { edit: 'deny' },
    });
  });

  it('omits permission for a write agent', () => {
    expect(parseFrontmatter(opencode.render(writer, ctx)[0].content).data).toEqual({
      description: 'Reviews a change.',
      mode: 'subagent',
    });
  });

  it('marks an explicit-only skill as a slash command that is not auto-invoked', () => {
    const [file] = opencode.render(skill(), ctx);
    expect(file.path).toBe('.opencode/skills/forge-quick/SKILL.md');
    expect(parseFrontmatter(file.content).data.metadata).toEqual({
      'opencode/autoinvoke': 'false',
      'opencode/slash': 'true',
    });
  });

  it('drops the .opencode prefix under the global config directory', () => {
    expect(opencode.root('project', dirs)).toBe('/work/app');
    expect(opencode.root('global', dirs)).toBe('/home/dev/.config/opencode');
    const global = { scope: 'global', version: '0.1.0' };
    expect(opencode.render(reader, global)[0].path).toBe('agents/reviewer.md');
    expect(opencode.render(skill(), global)[0].path).toBe('skills/forge-quick/SKILL.md');
  });
});

describe('cursor', () => {
  it('renders a read-only agent', () => {
    const [file] = cursor.render(reader, ctx);
    expect(file.path).toBe('.cursor/agents/reviewer.md');
    expect(parseFrontmatter(file.content).data).toEqual({
      name: 'reviewer',
      description: 'Reviews a change.',
      readonly: true,
    });
  });

  it('renders a write agent', () => {
    expect(parseFrontmatter(cursor.render(writer, ctx)[0].content).data.readonly).toBe(false);
  });

  it('renders an explicit-only skill', () => {
    const [file] = cursor.render(skill(), ctx);
    expect(file.path).toBe('.cursor/skills/forge-quick/SKILL.md');
    expect(parseFrontmatter(file.content).data['disable-model-invocation']).toBe(true);
  });
});

describe('every Markdown adapter', () => {
  it.each([
    ['claude', claude],
    ['opencode', opencode],
    ['cursor', cursor],
  ])('%s round-trips a description with YAML-special characters', (_name, adapter) => {
    const [file] = adapter.render(item({ description: tricky }), ctx);
    expect(parseFrontmatter(file.content).data.description).toBe(tricky);
  });
});
