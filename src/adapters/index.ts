import { UsageError } from '../errors.js';
import type { Adapter } from '../types.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as cursor from './cursor.js';
import * as opencode from './opencode.js';

// To support another harness: add its module and one line here.
export const adapters: Record<string, Adapter> = { claude, codex, opencode, cursor };
export const targetNames = Object.keys(adapters);

export function getAdapter(name: string): Adapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new UsageError(`unknown target "${name}". Choose from: ${targetNames.join(', ')}.`);
  }
  return adapter;
}
