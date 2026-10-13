// Writes the EC12 sample logs (10 Claude Code sessions, 3 Codex rollouts) and the reference totals that
// ccusage's published counting rules give for them. Deterministic: running it again changes nothing.
//
//   node --disable-warning=ExperimentalWarning test/fixtures/sample-logs/generate.ts
//
// The reference is computed from the true per-request usage below, never from the written lines and
// never through src/, so it is independent of the code under test. README.md explains how to replace
// it with the output of a real ccusage run.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = join(HERE, 'claude', 'projects', '-home-dev-shop');
const CODEX_DIR = join(HERE, 'codex', 'sessions');
const CWD = '/home/dev/shop';

// List prices in USD per million tokens, as in the LiteLLM table ccusage prices with. Deliberately not
// read from prices.json.
const CLAUDE_PRICES = {
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, write5m: 3.75, write1h: 6, read: 0.3 },
  'claude-opus-4-5-20251101': { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, write5m: 1.25, write1h: 2, read: 0.1 },
} as const;
const CODEX_PRICES = {
  'gpt-5-codex': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5.3-codex': { input: 1.75, cached: 0.175, output: 14 },
} as const;

type ClaudeModel = keyof typeof CLAUDE_PRICES;
type CodexModel = keyof typeof CODEX_PRICES;

/** mulberry32: a tiny seeded PRNG, so the sample is the same on every run. */
function rng(seed: number): (min: number, max: number) => number {
  let a = seed >>> 0;
  return (min, max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return min + Math.floor(r * (max - min + 1));
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const PER_MILLION = 1_000_000;

// ── Claude Code ────────────────────────────────────────────────────────────

interface ClaudeRequest {
  model: ClaudeModel;
  input: number;
  output: number;
  write5m: number;
  write1h: number;
  read: number;
  sidechain: boolean;
  branch: string | null;
  messageId: string;
  requestId: string;
  ts: number;
}

interface ClaudeSessionSpec {
  id: string;
  start: string;
  /** [model, count, branch, options] per run of requests. */
  runs: Array<{ model: ClaudeModel; count: number; branch: string | null; sidechain?: boolean; oneHour?: boolean }>;
  version?: string;
  /** Copy every line of this earlier session at the head of the file (what `claude --resume` writes). */
  resumes?: string;
  synthetic?: boolean;
  summary?: boolean;
  halfWrittenLastLine?: boolean;
}

const SESSIONS: ClaudeSessionSpec[] = [
  { id: 's01', start: '2026-10-01T09:00:00Z', runs: [{ model: 'claude-sonnet-4-5-20250929', count: 7, branch: 'feat/cart' }] },
  { id: 's02', start: '2026-10-01T14:00:00Z', runs: [{ model: 'claude-opus-4-5-20251101', count: 5, branch: 'feat/cart', oneHour: true }] },
  {
    id: 's03',
    start: '2026-10-02T10:00:00Z',
    runs: [
      { model: 'claude-sonnet-4-5-20250929', count: 4, branch: 'feat/search' },
      { model: 'claude-haiku-4-5-20251001', count: 3, branch: 'feat/search', sidechain: true },
      { model: 'claude-sonnet-4-5-20250929', count: 2, branch: 'feat/search' },
    ],
  },
  { id: 's04', start: '2026-10-03T08:30:00Z', runs: [{ model: 'claude-haiku-4-5-20251001', count: 4, branch: 'fix/login' }] },
  {
    id: 's05',
    start: '2026-10-03T13:00:00Z',
    runs: [
      { model: 'claude-sonnet-4-5-20250929', count: 3, branch: 'feat/search' },
      { model: 'claude-sonnet-4-5-20250929', count: 3, branch: 'fix/login' },
    ],
  },
  { id: 's06', start: '2026-10-04T11:00:00Z', version: '1.0.20', runs: [{ model: 'claude-sonnet-4-5-20250929', count: 4, branch: null }] },
  { id: 's07', start: '2026-10-05T16:00:00Z', synthetic: true, summary: true, runs: [{ model: 'claude-opus-4-5-20251101', count: 3, branch: 'main' }] },
  { id: 's08', start: '2026-10-06T09:15:00Z', halfWrittenLastLine: true, runs: [{ model: 'claude-sonnet-4-5-20250929', count: 5, branch: 'feat/export' }] },
  {
    id: 's09',
    start: '2026-10-07T10:00:00Z',
    runs: [
      { model: 'claude-sonnet-4-5-20250929', count: 3, branch: 'feat/export' },
      { model: 'claude-haiku-4-5-20251001', count: 3, branch: 'feat/export' },
    ],
  },
  { id: 's10', start: '2026-10-08T09:00:00Z', resumes: 's04', runs: [{ model: 'claude-haiku-4-5-20251001', count: 3, branch: 'fix/login' }] },
];

/** UUID-shaped session ids that sort in session order. */
const sessionUuid = (id: string) => `5e55a000-0000-4000-8000-0000000000${id.slice(1)}`;

function claudeRequests(spec: ClaudeSessionSpec, seed: number): ClaudeRequest[] {
  const r = rng(seed);
  let t = Date.parse(spec.start) + 20_000;
  const requests: ClaudeRequest[] = [];
  for (const run of spec.runs) {
    for (let i = 0; i < run.count; i += 1) {
      const n = requests.length + 1;
      const write = r(0, 4) === 0 ? 0 : r(400, 14_000);
      const oneHourShare = run.oneHour ? write - r(0, Math.floor(write / 4)) : 0;
      requests.push({
        model: run.model,
        input: r(3, 420),
        output: r(40, 3_200),
        write5m: write - oneHourShare,
        write1h: oneHourShare,
        read: n === 1 ? 0 : r(12_000, 140_000),
        sidechain: run.sidechain ?? false,
        branch: run.branch,
        messageId: `msg_01Sample${spec.id}${String(n).padStart(3, '0')}`,
        requestId: `req_011Sample${spec.id}${String(n).padStart(3, '0')}`,
        ts: t,
      });
      t += r(25_000, 95_000);
    }
  }
  return requests;
}

/** Content blocks of one streamed response, one transcript line each; the last line carries the final usage. */
const BLOCKS = [['tool_use'], ['thinking', 'tool_use'], ['thinking', 'text', 'tool_use']] as const;

function claudeLines(spec: ClaudeSessionSpec, requests: ClaudeRequest[], seed: number): object[] {
  const r = rng(seed + 1);
  const session = sessionUuid(spec.id);
  const lines: object[] = [];
  let parent: string | null = null;
  let uuidCounter = 0;
  const base = (branch: string | null, ts: number, sidechain: boolean): Record<string, unknown> => {
    uuidCounter += 1;
    const line: Record<string, unknown> = {
      parentUuid: parent,
      isSidechain: sidechain,
      userType: 'external',
      cwd: CWD,
      sessionId: session,
      version: spec.version ?? '2.1.4',
    };
    if (branch !== null) line.gitBranch = branch;
    line.uuid = `${session.slice(0, 8)}-line-${String(uuidCounter).padStart(4, '0')}`;
    line.timestamp = iso(ts);
    parent = line.uuid as string;
    return line;
  };

  requests.forEach((req, i) => {
    lines.push({
      ...base(req.branch, req.ts - 15_000, req.sidechain),
      type: 'user',
      message: { role: 'user', content: i === 0 ? `PROMPT-MARKER-sample-${spec.id} build the next step of the feature` : [{ type: 'tool_result', tool_use_id: `toolu_${spec.id}_${i}`, content: `PROMPT-MARKER-sample-tool ${spec.id} output ${i}` }] },
    });
    // Streaming: one line per content block; the early lines carry a partial output count, the last the final one.
    const blocks = BLOCKS[r(0, 2)];
    for (let c = 0; c < blocks.length; c += 1) {
      const last = c === blocks.length - 1;
      const block = blocks[c];
      const content =
        block === 'thinking'
          ? [{ type: 'thinking', thinking: `RESPONSE-MARKER-sample-thinking ${spec.id} ${i}`, signature: 'sig' }]
          : block === 'text'
            ? [{ type: 'text', text: `RESPONSE-MARKER-sample ${spec.id} step ${i}` }]
            : [{ type: 'tool_use', id: `toolu_${spec.id}_${i + 1}`, name: 'Edit', input: { file_path: `${CWD}/src/file${i}.ts` } }];
      lines.push({
        ...base(req.branch, req.ts + c * 400, req.sidechain),
        message: {
          id: req.messageId,
          type: 'message',
          role: 'assistant',
          model: req.model,
          content,
          stop_reason: last ? 'tool_use' : null,
          stop_sequence: null,
          usage: {
            input_tokens: req.input,
            cache_creation_input_tokens: req.write5m + req.write1h,
            cache_read_input_tokens: req.read,
            cache_creation: { ephemeral_5m_input_tokens: req.write5m, ephemeral_1h_input_tokens: req.write1h },
            output_tokens: last ? req.output : r(1, 9),
            service_tier: 'standard',
          },
        },
        requestId: req.requestId,
        type: 'assistant',
      });
    }
  });

  if (spec.synthetic) {
    lines.push({
      ...base('main', requests[requests.length - 1].ts + 60_000, false),
      message: {
        id: `msg_synthetic_${spec.id}`,
        type: 'message',
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'RESPONSE-MARKER-sample No response requested.' }],
        stop_reason: 'stop_sequence',
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      type: 'assistant',
    });
  }
  return lines;
}

interface SessionReference {
  sessionId: string;
  projectPath: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  lastActivity: string;
  modelsUsed: string[];
}

function claudeCost(req: ClaudeRequest): number {
  const p = CLAUDE_PRICES[req.model];
  return (req.input * p.input + req.output * p.output + req.write5m * p.write5m + req.write1h * p.write1h + req.read * p.read) / PER_MILLION;
}

function writeClaude(): SessionReference[] {
  rmSync(join(HERE, 'claude'), { recursive: true, force: true });
  mkdirSync(CLAUDE_DIR, { recursive: true });
  const written = new Map<string, object[]>();
  const references: SessionReference[] = [];
  SESSIONS.forEach((spec, index) => {
    const requests = claudeRequests(spec, 1000 + index * 17);
    let lines = claudeLines(spec, requests, 1000 + index * 17);
    if (spec.resumes) {
      // A resumed session's file starts with the earlier conversation, rewritten to the new session id.
      const copied = (written.get(spec.resumes) ?? []).map((line) => ({ ...line, sessionId: sessionUuid(spec.id) }));
      lines = [...copied, ...lines];
    }
    written.set(spec.id, lines);
    const text = lines.map((l) => JSON.stringify(l));
    if (spec.summary) text.unshift(JSON.stringify({ type: 'summary', summary: `PROMPT-MARKER-sample-summary ${spec.id} release prep`, leafUuid: `${sessionUuid(spec.id).slice(0, 8)}-line-0002` }));
    let body = text.join('\n') + '\n';
    if (spec.halfWrittenLastLine) {
      const partial = JSON.stringify({ parentUuid: null, isSidechain: false, cwd: CWD, sessionId: sessionUuid(spec.id), type: 'user', message: { role: 'user', content: 'PROMPT-MARKER-sample half written' } });
      body += partial.slice(0, Math.floor(partial.length / 2));
    }
    writeFileSync(join(CLAUDE_DIR, `${sessionUuid(spec.id)}.jsonl`), body);

    // ccusage's rules: one count per message.id + requestId (the most complete copy), so the copied
    // head of a resumed session counts once, under the session that first wrote it.
    const sum = (f: (q: ClaudeRequest) => number) => requests.reduce((total, q) => total + f(q), 0);
    const input = sum((q) => q.input);
    const output = sum((q) => q.output);
    const write = sum((q) => q.write5m + q.write1h);
    const read = sum((q) => q.read);
    references.push({
      sessionId: sessionUuid(spec.id),
      projectPath: '-home-dev-shop',
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: write,
      cacheReadTokens: read,
      totalTokens: input + output + write + read,
      totalCost: round(sum(claudeCost)),
      lastActivity: iso(requests[requests.length - 1].ts).slice(0, 10),
      modelsUsed: [...new Set(requests.map((q) => q.model))],
    });
  });
  return references;
}

// ── Codex ──────────────────────────────────────────────────────────────────

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

interface CodexSessionSpec {
  id: string;
  date: string;
  model: CodexModel;
  branch: string;
  turns: number;
  forkOf?: string;
  repeatAfterTurn?: number;
  noLastOnTurn?: number;
  compactionAtEnd?: boolean;
}

const CODEX_SESSIONS: CodexSessionSpec[] = [
  { id: '0199b001-7a10-7c2e-9d01-5a3f00000001', date: '2026-10-04T10:00:00Z', model: 'gpt-5-codex', branch: 'feat/search', turns: 4, repeatAfterTurn: 2, compactionAtEnd: true },
  { id: '0199b002-7a10-7c2e-9d01-5a3f00000002', date: '2026-10-06T15:30:00Z', model: 'gpt-5.3-codex', branch: 'fix/login', turns: 3, noLastOnTurn: 2 },
  { id: '0199b003-7a10-7c2e-9d01-5a3f00000003', date: '2026-10-07T08:45:00Z', model: 'gpt-5-codex', branch: 'feat/search', turns: 2, forkOf: '0199b001-7a10-7c2e-9d01-5a3f00000001' },
];

const zero = (): CodexUsage => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 });
const add = (a: CodexUsage, b: CodexUsage): CodexUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  reasoning_output_tokens: a.reasoning_output_tokens + b.reasoning_output_tokens,
  total_tokens: a.total_tokens + b.total_tokens,
});

const rolloutPath = (spec: CodexSessionSpec) => {
  const day = spec.date.slice(0, 10).replace(/-/g, '/');
  const stamp = spec.date.slice(0, 19).replace(/:/g, '-');
  return join(day, `rollout-${stamp}-${spec.id}`);
};

interface CodexReference {
  sessionId: string;
  sessionFile: string;
  directory: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUSD: number;
  lastActivity: string;
  models: string[];
}

function writeCodex(): CodexReference[] {
  rmSync(join(HERE, 'codex'), { recursive: true, force: true });
  const written = new Map<string, { lines: object[]; total: CodexUsage }>();
  const references: CodexReference[] = [];
  CODEX_SESSIONS.forEach((spec, index) => {
    const r = rng(5000 + index * 31);
    let t = Date.parse(spec.date);
    const lines: object[] = [];
    const meta: Record<string, unknown> = {
      id: spec.id,
      timestamp: iso(t),
      cwd: CWD,
      originator: 'codex_cli_rs',
      cli_version: '0.160.1',
      instructions: null,
      model_provider: 'openai',
      git: { commit_hash: '9c1d4b5e6f708192a3b4c5d6e7f809a1b2c33f2a', branch: spec.branch, repository_url: 'https://github.com/acme/shop.git' },
    };
    if (spec.forkOf) meta.forked_from_id = spec.forkOf;
    lines.push({ timestamp: iso(t), type: 'session_meta', payload: meta });

    // A fork starts with its parent's history, token_count snapshots included.
    let total = zero();
    if (spec.forkOf) {
      const parent = written.get(spec.forkOf);
      if (!parent) throw new Error(`fork parent ${spec.forkOf} must be written first`);
      for (const line of parent.lines) lines.push({ ...(line as Record<string, unknown>), timestamp: iso(t) });
      total = parent.total;
    }
    lines.push({ timestamp: iso((t += 50)), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 1.0, window_minutes: 300 }, secondary: null } } });

    let own = zero();
    for (let turn = 1; turn <= spec.turns; turn += 1) {
      lines.push({ timestamp: iso((t += 1_000)), type: 'turn_context', payload: { cwd: CWD, approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' }, model: spec.model, effort: 'medium', summary: 'auto' } });
      lines.push({ timestamp: iso((t += 100)), type: 'event_msg', payload: { type: 'user_message', message: `PROMPT-MARKER-sample-codex ${spec.id.slice(-4)} turn ${turn}`, kind: 'plain' } });
      lines.push({ timestamp: iso((t += 100)), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `PROMPT-MARKER-sample-codex ${spec.id.slice(-4)} turn ${turn}` }] } });
      lines.push({ timestamp: iso((t += r(5_000, 30_000))), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: `RESPONSE-MARKER-sample-codex thinking ${turn}` }] } });
      const input = r(8_000, 60_000);
      const output = r(300, 4_000);
      const last: CodexUsage = {
        input_tokens: input,
        cached_input_tokens: turn === 1 && !spec.forkOf ? 0 : Math.floor(input * r(50, 90) / 100),
        output_tokens: output,
        reasoning_output_tokens: Math.floor(output * r(20, 60) / 100),
        total_tokens: input + output,
      };
      total = add(total, last);
      own = add(own, last);
      const info: Record<string, unknown> = { total_token_usage: total, model_context_window: 272_000 };
      if (turn !== spec.noLastOnTurn) info.last_token_usage = last;
      const tokenCount = { type: 'token_count', info, rate_limits: { primary: { used_percent: 1 + turn, window_minutes: 300 }, secondary: null } };
      lines.push({ timestamp: iso((t += r(2_000, 20_000))), type: 'event_msg', payload: tokenCount });
      if (turn === spec.repeatAfterTurn) lines.push({ timestamp: iso((t += 300)), type: 'event_msg', payload: tokenCount });
      lines.push({ timestamp: iso((t += 200)), type: 'event_msg', payload: { type: 'agent_message', message: `RESPONSE-MARKER-sample-codex done ${turn}` } });
    }
    if (spec.compactionAtEnd) {
      lines.push({ timestamp: iso((t += 1_000)), type: 'compacted', payload: { message: 'RESPONSE-MARKER-sample-codex summary' } });
      lines.push({
        timestamp: iso((t += 100)),
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: { ...zero(), total_tokens: 30_000 }, model_context_window: 272_000 }, rate_limits: null },
      });
    }

    const rel = rolloutPath(spec);
    mkdirSync(dirname(join(CODEX_DIR, rel)), { recursive: true });
    writeFileSync(join(CODEX_DIR, `${rel}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    written.set(spec.id, { lines, total });

    // ccusage's rules: a snapshot counts only when the running total moved, and a fork's replayed
    // parent history isn't counted again, so each session is its own turns.
    const p = CODEX_PRICES[spec.model];
    const uncached = own.input_tokens - own.cached_input_tokens;
    references.push({
      sessionId: rel,
      sessionFile: `${rel}.jsonl`,
      directory: CWD,
      inputTokens: own.input_tokens,
      cachedInputTokens: own.cached_input_tokens,
      outputTokens: own.output_tokens,
      reasoningOutputTokens: own.reasoning_output_tokens,
      totalTokens: own.input_tokens + own.output_tokens,
      costUSD: round((uncached * p.input + own.cached_input_tokens * p.cached + own.output_tokens * p.output) / PER_MILLION),
      lastActivity: iso(t).slice(0, 10),
      models: [spec.model],
    });
  });
  return references;
}

const round = (usd: number) => Math.round(usd * 1e9) / 1e9;

function totalsOf<T extends object>(rows: T[], fields: Array<keyof T & string>): Record<string, number> {
  return Object.fromEntries(fields.map((f) => [f, round(rows.reduce((sum, row) => sum + Number(row[f]), 0))]));
}

const NOTE =
  'Reference derived from ccusage\'s published counting rules (see README.md), not captured from a ccusage run. Replace this file with real `--json` output to check against ccusage itself.';

const claude = writeClaude();
writeFileSync(
  join(HERE, 'ccusage-claude-session.json'),
  JSON.stringify(
    {
      _reference: NOTE,
      sessions: claude,
      totals: totalsOf(claude, ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalTokens', 'totalCost']),
    },
    null,
    2,
  ) + '\n',
);
const codex = writeCodex();
writeFileSync(
  join(HERE, 'ccusage-codex-session.json'),
  JSON.stringify(
    {
      _reference: NOTE,
      sessions: codex,
      totals: totalsOf(codex, ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens', 'costUSD']),
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(`wrote ${claude.length} Claude sessions and ${codex.length} Codex sessions to ${HERE}\n`);
