// `.prreceipt.json`: a finished receipt written by `prreceipt export`, committed with the branch, and posted on
// the pull request by the GitHub Action (`prreceipt comment --from`). It holds the Receipt object exactly as
// `show` renders it, so the Action prints the same markdown. Aggregates only: branch, model and base names and
// numbers; no prompts, paths or session ids. In CI the file comes from the PR, so every field is checked.
import { lstat, readFile } from 'node:fs/promises';
import type { Receipt } from './receipt.ts';

export const RECEIPT_FILE = '.prreceipt.json';
/** Bumped when a field changes meaning; readers refuse other versions instead of guessing. */
export const FORMAT = 'prreceipt/1';
/** A real receipt is a few KB (one row per model); anything this big wasn't written by export. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** Date's own range; a time outside it makes rendering throw. */
const MAX_TIME_MS = 8.64e15;
const BOM = String.fromCodePoint(0xfeff);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** API, Bedrock (ARNs), Vertex and proxy model ids. */
const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,200}$/;

export class ReceiptFileError extends Error {}

export interface ReceiptFile {
  /** ms since the epoch. */
  exportedAt: number;
  receipt: Receipt;
}

/** Pretty-printed with a trailing newline, so the committed file diffs well. JSON keeps every double exact. */
export function serializeReceipt(receipt: Receipt, exportedAt: number): string {
  return JSON.stringify({ format: FORMAT, exportedAt: new Date(exportedAt).toISOString(), receipt }, null, 2) + '\n';
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Checks `text` (from `source`, used in messages) and returns the receipt. Unknown fields are ignored. */
export function parseReceiptFile(text: string, source: string): ReceiptFile {
  const fail = (why: string): never => {
    throw new ReceiptFileError(`${source} ${why}`);
  };
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  if (body.trim() === '') fail('is empty. Run `prreceipt export` again.');
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    // Only where it broke: V8's message quotes the text around the error, and in CI that text could be
    // anything a PR pointed the Action at, so none of it goes into the log.
    const where = /position \d+(?: \(line \d+ column \d+\))?/.exec((e as Error).message)?.[0];
    fail(`is not valid JSON${where ? ` (at ${where})` : ''}. Run \`prreceipt export\` again.`);
  }
  if (!isObject(raw) || typeof raw.format !== 'string' || !/^prreceipt\/\d+$/.test(raw.format)) {
    return fail(`is not a prreceipt export (expected "format": "${FORMAT}")`);
  }
  if (raw.format !== FORMAT) {
    fail(`has format ${raw.format}, but this prreceipt reads ${FORMAT}. Update prreceipt, or export again with this version.`);
  }

  const invalid = (path: string, what: string): never => fail(`is not a valid prreceipt export: ${path} must be ${what}`);
  const object = (v: unknown, path: string): Json => (isObject(v) ? v : invalid(path, 'an object'));
  const list = (v: unknown, path: string): unknown[] => (Array.isArray(v) ? v : invalid(path, 'a list'));
  const text_ = (v: unknown, path: string): string => (typeof v === 'string' ? v : invalid(path, 'a string'));
  const name = (v: unknown, path: string): string =>
    typeof v === 'string' && v !== '' && !CONTROL.test(v) ? v : invalid(path, 'a non-empty string without control characters');
  // Model names are printed outside code spans in the comment, so only what model ids are made of: no
  // markdown links or images, no autolinked URLs (scheme or www.), no #references.
  const modelId = (v: unknown, path: string): string => {
    const id = text_(v, path);
    return MODEL_ID.test(id) && !id.includes('://') && !/^www\./i.test(id) ? id : invalid(path, 'a model id (letters, digits and . _ : / @ + -)');
  };
  // The footer prints the price date as is (it's from prices.json, not a name), so allow nothing but a date.
  const day = (v: unknown, path: string): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : invalid(path, 'a date (YYYY-MM-DD)'));
  const amount = (v: unknown, path: string): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : invalid(path, 'a non-negative number');
  const amountOrNull = (v: unknown, path: string): number | null =>
    v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : invalid(path, 'a non-negative number or null');
  const whole = (v: unknown, path: string): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : invalid(path, 'a whole number, 0 or more'));
  const time = (v: unknown, path: string): number =>
    typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_TIME_MS ? v : invalid(path, 'a time (ms since 1970)');
  const summary = (v: unknown, path: string) => {
    const o = object(v, path);
    return { sessions: whole(o.sessions, `${path}.sessions`), tokens: amount(o.tokens, `${path}.tokens`), cost: amount(o.cost, `${path}.cost`) };
  };

  const exportedAt = typeof raw.exportedAt === 'string' ? Date.parse(raw.exportedAt) : NaN;
  if (!Number.isFinite(exportedAt)) invalid('exportedAt', 'an ISO date');

  const r = object(raw.receipt, 'receipt');
  const hitRate = r.cacheHitRate;
  if (hitRate !== null && !(typeof hitRate === 'number' && hitRate >= 0 && hitRate <= 1)) invalid('receipt.cacheHitRate', 'a number from 0 to 1, or null');

  let window: Receipt['window'] = null;
  if (r.window !== null) {
    const w = object(r.window, 'receipt.window');
    window = { start: time(w.start, 'receipt.window.start'), end: time(w.end, 'receipt.window.end') };
    if (window.end < window.start) fail('is not a valid prreceipt export: receipt.window must not end before it starts');
  }
  let diff: Receipt['diff'] = null;
  if (r.diff !== null) {
    const d = object(r.diff, 'receipt.diff');
    diff = {
      base: name(d.base, 'receipt.diff.base'),
      files: whole(d.files, 'receipt.diff.files'),
      insertions: whole(d.insertions, 'receipt.diff.insertions'),
      deletions: whole(d.deletions, 'receipt.diff.deletions'),
    };
  }

  const receipt: Receipt = {
    branch: name(r.branch, 'receipt.branch'),
    asOf: day(r.asOf, 'receipt.asOf'),
    totalCost: amount(r.totalCost, 'receipt.totalCost'),
    totalTokens: amount(r.totalTokens, 'receipt.totalTokens'),
    input: amount(r.input, 'receipt.input'),
    output: amount(r.output, 'receipt.output'),
    cacheWrite: amount(r.cacheWrite, 'receipt.cacheWrite'),
    cacheRead: amount(r.cacheRead, 'receipt.cacheRead'),
    cacheHitRate: hitRate as number | null,
    sessions: whole(r.sessions, 'receipt.sessions'),
    wallTimeMs: amount(r.wallTimeMs, 'receipt.wallTimeMs'),
    models: list(r.models, 'receipt.models').map((v, i) => {
      const path = `receipt.models[${i}]`;
      const m = object(v, path);
      return {
        model: modelId(m.model, `${path}.model`),
        input: amount(m.input, `${path}.input`),
        output: amount(m.output, `${path}.output`),
        cacheWrite: amount(m.cacheWrite, `${path}.cacheWrite`),
        cacheRead: amount(m.cacheRead, `${path}.cacheRead`),
        tokens: amount(m.tokens, `${path}.tokens`),
        cost: amountOrNull(m.cost, `${path}.cost`),
      };
    }),
    unpriced: list(r.unpriced, 'receipt.unpriced').map((v, i) => modelId(v, `receipt.unpriced[${i}]`)),
    unattributed: summary(r.unattributed, 'receipt.unattributed'),
    window,
    fromWindow: summary(r.fromWindow, 'receipt.fromWindow'),
    diff,
    costPerLine: amountOrNull(r.costPerLine, 'receipt.costPerLine'),
  };
  return { exportedAt, receipt };
}

/** Reads and checks the file at `path`; messages name it as `source` (the path the user gave). */
export async function readReceiptFile(path: string, source = path): Promise<ReceiptFile> {
  const unreadable = (e: unknown) => new ReceiptFileError(`cannot read ${source}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  let info;
  try {
    info = await lstat(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ReceiptFileError(`no receipt file at ${source}. Run \`prreceipt export\` on the pull request's branch and commit the ${RECEIPT_FILE} it writes.`);
    }
    throw unreadable(e);
  }
  // In CI the path comes from the PR: a committed symlink could point at /proc/self/environ or /dev/zero.
  if (info.isSymbolicLink()) throw new ReceiptFileError(`${source} is a symbolic link; commit the receipt file itself`);
  if (info.isDirectory()) throw new ReceiptFileError(`${source} is a directory, not a receipt file`);
  if (!info.isFile()) throw new ReceiptFileError(`${source} is not a regular file`);
  if (info.size > MAX_FILE_BYTES) throw new ReceiptFileError(`${source} is larger than 1 MB, so it isn't a receipt written by \`prreceipt export\``);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw unreadable(e);
  }
  return parseReceiptFile(text, source);
}
