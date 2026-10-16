import { UsageError } from '../errors';
import type { Adapter } from '../types';
import * as claude from './claude';
import * as codex from './codex';
import * as cursor from './cursor';
import * as opencode from './opencode';

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
