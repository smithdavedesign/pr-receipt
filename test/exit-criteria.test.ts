// One block per M1 exit criterion in ROADMAP.md.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogs } from '../src/parse.ts';
import { loadPrices } from '../src/pricing.ts';
import { buildReceipt } from '../src/receipt.ts';
import { BRANCHES, THREE_MESSAGES, near, run, tempDir, writeJson } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('EC1: 3 assistant messages of 1,000 in / 500 out at $3/$15 per M', () => {
  it('computes a $0.0315 total and 4,500 tokens', async () => {
    const { entries } = await parseLogs([THREE_MESSAGES]);
    const prices = await loadPrices();
    const receipt = buildReceipt(entries, 'feat/demo', prices);
    assert.ok(near(receipt.totalCost, 0.0315, 0.0001), `total was ${receipt.totalCost}`);
    assert.equal(receipt.totalTokens, 4500);
    assert.equal(receipt.input, 3000);
    assert.equal(receipt.output, 1500);
  });

  it('`show` prints the $0.0315 total and 4,500 tokens in a markdown receipt', async () => {
    const { code, out } = await run(['show', 'feat/demo', '--logs', THREE_MESSAGES]);
    assert.equal(code, 0);
    assert.match(out, /^## /m, 'receipt starts with a markdown heading');
    assert.match(out, /\$0\.0315/);
    assert.match(out, /4,500/);
    assert.match(out, /API-equivalent estimate/);
  });

  it('never prints prompt or response text', async () => {
    const { out, err } = await run(['show', 'feat/demo', '--logs', THREE_MESSAGES]);
    assert.doesNotMatch(out + err, /PROMPT-MARKER|RESPONSE-MARKER|login form/);
  });
});

describe('EC2: `show feat/a` only includes feat/a sessions', () => {
  it('counts the 2 feat/a sessions and only their tokens', async () => {
    const { entries } = await parseLogs([BRANCHES]);
    const receipt = buildReceipt(entries, 'feat/a', await loadPrices());
    assert.equal(receipt.sessions, 2);
    // s-a1: 2 sonnet-4-5 msgs (1,000/500) = 0.021; s-a2: opus-4-5 2,000 in, 1,000 out, 4,000 cache write, 10,000 cache read = 0.065
    assert.ok(near(receipt.totalCost, 0.086, 1e-9), `total was ${receipt.totalCost}`);
    assert.equal(receipt.totalTokens, 20000);
  });

  it('prints 2 sessions and none of feat/b', async () => {
    const { code, out } = await run(['show', 'feat/a', '--logs', BRANCHES]);
    assert.equal(code, 0);
    assert.match(out, /Sessions:\*\* 2\b/);
    assert.match(out, /\$0\.0860/);
    assert.doesNotMatch(out, /feat\/b/);
    assert.doesNotMatch(out, /\$0\.0450/, 'feat/b total must not appear');
    assert.doesNotMatch(out, /7,000/, 'feat/b tokens must not appear');
  });

  it('`show feat/b` gets its own single session', async () => {
    const { entries } = await parseLogs([BRANCHES]);
    const receipt = buildReceipt(entries, 'feat/b', await loadPrices());
    assert.equal(receipt.sessions, 1);
    assert.ok(near(receipt.totalCost, 0.045, 1e-9));
    assert.equal(receipt.totalTokens, 7000);
  });
});

describe('EC3: entries with no gitBranch are "unattributed" and excluded', () => {
  it('keeps unattributed usage out of branch totals but reports it separately', async () => {
    const { entries } = await parseLogs([BRANCHES]);
    const receipt = buildReceipt(entries, 'feat/a', await loadPrices());
    assert.ok(near(receipt.totalCost, 0.086, 1e-9));
    assert.equal(receipt.unattributed.sessions, 1);
    assert.equal(receipt.unattributed.tokens, 400);
    assert.ok(near(receipt.unattributed.cost, 0.0024, 1e-9));
  });

  it('lists the unattributed bucket on the receipt', async () => {
    const { out } = await run(['show', 'feat/a', '--logs', BRANCHES]);
    const line = out.split('\n').find((l) => /unattributed/i.test(l));
    assert.ok(line, 'receipt has an unattributed line');
    assert.match(line, /1 session\b/);
    assert.match(line, /400 tokens/);
    assert.match(line, /\$0\.0024/);
    assert.match(line, /not included/i);
  });

  it('lists unattributed as its own row in the all-branches overview', async () => {
    const { code, out } = await run(['show', '--logs', BRANCHES]);
    assert.equal(code, 0);
    assert.match(out, /\| `feat\/a` \| 2 \| 20,000 \| \$0\.0860 \|/);
    assert.match(out, /\| `feat\/b` \| 1 \| 7,000 \| \$0\.0450 \|/);
    assert.match(out, /\| _unattributed_ \| 1 \| 400 \| \$0\.0024 \|/);
  });

  it('`show unattributed` is not a backdoor into the unattributed bucket', async () => {
    const { out } = await run(['show', 'unattributed', '--logs', BRANCHES]);
    assert.match(out, /no sessions found/);
  });
});

describe('EC4: an override file changes the total', () => {
  it('doubling sonnet-4-5 input price moves $0.0315 to $0.0405', async () => {
    const override = await writeJson({ models: { 'claude-sonnet-4-5': { input: 6 } } });
    const { code, out } = await run(['show', 'feat/demo', '--logs', THREE_MESSAGES, '--prices', override]);
    assert.equal(code, 0);
    assert.match(out, /\$0\.0405/);
    assert.doesNotMatch(out, /\$0\.0315/);
  });

  it('applies through the library API too', async () => {
    const override = await writeJson({ models: { 'claude-sonnet-4-5-20250929': { input: 6, output: 30 } } });
    const { entries } = await parseLogs([THREE_MESSAGES]);
    const receipt = buildReceipt(entries, 'feat/demo', await loadPrices(override));
    // 3,000 × $6/M + 1,500 × $30/M
    assert.ok(near(receipt.totalCost, 0.063, 1e-9), `total was ${receipt.totalCost}`);
  });

  it('picks up ~/.config/prreceipt/prices.json when no --prices flag is given', async () => {
    const home = await tempDir('prr-home-');
    await mkdir(join(home, '.config', 'prreceipt'), { recursive: true });
    await writeFile(
      join(home, '.config', 'prreceipt', 'prices.json'),
      JSON.stringify({ models: { 'claude-sonnet-4-5': { input: 6 } } }),
    );
    const { out } = await run(['show', 'feat/demo', '--logs', THREE_MESSAGES], { home });
    assert.match(out, /\$0\.0405/);
  });

  it('rejects an invalid override with a clear message and exit 1', async () => {
    const override = await writeJson({ models: { 'claude-sonnet-4-5': { imput: 6 } } });
    const { code, out, err } = await run(['show', 'feat/demo', '--logs', THREE_MESSAGES, '--prices', override]);
    assert.equal(code, 1);
    assert.equal(out, '');
    assert.match(err, /prices/);
    assert.match(err, /imput/);
  });
});

describe('EC5: no logs → exit 0 and "no sessions found"', () => {
  it('handles a logs directory that does not exist', async () => {
    const missing = join(await tempDir(), 'nope');
    const { code, out } = await run(['show', 'feat/a', '--logs', missing]);
    assert.equal(code, 0);
    assert.match(out, /no sessions found/);
  });

  it('handles an empty logs directory', async () => {
    const { code, out } = await run(['show', 'feat/a', '--logs', await tempDir()]);
    assert.equal(code, 0);
    assert.match(out, /no sessions found/);
  });

  it('handles a home directory with no Claude Code logs at all (defaults)', async () => {
    const { code, out } = await run(['show', 'feat/a']);
    assert.equal(code, 0);
    assert.match(out, /no sessions found/);
  });

  it('handles a branch that has no sessions', async () => {
    const { code, out } = await run(['show', 'feat/zzz', '--logs', BRANCHES]);
    assert.equal(code, 0);
    assert.match(out, /no sessions found/);
    assert.match(out, /feat\/zzz/);
  });

  it('exits 0 as a real process', async () => {
    const home = await tempDir('prr-home-');
    const result = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', join(ROOT, 'src', 'bin.ts'), 'show', 'feat/a'],
      { cwd: home, env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no sessions found/);
  });
});
