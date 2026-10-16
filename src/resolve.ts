import { UsageError } from './errors.js';
import type { Catalog, Item } from './types.js';

const TYPES = ['agent', 'skill', 'hook', 'rule'];
const unknown = (ref: string) =>
  new UsageError(`unknown item "${ref}". Run "wishforge list" to see available items.`);

export function findId(catalog: Catalog, ref: string): string {
  if (ref.includes(':')) {
    if (catalog.has(ref)) return ref;
    throw unknown(ref);
  }
  const matches = TYPES.map((type) => `${type}:${ref}`).filter((id) => catalog.has(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new UsageError(`"${ref}" is ambiguous: use ${matches.join(' or ')}.`);
  }
  throw unknown(ref);
}

export function resolve(catalog: Catalog, refs: string[]): { item: Item; explicit: boolean }[] {
  const explicit = new Set(refs.map((ref) => findId(catalog, ref)));
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of catalog.get(id)!.requires) visit(dep);
    order.push(id);
  };
  for (const id of explicit) visit(id);
  return order.map((id) => ({ item: catalog.get(id)!, explicit: explicit.has(id) }));
}
