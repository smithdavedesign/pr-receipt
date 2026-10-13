// Aggregates parsed log entries into a per-branch receipt and renders it as markdown.
import { resolve, sep } from 'node:path';
import type { LogEntry } from './parse.ts';
import { costOf, findPrice, normalizeModel, type PriceTable } from './pricing.ts';

export interface ModelLine {
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  tokens: number;
  /** null when the model has no price in the table. */
  cost: number | null;
}

export interface Summary {
  sessions: number;
  tokens: number;
  cost: number;
}

/** First → last commit time of a branch's own commits, in ms since the epoch (inclusive). */
export interface CommitWindow {
  start: number;
  end: number;
}

/** The branch's diff against its base (three-dot, like a PR's "Files changed"). */
export interface DiffStat {
  base: string;
  files: number;
  insertions: number;
  deletions: number;
}

/** What git knows about the branch. Every field is optional; without them the receipt is M1's. */
export interface BranchContext {
  window?: CommitWindow | null;
  /** Repo directories. Only no-branch entries whose cwd is inside one of them can be matched by the window. */
  roots?: string[];
  diff?: DiffStat | null;
}

export interface Receipt {
  branch: string;
  asOf: string;
  totalCost: number;
  totalTokens: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Cache reads as a share of all prompt tokens; null when there were no prompt tokens. */
  cacheHitRate: number | null;
  sessions: number;
  wallTimeMs: number;
  models: ModelLine[];
  unpriced: string[];
  unattributed: Summary;
  window: CommitWindow | null;
  /** The part of the totals above that came from no-branch sessions matched by the commit window. */
  fromWindow: Summary;
  diff: DiffStat | null;
  /** totalCost ÷ changed lines; null without a diff or when no lines changed. */
  costPerLine: number | null;
}

export interface BranchSummary extends Summary {
  branch: string;
}

export interface Overview {
  asOf: string;
  branches: BranchSummary[];
  unattributed: Summary;
  totalCost: number;
  unpriced: string[];
}

export interface Totals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  tokens: number;
  cost: number;
  sessions: number;
  wallTimeMs: number;
  models: ModelLine[];
  unpriced: string[];
}

/** Sums one bucket of entries. Sessions count only if they used tokens; wall time is first→last line per session. */
export function summarize(entries: LogEntry[], prices: PriceTable): Totals {
  const models = new Map<string, ModelLine>();
  const unpriced = new Set<string>();
  const spans = new Map<string, { first: number; last: number; used: boolean }>();
  let cost = 0;

  for (const entry of entries) {
    let span = spans.get(entry.sessionId);
    if (!span) {
      span = { first: Infinity, last: -Infinity, used: false };
      spans.set(entry.sessionId, span);
    }
    if (entry.timestamp !== null) {
      span.first = Math.min(span.first, entry.timestamp);
      span.last = Math.max(span.last, entry.timestamp);
    }
    const usage = entry.usage;
    if (!usage) continue;
    span.used = true;

    const name = normalizeModel(usage.model);
    const price = findPrice(prices, usage.model);
    let line = models.get(name);
    if (!line) {
      line = { model: name, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, tokens: 0, cost: price ? 0 : null };
      models.set(name, line);
    }
    line.input += usage.input;
    line.output += usage.output;
    line.cacheWrite += usage.cacheWrite;
    line.cacheRead += usage.cacheRead;
    line.tokens += usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
    if (price) {
      const c = costOf(usage, price);
      line.cost = (line.cost ?? 0) + c;
      cost += c;
    } else {
      unpriced.add(name);
    }
  }

  let sessions = 0;
  let wallTimeMs = 0;
  for (const span of spans.values()) {
    if (!span.used) continue;
    sessions += 1;
    if (span.last >= span.first) wallTimeMs += span.last - span.first;
  }

  const lines = [...models.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.tokens - a.tokens);
  const sum = (field: 'input' | 'output' | 'cacheWrite' | 'cacheRead' | 'tokens') =>
    lines.reduce((total, line) => total + line[field], 0);
  return {
    input: sum('input'),
    output: sum('output'),
    cacheWrite: sum('cacheWrite'),
    cacheRead: sum('cacheRead'),
    tokens: sum('tokens'),
    cost,
    sessions,
    wallTimeMs,
    models: lines,
    unpriced: [...unpriced].sort(),
  };
}

export function toSummary(t: Totals): Summary {
  return { sessions: t.sessions, tokens: t.tokens, cost: t.cost };
}

/** A predicate for "cwd is one of these directories or inside one". Entries without a cwd never match. */
function insideAny(dirs: string[]): (cwd: string | null) => boolean {
  const roots = dirs.map((dir) => {
    const root = resolve(dir);
    return { root, prefix: root.endsWith(sep) ? root : root + sep };
  });
  return (cwd) => {
    if (cwd === null) return false;
    const path = resolve(cwd);
    return roots.some(({ root, prefix }) => path === root || path.startsWith(prefix));
  };
}

/** Keeps entries whose working directory is inside `repo` (or any of several repo dirs). Entries without a cwd are dropped. */
export function filterByRepo(entries: LogEntry[], repo: string | string[]): LogEntry[] {
  const inside = insideAny(typeof repo === 'string' ? [repo] : repo);
  return entries.filter((e) => inside(e.cwd));
}

/**
 * Time-window fallback: entries with no git branch, run inside `roots`, from sessions whose time span overlaps
 * the window. Whole sessions are taken, because the session that makes a branch's first commit starts before it.
 */
export function matchWindow(entries: LogEntry[], window: CommitWindow, roots: string[]): LogEntry[] {
  const inside = insideAny(roots);
  const bySession = new Map<string, { entries: LogEntry[]; first: number; last: number }>();
  for (const entry of entries) {
    if (entry.branch !== null || !inside(entry.cwd)) continue;
    let session = bySession.get(entry.sessionId);
    if (!session) {
      session = { entries: [], first: Infinity, last: -Infinity };
      bySession.set(entry.sessionId, session);
    }
    session.entries.push(entry);
    if (entry.timestamp !== null) {
      session.first = Math.min(session.first, entry.timestamp);
      session.last = Math.max(session.last, entry.timestamp);
    }
  }
  const matched: LogEntry[] = [];
  for (const session of bySession.values()) {
    if (session.first > window.end || session.last < window.start) continue;
    for (const entry of session.entries) matched.push(entry); // no spread: one session can have 100k+ lines
  }
  return matched;
}

export function buildReceipt(entries: LogEntry[], branch: string, prices: PriceTable, context: BranchContext = {}): Receipt {
  const window = context.window ?? null;
  const windowed = new Set(window && context.roots ? matchWindow(entries, window, context.roots) : []);
  const t = summarize(
    entries.filter((e) => e.branch === branch || windowed.has(e)),
    prices,
  );
  const fromWindow = summarize([...windowed], prices);
  const unattributed = summarize(
    entries.filter((e) => e.branch === null && !windowed.has(e)),
    prices,
  );
  const promptTokens = t.input + t.cacheWrite + t.cacheRead;
  const diff = context.diff ?? null;
  const changedLines = diff ? diff.insertions + diff.deletions : 0;
  return {
    branch,
    asOf: prices.asOf,
    totalCost: t.cost,
    totalTokens: t.tokens,
    input: t.input,
    output: t.output,
    cacheWrite: t.cacheWrite,
    cacheRead: t.cacheRead,
    cacheHitRate: promptTokens > 0 ? t.cacheRead / promptTokens : null,
    sessions: t.sessions,
    wallTimeMs: t.wallTimeMs,
    models: t.models,
    unpriced: t.unpriced,
    unattributed: toSummary(unattributed),
    window,
    fromWindow: toSummary(fromWindow),
    diff,
    costPerLine: changedLines > 0 ? t.cost / changedLines : null,
  };
}

export function buildOverview(entries: LogEntry[], prices: PriceTable): Overview {
  const byBranch = new Map<string, LogEntry[]>();
  const none: LogEntry[] = [];
  for (const entry of entries) {
    if (entry.branch === null) {
      none.push(entry);
      continue;
    }
    const bucket = byBranch.get(entry.branch);
    if (bucket) bucket.push(entry);
    else byBranch.set(entry.branch, [entry]);
  }

  const unpriced = new Set<string>();
  const branches: BranchSummary[] = [];
  for (const [branch, bucket] of byBranch) {
    const t = summarize(bucket, prices);
    t.unpriced.forEach((m) => unpriced.add(m));
    if (t.sessions > 0) branches.push({ branch, ...toSummary(t) });
  }
  branches.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.branch.localeCompare(b.branch));

  const rest = summarize(none, prices);
  rest.unpriced.forEach((m) => unpriced.add(m));
  const totalCost = branches.reduce((total, b) => total + b.cost, rest.cost);
  return { asOf: prices.asOf, branches, unattributed: toSummary(rest), totalCost, unpriced: [...unpriced].sort() };
}

// ── formatting ──────────────────────────────────────────────────────────────

const USD_SMALL = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const USD_LARGE = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INTEGER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const MINUTE_MS = 60_000;

/** Four decimals below $1 (agent turns are often fractions of a cent), two above. */
export function formatUsd(amount: number): string {
  const rounded = Math.round(amount * 10_000) / 10_000;
  return '$' + (Math.abs(rounded) < 1 ? USD_SMALL.format(rounded) : USD_LARGE.format(amount));
}

/** formatUsd without trailing zeros past the cents: $0.0200 → $0.02, $0.0125 stays. For per-line amounts. */
export function formatUsdShort(amount: number): string {
  return formatUsd(amount).replace(/(\.\d\d\d*?)0+$/, '$1');
}

export function formatTokens(count: number): string {
  return INTEGER.format(count);
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatPercent(ratio: number | null): string {
  return ratio === null ? 'n/a' : `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Log- and GitHub-sourced names may contain characters that break markdown (backticks, pipes, HTML) or
 * terminals (C0/C1 controls, bidirectional overrides that make text read differently than it is); replace them.
 */
function safeText(text: string): string {
  return text.replace(/[`|<>\\\u0000-\u001f\u007f-\u009f]/g, '_').replace(BIDI_CONTROLS, '_');
}

/** U+202A–U+202E and U+2066–U+2069, built from code points so this source file holds no invisible characters. */
const BIDI_CONTROLS = new RegExp(
  `[${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2066)}-${String.fromCodePoint(0x2069)}]`,
  'g',
);

export function displayBranch(branch: string): string {
  return '`' + safeText(branch) + '`';
}

/**
 * For text outside code spans (model names, PR titles): markdown-active characters as in safeText, and "@",
 * which would mention a user or team once posted on GitHub.
 */
export function safeInline(text: string): string {
  return safeText(text).replace(/@/g, '_');
}

export const plural = (n: number, word: string) => `${formatTokens(n)} ${word}${n === 1 ? '' : 's'}`;

function unattributedLine(u: Summary): string | null {
  if (u.sessions === 0) return null;
  return `_Unattributed (no git branch): ${plural(u.sessions, 'session')} · ${formatTokens(u.tokens)} tokens · ${formatUsd(u.cost)}, not included above._`;
}

/** "2026-10-02 10:00" in UTC, so a receipt reads the same on every machine. */
export function utcMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function windowLine(r: Receipt): string | null {
  const w = r.fromWindow;
  if (w.sessions === 0 || r.window === null) return null;
  return `_Includes ${plural(w.sessions, 'session')} · ${formatTokens(w.tokens)} tokens · ${formatUsd(w.cost)} with no git branch recorded, matched by this branch’s commit window (${utcMinute(r.window.start)} → ${utcMinute(r.window.end)} UTC)._`;
}

function linesChanged(r: Receipt): string | null {
  const d = r.diff;
  if (d === null) return null;
  const line = `- **Lines changed:** ${formatTokens(d.insertions + d.deletions)} (+${formatTokens(d.insertions)} / -${formatTokens(d.deletions)} vs ${displayBranch(d.base)})`;
  return r.costPerLine === null ? line : `${line} · ${formatUsdShort(r.costPerLine)} per changed line`;
}

export function unpricedWarning(models: string[]): string | null {
  if (models.length === 0) return null;
  return `> ⚠️ No price for ${models.map(safeInline).join(', ')}: tokens are counted but cost $0 here. Add the model to a prices file and pass \`--prices <file>\`.`;
}

export function footer(asOf: string, extra = ''): string {
  return `<sub>API-equivalent estimate from local Claude Code and Codex logs, list prices as of ${asOf} plus any overrides.${extra} Generated by prreceipt.</sub>`;
}

export function renderReceipt(r: Receipt): string {
  if (r.sessions === 0) {
    return [
      `no sessions found for branch ${displayBranch(r.branch)}. Run \`prreceipt show --all\` to list branches that have sessions.`,
      unattributedLine(r.unattributed),
    ]
      .filter((l) => l !== null)
      .join('\n\n') + '\n';
  }
  const rows = r.models.map(
    (m) =>
      `| ${safeInline(m.model)} | ${formatTokens(m.input)} | ${formatTokens(m.output)} | ${formatTokens(m.cacheWrite)} | ${formatTokens(m.cacheRead)} | ${m.cost === null ? 'unpriced' : formatUsd(m.cost)} |`,
  );
  const blocks: Array<string | null> = [
    `## 🧾 PR Receipt: ${displayBranch(r.branch)}`,
    [
      `- **Total:** ${formatUsd(r.totalCost)} (API-equivalent estimate)`,
      `- **Tokens:** ${formatTokens(r.totalTokens)} (input ${formatTokens(r.input)} · output ${formatTokens(r.output)} · cache write ${formatTokens(r.cacheWrite)} · cache read ${formatTokens(r.cacheRead)})`,
      `- **Cache hit rate:** ${formatPercent(r.cacheHitRate)}`,
      `- **Sessions:** ${formatTokens(r.sessions)}`,
      `- **Wall time:** ${formatDuration(r.wallTimeMs)}`,
      linesChanged(r),
    ]
      .filter((l) => l !== null)
      .join('\n'),
    ['| Model | Input | Output | Cache write | Cache read | Cost |', '|---|---:|---:|---:|---:|---:|', ...rows].join('\n'),
    unpricedWarning(r.unpriced),
    windowLine(r),
    unattributedLine(r.unattributed),
    footer(r.asOf),
  ];
  return blocks.filter((b) => b !== null).join('\n\n') + '\n';
}

export function renderOverview(o: Overview): string {
  const rows = o.branches.map(
    (b) => `| ${displayBranch(b.branch)} | ${formatTokens(b.sessions)} | ${formatTokens(b.tokens)} | ${formatUsd(b.cost)} |`,
  );
  const u = o.unattributed;
  if (u.sessions > 0) rows.push(`| _unattributed_ | ${formatTokens(u.sessions)} | ${formatTokens(u.tokens)} | ${formatUsd(u.cost)} |`);
  const blocks: Array<string | null> = [
    '## 🧾 PR Receipt: all branches',
    ['| Branch | Sessions | Tokens | Cost |', '|---|---:|---:|---:|', ...rows].join('\n'),
    `**Total:** ${formatUsd(o.totalCost)} (API-equivalent estimate). Run \`prreceipt show <branch>\` for a full receipt.`,
    unpricedWarning(o.unpriced),
    footer(o.asOf),
  ];
  return blocks.filter((b) => b !== null).join('\n\n') + '\n';
}
