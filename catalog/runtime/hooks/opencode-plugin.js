// OpenCode plugin: runs forgeflow gates before tool calls and on user messages.
// Lives in .opencode/plugins/; the runtime and gates live in .opencode/forgeflow/.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '..', 'forgeflow');
const root = resolve(here, '..', '..');

export const ForgeflowGates = async () => {
  let runtime;
  let gates;
  try {
    runtime = await import(pathToFileURL(resolve(dir, 'runtime.mjs')).href);
    gates = await runtime.loadGates(resolve(dir, 'gates'));
  } catch {
    return {}; // a broken install must not stop OpenCode from starting
  }

  const check = (payload) => {
    let result;
    try {
      result = runtime.evaluate({ harness: 'opencode', payload, root, gates });
    } catch {
      return; // fail open
    }
    if (result.block) throw new Error(result.block);
  };

  return {
    'tool.execute.before': async (input, output) => {
      check({ hook: 'tool', tool: input?.tool, args: output?.args });
    },
    'chat.message': async (_input, output) => {
      const parts = Array.isArray(output?.parts) ? output.parts : [];
      const text = parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      check({ hook: 'prompt', text });
    },
  };
};
