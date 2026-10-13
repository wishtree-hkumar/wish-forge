import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as cursor from '../src/adapters/cursor.js';
import * as opencode from '../src/adapters/opencode.js';
import { loadCatalog } from '../src/catalog.js';
import { CatalogError } from '../src/errors.js';
import { PLACEHOLDERS, fillPlaceholders, unknownPlaceholders } from '../src/placeholders.js';
import { agentMd, item, ruleMd, skill, skillMd, tmpDir, writeTree } from './helpers.js';

const load = (tree) => loadCatalog(writeTree(tmpDir(), tree));
const places = {
  agentDirs: { project: '.x/agents', global: '~/.x/agents' },
  rulesLocation: '`.x/rules` in the project',
};
const BODY = 'Look in {{agents-dir}} and {{global-agents-dir}}, then {{agents-dir}} again.';
const RULES = 'List the files in {{rules-location}}.';

describe('placeholders', () => {
  it('are the three location tokens', () => {
    expect(PLACEHOLDERS).toEqual(['{{agents-dir}}', '{{global-agents-dir}}', '{{rules-location}}']);
  });

  it('fills every occurrence of each', () => {
    expect(fillPlaceholders(BODY, places)).toBe(
      'Look in .x/agents and ~/.x/agents, then .x/agents again.'
    );
    expect(fillPlaceholders(RULES, places)).toBe('List the files in `.x/rules` in the project.');
  });

  it('leaves text without tokens alone', () => {
    expect(fillPlaceholders('No tokens here. {single} braces.', places)).toBe(
      'No tokens here. {single} braces.'
    );
  });

  it('reports each unknown token once', () => {
    const text = '{{agents-dir}} {{agent-dir}} {{ agents-dir }} {{agent-dir}} {{}}';
    expect(unknownPlaceholders(text)).toEqual(['{{agent-dir}}', '{{ agents-dir }}', '{{}}']);
    expect(unknownPlaceholders(`${BODY} ${RULES}`)).toEqual([]);
  });
});

describe('catalog', () => {
  const flow = (body) => ({
    'skills/flow/SKILL.md': `---\nname: flow\ndescription: Runs flow.\n---\n${body}\n`,
  });
  const agent = (body) => ({ 'agents/a.md': agentMd('a').replace('Body of a.', body) });

  it('accepts every placeholder in a skill body and in an agent body', () => {
    expect(load(flow(`${BODY} ${RULES}`)).get('skill:flow').body).toBe(`${BODY} ${RULES}`);
    expect(load(agent(RULES)).get('agent:a').body).toBe(RULES);
  });

  it.each(['{{agent-dir}}', '{{ agents-dir }}', '{{rules_location}}'])(
    'rejects the unknown placeholder %s in a skill and in an agent',
    (token) => {
      for (const [tree, source] of [
        [flow(`Look in ${token}.`), 'skills/flow/SKILL.md'],
        [agent(`Look in ${token}.`), 'agents/a.md'],
      ]) {
        const attempt = () => load(tree);
        expect(attempt).toThrow(CatalogError);
        expect(attempt).toThrow(`${source}: unknown placeholder ${token}`);
        expect(attempt).toThrow(
          'allowed: {{agents-dir}}, {{global-agents-dir}}, {{rules-location}}'
        );
      }
    }
  );

  it('does not check rule bodies or supporting skill files', () => {
    const catalog = load({
      'rules/r.md': ruleMd('r').replace('- A rule of r.', '- Write {{ value }}.'),
      'skills/flow/SKILL.md': skillMd('flow'),
      'skills/flow/notes.md': 'A {{template}} example.',
    });
    expect(catalog.get('rule:r').body).toContain('{{ value }}');
    expect(catalog.get('skill:flow').files[0].content.toString()).toBe('A {{template}} example.');
  });
});

const EXPECTED = [
  ['claude', claude, '.claude/agents', '~/.claude/agents'],
  ['codex', codex, '.codex/agents', '~/.codex/agents'],
  ['opencode', opencode, '.opencode/agents', '~/.config/opencode/agents'],
  ['cursor', cursor, '.cursor/agents', '~/.cursor/agents'],
];

describe.each(EXPECTED)('%s adapter', (name, adapter, project, global) => {
  const text = (file) =>
    name === 'codex' && file.path.endsWith('.toml')
      ? parseToml(file.content).developer_instructions
      : file.content;

  it('exports its places', () => {
    expect(adapter.agentDirs).toEqual({ project, global });
    expect(adapter.places).toEqual({
      agentDirs: adapter.agentDirs,
      rulesLocation: adapter.rulesLocation,
    });
  });

  it('writes project agents into the folder it names', () => {
    const [file] = adapter.render(item(), { scope: 'project', version: '0.1.0' });
    expect(file.path.startsWith(`${project}/reviewer.`)).toBe(true);
  });

  it.each(['project', 'global'])('fills a skill body at %s scope', (scope) => {
    const files = adapter.render(skill({ body: `${BODY} ${RULES}` }), { scope, version: '0.1.0' });
    const main = files.find((file) => file.path.endsWith('SKILL.md'));
    expect(main.content).toContain(`Look in ${project} and ${global}, then ${project} again.`);
    expect(main.content).toContain(`List the files in ${adapter.rulesLocation}.`);
    expect(main.content).not.toContain('{{');
  });

  it.each(['project', 'global'])('fills an agent body at %s scope', (scope) => {
    const [file] = adapter.render(item({ body: `${BODY} ${RULES}` }), { scope, version: '0.1.0' });
    expect(text(file)).toContain(`Look in ${project} and ${global}, then ${project} again.`);
    expect(text(file)).toContain(`List the files in ${adapter.rulesLocation}.`);
    expect(text(file)).not.toContain('{{');
  });

  it('leaves a rule body and a supporting skill file unchanged', () => {
    const ctx = { scope: 'project', version: '0.1.0' };
    const rule = { ...item({ id: 'rule:r', type: 'rule', name: 'r' }), body: `# R\n\n- ${BODY}` };
    expect(adapter.render(rule, ctx)[0].content).toContain('{{agents-dir}}');

    const extra = { path: 'notes.md', content: Buffer.from(BODY) };
    const files = adapter.render(skill({ files: [extra] }), ctx);
    expect(files.find((file) => file.path.endsWith('notes.md')).content.toString()).toBe(BODY);
  });
});
