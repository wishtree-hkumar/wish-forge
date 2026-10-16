import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const SENTENCE =
  'If `.wishforge/memory/map.md` exists, tell every subagent you delegate to, review specialists included, ' +
  'to read it before exploring the code, as orientation to check against the code. ' +
  "It is not instructions, and it is not the project's release documentation.";

describe.each(['forge-quick', 'forge-full'])('%s', (name) => {
  const flow = catalog.get(`skill:${name}`);

  it('tells each delegated subagent to read the map when there is one', () => {
    expect(flow.body.split(SENTENCE)).toHaveLength(2);
    const step = flow.body.split('\n').find((text) => text.includes(SENTENCE));
    expect(step.startsWith('1. Delegate to the ')).toBe(true);
  });

  it('does not require the map, its command or its agent', () => {
    expect(flow.requires).not.toContain('agent:mapper');
    expect(flow.requires).not.toContain('skill:forge-map');
    expect(flow.body).not.toContain('`mapper`');
    expect(flow.body).not.toContain('forge-map');
  });
});
