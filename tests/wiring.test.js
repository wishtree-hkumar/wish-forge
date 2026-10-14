import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import {
  isBare,
  isWired,
  mergeWiring,
  parseConfig,
  serialize,
  stripWiring,
} from '../src/wiring.js';

const handler = {
  type: 'command',
  command: 'node "$X/.claude/wishforge/run.mjs" claude',
  timeout: 10,
};
const claude = {
  path: '.claude/settings.json',
  runner: '.claude/wishforge/run.mjs',
  skeleton: {},
  entries: {
    PreToolUse: { matcher: 'Bash|Write', hooks: [handler] },
    Stop: { hooks: [handler] },
  },
};
const cursor = {
  path: '.cursor/hooks.json',
  runner: '.cursor/wishforge/run.mjs',
  skeleton: { version: 1, hooks: {} },
  entries: { preToolUse: { command: 'node .cursor/wishforge/run.mjs cursor', timeout: 10 } },
};
const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: './my-hook.sh' }] };

describe('mergeWiring', () => {
  it('builds a config from the skeleton when there is none', () => {
    expect(mergeWiring(undefined, claude)).toEqual({
      hooks: { PreToolUse: [claude.entries.PreToolUse], Stop: [claude.entries.Stop] },
    });
    expect(mergeWiring(undefined, cursor)).toEqual({
      version: 1,
      hooks: { preToolUse: [cursor.entries.preToolUse] },
    });
  });

  it('keeps every other key and the user entries, in order, with ours last', () => {
    const config = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { PreToolUse: [mine], SessionStart: [mine] },
      model: 'opus',
    };
    const merged = mergeWiring(config, claude);
    expect(Object.keys(merged)).toEqual(['permissions', 'hooks', 'model']);
    expect(merged.permissions).toEqual(config.permissions);
    expect(merged.hooks.PreToolUse).toEqual([mine, claude.entries.PreToolUse]);
    expect(merged.hooks.SessionStart).toEqual([mine]);
    expect(merged.hooks.Stop).toEqual([claude.entries.Stop]);
  });

  it('is idempotent', () => {
    const once = mergeWiring({ hooks: { PreToolUse: [mine] } }, claude);
    expect(mergeWiring(once, claude)).toEqual(once);
  });

  it('replaces an older wishforge entry instead of adding a second one', () => {
    const old = {
      hooks: [{ type: 'command', command: 'node old/.claude/wishforge/run.mjs claude' }],
    };
    const merged = mergeWiring({ hooks: { PreToolUse: [old, mine], Stop: [old] } }, claude);
    expect(merged.hooks.PreToolUse).toEqual([mine, claude.entries.PreToolUse]);
    expect(merged.hooks.Stop).toEqual([claude.entries.Stop]);
  });

  it('does not mutate its input', () => {
    const config = { hooks: { PreToolUse: [mine] } };
    const before = JSON.stringify(config);
    mergeWiring(config, claude);
    expect(JSON.stringify(config)).toBe(before);
    expect(JSON.stringify(claude.skeleton)).toBe('{}');
  });
});

describe('stripWiring', () => {
  it('returns the user data exactly as it was before the merge', () => {
    const original = { permissions: { allow: [] }, hooks: { PreToolUse: [mine], Other: [] } };
    expect(stripWiring(mergeWiring(original, claude), claude)).toEqual(original);
  });

  it('removes the hooks key when only our entries were in it', () => {
    expect(stripWiring(mergeWiring({ model: 'opus' }, claude), claude)).toEqual({ model: 'opus' });
    expect(stripWiring(mergeWiring(undefined, claude), claude)).toEqual({});
  });

  it('drops a hooks object it emptied, even where the skeleton has one', () => {
    expect(stripWiring(mergeWiring(undefined, cursor), cursor)).toEqual({ version: 1 });
    expect(isBare({ version: 1 }, cursor.skeleton)).toBe(true);
    expect(isBare({ version: 1, other: true }, cursor.skeleton)).toBe(false);
  });

  it('leaves a config without our entries unchanged', () => {
    const config = { hooks: { PreToolUse: [mine] } };
    expect(stripWiring(config, claude)).toEqual(config);
    expect(stripWiring({ a: 1 }, claude)).toEqual({ a: 1 });
    expect(stripWiring({ hooks: {} }, claude)).toEqual({ hooks: {} });
  });
});

describe('isWired', () => {
  it('is true only when every wired event has the exact entry', () => {
    const merged = mergeWiring({ hooks: { PreToolUse: [mine] } }, claude);
    expect(isWired(merged, claude)).toBe(true);
    expect(isWired({ hooks: { PreToolUse: [claude.entries.PreToolUse] } }, claude)).toBe(false);
    expect(isWired({}, claude)).toBe(false);
    const changed = mergeWiring(undefined, claude);
    changed.hooks.Stop[0].hooks[0].timeout = 99;
    expect(isWired(changed, claude)).toBe(false);
  });
});

describe('parseConfig', () => {
  it('parses a valid config', () => {
    expect(parseConfig('{"hooks":{"Stop":[]}}', 'a.json')).toEqual({ hooks: { Stop: [] } });
    expect(parseConfig('{}', 'a.json')).toEqual({});
  });

  it.each([
    ['invalid JSON', '{ broken', 'is not valid JSON'],
    ['a list', '[]', 'must contain a JSON object'],
    ['a string', '"x"', 'must contain a JSON object'],
    ['hooks as a list', '{"hooks":[]}', '"hooks" value that is not an object'],
    [
      'an event that is not a list',
      '{"hooks":{"Stop":{}}}',
      '"hooks.Stop" value that is not a list',
    ],
  ])('refuses %s and names the file', (_label, text, message) => {
    expect(() => parseConfig(text, '.claude/settings.json')).toThrow(ConfigError);
    expect(() => parseConfig(text, '.claude/settings.json')).toThrow(message);
    expect(() => parseConfig(text, '.claude/settings.json')).toThrow('.claude/settings.json');
  });
});

describe('serialize', () => {
  it('uses two-space indentation and a trailing newline', () => {
    expect(serialize({ a: { b: 1 } })).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
  });
});
