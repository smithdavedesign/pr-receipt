// Price table (prices.json, USD per million tokens) plus a user override file for contracted rates.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Usage } from './parse.ts';

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface PriceTable {
  asOf: string;
  models: Record<string, ModelPrice>;
}

export interface PriceOverride {
  source: string;
  models: Record<string, Partial<ModelPrice>>;
}

export class PriceFileError extends Error {}

const PRICE_FIELDS = ['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead'] as const;
const PER_MILLION = 1_000_000;
// Anthropic's standard cache multipliers, used only when an override adds a model without cache prices.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;

// prices.json sits at the package root, one level above both src/ and dist/.
const BUILTIN_URL = new URL('../prices.json', import.meta.url);

/**
 * Maps API, Bedrock and Vertex ids to one key: "us.anthropic.claude-sonnet-4-20250514-v1:0" → "claude-sonnet-4".
 * OpenAI ids lose a provider prefix and a snapshot date: "openai/gpt-5-2025-08-07" → "gpt-5".
 */
export function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '')
    .replace(/^openai\//, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/[-@]\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

export function loadBuiltinPrices(): PriceTable {
  const raw = JSON.parse(readFileSync(BUILTIN_URL, 'utf8')) as PriceTable;
  return { asOf: raw.asOf, models: { ...raw.models } };
}

/** Validates an override file's text. Throws PriceFileError naming the file and the bad field. */
export function parsePriceFile(text: string, source: string): PriceOverride {
  const fail = (why: string): never => {
    throw new PriceFileError(`invalid prices file ${source}: ${why}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`not valid JSON (${(e as Error).message})`);
  }
  const models = (raw as { models?: unknown } | null)?.models;
  if (typeof raw !== 'object' || raw === null || typeof models !== 'object' || models === null || Array.isArray(models)) {
    return fail('expected an object like {"models": {"claude-sonnet-4-5": {"input": 3, "output": 15}}}');
  }

  const override: PriceOverride = { source, models: {} };
  for (const [name, value] of Object.entries(models as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fail(`model ${name} must be an object of prices`);
    }
    const entry: Partial<ModelPrice> = {};
    for (const [field, price] of Object.entries(value as Record<string, unknown>)) {
      if (!(PRICE_FIELDS as readonly string[]).includes(field)) {
        fail(`model ${name} has unknown field "${field}" (allowed: ${PRICE_FIELDS.join(', ')})`);
      }
      if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
        fail(`model ${name} field ${field} must be a non-negative number of USD per million tokens`);
      }
      entry[field as keyof ModelPrice] = price as number;
    }
    const key = normalizeModel(name);
    override.models[key] = { ...override.models[key], ...entry };
  }
  return override;
}

/** Field-by-field merge. Models new to the table need input and output; cache prices are derived if omitted. */
export function mergePrices(base: PriceTable, override: PriceOverride): PriceTable {
  const models = { ...base.models };
  for (const [name, fields] of Object.entries(override.models)) {
    const existing = models[name];
    if (existing) {
      models[name] = { ...existing, ...fields };
      continue;
    }
    if (fields.input === undefined || fields.output === undefined) {
      throw new PriceFileError(`invalid prices file ${override.source}: new model ${name} needs both input and output prices`);
    }
    models[name] = {
      input: fields.input,
      output: fields.output,
      cacheWrite: fields.cacheWrite ?? fields.input * CACHE_WRITE_MULTIPLIER,
      cacheWrite1h: fields.cacheWrite1h ?? fields.input * CACHE_WRITE_1H_MULTIPLIER,
      cacheRead: fields.cacheRead ?? fields.input * CACHE_READ_MULTIPLIER,
    };
  }
  return { asOf: base.asOf, models };
}

/** Built-in table, with the override file applied when a path is given. */
export async function loadPrices(overridePath?: string): Promise<PriceTable> {
  const base = loadBuiltinPrices();
  if (!overridePath) return base;
  let text: string;
  try {
    text = await readFile(overridePath, 'utf8');
  } catch (e) {
    throw new PriceFileError(`cannot read prices file ${overridePath}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  return mergePrices(base, parsePriceFile(text, overridePath));
}

/**
 * Exact match on the normalized id only; an unknown model is never priced like a sibling. Own properties only,
 * so a log naming its model "constructor" or "__proto__" can't pick up an inherited object as a price.
 */
export function findPrice(table: PriceTable, model: string): ModelPrice | null {
  const key = normalizeModel(model);
  return Object.hasOwn(table.models, key) ? table.models[key] : null;
}

export function costOf(usage: Usage, price: ModelPrice): number {
  const write1h = Math.min(usage.cacheWrite1h, usage.cacheWrite);
  const write5m = usage.cacheWrite - write1h;
  return (
    (usage.input * price.input +
      usage.output * price.output +
      write5m * price.cacheWrite +
      write1h * price.cacheWrite1h +
      usage.cacheRead * price.cacheRead) /
    PER_MILLION
  );
}
