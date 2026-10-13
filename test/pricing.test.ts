import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PriceFileError,
  costOf,
  findPrice,
  loadBuiltinPrices,
  loadPrices,
  mergePrices,
  normalizeModel,
  parsePriceFile,
} from '../src/pricing.ts';
import type { Usage } from '../src/parse.ts';
import { near, tempDir, writeJson } from './helpers.ts';
import { join } from 'node:path';

const usage = (u: Partial<Usage>): Usage => ({
  model: 'm',
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  ...u,
});

describe('built-in price table', () => {
  const table = loadBuiltinPrices();

  it('has a date and well-formed entries', () => {
    assert.match(table.asOf, /^\d{4}-\d{2}-\d{2}$/);
    const names = Object.keys(table.models);
    assert.ok(names.length >= 10);
    for (const name of names) {
      assert.equal(name, normalizeModel(name), `${name} is stored in normalized form`);
      for (const field of ['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead'] as const) {
        const v = table.models[name][field];
        assert.ok(Number.isFinite(v) && v >= 0, `${name}.${field} = ${v}`);
      }
    }
  });

  it('prices Sonnet 4.5 at $3 / $15 per million', () => {
    const p = findPrice(table, 'claude-sonnet-4-5-20250929');
    assert.equal(p?.input, 3);
    assert.equal(p?.output, 15);
  });

  it('covers the models Claude Code currently runs', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']) {
      assert.ok(findPrice(table, m), `${m} is priced`);
    }
  });
});

describe('normalizeModel', () => {
  it('strips date suffixes and cloud-provider decorations', () => {
    assert.equal(normalizeModel('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
    assert.equal(normalizeModel('claude-sonnet-4@20250514'), 'claude-sonnet-4');
    assert.equal(normalizeModel('us.anthropic.claude-sonnet-4-20250514-v1:0'), 'claude-sonnet-4');
    assert.equal(normalizeModel('anthropic.claude-3-5-haiku-20241022-v1:0'), 'claude-3-5-haiku');
    assert.equal(normalizeModel('  Claude-Opus-4-1  '), 'claude-opus-4-1');
    assert.equal(normalizeModel('claude-opus-5-5'), 'claude-opus-5-5');
  });
});

describe('findPrice', () => {
  const table = loadBuiltinPrices();

  it('never falls back to a sibling model by prefix', () => {
    assert.equal(findPrice(table, 'claude-opus-4-9'), null);
    assert.equal(findPrice(table, 'gpt-5'), null);
  });
});

describe('costOf', () => {
  const price = { input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 };

  it('prices every token type per million', () => {
    const cost = costOf(usage({ input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 }), price);
    assert.ok(near(cost, 3 + 15 + 3.75 + 0.3));
  });

  it('charges the 1-hour share of cache writes at the 1-hour rate', () => {
    const cost = costOf(usage({ cacheWrite: 1_000_000, cacheWrite1h: 400_000 }), price);
    assert.ok(near(cost, 0.6 * 3.75 + 0.4 * 6));
  });

  it('never charges more 1-hour tokens than total cache writes', () => {
    const cost = costOf(usage({ cacheWrite: 100, cacheWrite1h: 500 }), price);
    assert.ok(near(cost, (100 * 6) / 1e6));
  });
});

describe('override files', () => {
  it('merges fields over list prices and keeps the rest', () => {
    const merged = mergePrices(loadBuiltinPrices(), parsePriceFile('{"models":{"claude-sonnet-4-5":{"input":2}}}', 'x'));
    const p = merged.models['claude-sonnet-4-5'];
    assert.equal(p.input, 2);
    assert.equal(p.output, 15);
    assert.equal(p.cacheRead, 0.3);
  });

  it('accepts dated model ids as keys', () => {
    const merged = mergePrices(loadBuiltinPrices(), parsePriceFile('{"models":{"claude-sonnet-4-5-20250929":{"output":1}}}', 'x'));
    assert.equal(merged.models['claude-sonnet-4-5'].output, 1);
  });

  it('adds new models and derives cache prices from input when omitted', () => {
    const merged = mergePrices(loadBuiltinPrices(), parsePriceFile('{"models":{"my-model":{"input":4,"output":8}}}', 'x'));
    assert.deepEqual(merged.models['my-model'], { input: 4, output: 8, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.4 });
  });

  it('does not mutate the built-in table', () => {
    mergePrices(loadBuiltinPrices(), parsePriceFile('{"models":{"claude-sonnet-4-5":{"input":99}}}', 'x'));
    assert.equal(loadBuiltinPrices().models['claude-sonnet-4-5'].input, 3);
  });

  const bad: Array<[string, string, RegExp]> = [
    ['not json', '{nope', /JSON/],
    ['no models key', '{"claude-sonnet-4-5":{"input":1}}', /"models"/],
    ['models not an object', '{"models":[1]}', /"models"/],
    ['entry not an object', '{"models":{"a":5}}', /\ba\b/],
    ['unknown field', '{"models":{"claude-sonnet-4-5":{"imput":1}}}', /imput/],
    ['negative price', '{"models":{"claude-sonnet-4-5":{"input":-1}}}', /input/],
    ['string price', '{"models":{"claude-sonnet-4-5":{"output":"15"}}}', /output/],
    ['new model without output', '{"models":{"brand-new":{"input":1}}}', /brand-new.*output|output.*brand-new/],
  ];
  for (const [name, text, message] of bad) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => mergePrices(loadBuiltinPrices(), parsePriceFile(text, '/tmp/p.json')),
        (e: unknown) => e instanceof PriceFileError && message.test(e.message) && e.message.includes('/tmp/p.json'),
      );
    });
  }

  it('loadPrices reports a missing override file as a PriceFileError', async () => {
    const missing = join(await tempDir(), 'missing.json');
    await assert.rejects(loadPrices(missing), (e: unknown) => e instanceof PriceFileError && e.message.includes(missing));
  });

  it('loadPrices applies an override file', async () => {
    const table = await loadPrices(await writeJson({ models: { 'claude-haiku-4-5': { output: 1 } } }));
    assert.equal(table.models['claude-haiku-4-5'].output, 1);
  });
});
