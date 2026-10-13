import { UsageError } from './errors.js';

const TYPES = ['agent', 'skill', 'hook'];
const unknown = (ref) =>
  new UsageError(`unknown item "${ref}". Run "forgeflow list" to see available items.`);

export function findId(catalog, ref) {
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

export function resolve(catalog, refs) {
  const explicit = new Set(refs.map((ref) => findId(catalog, ref)));
  const order = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of catalog.get(id).requires) visit(dep);
    order.push(id);
  };
  for (const id of explicit) visit(id);
  return order.map((id) => ({ item: catalog.get(id), explicit: explicit.has(id) }));
}
