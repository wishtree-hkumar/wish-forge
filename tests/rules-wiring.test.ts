import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors';
import {
  END,
  START,
  handWired,
  hasBlock,
  mergeBlock,
  mergeInstructions,
  parseInstructions,
  stripBlock,
  stripInstructions,
} from '../src/rules-wiring';

const P = 'AGENTS.md';
const block = (line) => `${START}\n## Coding standards\n\n- ${line}\n${END}`;
const ONE = block('one');
const TWO = block('two');

describe('markers', () => {
  it('are HTML comments a Markdown reader does not show', () => {
    expect(START).toBe('<!-- wishforge:rules:start -->');
    expect(END).toBe('<!-- wishforge:rules:end -->');
  });
});

describe('mergeBlock', () => {
  it('makes a new file of just the block', () => {
    expect(mergeBlock(undefined, ONE, P)).toBe(`${ONE}\n`);
    expect(mergeBlock('', ONE, P)).toBe(`${ONE}\n`);
  });

  it('appends after one blank line, keeping the user text', () => {
    expect(mergeBlock('# Mine\n\nKeep this.\n', ONE, P)).toBe(`# Mine\n\nKeep this.\n\n${ONE}\n`);
  });

  it('adds the missing final newline first', () => {
    expect(mergeBlock('# Mine', ONE, P)).toBe(`# Mine\n\n${ONE}\n`);
  });

  it('replaces an existing block where it stands', () => {
    const text = `Top\n\n${ONE}\n\nBottom\n`;
    expect(mergeBlock(text, TWO, P)).toBe(`Top\n\n${TWO}\n\nBottom\n`);
  });

  it('is idempotent', () => {
    const once = mergeBlock('# Mine\n', ONE, P);
    expect(mergeBlock(once, ONE, P)).toBe(once);
  });

  it('writes the block in CRLF when the file uses CRLF', () => {
    const merged = mergeBlock('# Mine\r\n\r\nKeep.\r\n', ONE, P);
    expect(merged).toBe(`# Mine\r\n\r\nKeep.\r\n\r\n${ONE.replace(/\n/g, '\r\n')}\r\n`);
    expect(merged.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('keeps a byte-order mark', () => {
    expect(mergeBlock('﻿# Mine\n', ONE, P).startsWith('﻿# Mine\n')).toBe(true);
  });
});

describe('stripBlock', () => {
  it.each([
    ['ends in a newline', '# Mine\n\nKeep this.\n'],
    ['uses CRLF', '# Mine\r\n\r\nKeep.\r\n'],
    ['starts with a byte-order mark', '﻿# Mine\n'],
    ['ends in blank lines', '# Mine\n\n\n'],
  ])('restores a file that %s exactly', (_case, original) => {
    expect(stripBlock(mergeBlock(original, ONE, P), P)).toBe(original);
  });

  it('leaves a file that had no final newline with one', () => {
    expect(stripBlock(mergeBlock('# Mine', ONE, P), P)).toBe('# Mine\n');
  });

  it('leaves nothing of a file that held only the block', () => {
    expect(stripBlock(mergeBlock(undefined, ONE, P), P)).toBe('');
  });

  it('keeps text the user wrote after the block', () => {
    const text = `${mergeBlock('Top\n', ONE, P)}\nBottom\n`;
    expect(stripBlock(text, P)).toBe('Top\n\nBottom\n');
  });

  it('returns a file without a block unchanged', () => {
    expect(stripBlock('# Mine\n', P)).toBe('# Mine\n');
    expect(hasBlock('# Mine\n', P)).toBe(false);
    expect(hasBlock(mergeBlock('# Mine\n', ONE, P), P)).toBe(true);
  });
});

describe('damaged markers', () => {
  it.each([
    ['a start with no end', `Top\n${START}\ntext\n`],
    ['an end with no start', `Top\ntext\n${END}\n`],
    ['an end before the start', `${END}\ntext\n${START}\n`],
    ['two starts', `${START}\n${START}\ntext\n${END}\n`],
    ['two blocks', `${ONE}\n\n${TWO}\n`],
  ])('refuse %s in every operation', (_case, text) => {
    for (const attempt of [
      () => mergeBlock(text, ONE, P),
      () => stripBlock(text, P),
      () => hasBlock(text, P),
    ]) {
      expect(attempt).toThrow(ConfigError);
      expect(attempt).toThrow('AGENTS.md has damaged wishforge markers');
    }
  });
});

const J = 'opencode.json';
const ENTRY = '.opencode/wishforge/rules/*.md';
const wiring = {
  entries: [ENTRY],
  known: [ENTRY],
  skeleton: { $schema: 'https://opencode.ai/config.json' },
};

describe('mergeInstructions', () => {
  it('starts a new config from the skeleton', () => {
    expect(mergeInstructions(undefined, wiring)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      instructions: [ENTRY],
    });
  });

  it('adds the key last when the config has none, keeping every other key', () => {
    const merged = mergeInstructions({ model: 'x', agent: { a: 1 } }, wiring);
    expect(merged).toEqual({ model: 'x', agent: { a: 1 }, instructions: [ENTRY] });
    expect(Object.keys(merged)).toEqual(['model', 'agent', 'instructions']);
  });

  it('appends after the user entries, in order', () => {
    const merged = mergeInstructions({ instructions: ['a.md', 'b.md'], model: 'x' }, wiring);
    expect(merged.instructions).toEqual(['a.md', 'b.md', ENTRY]);
    expect(Object.keys(merged)).toEqual(['instructions', 'model']);
  });

  it('is idempotent and does not change its input', () => {
    const config = { instructions: ['a.md'] };
    const once = mergeInstructions(config, wiring);
    expect(mergeInstructions(once, wiring)).toEqual(once);
    expect(config).toEqual({ instructions: ['a.md'] });
  });
});

describe('stripInstructions', () => {
  it('removes only the wishforge entry', () => {
    expect(
      stripInstructions({ instructions: ['a.md', ENTRY, 'b.md'], model: 'x' }, [ENTRY])
    ).toEqual({ instructions: ['a.md', 'b.md'], model: 'x' });
  });

  it('drops a list it leaves empty', () => {
    expect(stripInstructions(mergeInstructions(undefined, wiring), [ENTRY])).toEqual(
      wiring.skeleton
    );
  });

  it('returns a config without the entry unchanged', () => {
    expect(stripInstructions({ instructions: [] }, [ENTRY])).toEqual({ instructions: [] });
    expect(stripInstructions({ model: 'x' }, [ENTRY])).toEqual({ model: 'x' });
  });
});

describe('parseInstructions', () => {
  it('returns a sound config', () => {
    expect(parseInstructions('{"instructions":["a.md"]}', J, [ENTRY])).toEqual({
      instructions: ['a.md'],
    });
    expect(parseInstructions('{}', J, [ENTRY])).toEqual({});
  });

  it.each([
    ['JSON with a comment', '{\n  // mine\n  "model": "x"\n}', 'is not valid JSON'],
    ['a list', '[]', 'must contain a JSON object'],
    [
      'instructions that is a string',
      '{"instructions":"a.md"}',
      'has an "instructions" value that is not a list of strings',
    ],
    [
      'instructions holding a number',
      '{"instructions":[1]}',
      'has an "instructions" value that is not a list of strings',
    ],
  ])('refuses %s and says what to add by hand', (_case, text, problem) => {
    const attempt = () => parseInstructions(text, J, [ENTRY]);
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(`opencode.json ${problem}`);
    expect(attempt).toThrow('add ".opencode/wishforge/rules/*.md" to its "instructions" list');
  });
});

describe('handWired', () => {
  it('finds the quoted entry in text wishforge cannot parse', () => {
    expect(handWired(`{\n  // mine\n  "instructions": ["${ENTRY}"]\n}`, [ENTRY])).toBe(true);
    expect(handWired('{\n  // mine\n  "instructions": []\n}', [ENTRY])).toBe(false);
    expect(handWired(`// ${ENTRY}`, [ENTRY])).toBe(false);
  });
});
