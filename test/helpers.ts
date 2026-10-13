import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, type CliContext } from '../src/cli.ts';
import type { Receipt } from '../src/receipt.ts';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const THREE_MESSAGES = join(FIXTURES, 'three-messages');
export const BRANCHES = join(FIXTURES, 'branches');
/** A Codex home: sessions/2026/10/03/rollout-….jsonl on branch feat/demo in /home/dev/demo. */
export const CODEX = join(FIXTURES, 'codex');
/** EC12: 10 Claude Code sessions, 3 Codex rollouts and ccusage reference totals (see its README.md). */
export const SAMPLE = join(FIXTURES, 'sample-logs');

/** A fresh temp dir. Real path, so it compares equal to what git reports (macOS /var → /private/var). */
export async function tempDir(prefix = 'prr-'): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

// ── git fixtures ────────────────────────────────────────────────────────────

/** Ignores the machine's git config so commits are reproducible (no signing, no hooks from templates). */
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

export function git(cwd: string, args: string[], dates?: { author: string; committer?: string }): string {
  const env = dates ? { ...gitEnv, GIT_AUTHOR_DATE: dates.author, GIT_COMMITTER_DATE: dates.committer ?? dates.author } : gitEnv;
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** An empty repo whose unborn branch is `branch`. */
export async function gitRepo(branch = 'main'): Promise<string> {
  const dir = await tempDir('prr-repo-');
  git(dir, ['init', '-q']);
  git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  return dir;
}

/** Writes (or, for null, deletes) files and commits everything at the given ISO date. */
export async function commit(
  repo: string,
  files: Record<string, string | null>,
  date: string | { author: string; committer: string },
  message = 'change',
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(repo, rel);
    if (content === null) {
      await rm(path);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', message], typeof date === 'string' ? { author: date } : date);
}

/** "line 1\n" … "line n\n" with a prefix, for diffs with an exact line count. */
export function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('');
}

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

/** Runs the CLI in-process with an empty env and a throwaway home, so the real machine is never read. */
export async function run(argv: string[], opts: Partial<Omit<CliContext, 'stdout' | 'stderr'>> = {}): Promise<RunResult> {
  let out = '';
  let err = '';
  const home = opts.home ?? (await tempDir('prr-home-'));
  const code = await main(argv, {
    env: opts.env ?? {},
    cwd: opts.cwd ?? home,
    home,
    gh: opts.gh,
    now: opts.now,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
  });
  return { code, out, err };
}

/** Writes JSONL files (relative path → entries, or raw text) into a fresh temp dir and returns it. */
export async function writeLogs(files: Record<string, Array<object | string> | string>): Promise<string> {
  const dir = await tempDir('prr-logs-');
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    const text =
      typeof content === 'string'
        ? content
        : content.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n';
    await writeFile(path, text);
  }
  return dir;
}

export async function writeJson(value: unknown): Promise<string> {
  const dir = await tempDir('prr-json-');
  const path = join(dir, 'prices.json');
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

let counter = 0;

export interface AssistantOpts {
  session: string;
  branch?: string | null;
  cwd?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  cacheRead?: number;
  ts?: string;
  id?: string;
  requestId?: string;
}

/** A Claude Code assistant transcript line. `branch: null` omits gitBranch entirely. */
export function assistant(o: AssistantOpts): object {
  counter += 1;
  const usage: Record<string, unknown> = {
    input_tokens: o.input ?? 0,
    cache_creation_input_tokens: o.cacheWrite ?? 0,
    cache_read_input_tokens: o.cacheRead ?? 0,
    output_tokens: o.output ?? 0,
    service_tier: 'standard',
  };
  if (o.cacheWrite1h !== undefined) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: (o.cacheWrite ?? 0) - o.cacheWrite1h,
      ephemeral_1h_input_tokens: o.cacheWrite1h,
    };
  }
  const line: Record<string, unknown> = {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: o.cwd ?? '/home/dev/proj',
    sessionId: o.session,
    version: '2.0.14',
    message: {
      id: o.id ?? `msg_gen_${counter}`,
      type: 'message',
      role: 'assistant',
      model: o.model ?? 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage,
    },
    requestId: o.requestId ?? `req_gen_${counter}`,
    type: 'assistant',
    uuid: `uuid-${counter}`,
    timestamp: o.ts ?? '2026-10-05T10:00:00.000Z',
  };
  if (o.branch !== null) line.gitBranch = o.branch ?? 'feat/x';
  return line;
}

export function user(o: { session: string; branch?: string | null; cwd?: string; ts: string; text?: string }): object {
  counter += 1;
  const line: Record<string, unknown> = {
    parentUuid: null,
    cwd: o.cwd ?? '/home/dev/proj',
    sessionId: o.session,
    type: 'user',
    message: { role: 'user', content: o.text ?? 'hello' },
    uuid: `uuid-${counter}`,
    timestamp: o.ts,
  };
  if (o.branch !== null) line.gitBranch = o.branch ?? 'feat/x';
  return line;
}

// ── Codex rollout lines ─────────────────────────────────────────────────────

export interface CodexTokens {
  input: number;
  cached?: number;
  output: number;
  reasoning?: number;
  cacheWrite?: number;
}

function codexUsage(t: CodexTokens): Record<string, number> {
  const usage: Record<string, number> = {
    input_tokens: t.input,
    cached_input_tokens: t.cached ?? 0,
    output_tokens: t.output,
    reasoning_output_tokens: t.reasoning ?? 0,
    total_tokens: t.input + t.output,
  };
  if (t.cacheWrite !== undefined) usage.cache_write_input_tokens = t.cacheWrite;
  return usage;
}

export function codexMeta(o: { id: string; ts: string; cwd?: string; branch?: string | null; forkedFrom?: string; spawnedBy?: string }): object {
  const payload: Record<string, unknown> = { id: o.id, timestamp: o.ts, cwd: o.cwd ?? '/home/dev/proj', originator: 'codex_cli_rs', cli_version: '0.160.1', model_provider: 'openai' };
  if (o.branch !== null) payload.git = { commit_hash: 'a'.repeat(40), branch: o.branch ?? 'feat/x', repository_url: 'https://github.com/acme/proj.git' };
  if (o.forkedFrom) payload.forked_from_id = o.forkedFrom;
  if (o.spawnedBy) payload.source = { subagent: { thread_spawn: { parent_thread_id: o.spawnedBy, depth: 1 } } };
  return { timestamp: o.ts, type: 'session_meta', payload };
}

export function codexTurn(o: { ts: string; model?: string; cwd?: string }): object {
  return { timestamp: o.ts, type: 'turn_context', payload: { cwd: o.cwd ?? '/home/dev/proj', approval_policy: 'on-request', model: o.model ?? 'gpt-5-codex', effort: 'medium' } };
}

/** A token_count event. `total` is the running total; `last` this turn's usage (omit either to leave it out). */
export function codexTokens(o: { ts: string; total?: CodexTokens; last?: CodexTokens }): object {
  const info: Record<string, unknown> = { model_context_window: 272_000 };
  if (o.total) info.total_token_usage = codexUsage(o.total);
  if (o.last) info.last_token_usage = codexUsage(o.last);
  return { timestamp: o.ts, type: 'event_msg', payload: { type: 'token_count', info, rate_limits: null } };
}

export function codexText(o: { ts: string; role: 'user' | 'assistant'; text: string }): object {
  return { timestamp: o.ts, type: 'response_item', payload: { type: 'message', role: o.role, content: [{ type: o.role === 'user' ? 'input_text' : 'output_text', text: o.text }] } };
}

/** Rows (cells, trimmed) of the first markdown table after the line matching `heading`. */
export function tableAfter(out: string, heading: RegExp): string[][] {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return [];
  let i = start + 1;
  while (i < lines.length && !lines[i].startsWith('|')) i += 1;
  const rows: string[][] = [];
  for (i += 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
  }
  return rows;
}

export function near(actual: number, expected: number, tolerance = 1e-9): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

// ── M4: receipt files and CI ────────────────────────────────────────────────

/** A committed receipt (prreceipt/1) exported from test/fixtures/three-messages, and the markdown it renders to. */
export const EXPORT_FIXTURE = join(FIXTURES, 'export');

/** A stand-in for the workflow's GITHUB_TOKEN, built at runtime so the repo holds nothing token-shaped. */
export const FAKE_TOKEN = ['ghs', 'Fake0Tok'.repeat(4)].join('_');

/** A complete receipt with every optional part present: window, diff, cache hits, an unpriced model. */
export function sampleReceipt(): Receipt {
  const start = Date.parse('2026-10-02T10:00:00Z');
  return {
    branch: 'feat/cart',
    asOf: '2026-10-13',
    totalCost: 0.123456789,
    totalTokens: 50_400,
    input: 10_000,
    output: 5_000,
    cacheWrite: 5_000,
    cacheRead: 30_400,
    cacheHitRate: 30_400 / 45_400,
    sessions: 2,
    wallTimeMs: 3_900_000,
    models: [
      { model: 'claude-sonnet-4-5', input: 9_000, output: 4_500, cacheWrite: 5_000, cacheRead: 30_000, tokens: 48_500, cost: 0.123456789 },
      { model: 'my-proxy-model', input: 1_000, output: 500, cacheWrite: 0, cacheRead: 400, tokens: 1_900, cost: null },
    ],
    unpriced: ['my-proxy-model'],
    unattributed: { sessions: 1, tokens: 400, cost: 0.0024 },
    window: { start, end: start + 7_200_999 },
    fromWindow: { sessions: 1, tokens: 1_900, cost: 0 },
    diff: { base: 'main', files: 3, insertions: 30, deletions: 10 },
    costPerLine: 0.123456789 / 40,
  };
}
