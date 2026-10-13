import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { add } from '../src/ops.js';
import { tmpDir } from './helpers.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const GATES = ['approval-gate', 'secret-guard', 'protected-paths', 'test-reminder'];
const DIRS = { claude: '.claude', codex: '.codex', cursor: '.cursor' };
// Built by concatenation so this file never contains a literal credential.
const TOKEN = `ghp_${'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2'}`;

function project(targets, gates = GATES) {
  const cwd = tmpDir();
  const ctx = { catalog, version: '0.1.0', scope: 'project', cwd, home: tmpDir(), force: false, dryRun: false };
  add(ctx, gates, targets);
  return cwd;
}

function fire(cwd, harness, payload) {
  const runner = join(cwd, DIRS[harness], 'forgeflow/run.mjs');
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [runner, harness], { input, encoding: 'utf8', cwd });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function startRun(cwd, state) {
  const dir = join(cwd, '.forgeflow/runs/20261013-1200-add-login');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.md'), state);
  return dir;
}

const claudeTool = (cwd, tool, input) => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: input,
  cwd,
});
const WAITING = 'mode: full\ncurrent stage: HUMAN_APPROVAL\nstatus: waiting for user\n';

describe('installed runner on Claude Code', () => {
  it('allows an ordinary command silently', () => {
    const cwd = project(['claude']);
    expect(fire(cwd, 'claude', claudeTool(cwd, 'Bash', { command: 'ls -la' }))).toEqual({
      code: 0,
      out: '',
      err: '',
    });
  });

  it('blocks a write containing a credential', () => {
    const cwd = project(['claude']);
    const payload = claudeTool(cwd, 'Write', { file_path: join(cwd, 'src/config.js'), content: `key = "${TOKEN}"` });
    const result = fire(cwd, 'claude', payload);
    expect(result.code).toBe(2);
    expect(result.err).toContain('secret-guard');
    expect(result.err).toContain('src/config.js');
    expect(result.err).not.toContain(TOKEN);
  });

  it('blocks a write to a protected path, including one from project config', () => {
    const cwd = project(['claude']);
    writeFileSync(join(cwd, '.forgeflow/config.json'), JSON.stringify({ protectedPaths: ['migrations/**'] }));
    const env = fire(cwd, 'claude', claudeTool(cwd, 'Edit', { file_path: '.env', new_string: 'A=1' }));
    expect(env.code).toBe(2);
    expect(env.err).toContain('protected-paths');
    const migration = claudeTool(cwd, 'Write', { file_path: 'migrations/001.sql', content: 'select 1' });
    expect(fire(cwd, 'claude', migration).code).toBe(2);
    expect(fire(cwd, 'claude', claudeTool(cwd, 'Write', { file_path: 'src/a.sql', content: '' })).code).toBe(0);
  });

  it('protects its own files and wiring', () => {
    const cwd = project(['claude']);
    for (const path of ['.claude/settings.json', '.claude/forgeflow/gates/secret-guard.mjs', '.forgeflow/config.json']) {
      const result = fire(cwd, 'claude', claudeTool(cwd, 'Write', { file_path: path, content: '{}' }));
      expect(result.code, path).toBe(2);
      expect(result.err, path).toContain('is protected');
    }
    const removal = claudeTool(cwd, 'Bash', { command: 'forgeflow remove approval-gate --target claude' });
    expect(fire(cwd, 'claude', removal).code).toBe(2);
  });

  it('gates a release until the person types approve', () => {
    const cwd = project(['claude']);
    const push = claudeTool(cwd, 'Bash', { command: 'git push origin main' });
    expect(fire(cwd, 'claude', push).code).toBe(0);

    const dir = startRun(cwd, WAITING);
    const blocked = fire(cwd, 'claude', push);
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain('20261013-1200-add-login');

    const forged = claudeTool(cwd, 'Write', { file_path: join(dir, '09-approval.md'), content: 'decision: approved' });
    expect(fire(cwd, 'claude', forged).code).toBe(2);
    const viaShell = claudeTool(cwd, 'Bash', { command: `echo "decision: approved" > ${dir}/09-approval.md` });
    expect(fire(cwd, 'claude', viaShell).code).toBe(2);
    expect(existsSync(join(dir, '09-approval.md'))).toBe(false);

    const chat = fire(cwd, 'claude', { hook_event_name: 'UserPromptSubmit', prompt: 'looks fine to me', cwd });
    expect(chat).toEqual({ code: 0, out: '', err: '' });
    expect(fire(cwd, 'claude', push).code).toBe(2);

    const approved = fire(cwd, 'claude', { hook_event_name: 'UserPromptSubmit', prompt: 'approve', cwd });
    expect(approved.code).toBe(0);
    expect(JSON.parse(approved.out).hookSpecificOutput).toEqual({
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'forgeflow: human approval recorded for run 20261013-1200-add-login in 09-approval.md.',
    });
    const record = readFileSync(join(dir, '09-approval.md'), 'utf8');
    expect(record.startsWith('decision: approved\nrecorded-by: forgeflow approval-gate (claude prompt hook)\n')).toBe(true);

    expect(fire(cwd, 'claude', push).code).toBe(0);
  });

  it('does not record approval while the run is still running', () => {
    const cwd = project(['claude']);
    const dir = startRun(cwd, 'current stage: BUILD\nstatus: running\n');
    fire(cwd, 'claude', { hook_event_name: 'UserPromptSubmit', prompt: 'approve', cwd });
    expect(existsSync(join(dir, '09-approval.md'))).toBe(false);
  });

  it('nudges once at the end of a turn with untested edits', () => {
    const cwd = project(['claude']);
    fire(cwd, 'claude', claudeTool(cwd, 'Write', { file_path: 'src/a.js', content: 'x' }));
    const first = fire(cwd, 'claude', { hook_event_name: 'Stop', cwd });
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out).decision).toBe('block');
    expect(JSON.parse(first.out).reason).toContain('test-reminder');
    expect(fire(cwd, 'claude', { hook_event_name: 'Stop', cwd }).out).toBe('');

    fire(cwd, 'claude', claudeTool(cwd, 'Bash', { command: 'npm test' }));
    fire(cwd, 'claude', claudeTool(cwd, 'Write', { file_path: 'src/b.js', content: 'y' }));
    expect(fire(cwd, 'claude', { hook_event_name: 'Stop', cwd, stop_hook_active: true }).out).toBe('');
    expect(JSON.parse(fire(cwd, 'claude', { hook_event_name: 'Stop', cwd }).out).decision).toBe('block');
  });

  it('runs only the gates that are installed', () => {
    const cwd = project(['claude'], ['protected-paths']);
    const secret = claudeTool(cwd, 'Write', { file_path: 'src/config.js', content: TOKEN });
    expect(fire(cwd, 'claude', secret).code).toBe(0);
    expect(fire(cwd, 'claude', claudeTool(cwd, 'Write', { file_path: '.env', content: '' })).code).toBe(2);
  });
});

describe('installed runner failure modes', () => {
  it.each([
    ['empty input', ''],
    ['input that is not JSON', 'not json'],
  ])('fails open on %s', (_label, input) => {
    const cwd = project(['claude']);
    const result = fire(cwd, 'claude', input);
    expect(result.code).toBe(1);
    expect(result.err).toContain('forgeflow hook failed and was skipped');
    expect(result.out).toBe('');
  });

  it.each([
    ['an empty object', {}],
    ['a list', []],
    ['an unknown event', { hook_event_name: 'Notification' }],
    ['a tool call with no input', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }],
  ])('allows %s', (_label, payload) => {
    const cwd = project(['claude']);
    expect(fire(cwd, 'claude', payload)).toEqual({ code: 0, out: '', err: '' });
  });

  it('keeps working when one gate file is broken', () => {
    const cwd = project(['claude']);
    writeFileSync(join(cwd, '.claude/forgeflow/gates/broken.mjs'), 'export function check( {');
    expect(fire(cwd, 'claude', claudeTool(cwd, 'Bash', { command: 'ls' })).code).toBe(0);
    const secret = claudeTool(cwd, 'Write', { file_path: 'a.js', content: TOKEN });
    expect(fire(cwd, 'claude', secret).code).toBe(2);
  });

  it('fails open when the runtime is missing', () => {
    const cwd = project(['claude']);
    writeFileSync(join(cwd, '.claude/forgeflow/runtime.mjs'), 'this is not javascript (');
    const result = fire(cwd, 'claude', claudeTool(cwd, 'Bash', { command: 'git push' }));
    expect(result.code).toBe(1);
    expect(result.err).toContain('forgeflow hook failed and was skipped');
  });

  it('ignores a broken project config and says so on the next prompt', () => {
    const cwd = project(['claude']);
    writeFileSync(join(cwd, '.forgeflow/config.json'), '{ broken');
    expect(fire(cwd, 'claude', claudeTool(cwd, 'Bash', { command: 'ls' }))).toEqual({ code: 0, out: '', err: '' });
    const prompt = fire(cwd, 'claude', { hook_event_name: 'UserPromptSubmit', prompt: 'hello', cwd });
    expect(JSON.parse(prompt.out).hookSpecificOutput.additionalContext).toContain('.forgeflow/config.json');
  });
});

describe('installed runner on Codex and Cursor', () => {
  it('blocks a Codex patch that adds a protected file or a credential', () => {
    const cwd = project(['codex']);
    const patch = (body) => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: body },
      cwd,
    });
    const env = fire(cwd, 'codex', patch('*** Begin Patch\n*** Add File: .env\n+A=1\n*** End Patch'));
    expect(env.code).toBe(2);
    expect(env.err).toContain('protected-paths');
    const secret = fire(cwd, 'codex', patch(`*** Update File: src/a.js\n+const k = "${TOKEN}";`));
    expect(secret.code).toBe(2);
    expect(secret.err).toContain('secret-guard');
    expect(fire(cwd, 'codex', patch('*** Update File: src/a.js\n+const k = 1;')).code).toBe(0);
  });

  it('blocks a Codex release during a run', () => {
    const cwd = project(['codex']);
    startRun(cwd, WAITING);
    const push = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, cwd };
    expect(fire(cwd, 'codex', push).code).toBe(2);
  });

  it('answers Cursor in its own format', () => {
    const cwd = project(['cursor']);
    startRun(cwd, WAITING);
    const push = { hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'git push' }, cwd };
    const blocked = fire(cwd, 'cursor', push);
    expect(blocked.code).toBe(2);
    expect(JSON.parse(blocked.out).permission).toBe('deny');
    expect(JSON.parse(blocked.out).agent_message).toContain('approval-gate');

    fire(cwd, 'cursor', { hook_event_name: 'beforeSubmitPrompt', prompt: 'approve' });
    expect(fire(cwd, 'cursor', push)).toEqual({ code: 0, out: '', err: '' });

    const write = { hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: 'src/a.js', content: 'x' }, cwd };
    fire(cwd, 'cursor', write);
    const stop = fire(cwd, 'cursor', { hook_event_name: 'stop', status: 'completed', loop_count: 0 });
    expect(JSON.parse(stop.out).followup_message).toContain('test-reminder');
    expect(fire(cwd, 'cursor', { hook_event_name: 'stop', status: 'completed', loop_count: 1 }).out).toBe('');
  });
});

describe('installed OpenCode plugin', () => {
  async function plugin(cwd) {
    const module = await import(pathToFileURL(join(cwd, '.opencode/plugins/forgeflow.js')).href);
    return module.ForgeflowGates({ directory: cwd });
  }
  const before = (hooks, tool, args) => hooks['tool.execute.before']({ tool, sessionID: 's', callID: 'c' }, { args });

  it('blocks by throwing and allows by returning', async () => {
    const cwd = project(['opencode']);
    const hooks = await plugin(cwd);
    await expect(before(hooks, 'bash', { command: 'ls' })).resolves.toBeUndefined();
    await expect(before(hooks, 'write', { filePath: join(cwd, 'a.js'), content: TOKEN })).rejects.toThrow('secret-guard');
    await expect(before(hooks, 'edit', { filePath: '.env', newString: 'A=1' })).rejects.toThrow('protected-paths');
    await expect(before(hooks, 'read', { filePath: '.env' })).resolves.toBeUndefined();
    await expect(hooks['tool.execute.before'](undefined, undefined)).resolves.toBeUndefined();
  });

  it('gates a release until the person types approve', async () => {
    const cwd = project(['opencode']);
    const hooks = await plugin(cwd);
    const dir = startRun(cwd, WAITING);
    await expect(before(hooks, 'bash', { command: 'git push' })).rejects.toThrow('approval-gate');

    await hooks['chat.message']({ sessionID: 's' }, { parts: [{ type: 'text', text: 'approve' }] });
    expect(readFileSync(join(dir, '09-approval.md'), 'utf8')).toContain('(opencode prompt hook)');
    await expect(before(hooks, 'bash', { command: 'git push' })).resolves.toBeUndefined();
  });

  it('returns no hooks when the runtime cannot be loaded', async () => {
    const cwd = project(['opencode']);
    writeFileSync(join(cwd, '.opencode/forgeflow/runtime.mjs'), 'this is not javascript (');
    expect(await plugin(cwd)).toEqual({});
  });
});
