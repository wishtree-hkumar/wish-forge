// Regression tests for findings from the whole-branch review of the quality gates.
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check as approval } from '../catalog/hooks/approval-gate/gate.mjs';
import { check as secretGuard } from '../catalog/hooks/secret-guard/gate.mjs';
import {
  evaluate,
  findRun,
  findRuns,
  matchesGlob,
  normalize,
  selfProtect,
} from '../catalog/runtime/hooks/runtime.mjs';
import * as claude from '../src/adapters/claude.js';
import * as cursor from '../src/adapters/cursor.js';
import { isWired, mergeWiring, stripWiring } from '../src/wiring.js';
import { tmpDir, writeTree } from './helpers.js';

const NOW = Date.UTC(2026, 9, 13, 12);

function runIn(root, name, state, ageHours = 0) {
  const dir = join(root, '.forgeflow/runs', name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'state.md');
  writeFileSync(file, state);
  const when = new Date(NOW - ageHours * 3600 * 1000);
  utimesSync(file, when, when);
  return dir;
}

describe('Cursor read tools are not writes', () => {
  const pre = (tool, input) =>
    normalize(
      'cursor',
      { hook_event_name: 'preToolUse', tool_name: tool, tool_input: input },
      '/work/app'
    );

  it.each(['Read', 'Grep', 'Glob', 'LS', 'SomeFutureReader'])(
    '%s with only a file_path produces no event',
    (tool) => {
      expect(pre(tool, { file_path: '.forgeflow/runs/r/09-approval.md' })).toEqual([]);
      expect(pre(tool, { file_path: '.env', offset: 1, limit: 20 })).toEqual([]);
    }
  );

  it('known write tools and any tool carrying new text are writes', () => {
    expect(pre('Delete', { file_path: '.env' })).toEqual([
      { kind: 'write', path: '.env', content: '' },
    ]);
    expect(pre('Write', { file_path: 'a.js', content: 'x' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'x' },
    ]);
    expect(pre('FutureEditor', { file_path: 'a.js', new_string: 'n' })).toEqual([
      { kind: 'write', path: 'a.js', content: 'n' },
    ]);
    expect(
      pre('MultiEdit', { file_path: 'a.js', edits: [{ new_string: 'one' }, { new_string: 'two' }] })
    ).toEqual([{ kind: 'write', path: 'a.js', content: 'one\ntwo' }]);
  });
});

describe('paths reached through symlinks or other letter case', () => {
  it('recognises a project file reached through a symlinked project path', () => {
    const root = writeTree(tmpDir(), {
      '.claude/forgeflow/run.mjs': '',
      '.claude/settings.json': '{}',
    });
    const link = join(tmpDir(), 'link');
    symlinkSync(root, link);
    const write = (file_path) =>
      normalize(
        'claude',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path, content: '' },
          cwd: link,
        },
        root
      );
    expect(write(join(link, '.claude/settings.json'))[0].path).toBe('.claude/settings.json');
    expect(write('.claude/forgeflow/gates/approval-gate.mjs')[0].path).toBe(
      '.claude/forgeflow/gates/approval-gate.mjs'
    );
    expect(write(join(link, 'migrations/001.sql'))[0].path).toBe('migrations/001.sql');
  });

  it('recognises a file reached through a symlinked folder inside the project', () => {
    const root = writeTree(tmpDir(), {
      '.claude/forgeflow/run.mjs': '',
      '.claude/settings.json': '{}',
    });
    symlinkSync(join(root, '.claude'), join(root, 'linkc'));
    const [event] = normalize(
      'claude',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: 'linkc/settings.json', content: '' },
        cwd: root,
      },
      root
    );
    expect(event.path).toBe('.claude/settings.json');
    expect(selfProtect(event, root)).toContain('is protected');
  });

  it('protects its files whatever the letter case', () => {
    const root = writeTree(tmpDir(), { '.claude/forgeflow/run.mjs': '' });
    for (const path of [
      '.Claude/settings.json',
      '.CLAUDE/forgeflow/run.mjs',
      '.forgeflow/CONFIG.json',
    ]) {
      expect(selfProtect({ kind: 'write', path, content: '' }, root), path).toContain(
        'is protected'
      );
    }
    expect(
      approval(
        { kind: 'write', path: '.forgeflow/runs/r/09-APPROVAL.md', content: '' },
        { runs: [] }
      ).block
    ).toBeDefined();
    expect(
      approval(
        { kind: 'shell', command: 'echo x > .forgeflow/runs/r/09-Approval.MD' },
        { runs: [] }
      ).block
    ).toBeDefined();
  });
});

describe('shell self-protection', () => {
  const root = tmpDir();
  const shell = (command) => selfProtect({ kind: 'shell', command }, root);

  it.each([
    'rm -rf .claude/forgeflow',
    'mv .claude/forgeflow /tmp/x',
    'cd x && rm -r .cursor/forgeflow/gates',
    'echo "" > .codex/forgeflow/run.mjs',
    'cp /tmp/evil.mjs .opencode/forgeflow/gates/secret-guard.mjs',
    'sed -i s/2/0/ .claude/forgeflow/runtime.mjs',
    'node bin/forgeflow.js remove approval-gate --target claude',
    'npx forgeflow remove secret-guard --target cursor',
  ])('blocks "%s"', (command) => {
    expect(shell(command)).toContain('is protected');
  });

  it.each([
    'git add .claude/forgeflow/run.mjs',
    'git add -A && git commit -m "Install forgeflow gates"',
    'ls .claude/forgeflow/gates',
    'cat .claude/forgeflow/gates/secret-guard.mjs',
    'git commit -m "forgeflow: remove dead code"',
    'git diff -- .cursor/forgeflow',
    'forgeflow status',
    'rm -rf node_modules',
  ])('allows "%s"', (command) => {
    expect(shell(command)).toBeUndefined();
  });
});

describe('OpenCode write tools', () => {
  const tool = (name, args) =>
    normalize('opencode', { hook: 'tool', tool: name, args }, '/work/app');

  it('treats multiedit as a write', () => {
    expect(
      tool('multiedit', { filePath: '.env', edits: [{ newString: 'A=1' }, { newString: 'B=2' }] })
    ).toEqual([{ kind: 'write', path: '.env', content: 'A=1\nB=2' }]);
    expect(tool('multiedit', { filePath: '.env', edits: [] })).toEqual([
      { kind: 'write', path: '.env', content: '' },
    ]);
  });

  it('treats apply_patch, and any tool carrying a patch, as writes', () => {
    const patchText = '*** Begin Patch\n*** Add File: .env\n+A=1\n*** End Patch';
    for (const name of ['apply_patch', 'patch', 'future_patch_tool']) {
      expect(tool(name, { patchText })).toEqual([{ kind: 'write', path: '.env', content: 'A=1' }]);
    }
  });
});

describe('finding runs', () => {
  it.each([
    ['quoted', 'status: "waiting for user"'],
    ['single-quoted', "status: 'waiting for user'"],
    ['a table row', '| status | waiting for user |'],
    ['a heading', '### status: waiting for user'],
    ['a quote line', '> status: waiting for user'],
    ['a numbered line', '7. status: waiting for user'],
  ])('reads a %s status', (_label, line) => {
    const root = tmpDir();
    runIn(root, 'r', `${line}\ncurrent stage: SHIP\n`);
    expect(findRun(root, NOW)).toMatchObject({ status: 'waiting for user', stage: 'SHIP' });
  });

  it('keeps a run that is waiting for the user however long it waits', () => {
    const root = tmpDir();
    runIn(root, 'waiting', 'status: waiting for user\ncurrent stage: HUMAN_APPROVAL\n', 24 * 9);
    runIn(root, 'abandoned', 'status: running\n', 25);
    expect(findRuns(root, NOW).map((run) => run.name)).toEqual(['waiting']);
  });

  it('returns every active run, newest first, and gives them all to gates', () => {
    const root = tmpDir();
    runIn(root, 'older', 'status: waiting for user\ncurrent stage: HUMAN_APPROVAL\n', 5);
    runIn(root, 'newer', 'status: running\ncurrent stage: BUILD\n', 1);
    runIn(root, 'done', 'status: complete\n', 0);
    expect(findRuns(root, NOW).map((run) => run.name)).toEqual(['newer', 'older']);

    let seen;
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    evaluate({
      harness: 'claude',
      payload,
      root,
      now: NOW,
      gates: [{ name: 'spy', check: (_e, ctx) => void (seen = ctx) }],
    });
    expect(seen.runs.map((run) => run.name)).toEqual(['newer', 'older']);
    expect(seen.run.name).toBe('newer');
  });
});

describe('approval-gate with imperfect state', () => {
  const run = (overrides = {}) => {
    const dir = join(tmpDir(), '.forgeflow/runs', overrides.name ?? 'r1');
    mkdirSync(dir, { recursive: true });
    return {
      dir,
      name: 'r1',
      status: 'waiting for user',
      stage: 'HUMAN_APPROVAL',
      approved: false,
      ...overrides,
    };
  };
  const context = (runs) => ({
    harness: 'claude',
    now: NOW,
    run: runs[0] ?? null,
    runs,
    config: { releaseCommands: [], protectedPaths: [], secretAllow: [], testCommands: [] },
    matchesGlob,
  });
  const approve = { kind: 'prompt', text: 'approve' };

  it.each([
    'Human Approval',
    'HUMAN_APPROVAL (step 9)',
    '9. HUMAN_APPROVAL',
    'human-approval',
    'Ship',
    '6. SHIP',
  ])('records approval when the stage is written as "%s"', (stage) => {
    const waiting = run({ stage });
    expect(approval(approve, context([waiting])).note).toContain('recorded');
    expect(existsSync(join(waiting.dir, '09-approval.md'))).toBe(true);
  });

  it('records approval for the run that is waiting, not a newer run that is still running', () => {
    const newer = run({ name: 'newer', status: 'running', stage: 'BUILD' });
    const waiting = run({ name: 'waiting' });
    const result = approval(approve, context([newer, waiting]));
    expect(result.note).toContain('waiting');
    expect(existsSync(join(waiting.dir, '09-approval.md'))).toBe(true);
    expect(existsSync(join(newer.dir, '09-approval.md'))).toBe(false);
  });

  it('blocks a release while any active run is unapproved', () => {
    const newerApproved = run({ name: 'newer', approved: true });
    const waiting = run({ name: 'waiting' });
    const result = approval(
      { kind: 'shell', command: 'git push' },
      context([newerApproved, waiting])
    );
    expect(result.block).toContain('waiting');
    expect(
      approval({ kind: 'shell', command: 'git push' }, context([newerApproved]))
    ).toBeUndefined();
  });

  it('says why when approve is typed and no run is at its approval step', () => {
    const building = run({ status: 'running', stage: 'BUILD' });
    const result = approval(approve, context([building]));
    expect(result.block).toBeUndefined();
    expect(result.note).toContain('was not recorded');
    expect(result.note).toContain('BUILD');
    expect(existsSync(join(building.dir, '09-approval.md'))).toBe(false);
  });

  it('stays silent when approve is typed and no run is active', () => {
    expect(approval(approve, context([]))).toBeUndefined();
    expect(approval(approve, context([run({ approved: true })]))).toBeUndefined();
  });
});

describe('secret-guard false positives', () => {
  const ctx = { config: { secretAllow: [] } };
  const write = (content) => secretGuard({ kind: 'write', path: 'src/a.js', content }, ctx);
  const firebase = `AIzaSy${'D4x7Kq9LmN2pR5sT8vW1yZ3bC6eF0gH4j'}`;

  it.each([
    ['a CSS class starting with sk-', '.sk-folding-cube-animation-delay { opacity: 0; }'],
    ['an identifier starting with sk-', 'const id = "sk-skeleton_loader_placeholder_row";'],
    ['a Firebase web API key, which is public by design', `apiKey: "${firebase}",`],
    ['the documented AWS example key', `aws_access_key_id = AKIA${'IOSFODNN7'}EXAMPLE`],
  ])('allows %s', (_label, content) => {
    expect(write(content)).toBeUndefined();
  });

  it('still blocks real-looking keys', () => {
    expect(write(`OPENAI_API_KEY=sk-${'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z'}`).block).toContain(
      'OpenAI'
    );
    expect(write(`key = "sk-proj-${'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z'}"`).block).toContain('OpenAI');
    expect(write(`AKIA${'ABCDEFGH12345678'}`).block).toContain('AWS');
  });
});

describe('wiring leaves the user entries alone', () => {
  const lookalike = { hooks: [{ type: 'command', command: 'node tools/forgeflow/run.mjs lint' }] };
  const notify = { type: 'command', command: './notify.sh' };

  it('keeps a user entry in an event forgeflow does not wire, even if it names a similar path', () => {
    const config = { hooks: { PostToolUse: [lookalike], Stop: [lookalike] } };
    const merged = mergeWiring(config, claude.wiring);
    expect(merged.hooks.PostToolUse).toEqual([lookalike]);
    expect(merged.hooks.Stop).toEqual([lookalike, claude.wiring.entries.Stop]);
    expect(stripWiring(merged, claude.wiring)).toEqual(config);
  });

  it('keeps a handler the user added inside a forgeflow group', () => {
    const merged = mergeWiring(undefined, claude.wiring);
    merged.hooks.Stop[0].hooks.push(notify);
    const again = mergeWiring(merged, claude.wiring);
    expect(again.hooks.Stop).toEqual([{ hooks: [notify] }, claude.wiring.entries.Stop]);
    expect(isWired(again, claude.wiring)).toBe(true);
    expect(stripWiring(again, claude.wiring).hooks).toEqual({ Stop: [{ hooks: [notify] }] });
  });

  it('strips only its own entries from a Cursor config', () => {
    const mine = { command: './my-hook.sh' };
    const merged = mergeWiring(
      { version: 1, hooks: { stop: [mine], afterFileEdit: [mine] } },
      cursor.wiring
    );
    expect(merged.hooks.stop).toEqual([mine, cursor.wiring.entries.stop]);
    expect(stripWiring(merged, cursor.wiring)).toEqual({
      version: 1,
      hooks: { stop: [mine], afterFileEdit: [mine] },
    });
    // A hooks object forgeflow emptied is dropped; the file is still bare.
    expect(stripWiring(mergeWiring(undefined, cursor.wiring), cursor.wiring)).toEqual({
      version: 1,
    });
  });
});
