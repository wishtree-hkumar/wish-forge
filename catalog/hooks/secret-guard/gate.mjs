// Exported so session-memory's copy can be checked against it.
export const PATTERNS = [
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  // A digit and a capital are required, so CSS classes and identifiers that
  // merely start with sk- are not mistaken for keys.
  [
    'OpenAI API key',
    /\bsk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{20,}/,
  ],
  ['private key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
];
const ALLOW_MARK = 'forgeflow-allow-secret';
// Vendors publish these as documentation samples.
const DOCUMENTED_EXAMPLE = /EXAMPLE$/;

export function check(event, ctx) {
  if (event.kind !== 'write') return undefined;

  for (const line of event.content.split('\n')) {
    if (line.includes(ALLOW_MARK)) continue;
    for (const [kind, pattern] of PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      if (DOCUMENTED_EXAMPLE.test(match[0])) continue;
      if (ctx.config.secretAllow.some((allow) => allow.test(match[0]))) continue;
      return {
        block:
          `forgeflow secret-guard: the text being written to ${event.path} looks like it ` +
          `contains a ${kind}. Read it from an environment variable or a secret store instead. ` +
          `If this is a false positive, a person can add ${ALLOW_MARK} to that line.`,
      };
    }
  }
  return undefined;
}
