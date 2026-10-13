import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findLogFiles, parseLine, parseLogs, type LogEntry } from '../src/parse.ts';
import { BRANCHES, assistant, tempDir, user, writeLogs } from './helpers.ts';

describe('findLogFiles', () => {
  it('finds .jsonl files recursively, including subagent transcripts, and ignores other files', async () => {
    const dir = await writeLogs({
      'projects/-a/s1.jsonl': [],
      'projects/-a/s1/subagents/agent-1.jsonl': [],
      'projects/-b/s2.jsonl': [],
      'projects/-b/notes.txt': 'not a log',
    });
    const files = await findLogFiles([dir]);
    assert.equal(files.length, 3);
    assert.ok(files.every((f) => f.endsWith('.jsonl')));
  });

  it('returns nothing for missing directories and does not list the same file twice', async () => {
    const dir = await writeLogs({ 's1.jsonl': [] });
    const files = await findLogFiles([dir, dir, join(dir, 'missing')]);
    assert.equal(files.length, 1);
  });
});

/** parseLine for a line that must produce an entry. */
function entryOf(line: object | string, fallbackSessionId = 'f'): LogEntry {
  const entry = parseLine(typeof line === 'string' ? line : JSON.stringify(line), fallbackSessionId);
  assert.ok(entry && entry !== 'malformed', `expected an entry, got ${String(entry)}`);
  return entry;
}

describe('parseLine', () => {
  it('keeps only aggregate fields from an assistant line', () => {
    const entry = entryOf(
      assistant({ session: 's1', branch: 'feat/x', cwd: '/w/p', input: 10, output: 20, cacheWrite: 30, cacheRead: 40 }),
    );
    assert.ok(entry.usage);
    assert.equal(entry.sessionId, 's1');
    assert.equal(entry.branch, 'feat/x');
    assert.equal(entry.cwd, '/w/p');
    assert.equal(entry.timestamp, Date.parse('2026-10-05T10:00:00.000Z'));
    assert.deepEqual(entry.usage, {
      model: 'claude-sonnet-4-5-20250929',
      input: 10,
      output: 20,
      cacheWrite: 30,
      cacheWrite1h: 0,
      cacheRead: 40,
    });
    assert.doesNotMatch(JSON.stringify(entry), /"ok"|content/, 'message content is dropped');
  });

  it('reads the 1-hour cache-write split when present', () => {
    const entry = entryOf(assistant({ session: 's1', cacheWrite: 1000, cacheWrite1h: 600 }));
    assert.equal(entry.usage?.cacheWrite, 1000);
    assert.equal(entry.usage?.cacheWrite1h, 600);
  });

  it('turns user lines into timestamp-only entries', () => {
    const entry = entryOf(user({ session: 's1', ts: '2026-10-05T09:00:00.000Z' }));
    assert.equal(entry.usage, null);
    assert.equal(entry.branch, 'feat/x');
  });

  it('treats a missing, empty or detached-HEAD gitBranch as unattributed', () => {
    for (const branch of [null, '', 'HEAD']) {
      assert.equal(entryOf(assistant({ session: 's1', branch })).branch, null, `branch ${JSON.stringify(branch)}`);
    }
  });

  it('falls back to the file name for a missing sessionId', () => {
    const raw = assistant({ session: 'x' }) as Record<string, unknown>;
    delete raw.sessionId;
    assert.equal(entryOf(raw, 'from-file').sessionId, 'from-file');
  });

  it('skips synthetic messages, summaries, blank and malformed lines', () => {
    assert.equal(parseLine(JSON.stringify(assistant({ session: 's', model: '<synthetic>' })), 'f'), null);
    assert.equal(parseLine('{"type":"summary","summary":"x","leafUuid":"y"}', 'f'), null);
    assert.equal(parseLine('   ', 'f'), null);
    assert.equal(parseLine('{"truncated":', 'f'), 'malformed');
    assert.equal(parseLine('not json', 'f'), 'malformed');
    assert.equal(parseLine('[1,2]', 'f'), null);
  });

  it('ignores negative or non-numeric token counts', () => {
    const raw = assistant({ session: 's', input: 5 }) as { message: { usage: Record<string, unknown> } };
    raw.message.usage.output_tokens = 'lots';
    raw.message.usage.cache_read_input_tokens = -3;
    const entry = entryOf(raw);
    assert.equal(entry.usage?.input, 5);
    assert.equal(entry.usage?.output, 0);
    assert.equal(entry.usage?.cacheRead, 0);
  });
});

describe('parseLogs', () => {
  it('dedupes streamed copies of the same message (message.id + requestId)', async () => {
    const { entries } = await parseLogs([BRANCHES]);
    const a1 = entries.filter((e) => e.sessionId === 's-a1' && e.usage);
    assert.equal(a1.length, 2, 'msg_a1_002 appears twice in the file but counts once');
  });

  it('dedupes across files (a subagent file repeating a parent message)', async () => {
    const dup = assistant({ session: 's1', id: 'msg_same', requestId: 'req_same', input: 7 });
    const dir = await writeLogs({ 'p/s1.jsonl': [dup], 'p/s1/subagents/agent-1.jsonl': [dup] });
    const { entries } = await parseLogs([dir]);
    assert.equal(entries.filter((e) => e.usage).length, 1);
  });

  it('keeps the largest counts when streamed copies differ (partial usage on early lines)', async () => {
    const early = assistant({ session: 's1', id: 'msg_s', requestId: 'req_s', input: 10, output: 5, cacheRead: 300 });
    const final = assistant({ session: 's1', id: 'msg_s', requestId: 'req_s', input: 10, output: 500, cacheRead: 300 });
    const dir = await writeLogs({ 'p/s1.jsonl': [early, final] });
    const usage = (await parseLogs([dir])).entries.filter((e) => e.usage).map((e) => e.usage);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.input, 10);
    assert.equal(usage[0]?.output, 500);
    assert.equal(usage[0]?.cacheRead, 300);
  });

  it('does not dedupe lines without both ids', async () => {
    const a = assistant({ session: 's1', input: 7 }) as Record<string, unknown>;
    delete a.requestId;
    const dir = await writeLogs({ 'p/s1.jsonl': [a, a] });
    const { entries } = await parseLogs([dir]);
    assert.equal(entries.filter((e) => e.usage).length, 2);
  });

  it('skips malformed lines, counts them, and keeps going', async () => {
    const dir = await writeLogs({
      'p/s1.jsonl': [assistant({ session: 's1', input: 1 }), '{"broken": ', 'not json', assistant({ session: 's1', input: 2 })],
    });
    const result = await parseLogs([dir]);
    assert.equal(result.entries.filter((e) => e.usage).length, 2);
    assert.equal(result.skippedLines, 2);
    assert.equal(result.files, 1);
  });

  it('handles CRLF line endings and a final line without a newline', async () => {
    const lines = [assistant({ session: 's1', input: 1 }), assistant({ session: 's1', input: 2 })].map((l) => JSON.stringify(l));
    const dir = await writeLogs({ 'p/s1.jsonl': lines.join('\r\n') });
    const { entries, skippedLines } = await parseLogs([dir]);
    assert.equal(entries.length, 2);
    assert.equal(skippedLines, 0);
  });

  it('counts unreadable files instead of crashing', { skip: process.getuid?.() === 0 ? 'root can read anything' : false }, async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'p'));
    const path = join(dir, 'p', 'locked.jsonl');
    await writeFile(path, JSON.stringify(assistant({ session: 's' })) + '\n');
    await chmod(path, 0o000);
    const result = await parseLogs([dir]);
    assert.equal(result.unreadableFiles, 1);
    assert.equal(result.entries.length, 0);
  });
});
