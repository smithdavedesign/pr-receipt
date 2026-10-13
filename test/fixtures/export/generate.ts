// Regenerates this directory: `node test/fixtures/export/generate.ts` from the repo root.
// feat-demo.prreceipt.json is what `prreceipt export` writes for feat/demo in test/fixtures/three-messages, and
// feat-demo.md is what `show` printed for the same logs. EC13 posts the JSON through the Action and expects the
// markdown, which pins format prreceipt/1: a file exported today must render the same tomorrow. If the
// receipt's rendering changes on purpose, rerun this script and review the diff of feat-demo.md.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../../src/cli.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const logs = join(here, '..', 'three-messages');
const EXPORTED_AT = Date.parse('2026-10-13T12:00:00Z');

async function cli(argv: string[]): Promise<string> {
  let out = '';
  let err = '';
  const home = await mkdtemp(join(tmpdir(), 'prr-gen-'));
  const code = await main(argv, {
    env: {},
    cwd: root, // a git repo, which export needs; feat/demo isn't a branch in it, so there's no diff or window
    home,
    now: () => EXPORTED_AT,
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
  });
  if (code !== 0) throw new Error(`prreceipt ${argv.join(' ')} exited ${code}: ${err}`);
  return out;
}

const scope = ['--logs', logs, '--repo', '/home/dev/demo'];
const exported = await cli(['export', 'feat/demo', ...scope, '--out', join(here, 'feat-demo.prreceipt.json')]);
const shown = await cli(['show', 'feat/demo', ...scope]);
if (exported !== shown) throw new Error('export printed something other than show');
await writeFile(join(here, 'feat-demo.md'), shown);
