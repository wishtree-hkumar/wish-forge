// Tokens an agent or skill body may contain. Each adapter fills them with its
// own locations, so the text looks only in the harness it is installed for.
const TOKENS = {
  '{{agents-dir}}': (places) => places.agentDirs.project,
  '{{global-agents-dir}}': (places) => places.agentDirs.global,
  '{{rules-location}}': (places) => places.rulesLocation,
};
const TOKEN_RE = /\{\{[^{}]*\}\}/g;

export const PLACEHOLDERS = Object.keys(TOKENS);

// A known name in one brace too few or too many, such as {agents-dir} or
// {{agents-dir}, would otherwise ship as literal text.
const NAMES = 'agents-dir|global-agents-dir|rules-location';
const NEAR_MISS = new RegExp(
  `(?<!\\{)\\{(?:${NAMES})\\}(?!\\})|\\{\\{(?:${NAMES})\\}(?!\\})|(?<!\\{)\\{(?:${NAMES})\\}\\}`,
  'g'
);

export function unknownPlaceholders(text) {
  const found = new Set([...(text.match(TOKEN_RE) ?? []), ...(text.match(NEAR_MISS) ?? [])]);
  return [...found].filter((token) => !Object.hasOwn(TOKENS, token));
}

// places is an adapter's { agentDirs: { project, global }, rulesLocation }.
export function fillPlaceholders(text, places) {
  return text.replace(TOKEN_RE, (token) =>
    Object.hasOwn(TOKENS, token) ? TOKENS[token](places) : token
  );
}
