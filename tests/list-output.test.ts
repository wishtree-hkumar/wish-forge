import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli';
import { agentMd, capture, ruleMd, skillMd, tmpDir, writeTree } from './helpers';
import { hookTree, runtimeTree } from './hook-helpers';

let catalogDir;
const run = (argv, stdout = capture()) => {
  const stderr = capture();
  const code = main(argv, { cwd: tmpDir(), home: tmpDir(), stdout, stderr, catalogDir });
  return { code, out: stdout.text, err: stderr.text };
};
// A terminal of the given width, as process.stdout looks when it is one.
const terminal = (columns) => {
  const out = capture();
  out.isTTY = true;
  out.columns = columns;
  return out;
};
const LONG = 'Builds things carefully and well. Use when a plan exists and the change is large.';

beforeEach(() => {
  catalogDir = writeTree(tmpDir(), {
    ...runtimeTree(),
    'agents/builder.md': agentMd('builder', 'stage: build\n').replace(
      'description: Does builder things.',
      `description: ${LONG}`
    ),
    'agents/analyzer.md': agentMd('analyzer', 'stage: analyze\n'),
    'agents/sec.md': agentMd('sec', 'joins: review\n'),
    'agents/mapper.md': agentMd('mapper'),
    'skills/forge-quick/SKILL.md': skillMd('forge-quick'),
    'skills/forge-map/SKILL.md': skillMd('forge-map', 'group: memory\n'),
    ...hookTree('guard', '[shell, write]'),
    'hooks/memo/HOOK.md':
      '---\nname: memo\ndescription: Remembers.\nevents: [start]\ngroup: memory\n---\nx\n',
    'hooks/memo/gate.mjs': 'export function check() {}\n',
    'rules/common.md': ruleMd('common'),
    'rules/ts.md': ruleMd('ts', 'paths:\n  - "**/*.ts"\n  - "**/*.tsx"\n'),
  });
});

describe('wishforge list', () => {
  it('groups items under a heading per kind, in a fixed order', () => {
    const headings = run(['list'])
      .out.split('\n')
      .filter((line) => line && !line.startsWith(' '));
    expect(headings).toEqual([
      'Flow agents',
      'Specialists',
      'Flows',
      'Quality gates',
      'Session memory',
      'Rules packs',
      '10 items. Run "wishforge info <name>" for the full description.',
    ]);
  });

  it('lists flow agents in stage order, with their stage and access', () => {
    const lines = run(['list']).out.split('\n');
    const at = lines.indexOf('Flow agents');
    expect(lines[at + 1]).toMatch(/^ {2}analyzer\s+ANALYZE\s+read-only\s+Does analyzer things\.$/);
    expect(lines[at + 2]).toMatch(
      /^ {2}builder\s+BUILD\s+read-only\s+Builds things carefully and well\.$/
    );
  });

  it('marks the specialists the flows run as reviewers', () => {
    const { out } = run(['list']);
    expect(out).toMatch(/^ {2}sec\s+reviewer\s+read-only\s+Does sec things\.$/m);
    expect(out).toMatch(/^ {2}mapper\s+read-only\s+Does mapper things\.$/m);
  });

  it('keeps memory items together and says which is the hook', () => {
    const lines = run(['list']).out.split('\n');
    const at = lines.indexOf('Session memory');
    expect(lines.slice(at + 1, at + 3)).toEqual([
      expect.stringMatching(/^ {2}forge-map\s+command\s+Runs forge-map\.$/),
      expect.stringMatching(/^ {2}memo\s+hook\s+Remembers\.$/),
    ]);
  });

  it('says what each rules pack applies to', () => {
    const { out } = run(['list']);
    expect(out).toMatch(/^ {2}common\s+all work\s+common standards\.$/m);
    expect(out).toMatch(/^ {2}ts\s+\*\.ts \*\.tsx\s+ts standards\.$/m);
  });

  it('stops a summary where a dash starts a list', () => {
    writeTree(catalogDir, {
      'agents/api.md': agentMd('api').replace(
        'description: Does api things.',
        'description: Designs an interface - endpoints, errors and versions. Use first.'
      ),
    });
    expect(run(['list']).out).toMatch(/^ {2}api\s+read-only\s+Designs an interface$/m);
  });

  it('shows only the first sentence and no type prefixes', () => {
    const { out } = run(['list']);
    expect(out).not.toContain('Use when a plan exists');
    expect(out).not.toMatch(/agent:|skill:|hook:|rule:/);
    expect(out).not.toContain('hooks  ');
  });

  it('cuts each line to the width of a terminal', () => {
    const { out } = run(['list'], terminal(40));
    const lines = out.split('\n').filter(Boolean);
    expect(lines.every((line) => line.length <= 40)).toBe(true);
    expect(lines.some((line) => line.endsWith('…'))).toBe(true);
  });

  it('does not cut lines when the output is not a terminal', () => {
    const { out } = run(['list']);
    expect(out).toContain('Builds things carefully and well.');
  });

  it('shows only the groups that match --type', () => {
    const headings = run(['list', '--type', 'agent'])
      .out.split('\n')
      .filter((line) => line && !line.startsWith(' '));
    expect(headings).toEqual([
      'Flow agents',
      'Specialists',
      '4 items. Run "wishforge info <name>" for the full description.',
    ]);
  });

  it('keeps the JSON output as it was, with full ids and descriptions', () => {
    const rows = JSON.parse(run(['list', '--json']).out);
    expect(rows.find((row) => row.id === 'agent:builder').description).toBe(LONG);
  });
});

describe('the real catalog', () => {
  it('fits a normal terminal', () => {
    catalogDir = fileURLToPath(new URL('../catalog', import.meta.url));
    const { code, out } = run(['list'], terminal(100));
    expect(code).toBe(0);
    expect(out.split('\n').every((line) => line.length <= 100)).toBe(true);
    expect(out).toContain('43 items.');
    expect(out).toMatch(
      /^ {2}api-designer\s+read-only\s+Designs an interface before it is built$/m
    );
  });
});
