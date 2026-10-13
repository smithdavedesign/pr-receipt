import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCodexDirs } from '../src/cli.ts';
import { isCodexRecord, UNKNOWN_CODEX_MODEL } from '../src/codex.ts';
import { parseLogs, type LogEntry } from '../src/parse.ts';
import { findPrice, loadBuiltinPrices, normalizeModel } from '../src/pricing.ts';
import { buildReceipt, renderReceipt } from '../src/receipt.ts';
import { CODEX, THREE_MESSAGES, assistant, codexMeta, codexText, codexTokens, codexTurn, near, run, tempDir, writeLogs } from './helpers.ts';

const prices = loadBuiltinPrices();
const T = (minute: number) => `2026-10-03T09:${String(minute).padStart(2, '0')}:00.000Z`;

async function entriesOf(files: Record<string, object[]>): Promise<LogEntry[]> {
  return (await parseLogs([await writeLogs(files)])).entries;
}

const used = (entries: LogEntry[]) => entries.filter((e) => e.usage);

describe('isCodexRecord', () => {
  it('recognises rollout lines and not Claude Code lines', () => {
    assert.equal(isCodexRecord(codexMeta({ id: 'c', ts: T(0) }) as Record<string, unknown>), true);
    assert.equal(isCodexRecord(codexTokens({ ts: T(1), total: { input: 1, output: 1 } }) as Record<string, unknown>), true);
    assert.equal(isCodexRecord(assistant({ session: 's' }) as Record<string, unknown>), false);
    assert.equal(isCodexRecord({ type: 'summary', summary: 'x' }), false);
    assert.equal(isCodexRecord({ type: 'progress', payload: { step: 1 } }), false, 'a payload alone does not make a Codex line');
  });

  it('keeps reading a Claude Code file as Claude even if a line has a payload field', async () => {
    const first = { ...(assistant({ session: 's1', branch: 'feat/x', input: 1000, output: 500 }) as Record<string, unknown>), payload: { extra: true } };
    const entries = await entriesOf({ 's1.jsonl': [first] });
    assert.equal(used(entries).length, 1);
  });
});

describe('Codex token_count events', () => {
  it('maps cached input to cache reads and keeps reasoning inside output', async () => {
    const entries = await entriesOf({
      'r.jsonl': [
        codexMeta({ id: 'c1', ts: T(0), branch: 'feat/x', cwd: '/w/p' }),
        codexTurn({ ts: T(0), model: 'gpt-5-codex', cwd: '/w/p' }),
        codexTokens({ ts: T(1), total: { input: 1000, cached: 600, output: 200, reasoning: 80 }, last: { input: 1000, cached: 600, output: 200, reasoning: 80 } }),
      ],
    });
    const [entry] = used(entries);
    assert.deepEqual(entry.usage, { model: 'gpt-5-codex', input: 400, output: 200, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 600 });
    assert.equal(entry.sessionId, 'c1');
    assert.equal(entry.branch, 'feat/x');
    assert.equal(entry.cwd, '/w/p');
    assert.equal(entry.timestamp, Date.parse(T(1)));
  });

  it('counts a repeated snapshot (unchanged running total) once', async () => {
    const snap = codexTokens({ ts: T(1), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } });
    const entries = await entriesOf({ 'r.jsonl': [codexMeta({ id: 'c1', ts: T(0) }), codexTurn({ ts: T(0) }), snap, snap, snap] });
    assert.equal(used(entries).length, 1);
  });

  it('uses the change in the running total when last_token_usage is missing', async () => {
    const entries = await entriesOf({
      'r.jsonl': [
        codexMeta({ id: 'c1', ts: T(0) }),
        codexTurn({ ts: T(0) }),
        codexTokens({ ts: T(1), total: { input: 100, cached: 0, output: 10 } }),
        codexTokens({ ts: T(2), total: { input: 350, cached: 200, output: 40, reasoning: 5 } }),
      ],
    });
    assert.deepEqual(
      used(entries).map((e) => [e.usage?.input, e.usage?.cacheRead, e.usage?.output]),
      [
        [100, 0, 10],
        [50, 200, 30],
      ],
    );
  });

  it('treats a running total that goes down as a restarted counter', async () => {
    const entries = await entriesOf({
      'r.jsonl': [
        codexMeta({ id: 'c1', ts: T(0) }),
        codexTurn({ ts: T(0) }),
        codexTokens({ ts: T(1), total: { input: 5000, output: 500 }, last: { input: 5000, output: 500 } }),
        codexTokens({ ts: T(2), total: { input: 300, output: 30 } }),
        codexTokens({ ts: T(3), total: { input: 700, output: 70 }, last: { input: 400, output: 40 } }),
      ],
    });
    assert.deepEqual(
      used(entries).map((e) => e.usage?.input),
      [5000, 300, 400],
    );
  });

  it('ignores rate-limit-only events, empty usage and compaction size estimates', async () => {
    const entries = await entriesOf({
      'r.jsonl': [
        codexMeta({ id: 'c1', ts: T(0) }),
        codexTurn({ ts: T(0) }),
        { timestamp: T(1), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 1 } } } },
        codexTokens({ ts: T(2), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
        { timestamp: T(3), type: 'compacted', payload: { message: 'summary' } },
        codexTokens({ ts: T(4), total: { input: 100, output: 10 }, last: { input: 0, output: 0 } }),
        codexTokens({ ts: T(5), last: { input: 0, output: 0 } }),
      ],
    });
    assert.equal(used(entries).length, 1);
  });

  it('counts an event with only last_token_usage (no running total) as is', async () => {
    const entries = await entriesOf({
      'r.jsonl': [codexMeta({ id: 'c1', ts: T(0) }), codexTurn({ ts: T(0) }), codexTokens({ ts: T(1), last: { input: 70, output: 7 } })],
    });
    assert.deepEqual(
      used(entries).map((e) => e.usage?.input),
      [70],
    );
  });

  it('reads cache_write_input_tokens as cache writes when Codex reports them', async () => {
    const entries = await entriesOf({
      'r.jsonl': [
        codexMeta({ id: 'c1', ts: T(0) }),
        codexTurn({ ts: T(0), model: 'gpt-5.6-terra' }),
        codexTokens({ ts: T(1), total: { input: 1000, cached: 300, cacheWrite: 500, output: 10 }, last: { input: 1000, cached: 300, cacheWrite: 500, output: 10 } }),
      ],
    });
    const [entry] = used(entries);
    assert.equal(entry.usage?.input, 200);
    assert.equal(entry.usage?.cacheWrite, 500);
    assert.equal(entry.usage?.cacheRead, 300);
    // terra: 200 × $2 + 500 × $2.50 + 300 × $0.20 + 10 × $12 per M
    const r = buildReceipt(entries, 'feat/x', prices);
    assert.ok(near(r.totalCost, (200 * 2 + 500 * 2.5 + 300 * 0.2 + 10 * 12) / 1e6), `cost was ${r.totalCost}`);
  });
});

describe('Codex session metadata', () => {
  it('takes the model from the latest turn_context, so a model switch is priced per turn', async () => {
    const entries = await entriesOf({
      'r.jsonl': [
        codexMeta({ id: 'c1', ts: T(0) }),
        codexTurn({ ts: T(0), model: 'gpt-5-codex' }),
        codexTokens({ ts: T(1), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
        codexTurn({ ts: T(2), model: 'gpt-5.1-codex-mini' }),
        codexTokens({ ts: T(3), total: { input: 300, output: 30 }, last: { input: 200, output: 20 } }),
      ],
    });
    assert.deepEqual(
      used(entries).map((e) => e.usage?.model),
      ['gpt-5-codex', 'gpt-5.1-codex-mini'],
    );
  });

  it('never guesses a model that was not recorded: tokens count, the receipt calls it unpriced', async () => {
    const entries = await entriesOf({
      'r.jsonl': [codexMeta({ id: 'c1', ts: T(0) }), codexTokens({ ts: T(1), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } })],
    });
    assert.equal(used(entries)[0].usage?.model, UNKNOWN_CODEX_MODEL);
    const r = buildReceipt(entries, 'feat/x', prices);
    assert.equal(r.totalTokens, 110);
    assert.deepEqual(r.unpriced, [UNKNOWN_CODEX_MODEL]);
    assert.match(renderReceipt(r), /No price for codex-unknown-model/);
  });

  it('treats a missing git block or a detached HEAD as no branch', async () => {
    for (const branch of [null, 'HEAD', '']) {
      const entries = await entriesOf({
        'r.jsonl': [codexMeta({ id: 'c1', ts: T(0), branch }), codexTurn({ ts: T(0) }), codexTokens({ ts: T(1), last: { input: 1, output: 1 } })],
      });
      assert.equal(used(entries)[0].branch, null, `branch ${JSON.stringify(branch)}`);
    }
  });

  it('follows the working directory of turn_context and falls back to the file name for the session id', async () => {
    const meta = codexMeta({ id: 'x', ts: T(0), cwd: '/w/a' }) as { payload: Record<string, unknown> };
    delete meta.payload.id;
    const entries = await entriesOf({
      'rollout-2026-10-03T09-00-00-abc.jsonl': [meta, codexTurn({ ts: T(0), cwd: '/w/b' }), codexTokens({ ts: T(1), last: { input: 1, output: 1 } })],
    });
    const [entry] = used(entries);
    assert.equal(entry.cwd, '/w/b');
    assert.equal(entry.sessionId, 'rollout-2026-10-03T09-00-00-abc');
  });

  it('measures wall time from the session start to the last counted turn', async () => {
    const entries = await entriesOf({
      'r.jsonl': [
        codexMeta({ id: 'c1', ts: T(0), branch: 'feat/x' }),
        codexTurn({ ts: T(0) }),
        codexTokens({ ts: T(7), last: { input: 1, output: 1 } }),
        codexText({ ts: T(30), role: 'assistant', text: 'later chatter' }),
      ],
    });
    assert.equal(buildReceipt(entries, 'feat/x', prices).wallTimeMs, 7 * 60_000);
  });
});

describe('forked and spawned Codex threads', () => {
  const parentLines = [
    codexMeta({ id: 'parent', ts: T(0), branch: 'feat/x' }),
    codexTurn({ ts: T(0) }),
    codexTokens({ ts: T(1), total: { input: 1000, output: 100 }, last: { input: 1000, output: 100 } }),
    codexTokens({ ts: T(2), total: { input: 3000, output: 300 }, last: { input: 2000, output: 200 } }),
  ];
  /** A child rollout: its own meta, then the replayed history (re-stamped), then its own turns. */
  const child = (meta: object, replay: object[], own: object[]) => [meta, ...replay.map((l) => ({ ...l, timestamp: T(10) })), ...own];

  it('does not count the parent history a fork replays at its head', async () => {
    const entries = await entriesOf({
      '2026/10/03/rollout-a-parent.jsonl': parentLines,
      '2026/10/03/rollout-b-fork.jsonl': child(codexMeta({ id: 'fork', ts: T(10), branch: 'feat/y', forkedFrom: 'parent' }), parentLines, [
        codexTurn({ ts: T(11) }),
        codexTokens({ ts: T(12), total: { input: 3500, output: 350 }, last: { input: 500, output: 50 } }),
      ]),
    });
    const bySession = (id: string) => used(entries).filter((e) => e.sessionId === id).reduce((n, e) => n + (e.usage?.input ?? 0), 0);
    assert.equal(bySession('parent'), 3000);
    assert.equal(bySession('fork'), 500);
    assert.equal(buildReceipt(entries, 'feat/y', prices).totalTokens, 550, 'the fork’s branch only gets its own turn');
  });

  it('handles a fork of a fork and a spawned subagent thread the same way', async () => {
    const forkOwn = [codexTurn({ ts: T(11) }), codexTokens({ ts: T(12), total: { input: 3500, output: 350 }, last: { input: 500, output: 50 } })];
    const fork = child(codexMeta({ id: 'fork', ts: T(10), forkedFrom: 'parent' }), parentLines, forkOwn);
    const grandchild = child(codexMeta({ id: 'fork2', ts: T(20), forkedFrom: 'fork' }), fork, [
      codexTokens({ ts: T(21), total: { input: 3600, output: 360 }, last: { input: 100, output: 10 } }),
    ]);
    const spawned = child(codexMeta({ id: 'sub', ts: T(30), spawnedBy: 'parent' }), parentLines, [
      codexTokens({ ts: T(31), total: { input: 3070, output: 307 }, last: { input: 70, output: 7 } }),
    ]);
    const entries = await entriesOf({
      'a/rollout-1-parent.jsonl': parentLines,
      'a/rollout-2-fork.jsonl': fork,
      'a/rollout-3-fork2.jsonl': grandchild,
      'a/rollout-4-sub.jsonl': spawned,
    });
    const inputs = Object.fromEntries(
      ['parent', 'fork', 'fork2', 'sub'].map((id) => [id, used(entries).filter((e) => e.sessionId === id).reduce((n, e) => n + (e.usage?.input ?? 0), 0)]),
    );
    assert.deepEqual(inputs, { parent: 3000, fork: 500, fork2: 100, sub: 70 });
  });
});

describe('mixed log directories', () => {
  it('reads Claude Code and Codex files side by side, deciding the format per file', async () => {
    const entries = await entriesOf({
      'claude/projects/-w-p/s1.jsonl': [assistant({ session: 's1', branch: 'feat/x', input: 1000, output: 500 })],
      'codex/sessions/2026/10/03/rollout-c.jsonl': [
        codexMeta({ id: 'c', ts: T(0), branch: 'feat/x' }),
        codexTurn({ ts: T(0) }),
        codexTokens({ ts: T(1), last: { input: 1000, cached: 0, output: 100 } }),
      ],
    });
    const r = buildReceipt(entries, 'feat/x', prices);
    assert.equal(r.sessions, 2);
    // sonnet-4-5 $0.0105 + gpt-5-codex 1,000 × $1.25 + 100 × $10 per M = $0.00225
    assert.ok(near(r.totalCost, 0.0105 + 0.00225), `total was ${r.totalCost}`);
  });

  it('keeps no prompt, response, reasoning or tool text from a rollout', async () => {
    const entries = await entriesOf({
      'r.jsonl': [
        codexMeta({ id: 'c', ts: T(0) }),
        codexTurn({ ts: T(0) }),
        codexText({ ts: T(1), role: 'user', text: 'PROMPT-MARKER secret plan' }),
        { timestamp: T(1), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'RESPONSE-MARKER thinking' }] } },
        { timestamp: T(1), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'RESPONSE-MARKER tool output' } },
        codexTokens({ ts: T(2), last: { input: 1, output: 1 } }),
      ],
    });
    assert.doesNotMatch(JSON.stringify(entries), /MARKER|secret plan|thinking|tool output/);
  });

  it('counts a half-written Codex line as skipped and keeps going', async () => {
    const dir = await writeLogs({
      'r.jsonl': [codexMeta({ id: 'c', ts: T(0) }), codexTurn({ ts: T(0) }), '{"timestamp":"2026-10-03T09:01:00Z","type":"event_ms', codexTokens({ ts: T(2), last: { input: 5, output: 1 } })],
    });
    const result = await parseLogs([dir]);
    assert.equal(result.skippedLines, 1);
    assert.equal(used(result.entries).length, 1);
  });
});

describe('Codex log locations', () => {
  it('uses $CODEX_HOME/sessions, else ~/.codex/sessions', () => {
    assert.deepEqual(resolveCodexDirs({ CODEX_HOME: 'codex-home' }, '/home/u', '/cwd'), ['/cwd/codex-home/sessions']);
    assert.deepEqual(resolveCodexDirs({ CODEX_HOME: ' ' }, '/home/u', '/cwd'), ['/home/u/.codex/sessions']);
    assert.deepEqual(resolveCodexDirs({}, '/home/u', '/cwd'), ['/home/u/.codex/sessions']);
  });

  it('reads only the --logs directories when they are given, not the Codex default', async () => {
    const home = await tempDir('prr-home-');
    await cp(join(CODEX, 'sessions'), join(home, '.codex', 'sessions'), { recursive: true });
    const { out } = await run(['show', 'feat/demo', '--logs', THREE_MESSAGES], { home });
    assert.match(out, /\*\*Total:\*\* \$0\.0315\b/);
  });
});

describe('model names that are also JavaScript object properties', () => {
  it('are unpriced, not priced as NaN', async () => {
    for (const model of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(findPrice(prices, model), null, model);
      const entries = await entriesOf({
        'r.jsonl': [codexMeta({ id: 'c', ts: T(0) }), codexTurn({ ts: T(0), model }), codexTokens({ ts: T(1), last: { input: 100, output: 10 } })],
      });
      const r = buildReceipt(entries, 'feat/x', prices);
      assert.equal(r.totalCost, 0, model);
      assert.deepEqual(r.unpriced, [normalizeModel(model)], model);
    }
  });
});

describe('Codex dedupe keys', () => {
  it('keeps two unrelated sessions whose running totals happen to be equal', async () => {
    const lines = (id: string) => [codexMeta({ id, ts: T(0) }), codexTurn({ ts: T(0) }), codexTokens({ ts: T(1), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } })];
    const entries = await entriesOf({ 'a.jsonl': lines('one'), 'b.jsonl': lines('two') });
    assert.deepEqual(
      used(entries).map((e) => e.sessionId),
      ['one', 'two'],
    );
  });
});

describe('Codex model prices', () => {
  it('normalizes OpenAI snapshot ids and provider prefixes', () => {
    assert.equal(normalizeModel('gpt-5-2025-08-07'), 'gpt-5');
    assert.equal(normalizeModel('openai/gpt-5-codex'), 'gpt-5-codex');
    assert.equal(normalizeModel('GPT-5.1-Codex-Max'), 'gpt-5.1-codex-max');
  });

  it('prices the Codex models at OpenAI list prices, cached input at the cache-read rate', () => {
    const codex = findPrice(prices, 'gpt-5-codex');
    assert.deepEqual(codex && [codex.input, codex.cacheRead, codex.output], [1.25, 0.125, 10]);
    for (const m of ['gpt-5-mini', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.2-codex', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      assert.ok(findPrice(prices, m), `${m} is priced`);
    }
  });
});
