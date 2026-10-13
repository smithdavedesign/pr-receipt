// `prreceipt report`: what did each merged pull request cost? A PR counts the sessions on its head branch (in
// this repository) up to its merge; the report gives the total, the median and the five most expensive.
import type { MergedPullRequest } from './github.ts';
import type { LogEntry } from './parse.ts';
import type { PriceTable } from './pricing.ts';
import {
  displayBranch,
  footer,
  formatTokens,
  formatUsd,
  formatUsdShort,
  plural,
  safeInline,
  summarize,
  toSummary,
  unpricedWarning,
  utcMinute,
  type Summary,
} from './receipt.ts';

const DAY_MS = 86_400_000;
/**
 * A PR counts at most this much work before its merge. Without a bound, the first PR from a long-lived branch
 * (a develop → main release, a main → production deploy) would collect every session ever run on that branch.
 */
export const PR_LOOKBACK_DAYS = 90;
const TOP = 5;
const TITLE_MAX = 60;
const MAX_LISTED = 10;

export interface PrCost extends Summary {
  pr: MergedPullRequest;
  /** additions + deletions; null when GitHub didn't report them. */
  lines: number | null;
  /** cost ÷ lines; null without lines or when no lines changed. */
  costPerLine: number | null;
}

export interface Report {
  since: number;
  asOf: string;
  /** Merged PRs listed, with or without sessions. */
  merged: number;
  /** Merged PRs with at least one session, newest merge first. */
  prs: PrCost[];
  /** The most expensive of `prs`, at most five, by cost. */
  top: PrCost[];
  totalCost: number;
  /** Median cost of `prs` (the mean of the two middle values for an even count); null without PRs. */
  median: number | null;
  /** Merged PRs with no session on their branch in these logs (by hand, another machine, another person). */
  withoutSessions: MergedPullRequest[];
  /** Usage since `since` that no PR above counts. */
  other: Summary;
  unpriced: string[];
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** "30d" or "2w" before `now`, or "2026-09-01" (00:00 UTC), in ms; null for anything else. */
export function parseSince(text: string, now: number): number | null {
  const relative = /^(\d{1,5})([dw])$/.exec(text);
  if (relative) {
    const n = Number(relative[1]);
    return n > 0 ? now - n * (relative[2] === 'w' ? 7 : 1) * DAY_MS : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  // Date.parse rolls 2026-02-31 over to March; a real date round-trips.
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(text) ? ms : null;
}

/**
 * An entry on a PR's head branch goes to the first PR of that branch merged at or after it, if it's within
 * PR_LOOKBACK_DAYS of that merge. A branch name used for two PRs is split at the first merge; work after the
 * last merge belongs to no PR. An entry without a timestamp goes to the branch's latest PR.
 *
 * A PR whose head has the same name as its base (a fork's `main` into `main`) gets no sessions: locally that
 * name is the base branch, so its sessions are this repository's own work, not the fork's.
 */
function attribute(entries: LogEntry[], prs: MergedPullRequest[]): Map<MergedPullRequest, LogEntry[]> {
  const byHead = new Map<string, MergedPullRequest[]>();
  for (const pr of prs) {
    if (pr.headRefName === pr.baseRefName) continue;
    const list = byHead.get(pr.headRefName);
    if (list) list.push(pr);
    else byHead.set(pr.headRefName, [pr]);
  }
  for (const list of byHead.values()) list.sort((a, b) => a.mergedAt - b.mergedAt);

  const buckets = new Map<MergedPullRequest, LogEntry[]>(prs.map((pr) => [pr, []]));
  for (const entry of entries) {
    const candidates = entry.branch === null ? undefined : byHead.get(entry.branch);
    if (!candidates) continue;
    const ts = entry.timestamp;
    const pr = ts === null ? candidates[candidates.length - 1] : candidates.find((p) => ts <= p.mergedAt);
    if (pr && (ts === null || ts >= pr.mergedAt - PR_LOOKBACK_DAYS * DAY_MS)) buckets.get(pr)?.push(entry);
  }
  return buckets;
}

const newestFirst = (a: MergedPullRequest, b: MergedPullRequest) => b.mergedAt - a.mergedAt || b.number - a.number;

/** `entries` should already be scoped to the repository; `prs` to those merged since `since`. */
export function buildReport(entries: LogEntry[], prs: MergedPullRequest[], prices: PriceTable, since: number): Report {
  const buckets = attribute(entries, prs);
  const counted = new Set<LogEntry>();
  const unpriced = new Set<string>();
  const costs: PrCost[] = [];
  const withoutSessions: MergedPullRequest[] = [];

  for (const pr of prs) {
    const bucket = buckets.get(pr) ?? [];
    const t = summarize(bucket, prices);
    if (t.sessions === 0) {
      withoutSessions.push(pr);
      continue;
    }
    for (const entry of bucket) counted.add(entry);
    t.unpriced.forEach((m) => unpriced.add(m));
    const lines = pr.additions !== null && pr.deletions !== null ? pr.additions + pr.deletions : null;
    costs.push({ pr, ...toSummary(t), lines, costPerLine: lines ? t.cost / lines : null });
  }

  const rest = summarize(
    entries.filter((e) => !counted.has(e) && e.timestamp !== null && e.timestamp >= since),
    prices,
  );
  rest.unpriced.forEach((m) => unpriced.add(m));

  costs.sort((a, b) => newestFirst(a.pr, b.pr));
  withoutSessions.sort(newestFirst);
  return {
    since,
    asOf: prices.asOf,
    merged: prs.length,
    prs: costs,
    top: [...costs].sort((a, b) => b.cost - a.cost || newestFirst(a.pr, b.pr)).slice(0, TOP),
    totalCost: costs.reduce((total, c) => total + c.cost, 0),
    median: median(costs.map((c) => c.cost)),
    withoutSessions,
    other: toSummary(rest),
    unpriced: [...unpriced].sort(),
  };
}

// ── rendering ───────────────────────────────────────────────────────────────

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "#12 Title", shortened by code point (no split emoji) and sanitized for a table cell. */
function prLabel(pr: MergedPullRequest): string {
  const chars = [...pr.title];
  const title = chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX - 1).join('').trimEnd() + '…' : pr.title;
  return `#${pr.number} ${safeInline(title)}`;
}

function cells(c: PrCost): string[] {
  return [
    prLabel(c.pr),
    displayBranch(c.pr.headRefName),
    utcDay(c.pr.mergedAt),
    formatTokens(c.sessions),
    c.lines === null ? 'n/a' : formatTokens(c.lines),
    c.costPerLine === null ? 'n/a' : formatUsdShort(c.costPerLine),
    formatUsd(c.cost),
  ];
}

const row = (values: string[]) => `| ${values.join(' | ')} |`;
const COLUMNS = ['PR', 'Branch', 'Merged', 'Sessions', 'Lines changed', '$ / line', 'Cost'];
const ALIGN = ['---', '---', '---', '---:', '---:', '---:', '---:'];

function withoutSessionsLine(prs: MergedPullRequest[]): string | null {
  if (prs.length === 0) return null;
  const listed = prs.slice(0, MAX_LISTED).map((pr) => `#${pr.number}`);
  const more = prs.length > MAX_LISTED ? ` and ${prs.length - MAX_LISTED} more` : '';
  const had = prs.length === 1 ? 'merged PR had' : 'merged PRs had';
  return `_${formatTokens(prs.length)} ${had} no sessions in these logs: ${listed.join(', ')}${more}._`;
}

function otherLine(r: Report, since: string): string | null {
  const o = r.other;
  if (o.sessions === 0) return null;
  return `_Not in any merged PR: ${plural(o.sessions, 'session')} · ${formatTokens(o.tokens)} tokens · ${formatUsd(o.cost)} in this repository since ${since} (open or unmerged branches, work after a merge, or no git branch recorded)._`;
}

export function renderReport(r: Report): string {
  const since = `${utcMinute(r.since)} UTC`;
  const join = (blocks: Array<string | null>) => blocks.filter((b) => b !== null).join('\n\n') + '\n';
  if (r.prs.length === 0) {
    const head =
      r.merged === 0
        ? `no merged pull requests since ${since}`
        : `no merged pull requests with sessions since ${since} (${formatTokens(r.merged)} merged, none had sessions on ${r.merged === 1 ? 'its branch' : 'their branches'} in these logs)`;
    return join([head, otherLine(r, since), unpricedWarning(r.unpriced)]);
  }
  return join([
    `## 🧾 PR Receipt report: merged PRs since ${since}`,
    [
      `- **Merged PRs with agent sessions:** ${formatTokens(r.prs.length)} of ${formatTokens(r.merged)}`,
      `- **Total:** ${formatUsd(r.totalCost)} (API-equivalent estimate)`,
      `- **Median per PR:** ${formatUsd(r.median ?? 0)}`,
    ].join('\n'),
    `### Top ${TOP} by cost`,
    [row(['#', ...COLUMNS]), row(['---:', ...ALIGN]), ...r.top.map((c, i) => row([String(i + 1), ...cells(c)]))].join('\n'),
    r.prs.length > TOP ? `### All ${formatTokens(r.prs.length)} merged PRs with sessions, newest first` : null,
    r.prs.length > TOP ? [row(COLUMNS), row(ALIGN), ...r.prs.map((c) => row(cells(c)))].join('\n') : null,
    withoutSessionsLine(r.withoutSessions),
    otherLine(r, since),
    unpricedWarning(r.unpriced),
    footer(r.asOf, ' Merged PRs come from GitHub via gh; a PR counts the sessions on its branch up to its merge.'),
  ]);
}
