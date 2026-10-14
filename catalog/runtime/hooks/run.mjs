// Entry point for Claude Code, Codex and Cursor hooks: node run.mjs <harness>
// Any failure here exits 1, which every harness treats as "proceed".
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

try {
  const { handle } = await import('./runtime.mjs');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const out = await handle(process.argv[2], JSON.parse(raw), {
    root: resolve(here, '..', '..'),
    gatesDir: resolve(here, 'gates'),
  });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(`${out.stderr}\n`);
  process.exitCode = out.code;
} catch (error) {
  process.stderr.write(`wishforge hook failed and was skipped: ${error.message}\n`);
  process.exitCode = 1;
}
