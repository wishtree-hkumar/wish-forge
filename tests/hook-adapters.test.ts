import { describe, expect, it } from 'vitest';
import type { Item } from '../src/types.js';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as cursor from '../src/adapters/cursor.js';
import * as opencode from '../src/adapters/opencode.js';
import { isWired, mergeWiring } from '../src/wiring.js';

const ctx = { scope: 'project' as const, version: '0.2.0' };
const hook: Item = {
  id: 'hook:secret-guard',
  type: 'hook',
  name: 'secret-guard',
  description: 'Blocks secrets.',
  events: ['write'],
  requires: ['runtime:hooks'],
  body: 'About.',
  gate: 'export function check() {}\n',
  files: [],
  source: 'hooks/secret-guard/HOOK.md',
};
const runtime: Item = {
  id: 'runtime:hooks',
  type: 'runtime',
  name: 'hooks',
  description: 'Runner.',
  requires: [],
  body: 'About.',
  sources: {
    'run.mjs': '// run\n',
    'runtime.mjs': '// runtime\n',
    'opencode-plugin.js': '// plugin\n',
  },
  files: [],
  source: 'runtime/hooks/RUNTIME.md',
};

describe.each([
  ['claude', claude, '.claude'],
  ['codex', codex, '.codex'],
  ['cursor', cursor, '.cursor'],
])('%s', (_name, adapter, dir) => {
  it('renders a gate into its wishforge folder with a marker line', () => {
    expect(adapter.render(hook, ctx)).toEqual([
      {
        path: `${dir}/wishforge/gates/secret-guard.mjs`,
        content: '// managed by wishforge: hook:secret-guard@0.2.0\nexport function check() {}\n',
      },
    ]);
  });

  it('renders the runner and runtime', () => {
    expect(adapter.render(runtime, ctx)).toEqual([
      {
        path: `${dir}/wishforge/run.mjs`,
        content: '// managed by wishforge: runtime:hooks@0.2.0\n// run\n',
      },
      {
        path: `${dir}/wishforge/runtime.mjs`,
        content: '// managed by wishforge: runtime:hooks@0.2.0\n// runtime\n',
      },
    ]);
  });

  it('describes wiring whose every entry runs its own runner', () => {
    const { wiring } = adapter;
    expect(wiring.path.startsWith(`${dir}/`)).toBe(true);
    for (const entry of Object.values(wiring.entries)) {
      const text = JSON.stringify(entry);
      expect(text).toContain(`${dir}/wishforge/run.mjs`);
      expect(text).toContain('"timeout":10');
    }
    expect(isWired(mergeWiring(undefined, wiring), wiring)).toBe(true);
  });
});

describe('wiring details', () => {
  it('claude wires four events into settings.json', () => {
    const { wiring } = claude;
    expect(wiring.path).toBe('.claude/settings.json');
    expect(wiring.skeleton).toEqual({});
    const handler = {
      type: 'command',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/wishforge/run.mjs" claude',
      timeout: 10,
    };
    expect(wiring.entries).toEqual({
      PreToolUse: { matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [handler] },
      UserPromptSubmit: { hooks: [handler] },
      Stop: { hooks: [handler] },
      SessionStart: { matcher: 'startup|clear|compact', hooks: [handler] },
    });
  });

  it('codex wires four events into hooks.json and finds the repo root itself', () => {
    const { wiring } = codex;
    expect(wiring.path).toBe('.codex/hooks.json');
    expect(wiring.skeleton).toEqual({});
    expect(Object.keys(wiring.entries)).toEqual([
      'PreToolUse',
      'UserPromptSubmit',
      'Stop',
      'SessionStart',
    ]);
    expect(wiring.entries.PreToolUse.matcher).toBe('Bash|apply_patch|Edit|Write');
    expect(wiring.entries.Stop.hooks[0].command).toBe(
      'node "$(git rev-parse --show-toplevel)/.codex/wishforge/run.mjs" codex'
    );
  });

  it('cursor wires five events into a versioned hooks.json', () => {
    const { wiring } = cursor;
    expect(wiring.path).toBe('.cursor/hooks.json');
    expect(wiring.skeleton).toEqual({ version: 1, hooks: {} });
    const entry = { command: 'node .cursor/wishforge/run.mjs cursor', timeout: 10 };
    expect(wiring.entries).toEqual({
      preToolUse: entry,
      beforeSubmitPrompt: entry,
      stop: entry,
      sessionStart: entry,
      preCompact: entry,
    });
  });
});

describe('opencode', () => {
  it('renders a gate beside the runtime', () => {
    expect(opencode.render(hook, ctx)[0].path).toBe('.opencode/wishforge/gates/secret-guard.mjs');
  });

  it('renders the runtime and a plugin, and no runner', () => {
    expect(opencode.render(runtime, ctx)).toEqual([
      {
        path: '.opencode/wishforge/runtime.mjs',
        content: '// managed by wishforge: runtime:hooks@0.2.0\n// runtime\n',
      },
      {
        path: '.opencode/plugins/wishforge.js',
        content: '// managed by wishforge: runtime:hooks@0.2.0\n// plugin\n',
      },
    ]);
  });

  it('has no config wiring', () => {
    expect(opencode.wiring).toBeNull();
  });
});
