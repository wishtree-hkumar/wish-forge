// OpenCode plugin: runs wishforge hooks before tool calls, on user messages and before compaction.
// Lives in .opencode/plugins/; the runtime and gates live in .opencode/wishforge/.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '..', 'wishforge');
const root = resolve(here, '..', '..');

// OpenCode's payloads are read defensively, so they are not typed here.
export const WishforgeGates = async () => {
  /** @type {any} */
  let runtime;
  /** @type {unknown} */
  let gates;
  try {
    runtime = await import(pathToFileURL(resolve(dir, 'runtime.mjs')).href);
    gates = await runtime.loadGates(resolve(dir, 'gates'));
  } catch {
    return {}; // a broken install must not stop OpenCode from starting
  }

  const evaluate = (/** @type {object} */ payload) => {
    try {
      return runtime.evaluate({ harness: 'opencode', payload, root, gates });
    } catch {
      return {}; // fail open
    }
  };
  const check = (/** @type {object} */ payload) => {
    const result = evaluate(payload);
    if (result.block) throw new Error(result.block);
  };

  return {
    'tool.execute.before': async (/** @type {any} */ input, /** @type {any} */ output) => {
      check({ hook: 'tool', tool: input?.tool, args: output?.args, session: input?.sessionID });
    },
    'chat.message': async (/** @type {any} */ input, /** @type {any} */ output) => {
      /** @type {any[]} */
      const parts = Array.isArray(output?.parts) ? output.parts : [];
      const text = parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      check({ hook: 'prompt', text, session: input?.sessionID });
    },
    // The only place OpenCode lets a plugin add to what survives compaction.
    'experimental.session.compacting': async (
      /** @type {any} */ input,
      /** @type {any} */ output
    ) => {
      const result = evaluate({ hook: 'compact', session: input?.sessionID });
      if (Array.isArray(output?.context)) output.context.push(...(result.contexts ?? []));
    },
  };
};
