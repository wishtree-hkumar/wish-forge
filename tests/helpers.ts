import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Item, Output } from '../src/types';

export function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'wishforge-'));
}

export function writeTree(root: string, tree: Record<string, string | Buffer>): string {
  for (const [path, content] of Object.entries(tree)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

export function agentMd(name, extra = '') {
  return `---\nname: ${name}\ndescription: Does ${name} things.\naccess: read-only\n${extra}---\nBody of ${name}.\n`;
}

export function skillMd(name, extra = '') {
  return `---\nname: ${name}\ndescription: Runs ${name}.\n${extra}---\nSteps of ${name}.\n`;
}

export function ruleMd(name, extra = '') {
  return `---\nname: ${name}\ndescription: ${name} standards.\n${extra}---\n# ${name}\n\n- A rule of ${name}.\n`;
}

export function item(overrides: Partial<Item> = {}): Item {
  return {
    id: 'agent:reviewer',
    type: 'agent',
    name: 'reviewer',
    description: 'Reviews a change.',
    stage: 'review',
    access: 'read-only',
    modelTier: 'strong',
    requires: [],
    body: 'You review code.',
    files: [],
    source: 'agents/reviewer.md',
    ...overrides,
  };
}

export function skill(overrides: Partial<Item> = {}): Item {
  return {
    id: 'skill:forge-quick',
    type: 'skill',
    name: 'forge-quick',
    description: 'Run the quick flow.',
    userInvocableOnly: true,
    requires: [],
    body: 'Follow the steps.',
    files: [],
    source: 'skills/forge-quick/SKILL.md',
    ...overrides,
  };
}

// An output that keeps what is written. isTTY and columns may be set to act as a terminal.
export function capture(): Output & { readonly text: string } {
  let text = '';
  return {
    write(chunk: string) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}
