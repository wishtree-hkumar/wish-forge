// Tokens a skill body may contain. Each adapter fills them with its own agents
// folders, so a flow can look for optional agents in the harness it runs in.
const TOKENS = { '{{agents-dir}}': 'project', '{{global-agents-dir}}': 'global' };
const TOKEN_RE = /\{\{[^{}]*\}\}/g;

export const PLACEHOLDERS = Object.keys(TOKENS);

export function unknownPlaceholders(text) {
  const found = new Set(text.match(TOKEN_RE) ?? []);
  return [...found].filter((token) => !Object.hasOwn(TOKENS, token));
}

// agentDirs is an adapter's { project, global } pair.
export function fillPlaceholders(text, agentDirs) {
  return text.replace(TOKEN_RE, (token) =>
    Object.hasOwn(TOKENS, token) ? agentDirs[TOKENS[token]] : token
  );
}
