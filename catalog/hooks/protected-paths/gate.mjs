const DEFAULTS = ['.env', '.env.*', '*.pem', '*.key'];
// Committed templates that the .env.* default would otherwise catch.
const TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

export function check(event, ctx) {
  if (event.kind !== 'write') return undefined;

  const name = event.path.split('/').pop();
  const matches = (glob) => ctx.matchesGlob(event.path, glob);
  const pattern =
    ctx.config.protectedPaths.find(matches) ??
    (TEMPLATES.has(name) ? undefined : DEFAULTS.find(matches));
  if (!pattern) return undefined;

  return {
    block:
      `forgeflow protected-paths: ${event.path} is protected (${pattern}). A person must change ` +
      'this file, or remove the pattern from protectedPaths in .forgeflow/config.json.',
  };
}
