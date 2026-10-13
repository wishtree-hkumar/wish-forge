#!/usr/bin/env node
import { homedir } from 'node:os';
import { main } from '../src/cli.js';

process.exitCode = main(process.argv.slice(2), {
  cwd: process.cwd(),
  home: homedir(),
  stdout: process.stdout,
  stderr: process.stderr,
});
