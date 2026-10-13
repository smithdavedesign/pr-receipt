// One block per M3 exit criterion in ROADMAP.md (EC10–EC12, numbered after M2's).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogs, type LogEntry } from '../src/parse.ts';
import { loadPrices, type PriceTable } from '../src/pricing.ts';
import { buildReceipt, summarize } from '../src/receipt.ts';
import { buildReport, median } from '../src/report.ts';
import type { MergedPullRequest } from '../src/github.ts';
import { FakeGitHub, installFakeGh, type FakeMergedPr } from './fake-gh.ts';
import { CODEX, SAMPLE, THREE_MESSAGES, assistant, commit, gitRepo, near, run, tableAfter, tempDir, writeLogs } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HAIKU = 'claude-haiku-4-5-20251001'; // $1 per million input tokens: 100,000 input = $0.10

// ── EC10 ───────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-10-13T12:00:00Z'); // --since 30d → 2026-09-13 12:00 UTC

/** Six merged PRs whose costs are $0.10 … $1.30: sorted 0.1, 0.2, 0.3, 0.5, 0.8, 1.3 → median (0.3 + 0.5) / 2 = 0.4. */
const SIX: Array<FakeMergedPr & { cost: number[] }> = [
  { number: 101, title: 'Tidy the footer', head: 'feat/a', mergedAt: '2026-09-20T10:00:00Z', additions: 8, deletions: 2, cost: [0.1] },
  { number: 102, title: 'Search with filters', head: 'feat/b', mergedAt: '2026-09-25T10:00:00Z', additions: 100, deletions: 30, cost: [0.9, 0.4] },
  { number: 103, title: 'Cart badge', head: 'feat/c', mergedAt: '2026-09-28T10:00:00Z', additions: 50, deletions: 10, cost: [0.3] },
  { number: 104, title: 'Checkout flow', head: 'feat/d', mergedAt: '2026-10-02T10:00:00Z', additions: 300, deletions: 100, cost: [0.8] },
  { number: 105, title: 'Fix login redirect', head: 'feat/e', mergedAt: '2026-10-06T10:00:00Z', additions: 4, deletions: 1, cost: [0.2] },
  { number: 106, title: 'Export orders as CSV', head: 'feat/f', mergedAt: '2026-10-10T10:00:00Z', additions: 200, deletions: 50, cost: [0.25, 0.25] },
];

/** Logs and GitHub state for EC10, plus noise that must not move the numbers. */
async function ec10Scenario() {
  const repo = await gitRepo('main');
  await commit(repo, { 'README.md': 'shop\n' }, '2026-09-01T00:00:00Z');
  const lines: object[] = [];
  let s = 0;
  const spend = (branch: string, usd: number, ts: string, cwd = repo) => {
    s += 1;
    lines.push(assistant({ session: `s${s}`, branch, cwd, model: HAIKU, input: Math.round(usd * 1_000_000), ts }));
  };
  for (const pr of SIX) {
    const merged = Date.parse(pr.mergedAt);
    pr.cost.forEach((usd, i) => spend(pr.head, usd, new Date(merged - (i + 1) * 3_600_000).toISOString()));
  }
  // Noise:
  spend('feat/old', 5, '2026-08-30T10:00:00Z'); //         #99 merged before the window
  spend('feat/early', 2, '2026-09-12T10:00:00Z'); //       #100 merged on the window's first day, but before 12:00
  spend('feat/a', 3, '2026-09-19T10:00:00Z', '/elsewhere/other-repo'); // same branch name, another repository
  spend('feat/wip', 0.7, '2026-10-08T10:00:00Z'); //       a branch with no merged PR
  spend('feat/f', 0.9, '2026-10-11T10:00:00Z'); //         work on feat/f after #106 was merged
  const logs = await writeLogs({ 'p/all.jsonl': lines });

  const merged: FakeMergedPr[] = [
    ...SIX.map(({ cost: _cost, ...pr }) => pr),
    { number: 99, title: 'Old work', head: 'feat/old', mergedAt: '2026-09-01T09:00:00Z' },
    { number: 100, title: 'Early work', head: 'feat/early', mergedAt: '2026-09-13T08:00:00Z' },
    { number: 107, title: 'Docs: README', head: 'docs/readme', mergedAt: '2026-10-11T09:00:00Z', additions: 12, deletions: 0 },
  ];
  return { repo, logs, fake: new FakeGitHub({ merged }) };
}

describe('EC10: with 6 merged PRs, report prints the median as the mean of the middle two and the top 5 by cost', () => {
  it('median() averages the two middle values of an even count', () => {
    assert.ok(near(median([0.1, 1.3, 0.3, 0.8, 0.2, 0.5]) ?? NaN, 0.4));
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([7]), 7);
    assert.equal(median([]), null);
  });

  it('`report` prints a $0.40 median, which is neither middle value, and the top 5 in descending cost', async () => {
    const { repo, logs, fake } = await ec10Scenario();
    const { code, out, err } = await run(['report', '--since', '30d', '--logs', logs], { cwd: repo, gh: fake.gh, now: () => NOW });
    assert.equal(code, 0, err);
    assert.match(out, /\*\*Median per PR:\*\* \$0\.4000\b/);
    assert.match(out, /\*\*Merged PRs with agent sessions:\*\* 6 of 7\b/);
    assert.match(out, /\*\*Total:\*\* \$3\.20\b/);

    const top = tableAfter(out, /^### Top 5/);
    assert.equal(top.length, 5, 'exactly five rows');
    assert.deepEqual(
      top.map((row) => row[0]),
      ['1', '2', '3', '4', '5'],
    );
    assert.deepEqual(
      top.map((row) => /#(\d+)/.exec(row[1])?.[1]),
      ['102', '104', '106', '103', '105'],
    );
    assert.deepEqual(
      top.map((row) => row[row.length - 1]),
      ['$1.30', '$0.8000', '$0.5000', '$0.3000', '$0.2000'],
    );
    assert.ok(!top.some((row) => row[1].includes('#101')), 'the cheapest PR is not in the top 5');
  });

  it('lists every merged PR with sessions, newest first, when there are more than five', async () => {
    const { repo, logs, fake } = await ec10Scenario();
    const { out } = await run(['report', '--logs', logs], { cwd: repo, gh: fake.gh, now: () => NOW });
    const all = tableAfter(out, /^### All 6 merged PRs/);
    assert.deepEqual(
      all.map((row) => /#(\d+)/.exec(row[0])?.[1]),
      ['106', '105', '104', '103', '102', '101'],
    );
    const pr102 = all.find((row) => row[0].includes('#102'));
    assert.ok(pr102);
    assert.deepEqual(pr102.slice(1), ['`feat/b`', '2026-09-25', '2', '130', '$0.01', '$1.30']);
  });

  it('keeps the noise out: earlier merges, other repos, PRs without sessions, unmerged and post-merge work', async () => {
    const { repo, logs, fake } = await ec10Scenario();
    const { out } = await run(['report', '--logs', logs], { cwd: repo, gh: fake.gh, now: () => NOW });
    assert.doesNotMatch(out, /#99\b|#100\b/, 'PRs merged before --since are not listed');
    assert.match(out, /1 merged PR had no sessions in these logs: #107\b/);
    const other = out.split('\n').find((l) => /Not in any merged PR/.test(l));
    assert.ok(other, 'spend outside merged PRs is reported');
    assert.match(other, /2 sessions/);
    assert.match(other, /\$1\.60\b/, 'feat/wip ($0.70) + feat/f after its merge ($0.90)');
    assert.doesNotMatch(out, /\$3\.00|\$5\.00|\$2\.00/);
  });

  it('computes the same numbers through the library', async () => {
    const { repo, logs } = await ec10Scenario();
    const { entries } = await parseLogs([logs]);
    const prs: MergedPullRequest[] = SIX.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: `https://github.com/acme/shop/pull/${pr.number}`,
      headRefName: pr.head,
      baseRefName: 'main',
      mergedAt: Date.parse(pr.mergedAt),
      additions: pr.additions ?? null,
      deletions: pr.deletions ?? null,
    }));
    const inRepo = entries.filter((e) => e.cwd === repo);
    const report = buildReport(inRepo, prs, await loadPrices(), Date.parse('2026-09-13T12:00:00Z'));
    assert.equal(report.prs.length, 6);
    assert.ok(report.median !== null && near(report.median, 0.4, 1e-9), `median was ${report.median}`);
    assert.deepEqual(
      report.top.map((p) => p.pr.number),
      [102, 104, 106, 103, 105],
    );
    const costs = report.top.map((p) => p.cost);
    assert.deepEqual([...costs].sort((x, y) => y - x), costs, 'descending');
    assert.ok(near(report.totalCost, 3.2, 1e-9));
  });

  it('works as a real process against a `gh` executable on PATH', async () => {
    const now = Date.now();
    const day = 86_400_000;
    const repo = await gitRepo('main');
    await commit(repo, { 'README.md': 'shop\n' }, new Date(now - 60 * day).toISOString());
    const usd = [0.1, 1.3, 0.3, 0.8, 0.2, 0.5];
    const merged: FakeMergedPr[] = usd.map((_, i) => ({
      number: 201 + i,
      title: `PR ${i + 1}`,
      head: `feat/p${i + 1}`,
      mergedAt: new Date(now - (i + 1) * day).toISOString(),
      additions: 10,
      deletions: 0,
    }));
    const logs = await writeLogs({
      'p/s.jsonl': usd.map((cost, i) =>
        assistant({ session: `p${i}`, branch: `feat/p${i + 1}`, cwd: repo, model: HAIKU, input: Math.round(cost * 1_000_000), ts: new Date(now - (i + 1) * day - 3_600_000).toISOString() }),
      ),
    });
    const fakeGh = await installFakeGh({ merged });
    const home = await tempDir('prr-home-');
    const result = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', join(ROOT, 'src', 'bin.ts'), 'report', '--since', '30d', '--logs', logs],
      { cwd: repo, env: { PATH: `${fakeGh.binDir}:${process.env.PATH ?? ''}`, HOME: home, PRR_FAKE_GH_STATE: fakeGh.statePath }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\*\*Median per PR:\*\* \$0\.4000\b/);
    assert.deepEqual(
      tableAfter(result.stdout, /^### Top 5/).map((row) => row[row.length - 1]),
      ['$1.30', '$0.8000', '$0.5000', '$0.3000', '$0.2000'],
    );
    assert.equal((await fakeGh.read()).lists().length, 1, 'one gh call, read-only');
  });
});

// ── EC11 ───────────────────────────────────────────────────────────────────

describe('EC11: a Codex fixture yields its known total; a branch with Claude and Codex sessions sums both', () => {
  // 2 counted turns of gpt-5-codex ($1.25 in / $0.125 cached / $10 out per M):
  //   uncached 10,000 × 1.25 + cached 20,000 × 0.125 + output 3,000 × 10 = $0.0125 + $0.0025 + $0.03 = $0.045
  // The repeated snapshot, the rate-limit-only event and the compaction event add nothing.
  it('parses the Codex rollout to $0.0450 and 33,000 tokens', async () => {
    const { entries } = await parseLogs([CODEX]);
    const r = buildReceipt(entries, 'feat/demo', await loadPrices());
    assert.ok(near(r.totalCost, 0.045, 1e-9), `total was ${r.totalCost}`);
    assert.equal(r.totalTokens, 33_000);
    assert.equal(r.input, 10_000, 'uncached input');
    assert.equal(r.cacheRead, 20_000, 'cached input');
    assert.equal(r.output, 3_000, 'output already includes reasoning');
    assert.equal(r.sessions, 1);
    assert.deepEqual(
      r.models.map((m) => m.model),
      ['gpt-5-codex'],
    );
    assert.equal(r.wallTimeMs, 5 * 60_000);
  });

  it('`show` prints the Codex receipt', async () => {
    const { code, out } = await run(['show', 'feat/demo', '--logs', CODEX]);
    assert.equal(code, 0);
    assert.match(out, /\*\*Total:\*\* \$0\.0450\b/);
    assert.match(out, /\*\*Tokens:\*\* 33,000\b/);
    assert.match(out, /\| gpt-5-codex \|/);
  });

  it('sums Claude ($0.0315, 4,500 tokens) and Codex ($0.0450, 33,000 tokens) on feat/demo', async () => {
    const { code, out } = await run(['show', 'feat/demo', '--logs', THREE_MESSAGES, '--logs', CODEX]);
    assert.equal(code, 0);
    assert.match(out, /\*\*Total:\*\* \$0\.0765\b/);
    assert.match(out, /\*\*Tokens:\*\* 37,500\b/);
    assert.match(out, /\*\*Sessions:\*\* 2\b/);
    assert.match(out, /\| gpt-5-codex \| 10,000 \| 3,000 \| 0 \| 20,000 \| \$0\.0450 \|/);
    assert.match(out, /\| claude-sonnet-4-5 \| 3,000 \| 1,500 \| 0 \| 0 \| \$0\.0315 \|/);
  });

  it('finds both in their default locations ($CLAUDE_CONFIG_DIR and $CODEX_HOME)', async () => {
    const { out } = await run(['show', 'feat/demo'], { env: { CLAUDE_CONFIG_DIR: THREE_MESSAGES, CODEX_HOME: CODEX } });
    assert.match(out, /\*\*Total:\*\* \$0\.0765\b/);
  });

  it('reads ~/.codex/sessions when $CODEX_HOME is not set', async () => {
    const home = await tempDir('prr-home-');
    await cp(join(CODEX, 'sessions'), join(home, '.codex', 'sessions'), { recursive: true });
    const { out } = await run(['show', 'feat/demo'], { home });
    assert.match(out, /\*\*Total:\*\* \$0\.0450\b/);
  });

  it('the comment for a Claude + Codex branch has no Codex prompt, response or tool text', async () => {
    const repo = await gitRepo('main');
    await commit(repo, { 'README.md': 'x\n' }, '2026-10-01T00:00:00Z');
    const fake = new FakeGitHub({ pr: { number: 8, head: 'feat/demo', base: 'main' } });
    const { code, err } = await run(['comment', 'feat/demo', '--logs', THREE_MESSAGES, '--logs', CODEX, '--repo', '/home/dev/demo'], { cwd: repo, gh: fake.gh });
    assert.equal(code, 0, err);
    const [body] = fake.sentBodies();
    assert.match(body, /\$0\.0765/);
    const texts = await codexStrings(CODEX);
    assert.ok(texts.some((t) => t.includes('PROMPT-MARKER-codex')), 'the fixture really has prompt text');
    assert.deepEqual(
      texts.filter((t) => body.includes(t)),
      [],
    );
    assert.doesNotMatch(body, /PROMPT-MARKER|RESPONSE-MARKER|login form|src\/login/);
  });
});

/** Every string of 5+ characters inside Codex payloads, except ids, paths and enum-like values. */
async function codexStrings(dir: string): Promise<string[]> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') found.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const name of await readdir(dir, { recursive: true })) {
    if (!name.endsWith('.jsonl')) continue;
    for (const line of (await readFile(join(dir, name), 'utf8')).split('\n')) {
      if (line.trim() === '') continue;
      const obj = JSON.parse(line) as { payload?: Record<string, unknown> };
      const p = obj.payload ?? {};
      walk([p.message, p.content, p.summary, p.arguments, p.output, p.instructions]);
    }
  }
  return [...found].filter((s) => s.length >= 5);
}

// ── EC12 ───────────────────────────────────────────────────────────────────

interface Reference {
  sessions: Array<{ id: string; tokens: number; cost: number }>;
  totals: { tokens: number; cost: number };
}

/** Reads a `ccusage session --json` (or `ccusage-codex session --json`) file, real or derived. */
async function readCcusage(file: string): Promise<Reference> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as { sessions: Array<Record<string, unknown>>; totals: Record<string, unknown> };
  const cost = (o: Record<string, unknown>) => Number(o.totalCost ?? o.costUSD);
  return {
    sessions: raw.sessions.map((s) => ({ id: String(s.sessionId), tokens: Number(s.totalTokens), cost: cost(s) })),
    totals: { tokens: Number(raw.totals.totalTokens), cost: cost(raw.totals) },
  };
}

const within5 = (ours: number, theirs: number) => Math.abs(ours - theirs) <= 0.05 * Math.abs(theirs);

function perSession(entries: LogEntry[], prices: PriceTable): Map<string, { tokens: number; cost: number }> {
  const groups = new Map<string, LogEntry[]>();
  for (const e of entries) groups.set(e.sessionId, [...(groups.get(e.sessionId) ?? []), e]);
  const out = new Map<string, { tokens: number; cost: number }>();
  for (const [id, group] of groups) {
    const t = summarize(group, prices);
    if (t.sessions > 0) out.set(id, { tokens: t.tokens, cost: t.cost });
  }
  return out;
}

function compareSessions(ref: Reference, ours: Map<string, { tokens: number; cost: number }>): void {
  assert.equal(ours.size, ref.sessions.length, 'same number of sessions');
  for (const s of ref.sessions) {
    const match = [...ours].find(([id]) => s.id.includes(id));
    assert.ok(match, `no session of ours matches ccusage session ${s.id}`);
    const [id, mine] = match;
    assert.ok(within5(mine.tokens, s.tokens), `${id}: ${mine.tokens} tokens vs ccusage ${s.tokens}`);
    assert.ok(within5(mine.cost, s.cost), `${id}: $${mine.cost} vs ccusage $${s.cost}`);
  }
}

describe('EC12: totals agree with ccusage within 5% on the sample logs', () => {
  const claudeDir = join(SAMPLE, 'claude');
  const codexDir = join(SAMPLE, 'codex');

  it('each of the 10 Claude Code sample sessions is within 5% of ccusage (tokens and cost)', async () => {
    const ref = await readCcusage(join(SAMPLE, 'ccusage-claude-session.json'));
    assert.equal(ref.sessions.length, 10);
    compareSessions(ref, perSession((await parseLogs([claudeDir])).entries, await loadPrices()));
  });

  it('each Codex sample session is within 5% of ccusage-codex, the fork included', async () => {
    const ref = await readCcusage(join(SAMPLE, 'ccusage-codex-session.json'));
    assert.equal(ref.sessions.length, 3);
    compareSessions(ref, perSession((await parseLogs([codexDir])).entries, await loadPrices()));
  });

  it('the grand totals and `show --all` agree within 5%', async () => {
    const claude = await readCcusage(join(SAMPLE, 'ccusage-claude-session.json'));
    const codex = await readCcusage(join(SAMPLE, 'ccusage-codex-session.json'));
    const prices = await loadPrices();
    const { entries } = await parseLogs([SAMPLE]);
    const all = summarize(entries, prices);
    assert.ok(within5(all.tokens, claude.totals.tokens + codex.totals.tokens), `${all.tokens} tokens`);
    assert.ok(within5(all.cost, claude.totals.cost + codex.totals.cost), `$${all.cost}`);

    const { code, out } = await run(['show', '--all', '--logs', SAMPLE]);
    assert.equal(code, 0);
    const shown = Number(/\*\*Total:\*\* \$([\d,.]+)/.exec(out)?.[1].replace(/,/g, ''));
    assert.ok(within5(shown, claude.totals.cost + codex.totals.cost), `show --all printed $${shown}`);
  });

  it('has teeth: counting every usage line, as a naive parser would, misses ccusage by more than 5%', async () => {
    const claude = await readCcusage(join(SAMPLE, 'ccusage-claude-session.json'));
    const codex = await readCcusage(join(SAMPLE, 'ccusage-codex-session.json'));
    let claudeNaive = 0;
    let codexNaive = 0;
    for (const name of await readdir(SAMPLE, { recursive: true })) {
      if (!name.endsWith('.jsonl')) continue;
      for (const line of (await readFile(join(SAMPLE, name), 'utf8')).split('\n')) {
        let obj: { message?: { usage?: Record<string, number> }; payload?: { type?: string; info?: { last_token_usage?: { total_tokens: number } } | null } };
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const u = obj.message?.usage;
        if (u) claudeNaive += u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
        if (obj.payload?.type === 'token_count') codexNaive += obj.payload.info?.last_token_usage?.total_tokens ?? 0;
      }
    }
    assert.ok(!within5(claudeNaive, claude.totals.tokens), `naive Claude count ${claudeNaive} vs ${claude.totals.tokens}`);
    assert.ok(!within5(codexNaive, codex.totals.tokens), `naive Codex count ${codexNaive} vs ${codex.totals.tokens}`);
  });

  it('really contains the cases tools disagree on', async () => {
    const claudeLines: Array<Record<string, any>> = [];
    const codexText: string[] = [];
    for (const name of await readdir(SAMPLE, { recursive: true })) {
      if (!name.endsWith('.jsonl')) continue;
      const text = await readFile(join(SAMPLE, name), 'utf8');
      if (name.startsWith('codex')) codexText.push(text);
      else for (const line of text.split('\n')) {
        try {
          claudeLines.push({ ...JSON.parse(line), file: name });
        } catch {
          // the half-written last line
        }
      }
    }
    const copies = new Map<string, Array<Record<string, any>>>();
    for (const l of claudeLines.filter((l) => l.message?.usage && l.requestId)) {
      const key = `${l.message.id}:${l.requestId}`;
      copies.set(key, [...(copies.get(key) ?? []), l]);
    }
    const groups = [...copies.values()];
    assert.ok(groups.some((g) => new Set(g.map((l) => l.message.usage.output_tokens)).size > 1), 'streamed copies with growing output');
    assert.ok(groups.some((g) => new Set(g.map((l) => l.file)).size > 1), 'a request copied into a resumed session');
    assert.ok(claudeLines.some((l) => l.message?.usage?.cache_creation?.ephemeral_1h_input_tokens > 0), '1-hour cache writes');
    assert.ok(claudeLines.some((l) => l.isSidechain === true && l.message?.usage), 'sidechain usage');
    assert.ok(codexText.some((t) => t.includes('"forked_from_id"')), 'a forked Codex rollout');
    const totals = codexText.flatMap((t) => [...t.matchAll(/"total_token_usage":(\{[^}]*\})/g)].map((m) => m[1]));
    assert.ok(totals.length > new Set(totals).size, 'repeated Codex snapshots');
  });
});
