import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogs } from '../src/parse.ts';
import { loadBuiltinPrices } from '../src/pricing.ts';
import {
  buildOverview,
  buildReceipt,
  filterByRepo,
  formatDuration,
  formatPercent,
  formatTokens,
  formatUsd,
  formatUsdShort,
  matchWindow,
  renderOverview,
  renderReceipt,
  type CommitWindow,
} from '../src/receipt.ts';
import { BRANCHES, assistant, near, user, writeLogs } from './helpers.ts';

const prices = loadBuiltinPrices();

async function entriesOf(files: Record<string, object[]>) {
  return (await parseLogs([await writeLogs(files)])).entries;
}

describe('buildReceipt', () => {
  it('breaks tokens and cost down by model', async () => {
    const { entries } = await parseLogs([BRANCHES]);
    const r = buildReceipt(entries, 'feat/a', prices);
    assert.deepEqual(
      r.models.map((m) => m.model),
      ['claude-opus-4-5', 'claude-sonnet-4-5'],
      'sorted by cost, highest first',
    );
    const opus = r.models[0];
    assert.equal(opus.input, 2000);
    assert.equal(opus.output, 1000);
    assert.equal(opus.cacheWrite, 4000);
    assert.equal(opus.cacheRead, 10000);
    assert.equal(opus.tokens, 17000);
    assert.ok(opus.cost !== null && near(opus.cost, 0.065));
  });

  it('computes cache hit rate as cache reads over all prompt tokens', async () => {
    const { entries } = await parseLogs([BRANCHES]);
    const r = buildReceipt(entries, 'feat/a', prices);
    // 10,000 read / (4,000 input + 4,000 write + 10,000 read)
    assert.ok(r.cacheHitRate !== null && near(r.cacheHitRate, 10000 / 18000));
  });

  it('reports no cache hit rate when there are no prompt tokens', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [assistant({ session: 's', output: 10 })] });
    assert.equal(buildReceipt(entries, 'feat/x', prices).cacheHitRate, null);
  });

  it('sums wall time per session from first to last line on the branch', async () => {
    const { entries } = await parseLogs([BRANCHES]);
    const r = buildReceipt(entries, 'feat/a', prices);
    assert.equal(r.wallTimeMs, 32 * 60_000, 's-a1 runs 2 minutes, s-a2 runs 30 minutes');
  });

  it('splits a session that switched branches between both branches', async () => {
    const entries = await entriesOf({
      'p/s.jsonl': [
        user({ session: 's', branch: 'feat/one', ts: '2026-10-05T10:00:00Z' }),
        assistant({ session: 's', branch: 'feat/one', input: 100, ts: '2026-10-05T10:10:00Z' }),
        assistant({ session: 's', branch: 'feat/two', input: 200, ts: '2026-10-05T11:00:00Z' }),
        assistant({ session: 's', branch: 'feat/two', input: 300, ts: '2026-10-05T11:05:00Z' }),
      ],
    });
    const one = buildReceipt(entries, 'feat/one', prices);
    const two = buildReceipt(entries, 'feat/two', prices);
    assert.equal(one.input, 100);
    assert.equal(two.input, 500);
    assert.equal(one.sessions, 1);
    assert.equal(two.sessions, 1);
    assert.equal(one.wallTimeMs, 10 * 60_000);
    assert.equal(two.wallTimeMs, 5 * 60_000);
  });

  it('does not count a session that only has user lines on the branch', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [user({ session: 's', branch: 'feat/x', ts: '2026-10-05T10:00:00Z' })] });
    const r = buildReceipt(entries, 'feat/x', prices);
    assert.equal(r.sessions, 0);
    assert.equal(r.totalTokens, 0);
  });

  it('counts tokens of unknown models, flags them, and adds $0 for them', async () => {
    const entries = await entriesOf({
      'p/s.jsonl': [
        assistant({ session: 's', model: 'claude-mystery-9', input: 1000, output: 1000 }),
        assistant({ session: 's', input: 1000, output: 500 }),
      ],
    });
    const r = buildReceipt(entries, 'feat/x', prices);
    assert.deepEqual(r.unpriced, ['claude-mystery-9']);
    assert.equal(r.totalTokens, 3500);
    assert.ok(near(r.totalCost, 0.0105));
    assert.equal(r.models.find((m) => m.model === 'claude-mystery-9')?.cost, null);
  });
});

describe('filterByRepo', () => {
  it('keeps entries whose cwd is the repo or inside it, and nothing else', async () => {
    const entries = await entriesOf({
      'p/s.jsonl': [
        assistant({ session: 's1', cwd: '/w/shop', input: 1 }),
        assistant({ session: 's2', cwd: '/w/shop/packages/api', input: 2 }),
        assistant({ session: 's3', cwd: '/w/shop-old', input: 4 }),
        assistant({ session: 's4', cwd: '/w/other', input: 8 }),
      ],
    });
    const kept = filterByRepo(entries, '/w/shop/');
    assert.deepEqual(kept.map((e) => e.usage?.input).sort(), [1, 2]);
  });
});

describe('filterByRepo with several roots', () => {
  it('keeps entries inside any of the roots', async () => {
    const entries = await entriesOf({
      'p/s.jsonl': [
        assistant({ session: 's1', cwd: '/w/shop', input: 1 }),
        assistant({ session: 's2', cwd: '/tmp/wt/shop-feature/src', input: 2 }),
        assistant({ session: 's3', cwd: '/w/blog', input: 4 }),
      ],
    });
    assert.deepEqual(filterByRepo(entries, ['/w/shop', '/tmp/wt/shop-feature']).map((e) => e.usage?.input).sort(), [1, 2]);
    assert.deepEqual(filterByRepo(entries, []), []);
  });
});

describe('commit-window fallback', () => {
  // Window: 10:00:00.000 → 12:00:00.999 on 2026-10-02
  const window: CommitWindow = { start: Date.parse('2026-10-02T10:00:00Z'), end: Date.parse('2026-10-02T12:00:00Z') + 999 };
  const repo = '/w/shop';
  const nb = (session: string, ts: string, input = 100, cwd = repo) => assistant({ session, branch: null, cwd, input, ts: `2026-10-02T${ts}Z` });

  it('takes a no-branch session whose span overlaps the window, all of it', async () => {
    const entries = await entriesOf({
      'p/s.jsonl': [nb('straddle', '09:40:00', 1), nb('straddle', '10:20:00', 2), nb('inside', '11:00:00', 4), nb('edge', '12:00:00.500', 8)],
    });
    const matched = matchWindow(entries, window, [repo]);
    assert.deepEqual(matched.map((e) => e.usage?.input).sort((a, b) => (a ?? 0) - (b ?? 0)), [1, 2, 4, 8]);
  });

  it('leaves sessions entirely before or after the window', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [nb('before', '09:59:59'), nb('after', '12:00:01')] });
    assert.deepEqual(matchWindow(entries, window, [repo]), []);
  });

  it('never moves entries that have a branch, or that ran outside the repo, or have no cwd', async () => {
    const noCwd = assistant({ session: 'nocwd', branch: null, input: 5, ts: '2026-10-02T11:00:00Z' }) as Record<string, unknown>;
    delete noCwd.cwd;
    const entries = await entriesOf({
      'p/s.jsonl': [
        assistant({ session: 'tagged', branch: 'feat/other', cwd: repo, ts: '2026-10-02T11:00:00Z' }),
        nb('elsewhere', '11:00:00', 100, '/w/shop-old'),
        noCwd,
      ],
    });
    assert.deepEqual(matchWindow(entries, window, [repo]), []);
  });

  it('matches nothing without repo roots or without timestamps', async () => {
    const noTs = assistant({ session: 'nots', branch: null, cwd: repo, input: 5 }) as Record<string, unknown>;
    delete noTs.timestamp;
    const entries = await entriesOf({ 'p/s.jsonl': [nb('inside', '11:00:00'), noTs] });
    assert.deepEqual(matchWindow(entries, window, []), []);
    assert.deepEqual(matchWindow(entries, window, [repo]).map((e) => e.sessionId), ['inside']);
  });

  it('buildReceipt adds window sessions to the totals and takes them out of unattributed', async () => {
    const entries = await entriesOf({
      'p/s.jsonl': [
        assistant({ session: 'mixed', branch: 'feat/x', cwd: repo, input: 1000, output: 500, ts: '2026-10-02T10:30:00Z' }),
        nb('mixed', '10:40:00', 2000),
        nb('lone', '11:00:00', 4000),
        nb('late', '18:00:00', 8000),
      ],
    });
    const r = buildReceipt(entries, 'feat/x', prices, { window, roots: [repo] });
    assert.equal(r.sessions, 2, 'the mixed session counts once');
    assert.equal(r.input, 7000);
    assert.ok(near(r.totalCost, 0.0105 + 0.006 + 0.012));
    assert.equal(r.fromWindow.sessions, 2);
    assert.equal(r.fromWindow.tokens, 6000);
    assert.equal(r.unattributed.sessions, 1);
    assert.equal(r.unattributed.tokens, 8000);
    assert.deepEqual(r.window, window);
  });

  it('is off unless a window and roots are given (M1 behaviour)', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [nb('lone', '11:00:00', 4000)] });
    for (const context of [undefined, {}, { window }, { roots: [repo] }, { window: null, roots: [repo] }]) {
      const r = buildReceipt(entries, 'feat/x', prices, context);
      assert.equal(r.sessions, 0);
      assert.equal(r.fromWindow.sessions, 0);
      assert.equal(r.unattributed.sessions, 1);
    }
  });
});

describe('lines changed', () => {
  const diff = { base: 'main', files: 2, insertions: 30, deletions: 5 };

  it('divides the total by insertions + deletions', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [assistant({ session: 's', input: 1000, output: 500 })] });
    const r = buildReceipt(entries, 'feat/x', prices, { diff });
    assert.deepEqual(r.diff, diff);
    assert.ok(r.costPerLine !== null && near(r.costPerLine, 0.0105 / 35));
  });

  it('has no per-line cost without a diff or with zero changed lines', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [assistant({ session: 's', input: 1000, output: 500 })] });
    assert.equal(buildReceipt(entries, 'feat/x', prices).costPerLine, null);
    assert.equal(buildReceipt(entries, 'feat/x', prices, { diff: { ...diff, insertions: 0, deletions: 0 } }).costPerLine, null);
  });

  it('renders the line under wall time, and only when there is a diff', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [assistant({ session: 's', input: 1000, output: 500 })] });
    const md = renderReceipt(buildReceipt(entries, 'feat/x', prices, { diff }));
    const bullets = md.split('\n').filter((l) => l.startsWith('- **'));
    assert.match(bullets[bullets.length - 1], /^- \*\*Lines changed:\*\* 35 \(\+30 \/ -5 vs `main`\) · \$0\.0003 per changed line$/);
    assert.doesNotMatch(renderReceipt(buildReceipt(entries, 'feat/x', prices)), /Lines changed/);
    const none = renderReceipt(buildReceipt(entries, 'feat/x', prices, { diff: { ...diff, insertions: 0, deletions: 0 } }));
    assert.match(none, /\*\*Lines changed:\*\* 0 \(\+0 \/ -0 vs `main`\)\n/);
    assert.doesNotMatch(none, /per changed line/);
  });

  it('escapes a base name taken from the command line', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [assistant({ session: 's', input: 1000, output: 500 })] });
    const md = renderReceipt(buildReceipt(entries, 'feat/x', prices, { diff: { ...diff, base: 'x`<b>|y' } }));
    assert.doesNotMatch(md, /<b>/);
    assert.match(md, /vs `x__b__y`/);
  });
});

describe('window line', () => {
  it('says how much came from the window and shows the window in UTC', async () => {
    const window = { start: Date.parse('2026-10-02T10:00:00Z'), end: Date.parse('2026-10-03T12:00:00Z') + 999 };
    const entries = await entriesOf({
      'p/s.jsonl': [
        assistant({ session: 'a', branch: 'feat/x', cwd: '/r', input: 1000, ts: '2026-10-02T10:00:00Z' }),
        assistant({ session: 'b', branch: null, cwd: '/r', input: 2000, ts: '2026-10-02T11:00:00Z' }),
      ],
    });
    const md = renderReceipt(buildReceipt(entries, 'feat/x', prices, { window, roots: ['/r'] }));
    assert.match(
      md,
      /\n_Includes 1 session · 2,000 tokens · \$0\.0060 with no git branch recorded, matched by this branch’s commit window \(2026-10-02 10:00 → 2026-10-03 12:00 UTC\)\._\n/,
    );
  });

  it('is left out when the window matched nothing', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [assistant({ session: 'a', branch: 'feat/x', cwd: '/r', input: 1000 })] });
    const md = renderReceipt(buildReceipt(entries, 'feat/x', prices, { window: { start: 0, end: 1 }, roots: ['/r'] }));
    assert.doesNotMatch(md, /commit window/);
  });
});

describe('buildOverview', () => {
  it('lists branches by cost, highest first, with unattributed separate', async () => {
    const { entries } = await parseLogs([BRANCHES]);
    const o = buildOverview(entries, prices);
    assert.deepEqual(
      o.branches.map((b) => [b.branch, b.sessions, b.tokens]),
      [
        ['feat/a', 2, 20000],
        ['feat/b', 1, 7000],
      ],
    );
    assert.equal(o.unattributed.sessions, 1);
    assert.ok(near(o.totalCost, 0.086 + 0.045 + 0.0024));
  });
});

describe('rendering', () => {
  it('renders a complete receipt', async () => {
    const { entries } = await parseLogs([BRANCHES]);
    const md = renderReceipt(buildReceipt(entries, 'feat/a', prices));
    assert.match(md, /^## 🧾 PR Receipt: `feat\/a`/);
    assert.match(md, /\*\*Total:\*\* \$0\.0860 \(API-equivalent estimate\)/);
    assert.match(md, /\*\*Tokens:\*\* 20,000/);
    assert.match(md, /\*\*Cache hit rate:\*\* 55\.6%/);
    assert.match(md, /\*\*Sessions:\*\* 2/);
    assert.match(md, /\*\*Wall time:\*\* 32m/);
    assert.match(md, /\| Model \| Input \| Output \| Cache write \| Cache read \| Cost \|/);
    assert.match(md, /\| claude-opus-4-5 \| 2,000 \| 1,000 \| 4,000 \| 10,000 \| \$0\.0650 \|/);
    assert.match(md, /list prices as of \d{4}-\d{2}-\d{2}/);
  });

  it('warns about unpriced models and points at the override file', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [assistant({ session: 's', model: 'claude-mystery-9', input: 5 })] });
    const md = renderReceipt(buildReceipt(entries, 'feat/x', prices));
    assert.match(md, /\| claude-mystery-9 \| 5 \| 0 \| 0 \| 0 \| unpriced \|/);
    assert.match(md, /No price for claude-mystery-9/);
    assert.match(md, /--prices/);
  });

  it('escapes markdown in branch names', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [assistant({ session: 's', branch: 'fix/`rm`<b>|x', input: 5 })] });
    const md = renderReceipt(buildReceipt(entries, 'fix/`rm`<b>|x', prices));
    const heading = md.split('\n')[0];
    assert.doesNotMatch(heading, /<b>/);
    assert.equal((heading.match(/`/g) ?? []).length, 2, 'only the wrapping backticks remain');
    const overview = renderOverview(buildOverview(entries, prices));
    assert.doesNotMatch(overview, /<b>/);
    assert.doesNotMatch(overview, /[^\\]\|x/, 'pipes are escaped inside table cells');
  });

  it('escapes markdown in model names', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [assistant({ session: 's', model: 'evil|<img src=x>`m', input: 5 })] });
    const md = renderReceipt(buildReceipt(entries, 'feat/x', prices));
    assert.doesNotMatch(md, /<img/);
    assert.doesNotMatch(md, /evil\|/);
    assert.match(md, /\| evil__img src=x__m \| 5 \|/);
  });

  it('keeps an "@" in a model name from mentioning anyone once posted', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [assistant({ session: 's', model: 'proxy@acme/security', input: 5 })] });
    const md = renderReceipt(buildReceipt(entries, 'feat/x', prices));
    assert.doesNotMatch(md, /@/);
    assert.match(md, /\| proxy_acme\/security \| 5 \|/);
    assert.match(md, /No price for proxy_acme\/security/);
  });

  it('omits the unattributed line when there is nothing unattributed', async () => {
    const entries = await entriesOf({ 'p/s.jsonl': [assistant({ session: 's', input: 5 })] });
    assert.doesNotMatch(renderReceipt(buildReceipt(entries, 'feat/x', prices)), /nattributed/);
  });
});

describe('formatting', () => {
  it('formats dollars with 4 decimals under $1 and 2 above', () => {
    assert.equal(formatUsd(0.0315), '$0.0315');
    assert.equal(formatUsd(0), '$0.0000');
    assert.equal(formatUsd(0.99996), '$1.00');
    assert.equal(formatUsd(12.345), '$12.35');
    assert.equal(formatUsd(1234.5), '$1,234.50');
  });

  it('formats tokens with thousands separators regardless of locale', () => {
    assert.equal(formatTokens(4500), '4,500');
    assert.equal(formatTokens(1234567), '1,234,567');
    assert.equal(formatTokens(0), '0');
  });

  it('formats durations', () => {
    assert.equal(formatDuration(0), '<1m');
    assert.equal(formatDuration(59_000), '<1m');
    assert.equal(formatDuration(32 * 60_000), '32m');
    assert.equal(formatDuration(65 * 60_000), '1h 05m');
    assert.equal(formatDuration(26 * 3_600_000), '26h 00m');
  });

  it('formats per-line amounts without trailing zeros past the cents', () => {
    assert.equal(formatUsdShort(0.02), '$0.02');
    assert.equal(formatUsdShort(0.8), '$0.80');
    assert.equal(formatUsdShort(0.0125), '$0.0125');
    assert.equal(formatUsdShort(0.0003), '$0.0003');
    assert.equal(formatUsdShort(1.5), '$1.50');
    assert.equal(formatUsdShort(0), '$0.00');
  });

  it('formats percentages', () => {
    assert.equal(formatPercent(10000 / 18000), '55.6%');
    assert.equal(formatPercent(0), '0.0%');
    assert.equal(formatPercent(null), 'n/a');
  });
});
