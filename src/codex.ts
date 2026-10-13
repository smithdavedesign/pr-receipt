// Reads Codex CLI rollouts ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl) into the same lean usage records
// as Claude Code transcripts. Each line is {timestamp, type, payload}; only session_meta (id, cwd, git branch,
// fork parent), turn_context (model, cwd) and token_count events are read. Messages, reasoning and tool
// payloads are never looked at.
import type { LogEntry, Usage } from './parse.ts';

/** Shown (unpriced) when a rollout never recorded its model; a model is never guessed. */
export const UNKNOWN_CODEX_MODEL = 'codex-unknown-model';

interface Counts {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Rollout record types. A file is read as Codex only if its first record is one of these. */
const CODEX_TYPES = new Set(['session_meta', 'turn_context', 'event_msg', 'response_item', 'compacted']);

/** A rollout line: one of Codex's record types with an object `payload` (Claude Code lines have neither). */
export function isCodexRecord(obj: Record<string, unknown>): boolean {
  return typeof obj.type === 'string' && CODEX_TYPES.has(obj.type) && asObject(obj.payload) !== null;
}

/** input_tokens already include the cached and cache-write tokens; output_tokens already include reasoning. */
function readCounts(value: unknown): Counts | null {
  const u = asObject(value);
  if (!u) return null;
  return { input: count(u.input_tokens), cached: count(u.cached_input_tokens), cacheWrite: count(u.cache_write_input_tokens), output: count(u.output_tokens) };
}

const FIELDS = ['input', 'cached', 'cacheWrite', 'output'] as const;
const same = (a: Counts, b: Counts) => FIELDS.every((f) => a[f] === b[f]);

/** total − previous, or the total itself when a field went down (the counter restarted). */
function delta(total: Counts, previous: Counts | null): Counts {
  if (!previous || FIELDS.some((f) => total[f] < previous[f])) return total;
  return { input: total.input - previous.input, cached: total.cached - previous.cached, cacheWrite: total.cacheWrite - previous.cacheWrite, output: total.output - previous.output };
}

/** Root of a fork chain: follows forked_from_id / parent_thread_id links seen so far. */
function rootOf(id: string, parents: Map<string, string | null>): string {
  const seen = new Set<string>();
  let current = id;
  for (let parent = parents.get(current); parent && !seen.has(parent); parent = parents.get(current)) {
    seen.add(current);
    current = parent;
  }
  return current;
}

export type CodexReader = (record: Record<string, unknown>) => LogEntry | null;

/**
 * A reader for one rollout file. `parents` maps session id → fork parent and is shared across files.
 *
 * Counting follows ccusage: a token_count counts only when the running total (total_token_usage) moved since
 * the previous one in the file; it counts last_token_usage, or the change in the total when that's missing.
 * Each counted event is keyed on (root session of its fork chain, running total). A fork or spawned thread
 * starts by replaying its parent's history, snapshots included, so those replayed snapshots get the same keys
 * as the parent's originals and the shared dedupe in parseLogs drops them.
 */
export function codexReader(fallbackSessionId: string, parents: Map<string, string | null>): CodexReader {
  let sessionId = fallbackSessionId;
  let metaSeen = false;
  let branch: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let previous: Counts | null = null;

  const entry = (timestamp: number | null, usage: Usage | null, key: string | null): LogEntry => ({ sessionId, branch, cwd, timestamp, usage, key });

  return (record) => {
    const payload = asObject(record.payload);
    if (!payload) return null;
    const parsed = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    const timestamp = Number.isFinite(parsed) ? parsed : null;

    if (record.type === 'session_meta') {
      // Later session_meta lines are a fork's replayed parent history; the first one is this session.
      if (metaSeen) return null;
      metaSeen = true;
      sessionId = text(payload.id) ?? text(payload.session_id) ?? fallbackSessionId;
      const spawn = asObject(asObject(asObject(payload.source)?.subagent)?.thread_spawn);
      parents.set(sessionId, text(payload.forked_from_id) ?? text(spawn?.parent_thread_id));
      const gitBranch = text(asObject(payload.git)?.branch);
      branch = gitBranch === 'HEAD' ? null : gitBranch;
      cwd = text(payload.cwd);
      // A timestamp-only entry: the session's start, for wall time.
      return timestamp === null ? null : entry(timestamp, null, null);
    }

    if (record.type === 'turn_context') {
      model = text(payload.model) ?? model;
      cwd = text(payload.cwd) ?? cwd;
      return null;
    }

    if (record.type !== 'event_msg' || payload.type !== 'token_count') return null;
    const info = asObject(payload.info);
    const total = readCounts(info?.total_token_usage);
    const last = readCounts(info?.last_token_usage);
    if (total && previous && same(total, previous)) return null; // a repeated snapshot
    const counts = total ? (last ?? delta(total, previous)) : last;
    if (total) previous = total;
    if (!counts || FIELDS.every((f) => counts[f] === 0)) return null;

    const usage: Usage = {
      model: model ?? UNKNOWN_CODEX_MODEL,
      input: Math.max(0, counts.input - counts.cached - counts.cacheWrite),
      output: counts.output,
      cacheWrite: counts.cacheWrite,
      cacheWrite1h: 0,
      cacheRead: counts.cached,
    };
    const key = total ? `codex:${rootOf(sessionId, parents)}:${FIELDS.map((f) => total[f]).join(':')}` : null;
    return entry(timestamp, usage, key);
  };
}
