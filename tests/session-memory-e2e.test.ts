import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog';
import { add, remove } from '../src/ops';
import { tmpDir, writeTree } from './helpers';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const DIRS = { claude: '.claude', codex: '.codex', cursor: '.cursor' };
const TOKEN = ['ghp_', 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2'].join('');
const LESSONS = '# Project lessons\n\n- (2026-10-01) Run tests with npm test.\n';

function project(targets, items = ['session-memory']) {
  const cwd = tmpDir();
  const ctx = {
    catalog,
    version: '0.1.0',
    scope: 'project' as const,
    cwd,
    home: tmpDir(),
    force: false,
    dryRun: false,
  };
  add(ctx, items, targets);
  return cwd;
}

function fire(cwd, harness, payload) {
  const runner = join(cwd, DIRS[harness], 'wishforge/run.mjs');
  const result = spawnSync(process.execPath, [runner, harness], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const record = (cwd) =>
  JSON.parse(readFileSync(join(cwd, '.wishforge/local/session.json'), 'utf8'));
const writeTool = (cwd, session, path) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: join(cwd, path), content: 'x' },
  cwd,
  session_id: session,
});
const QUIET = { code: 0, out: '', err: '' };

describe.each(['claude', 'codex'])('installed runner on %s', (harness) => {
  it('records writes and prompts without a word, and redacts a credential', () => {
    const cwd = project([harness]);
    expect(fire(cwd, harness, writeTool(cwd, 's-1', 'src/a.js'))).toEqual(QUIET);
    expect(
      fire(cwd, harness, {
        hook_event_name: 'UserPromptSubmit',
        prompt: `deploy with ${TOKEN}`,
        session_id: 's-1',
      })
    ).toEqual(QUIET);

    expect(record(cwd).current).toMatchObject({
      id: 's-1',
      harness,
      files: ['src/a.js'],
      prompts: ['deploy with [redacted]'],
    });
    expect(readFileSync(join(cwd, '.wishforge/local/.gitignore'), 'utf8')).toBe('*\n');
    expect(readFileSync(join(cwd, '.wishforge/local/session.md'), 'utf8')).toContain('- src/a.js');
  });

  it('gives a new session the lessons and the last session, and a resumed one nothing', () => {
    const cwd = project([harness]);
    writeTree(cwd, { '.wishforge/memory/lessons.md': LESSONS });
    fire(cwd, harness, writeTool(cwd, 's-1', 'src/a.js'));

    const started = fire(cwd, harness, {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 's-2',
    });
    expect(started.code).toBe(0);
    const { hookSpecificOutput } = JSON.parse(started.out);
    expect(hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(hookSpecificOutput.additionalContext).toContain('# wishforge memory');
    expect(hookSpecificOutput.additionalContext).toContain('Run tests with npm test.');
    expect(hookSpecificOutput.additionalContext).toContain('## Recent activity (last session)');
    expect(hookSpecificOutput.additionalContext).toContain('- src/a.js');

    expect(
      fire(cwd, harness, { hook_event_name: 'SessionStart', source: 'resume', session_id: 's-2' })
    ).toEqual(QUIET);
  });

  it('gives the session its own activity back after compaction', () => {
    const cwd = project([harness]);
    fire(cwd, harness, writeTool(cwd, 's-1', 'src/a.js'));
    const { out } = fire(cwd, harness, {
      hook_event_name: 'SessionStart',
      source: 'compact',
      session_id: 's-1',
    });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain(
      '## Recent activity (this session so far)'
    );
  });

  it('says nothing to a new session in a project with no memory yet', () => {
    const cwd = project([harness]);
    expect(
      fire(cwd, harness, { hook_event_name: 'SessionStart', source: 'startup', session_id: 's-1' })
    ).toEqual(QUIET);
  });

  it('never fails a tool call when the record cannot be written or is damaged', () => {
    const blocked = project([harness]);
    writeTree(blocked, { '.wishforge/local': 'not a folder' });
    expect(fire(blocked, harness, writeTool(blocked, 's-1', 'src/a.js'))).toEqual(QUIET);

    const damaged = project([harness]);
    writeTree(damaged, { '.wishforge/local/session.json': '{ half' });
    expect(fire(damaged, harness, writeTool(damaged, 's-1', 'src/a.js'))).toEqual(QUIET);
    expect(record(damaged).current.files).toEqual(['src/a.js']);
  });
});

describe('installed runner on Cursor', () => {
  it('adds the memory at session start in its own field', () => {
    const cwd = project(['cursor']);
    writeTree(cwd, { '.wishforge/memory/lessons.md': LESSONS });
    const { code, out } = fire(cwd, 'cursor', {
      hook_event_name: 'sessionStart',
      session_id: 'c-1',
    });
    expect(code).toBe(0);
    expect(JSON.parse(out).additional_context).toContain('Run tests with npm test.');
  });

  it('records under the conversation id and tells the person on compaction', () => {
    const cwd = project(['cursor']);
    fire(cwd, 'cursor', {
      hook_event_name: 'preToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(cwd, 'src/a.js'), content: 'x' },
      conversation_id: 'c-1',
    });
    expect(record(cwd).current).toMatchObject({
      id: 'c-1',
      harness: 'cursor',
      files: ['src/a.js'],
    });

    const { out } = fire(cwd, 'cursor', { hook_event_name: 'preCompact', trigger: 'auto' });
    expect(JSON.parse(out).user_message).toContain('.wishforge/local/session.md');
  });
});

describe('OpenCode', () => {
  it('lists the memory files in opencode.json and adds the record to the compaction prompt', async () => {
    const cwd = project(['opencode']);
    expect(JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8')).instructions).toEqual([
      '.wishforge/memory/*.md',
      '.wishforge/local/*.md',
    ]);

    const url = pathToFileURL(join(cwd, '.opencode/plugins/wishforge.js')).href;
    const hooks = await (await import(url)).WishforgeGates({ directory: cwd });
    await hooks['tool.execute.before'](
      { tool: 'write', sessionID: 'o-1' },
      { args: { filePath: join(cwd, 'src/a.js'), content: 'x' } }
    );
    await hooks['chat.message'](
      { sessionID: 'o-1' },
      { parts: [{ type: 'text', text: 'add a test' }] }
    );
    expect(record(cwd).current).toMatchObject({
      id: 'o-1',
      harness: 'opencode',
      files: ['src/a.js'],
      prompts: ['add a test'],
    });

    const output = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 'o-1' }, output);
    expect(output.context).toHaveLength(1);
    expect(output.context[0]).toContain('- src/a.js');
  });
});

describe('beside the gates', () => {
  it('does not weaken a gate: a blocked write is still blocked, and not recorded', () => {
    const cwd = project(['claude'], ['session-memory', 'protected-paths']);
    const blocked = fire(cwd, 'claude', writeTool(cwd, 's-1', '.env'));
    expect(blocked.code).toBe(2);
    expect(existsSync(join(cwd, '.wishforge/local/session.json'))).toBe(false);
  });

  it('leaves the memory files in place when it is removed', () => {
    const cwd = project(['claude']);
    writeTree(cwd, { '.wishforge/memory/lessons.md': LESSONS });
    fire(cwd, 'claude', writeTool(cwd, 's-1', 'src/a.js'));

    const ctx = {
      catalog,
      version: '0.1.0',
      scope: 'project' as const,
      cwd,
      home: tmpDir(),
      force: false,
    };
    remove({ ...ctx, dryRun: false }, ['session-memory'], ['claude']);

    expect(existsSync(join(cwd, '.claude'))).toBe(false);
    expect(readFileSync(join(cwd, '.wishforge/memory/lessons.md'), 'utf8')).toBe(LESSONS);
    expect(record(cwd).current.files).toEqual(['src/a.js']);
  });
});
