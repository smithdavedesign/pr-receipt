// Reads agent session logs into lean usage records: Claude Code transcripts (~/.claude/projects/**/*.jsonl)
// here, Codex rollouts in codex.ts. Each file's format is decided by its first record.
// Only aggregate fields are kept; message content (prompts, responses, tool output) is never retained.
import { createReadStream, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { codexReader, isCodexRecord, type CodexReader } from './codex.ts';

export interface Usage {
  model: string;
  input: number;
  output: number;
  /** All cache-write tokens, including the 1-hour share below. */
  cacheWrite: number;
  /** The part of cacheWrite written with a 1-hour TTL (billed at a higher rate). */
  cacheWrite1h: number;
  cacheRead: number;
}

export interface LogEntry {
  sessionId: string;
  /** null when the line has no usable gitBranch (missing, empty or detached "HEAD"). */
  branch: string | null;
  cwd: string | null;
  timestamp: number | null;
  /** null for lines without token usage (user turns, tool results); they still count toward wall time. */
  usage: Usage | null;
  /** message.id:requestId, used to drop streamed duplicates of the same API response. */
  key: string | null;
}

export interface ParseResult {
  entries: LogEntry[];
  files: number;
  skippedLines: number;
  unreadableFiles: number;
}

const SYNTHETIC_MODEL = '<synthetic>';

export async function findLogFiles(dirs: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir, { recursive: true, encoding: 'utf8' });
    } catch {
      continue; // missing or unreadable directory: nothing to scan
    }
    for (const name of names) {
      if (name.endsWith('.jsonl')) found.add(resolve(join(dir, name)));
    }
  }
  return [...found].sort();
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readUsage(message: Record<string, unknown> | null): Usage | null {
  const usage = asObject(message?.usage);
  const model = message?.model;
  if (!usage || typeof model !== 'string' || model === '' || model === SYNTHETIC_MODEL) return null;
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
  const split = asObject(usage.cache_creation);
  return {
    model,
    input: tokenCount(usage.input_tokens),
    output: tokenCount(usage.output_tokens),
    cacheWrite,
    cacheWrite1h: Math.min(tokenCount(split?.ephemeral_1h_input_tokens), cacheWrite),
    cacheRead: tokenCount(usage.cache_read_input_tokens),
  };
}

/**
 * Parses one transcript line. Returns null for lines that carry nothing we use
 * (summaries, blank lines, synthetic messages) and 'malformed' for invalid JSON.
 */
export function parseLine(line: string, fallbackSessionId: string): LogEntry | null | 'malformed' {
  const obj = parseJsonLine(line);
  return obj === 'malformed' || obj === null ? obj : parseClaudeRecord(obj, fallbackSessionId);
}

/** A line's JSON object; null for blank lines and non-objects, 'malformed' for invalid JSON. */
function parseJsonLine(line: string): Record<string, unknown> | null | 'malformed' {
  if (line.trim() === '') return null;
  try {
    return asObject(JSON.parse(line));
  } catch {
    return 'malformed';
  }
}

/** One Claude Code transcript record; null for records that carry nothing we use. */
export function parseClaudeRecord(obj: Record<string, unknown>, fallbackSessionId: string): LogEntry | null {
  const message = asObject(obj.message);
  const isSynthetic = message?.model === SYNTHETIC_MODEL;
  const usage = readUsage(message);
  const parsedTime = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
  const timestamp = Number.isFinite(parsedTime) ? parsedTime : null;
  if (isSynthetic || (!usage && timestamp === null)) return null;

  const branch = typeof obj.gitBranch === 'string' && obj.gitBranch !== '' && obj.gitBranch !== 'HEAD' ? obj.gitBranch : null;
  const sessionId = typeof obj.sessionId === 'string' && obj.sessionId !== '' ? obj.sessionId : fallbackSessionId;
  const id = message?.id;
  const requestId = obj.requestId;
  const key = usage && typeof id === 'string' && typeof requestId === 'string' ? `${id}:${requestId}` : null;

  return {
    sessionId,
    branch,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
    timestamp,
    usage,
    key,
  };
}

/** Streamed copies of one API response share a key; keep one, with the largest count seen for each field. */
function mergeCopy(kept: Usage, copy: Usage): void {
  kept.input = Math.max(kept.input, copy.input);
  kept.output = Math.max(kept.output, copy.output);
  kept.cacheWrite = Math.max(kept.cacheWrite, copy.cacheWrite);
  kept.cacheWrite1h = Math.max(kept.cacheWrite1h, copy.cacheWrite1h);
  kept.cacheRead = Math.max(kept.cacheRead, copy.cacheRead);
}

/**
 * Streams every .jsonl file under `dirs` (Claude Code or Codex, decided per file), deduping copies of the
 * same response across files: Claude's streamed or resumed copies, Codex's repeated and replayed snapshots.
 */
export async function parseLogs(dirs: string[]): Promise<ParseResult> {
  const files = await findLogFiles(dirs);
  const entries: LogEntry[] = [];
  const byKey = new Map<string, LogEntry>();
  const codexParents = new Map<string, string | null>();
  let skippedLines = 0;
  let unreadableFiles = 0;

  for (const file of files) {
    const fallbackSessionId = basename(file, '.jsonl');
    // undefined until the file's first record shows its format; null for Claude Code.
    let codex: CodexReader | null | undefined;
    try {
      const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        const obj = parseJsonLine(line);
        if (obj === 'malformed') {
          skippedLines += 1;
          continue;
        }
        if (!obj) continue;
        if (codex === undefined) codex = isCodexRecord(obj) ? codexReader(fallbackSessionId, codexParents) : null;
        const entry = codex ? codex(obj) : parseClaudeRecord(obj, fallbackSessionId);
        if (!entry) continue;
        if (entry.key && entry.usage) {
          const kept = byKey.get(entry.key);
          if (kept?.usage) {
            mergeCopy(kept.usage, entry.usage);
            continue;
          }
          byKey.set(entry.key, entry);
        }
        entries.push(entry);
      }
    } catch {
      unreadableFiles += 1;
    }
  }

  return { entries, files: files.length, skippedLines, unreadableFiles };
}
