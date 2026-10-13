import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GhError, MERGED_PR_LIMIT, listMergedPullRequests, type Gh, type MergedPullRequest } from '../src/github.ts';
import type { LogEntry } from '../src/parse.ts';
import { loadBuiltinPrices } from '../src/pricing.ts';
import { PR_LOOKBACK_DAYS, buildReport, parseSince, renderReport } from '../src/report.ts';
import { FakeGitHub } from './fake-gh.ts';
import { assistant, commit, gitRepo, near, run, tableAfter, writeLogs } from './helpers.ts';

const prices = loadBuiltinPrices();
const HAIKU = 'claude-haiku-4-5-20251001';
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-13T12:00:00Z');
const SINCE = NOW - 30 * DAY;

function pr(number: number, head: string, merged: string, extra: Partial<MergedPullRequest> = {}): MergedPullRequest {
  return { number, title: `PR ${number}`, url: `https://github.com/acme/shop/pull/${number}`, headRefName: head, baseRefName: 'main', mergedAt: Date.parse(merged), additions: 10, deletions: 0, ...extra };
}

/** A usage entry worth `usd` (Haiku input at $1 per M). */
function spend(session: string, branch: string | null, usd: number, ts: string | null): LogEntry {
  return {
    sessionId: session,
    branch,
    cwd: '/w/shop',
    timestamp: ts === null ? null : Date.parse(ts),
    usage: { model: HAIKU, input: Math.round(usd * 1_000_000), output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 },
    key: null,
  };
}

describe('parseSince', () => {
  it('reads days, weeks and dates', () => {
    assert.equal(parseSince('30d', NOW), NOW - 30 * DAY);
    assert.equal(parseSince('2w', NOW), NOW - 14 * DAY);
    assert.equal(parseSince('1d', NOW), NOW - DAY);
    assert.equal(parseSince('2026-09-01', NOW), Date.parse('2026-09-01T00:00:00Z'));
  });

  it('rejects anything else', () => {
    for (const bad of ['', '30', 'd', '0d', '-3d', '3m', '30 d', '2026-02-31', '2026-9-1', 'yesterday', '99999999d']) {
      assert.equal(parseSince(bad, NOW), null, JSON.stringify(bad));
    }
  });
});

describe('listMergedPullRequests', () => {
  const reply = (body: unknown): Gh => async () => (typeof body === 'string' ? body : JSON.stringify(body));

  it('asks gh for merged PRs since the day of `since`, with the fields it needs', async () => {
    const fake = new FakeGitHub({ merged: [{ number: 5, title: 'T', head: 'feat/t', mergedAt: '2026-10-01T10:00:00Z', additions: 3, deletions: 1 }] });
    const prs = await listMergedPullRequests(fake.gh, Date.parse('2026-09-13T12:00:00Z'));
    assert.deepEqual(fake.lists()[0].args, [
      'pr',
      'list',
      '--state',
      'merged',
      '--search',
      'merged:>=2026-09-13',
      '--limit',
      String(MERGED_PR_LIMIT),
      '--json',
      'number,title,url,headRefName,baseRefName,mergedAt,additions,deletions',
    ]);
    assert.deepEqual(prs, [
      { number: 5, title: 'T', url: 'https://github.com/acme/shop/pull/5', headRefName: 'feat/t', baseRefName: 'main', mergedAt: Date.parse('2026-10-01T10:00:00Z'), additions: 3, deletions: 1 },
    ]);
  });

  it('accepts PRs without diff counts', async () => {
    const [p] = await listMergedPullRequests(reply([{ number: 1, title: 't', url: 'https://g.example/o/r/pull/1', headRefName: 'b', baseRefName: 'main', mergedAt: '2026-10-01T00:00:00Z' }]), SINCE);
    assert.equal(p.additions, null);
    assert.equal(p.deletions, null);
  });

  it('rejects output it does not understand', async () => {
    const good = { number: 1, title: 't', url: 'https://github.com/o/r/pull/1', headRefName: 'b', baseRefName: 'main', mergedAt: '2026-10-01T00:00:00Z' };
    const { baseRefName: _base, ...noBase } = good;
    for (const bad of ['not json', '{}', JSON.stringify([{ ...good, number: '1' }]), JSON.stringify([{ ...good, url: 'file:///etc/passwd' }]), JSON.stringify([{ ...good, mergedAt: 'soon' }]), JSON.stringify([{ ...good, headRefName: 7 }]), JSON.stringify([noBase]), JSON.stringify([{ ...good, additions: -1 }])]) {
      await assert.rejects(listMergedPullRequests(reply(bad), SINCE), GhError, bad);
    }
  });
});

describe('buildReport attribution', () => {
  it('splits a reused branch name at each merge and leaves work after the last merge out', () => {
    const prs = [pr(20, 'fix/typo', '2026-09-20T10:00:00Z'), pr(30, 'fix/typo', '2026-10-05T10:00:00Z')];
    const entries = [
      spend('a', 'fix/typo', 0.1, '2026-09-19T10:00:00Z'),
      spend('b', 'fix/typo', 0.2, '2026-09-25T10:00:00Z'),
      spend('c', 'fix/typo', 0.4, '2026-10-06T10:00:00Z'),
    ];
    const r = buildReport(entries, prs, prices, SINCE);
    const cost = (n: number) => r.prs.find((p) => p.pr.number === n)?.cost;
    assert.ok(near(cost(20) ?? NaN, 0.1));
    assert.ok(near(cost(30) ?? NaN, 0.2));
    assert.ok(near(r.other.cost, 0.4), 'post-merge work is reported as not in any PR');
  });

  it(`counts at most ${PR_LOOKBACK_DAYS} days of work before a merge, so a long-lived branch's first PR doesn't take all its history`, () => {
    const release = pr(50, 'develop', '2026-10-10T00:00:00Z');
    const entries = [spend('old', 'develop', 5, '2026-05-01T00:00:00Z'), spend('recent', 'develop', 0.5, '2026-09-01T00:00:00Z')];
    const r = buildReport(entries, [release], prices, SINCE);
    assert.ok(near(r.prs[0].cost, 0.5), `cost was ${r.prs[0].cost}`);
    assert.equal(r.other.sessions, 0, 'old work before --since is not "other" spend either');
  });

  it('gives no local sessions to a fork PR whose branch has the base branch’s name (main → main)', () => {
    const fork = pr(60, 'main', '2026-10-05T00:00:00Z', { baseRefName: 'main', title: 'Fix typo (from a fork)' });
    const own = pr(61, 'feat/x', '2026-10-06T00:00:00Z');
    const entries = [spend('maintainer', 'main', 0.8, '2026-10-04T00:00:00Z'), spend('feature', 'feat/x', 0.1, '2026-10-05T00:00:00Z')];
    const r = buildReport(entries, [fork, own], prices, SINCE);
    assert.deepEqual(
      r.prs.map((p) => p.pr.number),
      [61],
    );
    assert.deepEqual(
      r.withoutSessions.map((p) => p.number),
      [60],
    );
    assert.ok(near(r.other.cost, 0.8), 'work on main stays "not in any merged PR"');
  });

  it('counts work up to and including the merge time', () => {
    const r = buildReport([spend('a', 'feat/x', 0.1, '2026-10-01T10:00:00Z')], [pr(1, 'feat/x', '2026-10-01T10:00:00Z')], prices, SINCE);
    assert.equal(r.prs.length, 1);
  });

  it('gives usage without a timestamp to the latest PR of its branch', () => {
    const prs = [pr(20, 'fix/typo', '2026-09-20T10:00:00Z'), pr(30, 'fix/typo', '2026-10-05T10:00:00Z')];
    const r = buildReport([spend('a', 'fix/typo', 0.3, null)], prs, prices, SINCE);
    assert.deepEqual(
      r.prs.map((p) => p.pr.number),
      [30],
    );
  });

  it('keeps PRs without sessions out of the median and lists them', () => {
    const prs = [pr(1, 'a', '2026-10-01T00:00:00Z'), pr(2, 'b', '2026-10-02T00:00:00Z'), pr(3, 'c', '2026-10-03T00:00:00Z')];
    const r = buildReport([spend('s1', 'a', 0.1, '2026-09-30T00:00:00Z'), spend('s2', 'b', 0.3, '2026-09-30T00:00:00Z')], prs, prices, SINCE);
    assert.ok(r.median !== null && near(r.median, 0.2));
    assert.deepEqual(
      r.withoutSessions.map((p) => p.number),
      [3],
    );
    assert.equal(r.merged, 3);
  });

  it('only reports other spend since `since`, and none of the no-branch work before it', () => {
    const r = buildReport([spend('s1', null, 0.5, '2026-09-01T00:00:00Z'), spend('s2', null, 0.25, '2026-10-01T00:00:00Z')], [], prices, SINCE);
    assert.ok(near(r.other.cost, 0.25));
    assert.equal(r.other.sessions, 1);
  });

  it('breaks cost ties by the most recent merge', () => {
    const prs = [pr(1, 'a', '2026-10-01T00:00:00Z'), pr(2, 'b', '2026-10-02T00:00:00Z')];
    const r = buildReport([spend('s1', 'a', 0.1, '2026-09-30T00:00:00Z'), spend('s2', 'b', 0.1, '2026-09-30T00:00:00Z')], prs, prices, SINCE);
    assert.deepEqual(
      r.top.map((p) => p.pr.number),
      [2, 1],
    );
  });

  it('stays fast: 20,000 lines across 300 merged PRs in well under a second', () => {
    const prs = Array.from({ length: 300 }, (_, i) => pr(i + 1, `feat/${i}`, new Date(NOW - (i % 29) * DAY).toISOString()));
    const entries = Array.from({ length: 20_000 }, (_, i) => spend(`s${i % 1000}`, `feat/${i % 350}`, 0.001, new Date(NOW - 40 * DAY + (i % 1000) * 60_000).toISOString()));
    const started = performance.now();
    const r = buildReport(entries, prs, prices, SINCE);
    renderReport(r);
    assert.ok(performance.now() - started < 1_000, `took ${performance.now() - started} ms`);
    assert.equal(r.merged, 300);
  });
});

describe('renderReport', () => {
  it('sanitizes PR titles and shortens long ones', () => {
    const title = 'Fix | table <script>alert(1)</script> and ping @acme/team ' + 'x'.repeat(80);
    const r = buildReport([spend('s', 'feat/x', 0.1, '2026-10-01T00:00:00Z')], [pr(9, 'feat/x', '2026-10-02T00:00:00Z', { title })], prices, SINCE);
    const out = renderReport(r);
    const [row] = tableAfter(out, /^### Top 5/);
    assert.equal(row.length, 8, 'the title did not add table columns');
    assert.doesNotMatch(out, /<script>|@acme/);
    assert.ok(row[1].length <= 70, `title cell was ${row[1].length} characters`);
    assert.match(row[1], /…$/);
  });

  it('replaces terminal control and bidirectional-override characters in titles and branch names', () => {
    const c1 = String.fromCodePoint(0x9b); // CSI: starts a terminal escape sequence
    const rlo = String.fromCodePoint(0x202e); // right-to-left override
    const isolate = String.fromCodePoint(0x2066);
    const title = `Fix ${c1}31m red ${rlo}txt.exe ${isolate}x`;
    const r = buildReport([spend('s', `feat/${rlo}x`, 0.1, '2026-10-01T00:00:00Z')], [pr(9, `feat/${rlo}x`, '2026-10-02T00:00:00Z', { title })], prices, SINCE);
    const out = renderReport(r);
    for (const ch of [c1, rlo, isolate]) assert.ok(!out.includes(ch), `U+${ch.codePointAt(0)?.toString(16)} removed`);
    assert.match(out, /#9 Fix _31m red _txt\.exe _x/);
  });

  it('shows n/a per line when the diff size is unknown or zero', () => {
    const prs = [pr(1, 'a', '2026-10-01T00:00:00Z', { additions: null, deletions: null }), pr(2, 'b', '2026-10-02T00:00:00Z', { additions: 0, deletions: 0 })];
    const r = buildReport([spend('s1', 'a', 0.1, '2026-09-30T00:00:00Z'), spend('s2', 'b', 0.2, '2026-09-30T00:00:00Z')], prs, prices, SINCE);
    const rows = tableAfter(renderReport(r), /^### Top 5/);
    assert.deepEqual(
      rows.map((row) => [row[5], row[6]]),
      [
        ['0', 'n/a'],
        ['n/a', 'n/a'],
      ],
    );
  });

  it('omits the all-PRs table at five PRs or fewer', () => {
    const prs = [1, 2, 3, 4, 5].map((n) => pr(n, `b${n}`, `2026-10-0${n}T00:00:00Z`));
    const entries = prs.map((p, i) => spend(`s${i}`, p.headRefName, 0.1 * (i + 1), '2026-09-30T00:00:00Z'));
    const out = renderReport(buildReport(entries, prs, prices, SINCE));
    assert.equal(tableAfter(out, /^### Top 5/).length, 5);
    assert.doesNotMatch(out, /### All/);
  });

  it('says so when nothing was merged, or nothing merged had sessions', () => {
    assert.match(renderReport(buildReport([], [], prices, SINCE)), /^no merged pull requests since 2026-09-13 12:00 UTC/);
    const out = renderReport(buildReport([spend('s', 'feat/wip', 0.1, '2026-10-01T00:00:00Z')], [pr(1, 'a', '2026-10-01T00:00:00Z')], prices, SINCE));
    assert.match(out, /^no merged pull requests with sessions since 2026-09-13 12:00 UTC \(1 merged, none had sessions on its branch in these logs\)/);
    assert.match(out, /Not in any merged PR: 1 session/);
  });

  it('warns about unpriced models', () => {
    const entry = spend('s', 'feat/x', 0.1, '2026-10-01T00:00:00Z');
    entry.usage = { ...entry.usage!, model: 'gpt-6-astra' };
    const out = renderReport(buildReport([entry], [pr(1, 'feat/x', '2026-10-02T00:00:00Z')], prices, SINCE));
    assert.match(out, /No price for gpt-6-astra/);
  });
});

describe('`report` command', () => {
  async function repoWithLogs() {
    const repo = await gitRepo('main');
    await commit(repo, { 'README.md': 'x\n' }, '2026-09-01T00:00:00Z');
    const logs = await writeLogs({ 'p/s.jsonl': [assistant({ session: 's', branch: 'feat/x', cwd: repo, model: HAIKU, input: 100_000, ts: '2026-10-01T00:00:00Z' })] });
    return { repo, logs };
  }

  it('defaults to the last 30 days', async () => {
    const { repo, logs } = await repoWithLogs();
    const fake = new FakeGitHub({ merged: [{ number: 1, title: 't', head: 'feat/x', mergedAt: '2026-10-02T00:00:00Z' }] });
    const { code, out } = await run(['report', '--logs', logs], { cwd: repo, gh: fake.gh, now: () => NOW });
    assert.equal(code, 0);
    assert.match(out, /since 2026-09-13 12:00 UTC/);
    assert.equal(fake.lists()[0].args[5], 'merged:>=2026-09-13');
  });

  it('only counts sessions in this repository unless --repo says otherwise', async () => {
    const { repo } = await repoWithLogs();
    const logs = await writeLogs({ 'p/s.jsonl': [assistant({ session: 's', branch: 'feat/x', cwd: '/w/other', model: HAIKU, input: 100_000, ts: '2026-10-01T00:00:00Z' })] });
    const fake = new FakeGitHub({ merged: [{ number: 1, title: 't', head: 'feat/x', mergedAt: '2026-10-02T00:00:00Z' }] });
    const scoped = await run(['report', '--logs', logs], { cwd: repo, gh: fake.gh, now: () => NOW });
    assert.match(scoped.out, /none had sessions/);
    const other = await run(['report', '--logs', logs, '--repo', '/w/other'], { cwd: repo, gh: fake.gh, now: () => NOW });
    assert.match(other.out, /\*\*Median per PR:\*\* \$0\.1000/);
  });

  it('says where it looked when there are no sessions at all, and still lists what was merged', async () => {
    const { repo } = await repoWithLogs();
    const empty = await writeLogs({});
    const fake = new FakeGitHub({ merged: [{ number: 1, title: 't', head: 'feat/x', mergedAt: '2026-10-02T00:00:00Z' }] });
    const { code, out, err } = await run(['report', '--logs', empty], { cwd: repo, gh: fake.gh, now: () => NOW });
    assert.equal(code, 0);
    assert.match(err, /no sessions found \(scanned 0 log files in /);
    assert.match(out, /1 merged, none had sessions/);
  });

  it('warns when GitHub’s search cap may have cut the list', async () => {
    const { repo, logs } = await repoWithLogs();
    const merged = Array.from({ length: MERGED_PR_LIMIT }, (_, i) => ({ number: i + 1, title: 't', head: `b${i}`, mergedAt: '2026-10-02T00:00:00Z' }));
    const fake = new FakeGitHub({ merged });
    const { code, err } = await run(['report', '--logs', logs], { cwd: repo, gh: fake.gh, now: () => NOW });
    assert.equal(code, 0);
    assert.match(err, /1000 merged PRs/);
    assert.match(err, /--since/);
  });

  it('exits 1 outside a git repository, and on gh errors', async () => {
    const outside = await run(['report', '--logs', (await repoWithLogs()).logs], { gh: new FakeGitHub().gh, now: () => NOW });
    assert.equal(outside.code, 1);
    assert.match(outside.err, /inside the repository/);
    assert.doesNotMatch(outside.err, /no sessions found/, 'fails before scanning logs');
    const { repo, logs } = await repoWithLogs();
    const failing: Gh = async () => {
      throw new GhError('gh pr list failed: HTTP 401: Bad credentials');
    };
    const { code, out, err } = await run(['report', '--logs', logs], { cwd: repo, gh: failing, now: () => NOW });
    assert.equal(code, 1);
    assert.equal(out, '');
    assert.match(err, /Bad credentials/);
  });

  it('rejects misuse with exit 1 and a message that names the problem, inside a repo with logs', async () => {
    const { repo, logs } = await repoWithLogs();
    const cases: Array<[string[], RegExp]> = [
      [['report', 'feat/x'], /report takes no branch/],
      [['report', '--all'], /--all only works with show/],
      [['report', '--dry-run'], /--dry-run only works with comment/],
      [['report', '--base', 'main'], /--base only works with show and comment/],
      [['report', '--since', 'yesterday'], /--since needs a number of days or weeks/],
      [['show', 'feat/x', '--since', '30d'], /--since only works with report/],
      [['comment', 'feat/x', '--since', '30d'], /--since only works with report/],
    ];
    for (const [argv, message] of cases) {
      const fake = new FakeGitHub({ merged: [{ number: 1, title: 't', head: 'feat/x', mergedAt: '2026-10-02T00:00:00Z' }] });
      const { code, out, err } = await run([...argv, '--logs', logs], { cwd: repo, gh: fake.gh, now: () => NOW });
      assert.equal(code, 1, argv.join(' '));
      assert.equal(out, '', argv.join(' '));
      assert.match(err, message, argv.join(' '));
      assert.doesNotMatch(err, /skipped|no sessions found/, `${argv.join(' ')} fails before reading logs`);
      assert.equal(fake.state.calls.length, 0, `${argv.join(' ')} must not call gh`);
    }
  });

  it('is listed in --help', async () => {
    const { out } = await run(['--help']);
    assert.match(out, /prreceipt report/);
    assert.match(out, /--since/);
    assert.match(out, /CODEX_HOME/);
  });
});
