import { describe, expect, it } from 'vitest';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as cursor from '../src/adapters/cursor.js';
import * as opencode from '../src/adapters/opencode.js';
import { isWired, mergeWiring } from '../src/wiring.js';

const ctx = { scope: 'project', version: '0.2.0' };
const hook = {
  id: 'hook:secret-guard',
  type: 'hook',
  name: 'secret-guard',
  description: 'Blocks secrets.',
  events: ['write'],
  requires: ['runtime:hooks'],
  body: 'About.',
  gate: 'export function check() {}\n',
  files: [],
};
const runtime = {
  id: 'runtime:hooks',
  type: 'runtime',
  name: 'hooks',
  description: 'Runner.',
  requires: [],
  body: 'About.',
  sources: { 'run.mjs': '// run\n', 'runtime.mjs': '// runtime\n', 'opencode-plugin.js': '// plugin\n' },
  files: [],
};

describe.each([
  ['claude', claude, '.claude'],
  ['codex', codex, '.codex'],
  ['cursor', cursor, '.cursor'],
])('%s', (_name, adapter, dir) => {
  it('renders a gate into its forgeflow folder with a marker line', () => {
    expect(adapter.render(hook, ctx)).toEqual([
      {
        path: `${dir}/forgeflow/gates/secret-guard.mjs`,
        content: '// managed by forgeflow: hook:secret-guard@0.2.0\nexport function check() {}\n',
      },
    ]);
  });

  it('renders the runner and runtime', () => {
    expect(adapter.render(runtime, ctx)).toEqual([
      { path: `${dir}/forgeflow/run.mjs`, content: '// managed by forgeflow: runtime:hooks@0.2.0\n// run\n' },
      {
        path: `${dir}/forgeflow/runtime.mjs`,
        content: '// managed by forgeflow: runtime:hooks@0.2.0\n// runtime\n',
      },
    ]);
  });

  it('describes wiring whose every entry runs its own runner', () => {
    const { wiring } = adapter;
    expect(wiring.path.startsWith(`${dir}/`)).toBe(true);
    for (const entry of Object.values(wiring.entries)) {
      const text = JSON.stringify(entry);
      expect(text).toContain(`${dir}/forgeflow/run.mjs`);
      expect(text).toContain('"timeout":10');
    }
    expect(isWired(mergeWiring(undefined, wiring), wiring)).toBe(true);
  });
});

describe('wiring details', () => {
  it('claude wires three events into settings.json', () => {
    const { wiring } = claude;
    expect(wiring.path).toBe('.claude/settings.json');
    expect(wiring.skeleton).toEqual({});
    const handler = {
      type: 'command',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/forgeflow/run.mjs" claude',
      timeout: 10,
    };
    expect(wiring.entries).toEqual({
      PreToolUse: { matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [handler] },
      UserPromptSubmit: { hooks: [handler] },
      Stop: { hooks: [handler] },
    });
  });

  it('codex wires three events into hooks.json and finds the repo root itself', () => {
    const { wiring } = codex;
    expect(wiring.path).toBe('.codex/hooks.json');
    expect(wiring.skeleton).toEqual({});
    expect(Object.keys(wiring.entries)).toEqual(['PreToolUse', 'UserPromptSubmit', 'Stop']);
    expect(wiring.entries.PreToolUse.matcher).toBe('Bash|apply_patch|Edit|Write');
    expect(wiring.entries.Stop.hooks[0].command).toBe(
      'node "$(git rev-parse --show-toplevel)/.codex/forgeflow/run.mjs" codex'
    );
  });

  it('cursor wires three events into a versioned hooks.json', () => {
    const { wiring } = cursor;
    expect(wiring.path).toBe('.cursor/hooks.json');
    expect(wiring.skeleton).toEqual({ version: 1, hooks: {} });
    const entry = { command: 'node .cursor/forgeflow/run.mjs cursor', timeout: 10 };
    expect(wiring.entries).toEqual({ preToolUse: entry, beforeSubmitPrompt: entry, stop: entry });
  });
});

describe('opencode', () => {
  it('renders a gate beside the runtime', () => {
    expect(opencode.render(hook, ctx)[0].path).toBe('.opencode/forgeflow/gates/secret-guard.mjs');
  });

  it('renders the runtime and a plugin, and no runner', () => {
    expect(opencode.render(runtime, ctx)).toEqual([
      {
        path: '.opencode/forgeflow/runtime.mjs',
        content: '// managed by forgeflow: runtime:hooks@0.2.0\n// runtime\n',
      },
      {
        path: '.opencode/plugins/forgeflow.js',
        content: '// managed by forgeflow: runtime:hooks@0.2.0\n// plugin\n',
      },
    ]);
  });

  it('has no config wiring', () => {
    expect(opencode.wiring).toBeNull();
  });
});
