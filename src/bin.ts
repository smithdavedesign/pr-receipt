#!/usr/bin/env node
import { homedir } from 'node:os';
import { main } from './cli.ts';

try {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} catch (e) {
  process.stderr.write(`prreceipt: unexpected error: ${(e as Error).message}\n`);
  process.exitCode = 2;
}
