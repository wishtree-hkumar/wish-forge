import { describe, expect, it } from 'vitest';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as cursor from '../src/adapters/cursor.js';
import * as opencode from '../src/adapters/opencode.js';
import { loadCatalog } from '../src/catalog.js';
import { CatalogError } from '../src/errors.js';
import { PLACEHOLDERS, fillPlaceholders, unknownPlaceholders } from '../src/placeholders.js';
import { agentMd, item, skill, skillMd, tmpDir, writeTree } from './helpers.js';

const load = (tree) => loadCatalog(writeTree(tmpDir(), tree));
const dirs = { project: '.x/agents', global: '~/.x/agents' };
const BODY = 'Look in {{agents-dir}} and {{global-agents-dir}}, then {{agents-dir}} again.';

describe('placeholders', () => {
  it('are the two agents-folder tokens', () => {
    expect(PLACEHOLDERS).toEqual(['{{agents-dir}}', '{{global-agents-dir}}']);
  });

  it('fills every occurrence of both', () => {
    expect(fillPlaceholders(BODY, dirs)).toBe(
      'Look in .x/agents and ~/.x/agents, then .x/agents again.'
    );
  });

  it('leaves text without tokens alone', () => {
    expect(fillPlaceholders('No tokens here. {single} braces.', dirs)).toBe(
      'No tokens here. {single} braces.'
    );
  });

  it('reports each unknown token once', () => {
    const text = '{{agents-dir}} {{agent-dir}} {{ agents-dir }} {{agent-dir}} {{}}';
    expect(unknownPlaceholders(text)).toEqual(['{{agent-dir}}', '{{ agents-dir }}', '{{}}']);
    expect(unknownPlaceholders(BODY)).toEqual([]);
  });
});

describe('catalog', () => {
  const flow = (body) => ({
    'skills/flow/SKILL.md': `---\nname: flow\ndescription: Runs flow.\n---\n${body}\n`,
  });

  it('accepts both placeholders in a skill body', () => {
    expect(load(flow(BODY)).get('skill:flow').body).toBe(BODY);
  });

  it.each(['{{agent-dir}}', '{{ agents-dir }}', '{{global_agents_dir}}'])(
    'rejects the unknown placeholder %s and names it',
    (token) => {
      const attempt = () => load(flow(`Look in ${token}.`));
      expect(attempt).toThrow(CatalogError);
      expect(attempt).toThrow(`skills/flow/SKILL.md: unknown placeholder ${token}`);
      expect(attempt).toThrow('allowed: {{agents-dir}}, {{global-agents-dir}}');
    }
  );

  it('does not check agent bodies or supporting skill files', () => {
    const catalog = load({
      'agents/a.md': agentMd('a').replace('Body of a.', 'Uses {{anything}}.'),
      'skills/flow/SKILL.md': skillMd('flow'),
      'skills/flow/notes.md': 'A {{template}} example.',
    });
    expect(catalog.get('agent:a').body).toBe('Uses {{anything}}.');
    expect(catalog.get('skill:flow').files[0].content.toString()).toBe('A {{template}} example.');
  });
});

const EXPECTED = [
  ['claude', claude, '.claude/agents', '~/.claude/agents'],
  ['codex', codex, '.codex/agents', '~/.codex/agents'],
  ['opencode', opencode, '.opencode/agents', '~/.config/opencode/agents'],
  ['cursor', cursor, '.cursor/agents', '~/.cursor/agents'],
];

describe.each(EXPECTED)('%s adapter', (_name, adapter, project, global) => {
  it('exports its agents folders', () => {
    expect(adapter.agentDirs).toEqual({ project, global });
  });

  it('writes project agents into the folder it names', () => {
    const [file] = adapter.render(item(), { scope: 'project', version: '0.1.0' });
    expect(file.path.startsWith(`${project}/reviewer.`)).toBe(true);
  });

  it.each(['project', 'global'])('fills a skill body at %s scope', (scope) => {
    const files = adapter.render(skill({ body: BODY }), { scope, version: '0.1.0' });
    const main = files.find((file) => file.path.endsWith('SKILL.md'));
    expect(main.content).toContain(`Look in ${project} and ${global}, then ${project} again.`);
    expect(main.content).not.toContain('{{');
  });

  it('leaves an agent body and a supporting skill file unchanged', () => {
    const ctx = { scope: 'project', version: '0.1.0' };
    const [agent] = adapter.render(item({ body: BODY }), ctx);
    expect(agent.content).toContain('{{agents-dir}}');

    const extra = { path: 'notes.md', content: Buffer.from(BODY) };
    const files = adapter.render(skill({ files: [extra] }), ctx);
    expect(files.find((file) => file.path.endsWith('notes.md')).content.toString()).toBe(BODY);
  });
});
