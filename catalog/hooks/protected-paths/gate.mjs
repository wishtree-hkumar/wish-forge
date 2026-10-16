const DEFAULTS = [
  '.env',
  '.env.*',
  '.envrc',
  '*.pem',
  '*.key',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
];
// Committed templates, such as .env.local.example, that the .env.* default would otherwise catch.
const TEMPLATE = /\.(example|sample|template)$/;

// The events the runtime sends, and the parts of its context this gate reads.
// A gate imports nothing, so they are described here.
/**
 * @typedef {{ kind: 'shell', command: string }
 *   | { kind: 'write', path: string, content: string }
 *   | { kind: 'prompt', text: string }
 *   | { kind: 'start', source: string }
 *   | { kind: 'stop' }
 *   | { kind: 'compact' }} Event
 * @typedef {{
 *   config: { protectedPaths: string[] },
 *   matchesGlob: (path: string, glob: string) => boolean,
 * }} Context
 */

/**
 * @param {Event} event
 * @param {Context} ctx
 */
export function check(event, ctx) {
  if (event.kind !== 'write') return undefined;

  const name = /** @type {string} */ (event.path.split('/').pop());
  const matches = (/** @type {string} */ glob) => ctx.matchesGlob(event.path, glob);
  const pattern =
    ctx.config.protectedPaths.find(matches) ??
    (TEMPLATE.test(name) ? undefined : DEFAULTS.find(matches));
  if (!pattern) return undefined;

  return {
    block:
      `wishforge protected-paths: ${event.path} is protected (${pattern}). A person must change ` +
      'this file, or remove the pattern from protectedPaths in .wishforge/config.json.',
  };
}
