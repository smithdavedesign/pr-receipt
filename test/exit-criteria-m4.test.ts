// One block per M4 exit criterion in ROADMAP.md (EC13–EC14, numbered after M3's). "The Action" is the real
// action.yml, run step by step by test/action-runner.ts with a fake gh on PATH.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MARKER } from '../src/github.ts';
import { runAction, type ActionContext } from './action-runner.ts';
import { FakeGitHub, installFakeGh, type FakeState } from './fake-gh.ts';
import {
  EXPORT_FIXTURE,
  FAKE_TOKEN,
  assistant,
  codexMeta,
  codexTokens,
  codexTurn,
  commit,
  git,
  gitRepo,
  lines,
  run,
  sampleReceipt,
  tempDir,
  user,
  writeLogs,
} from './helpers.ts';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const SONNET = 'claude-sonnet-4-5-20250929';
const OPUS = 'claude-opus-4-5-20251101';

/**
 * A repo whose `feat/cart` has two commits (window 10-02 10:00 → 15:00) changing 65 lines against main, and
 * logs with every part a receipt can show: Claude and Codex sessions on the branch, a no-branch session in the
 * window (counted), one after it (unattributed), and cache reads. `elsewhere` adds a session on a branch of
 * the same name in another repository.
 */
async function cartScenario(opts: { elsewhere?: boolean } = {}) {
  const repo = await gitRepo('main');
  await commit(repo, { 'README.md': 'shop\n', 'src/cart.ts': lines(40) }, '2026-10-01T00:00:00Z', 'base');
  git(repo, ['checkout', '-q', '-b', 'feat/cart']);
  await commit(repo, { 'src/cart.ts': lines(30) + lines(25, 'total'), 'src/badge.ts': lines(12, 'badge') }, '2026-10-02T10:00:00Z');
  await commit(repo, { 'src/checkout.ts': lines(18, 'pay') }, '2026-10-02T15:00:00Z');
  const codexId = '0199c000-0000-7000-8000-000000000001';
  const files: Record<string, object[]> = {
    'claude/projects/-shop/s1.jsonl': [
      user({ session: 's1', branch: 'feat/cart', cwd: repo, ts: '2026-10-02T09:30:00Z', text: 'PROMPT-MARKER-m4 add a badge with the cart count' }),
      assistant({ session: 's1', branch: 'feat/cart', cwd: repo, model: SONNET, input: 12_000, output: 4_000, cacheWrite: 20_000, cacheRead: 150_000, ts: '2026-10-02T09:45:00Z' }),
      assistant({ session: 's1', branch: 'feat/cart', cwd: repo, model: SONNET, input: 3_000, output: 6_000, cacheRead: 170_000, ts: '2026-10-02T10:20:00Z' }),
    ],
    'claude/projects/-shop/s2.jsonl': [
      assistant({ session: 's2', branch: null, cwd: repo, model: OPUS, input: 3_000, output: 1_500, cacheRead: 40_000, ts: '2026-10-02T13:00:00Z' }),
    ],
    'claude/projects/-shop/s3.jsonl': [assistant({ session: 's3', branch: null, cwd: repo, model: SONNET, input: 2_000, output: 500, ts: '2026-10-04T09:00:00Z' })],
    [`codex/sessions/2026/10/02/rollout-2026-10-02T14-00-00-${codexId}.jsonl`]: [
      codexMeta({ id: codexId, ts: '2026-10-02T14:00:00Z', cwd: repo, branch: 'feat/cart' }),
      codexTurn({ ts: '2026-10-02T14:00:01Z', cwd: repo }),
      codexTokens({ ts: '2026-10-02T14:05:00Z', total: { input: 30_000, cached: 20_000, output: 2_000 }, last: { input: 30_000, cached: 20_000, output: 2_000 } }),
    ],
  };
  if (opts.elsewhere) {
    files['claude/projects/-other/s4.jsonl'] = [assistant({ session: 's4', branch: 'feat/cart', cwd: '/elsewhere/other-shop', model: SONNET, input: 900_000, ts: '2026-10-02T11:00:00Z' })];
  }
  return { repo, logs: await writeLogs(files) };
}

/** A fresh CI checkout holding only `files` (relative path → source file): no logs, no git history. */
async function workspaceWith(files: Record<string, string>): Promise<string> {
  const workspace = await tempDir('prr-ws-');
  for (const [rel, source] of Object.entries(files)) {
    await mkdir(join(workspace, rel, '..'), { recursive: true });
    await copyFile(source, join(workspace, rel));
  }
  return workspace;
}

/** The Action on pull request #7 (head feat/cart) of acme/shop, with a fake gh that requires the workflow token. */
async function actionOnPr(workspace: string, opts: { pr?: FakeState['pr']; prNumber?: number; inputs?: Record<string, string> } = {}) {
  const pr = opts.pr === undefined ? { number: 7, head: 'feat/cart', base: 'main' } : opts.pr;
  const gh = await installFakeGh({ pr });
  const ctx: ActionContext = {
    workspace,
    prNumber: 'prNumber' in opts ? opts.prNumber : (pr?.number ?? 7),
    headRef: pr?.head ?? 'feat/cart',
    token: FAKE_TOKEN,
    inputs: opts.inputs,
    binDir: gh.binDir,
    env: { PRR_FAKE_GH_STATE: gh.statePath, PRR_FAKE_GH_TOKEN: FAKE_TOKEN },
    home: await tempDir('prr-runner-home-'),
  };
  return { gh, ctx, result: runAction(ctx) };
}

describe('EC13: the Action run against a receipt JSON produces the same markdown as local `show`', () => {
  it('posts exactly what `show` prints, from the exported file alone', async () => {
    const { repo, logs } = await cartScenario();
    const shown = await run(['show', '--logs', logs], { cwd: repo });
    assert.equal(shown.code, 0, shown.err);
    // The scenario exercises every part of a receipt, so "the same markdown" covers all of them.
    assert.match(shown.out, /\*\*Lines changed:\*\* 65 \(\+55 \/ -10 vs `main`\)/);
    assert.match(shown.out, /matched by this branch’s commit window/);
    assert.match(shown.out, /^_Unattributed/m);
    assert.match(shown.out, /\| gpt-5-codex \|/);
    assert.match(shown.out, /\| claude-opus-4-5 \|/);
    assert.match(shown.out, /\*\*Sessions:\*\* 3/);

    const exported = await run(['export', '--logs', logs], { cwd: repo, now: () => NOW });
    assert.equal(exported.code, 0, exported.err);
    const workspace = await workspaceWith({ '.prreceipt.json': join(repo, '.prreceipt.json') });

    const { gh, result } = await actionOnPr(workspace);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.skipped, ['actions/setup-node@v5']);
    const fake = await gh.read();
    assert.equal(fake.creates().length, 1);
    assert.deepEqual(fake.sentBodies(), [`${MARKER}\n${shown.out}`], 'the posted body is the marker plus show’s markdown, byte for byte');
    assert.match(result.stdout, /posted PR receipt on #7/);
    assert.match(result.stderr, /receipt for `feat\/cart`, exported 2026-10-13 12:00 UTC/, 'the Action log says when the receipt was exported');
  });

  it('updates the same comment when the Action runs again (one comment per PR, as with local `comment`)', async () => {
    const { repo, logs } = await cartScenario();
    await run(['export', '--logs', logs], { cwd: repo, now: () => NOW });
    const workspace = await workspaceWith({ '.prreceipt.json': join(repo, '.prreceipt.json') });
    const { gh, ctx, result } = await actionOnPr(workspace);
    assert.equal(result.code, 0, result.stderr);
    const second = runAction(ctx);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /updated PR receipt on #7/);
    const fake = await gh.read();
    assert.equal(fake.creates().length, 1);
    assert.equal(fake.updates().length, 1);
    assert.equal(fake.ours().length, 1);
  });

  it('`export` prints, and `show --from` reprints, the same markdown as `show`', async () => {
    const { repo, logs } = await cartScenario();
    const shown = await run(['show', '--logs', logs], { cwd: repo });
    const exported = await run(['export', '--logs', logs], { cwd: repo, now: () => NOW });
    assert.equal(exported.out, shown.out);
    const fromFile = await run(['show', '--from', '.prreceipt.json'], { cwd: repo });
    assert.equal(fromFile.code, 0, fromFile.err);
    assert.equal(fromFile.out, shown.out);
  });

  it('matches `show --repo` when another repository has a branch of the same name (the receipt counts this repository only)', async () => {
    const { repo, logs } = await cartScenario({ elsewhere: true });
    const unscoped = await run(['show', '--logs', logs], { cwd: repo });
    assert.match(unscoped.out, /\*\*Sessions:\*\* 4/, '`show` alone counts every repository (M1 behaviour)');
    const scoped = await run(['show', '--logs', logs, '--repo', repo], { cwd: repo });
    assert.match(scoped.out, /\*\*Sessions:\*\* 3/);

    await run(['export', '--logs', logs], { cwd: repo, now: () => NOW });
    const workspace = await workspaceWith({ '.prreceipt.json': join(repo, '.prreceipt.json') });
    const { gh, result } = await actionOnPr(workspace);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual((await gh.read()).sentBodies(), [`${MARKER}\n${scoped.out}`]);
  });

  it('renders the committed fixture file (format prreceipt/1) to the markdown `show` printed when it was exported', async () => {
    const workspace = await workspaceWith({ 'receipts/demo.json': join(EXPORT_FIXTURE, 'feat-demo.prreceipt.json') });
    const { gh, result } = await actionOnPr(workspace, { pr: { number: 3, head: 'feat/demo', base: 'main' }, inputs: { path: 'receipts/demo.json' } });
    assert.equal(result.code, 0, result.stderr);
    const expected = await readFile(join(EXPORT_FIXTURE, 'feat-demo.md'), 'utf8');
    assert.match(expected, /^## 🧾 PR Receipt: `feat\/demo`/);
    assert.deepEqual((await gh.read()).sentBodies(), [`${MARKER}\n${expected}`]);
  });
});

/** A valid file's JSON, with `change` applied to a copy. */
function fileText(change: (file: { format: unknown; exportedAt: unknown; receipt: Record<string, unknown> }) => void = () => {}): string {
  const file = { format: 'prreceipt/1', exportedAt: '2026-10-13T12:00:00.000Z', receipt: sampleReceipt() as unknown as Record<string, unknown> };
  change(file);
  return JSON.stringify(file, null, 2) + '\n';
}

const INVALID: Array<{ what: string; content: string | null | 'directory' | 'huge'; message: RegExp }> = [
  { what: 'no file', content: null, message: /no receipt file at \.prreceipt\.json\. Run `prreceipt export`/ },
  { what: 'a half-written file', content: fileText().slice(0, 200), message: /\.prreceipt\.json is not valid JSON/ },
  { what: 'an empty file', content: '', message: /\.prreceipt\.json is empty/ },
  { what: 'a directory', content: 'directory', message: /\.prreceipt\.json is a directory/ },
  { what: 'a JSON array', content: '[]\n', message: /\.prreceipt\.json is not a prreceipt export/ },
  { what: 'an object without a format', content: '{}\n', message: /\.prreceipt\.json is not a prreceipt export/ },
  { what: 'a newer format', content: fileText((f) => (f.format = 'prreceipt/2')), message: /has format prreceipt\/2, but this prreceipt reads prreceipt\/1\. Update prreceipt/ },
  { what: 'a cost given as text', content: fileText((f) => (f.receipt.totalCost = '0.12')), message: /receipt\.totalCost must be a non-negative number/ },
  { what: 'a model row without its name', content: fileText((f) => delete (f.receipt.models as Array<Record<string, unknown>>)[1].model), message: /receipt\.models\[1\]\.model must be a string/ },
  { what: 'a date out of range', content: fileText((f) => (f.receipt.window = { start: 1e17, end: 1e17 })), message: /receipt\.window\.start must be a time/ },
  { what: 'a file over 1 MB', content: 'huge', message: /\.prreceipt\.json is larger than 1 MB/ },
];

describe('EC14: a missing or invalid receipt JSON fails with a clear message and a non-zero exit', () => {
  for (const { what, content, message } of INVALID) {
    it(`the Action fails on ${what}, and nothing reaches GitHub`, async () => {
      const workspace = await tempDir('prr-ws-');
      const path = join(workspace, '.prreceipt.json');
      if (content === 'directory') await mkdir(path);
      else if (content === 'huge') await writeFile(path, fileText((f) => (f.receipt.padding = 'x'.repeat(1_100_000))));
      else if (content !== null) await writeFile(path, content);

      const { gh, result } = await actionOnPr(workspace);
      assert.notEqual(result.code, 0, 'the step fails');
      assert.match(result.stderr, message);
      assert.match(result.stderr, /^prreceipt: /m, 'the message is prreceipt’s own, not a stack trace');
      assert.doesNotMatch(result.stderr, /unexpected error|\n\s+at /, 'no crash');
      assert.equal(result.stdout, '');
      assert.equal((await gh.read()).state.calls.length, 0, 'gh is never called');
    });
  }

  it('`show --from` fails the same way, with exit 1', async () => {
    const cwd = await tempDir('prr-from-');
    const missing = await run(['show', '--from', '.prreceipt.json'], { cwd });
    assert.equal(missing.code, 1);
    assert.equal(missing.out, '');
    assert.match(missing.err, /^prreceipt: no receipt file at \.prreceipt\.json\. Run `prreceipt export`/);

    await writeFile(join(cwd, 'bad.json'), '{"format": "prreceipt/1", "receipt": ');
    const invalid = await run(['show', '--from', 'bad.json'], { cwd });
    assert.equal(invalid.code, 1);
    assert.match(invalid.err, /^prreceipt: bad\.json is not valid JSON\b.*Run `prreceipt export` again\./);
  });

  it('`comment --from` fails before asking GitHub anything', async () => {
    const cwd = await tempDir('prr-from-');
    await writeFile(join(cwd, 'r.json'), fileText((f) => (f.receipt.sessions = 1.5)));
    const fake = new FakeGitHub();
    const result = await run(['comment', '--from', 'r.json', '--pr', '7'], { cwd, gh: fake.gh });
    assert.equal(result.code, 1);
    assert.match(result.err, /receipt\.sessions must be a whole number/);
    assert.equal(fake.state.calls.length, 0);
  });
});
