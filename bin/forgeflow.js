#!/usr/bin/env node
import { homedir } from 'node:os';
import { main } from '../src/cli.js';

// A reader that stops early, such as `forgeflow list | head`, closes the pipe:
// that ends the command, it is not an error.
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') throw error;
  process.exit(process.exitCode ?? 0);
});

process.exitCode = main(process.argv.slice(2), {
  cwd: process.cwd(),
  home: homedir(),
  stdout: process.stdout,
  stderr: process.stderr,
});
