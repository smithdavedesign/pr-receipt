// M4 beyond the exit criteria: the receipt file format, `export`, `comment --from`, flag misuse, the git
// diff exclusion, and the Action / example workflow files.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { branchContext } from '../src/git.ts';
import { MARKER } from '../src/github.ts';
import { FORMAT, MAX_FILE_BYTES, RECEIPT_FILE, ReceiptFileError, parseReceiptFile, readReceiptFile, serializeReceipt } from '../src/receipt-file.ts';
import { renderReceipt, type Receipt } from '../src/receipt.ts';
import { ROOT, loadAction, runAction } from './action-runner.ts';
import { FakeGitHub, installFakeGh } from './fake-gh.ts';
import { FAKE_TOKEN, THREE_MESSAGES, assistant, commit, git, gitRepo, lines, run, sampleReceipt, tempDir, user, writeLogs } from './helpers.ts';

const NOW = Date.parse('2026-10-13T12:00:00Z');

/** main + `feat/x` with one commit of 10 lines; one $0.0105 session on feat/x in the repo. */
async function repoScenario(branch = 'feat/x') {
  const repo = await gitRepo('main');
  await commit(repo, { 'README.md': 'hi\n' }, '2026-10-01T00:00:00Z', 'base');
  git(repo, ['checkout', '-q', '-b', branch]);
  await commit(repo, { 'src/x.ts': lines(10) }, '2026-10-02T10:00:00Z');
  const logs = await writeLogs({
    'p/s1.jsonl': [assistant({ session: 's1', branch, cwd: repo, input: 1000, output: 500, ts: '2026-10-02T09:50:00Z' })],
  });
  return { repo, logs };
}

async function writeReceipt(dir: string, receipt: Receipt, name = RECEIPT_FILE): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, serializeReceipt(receipt, NOW));
  return path;
}

describe('receipt file format', () => {
  it('round-trips a receipt exactly, floats included', () => {
    const receipt = sampleReceipt();
    const file = parseReceiptFile(serializeReceipt(receipt, NOW), 'r.json');
    assert.deepEqual(file.receipt, receipt);
    assert.equal(file.exportedAt, NOW);
    assert.equal(renderReceipt(file.receipt), renderReceipt(receipt));
  });

  it('round-trips the empty optional parts (no window, no diff, no prompt tokens, no unpriced models)', () => {
    const receipt: Receipt = {
      ...sampleReceipt(),
      cacheHitRate: null,
      window: null,
      diff: null,
      costPerLine: null,
      unpriced: [],
      models: [sampleReceipt().models[0]],
      fromWindow: { sessions: 0, tokens: 0, cost: 0 },
    };
    assert.deepEqual(parseReceiptFile(serializeReceipt(receipt, NOW), 'r.json').receipt, receipt);
  });

  it('is pretty-printed JSON with the format first and a trailing newline, for readable diffs', () => {
    const text = serializeReceipt(sampleReceipt(), NOW);
    assert.ok(text.startsWith(`{\n  "format": "${FORMAT}",\n  "exportedAt": "2026-10-13T12:00:00.000Z",\n  "receipt": {\n    "branch": "feat/cart",`));
    assert.ok(text.endsWith('}\n'));
    assert.equal(FORMAT, 'prreceipt/1');
    assert.equal(RECEIPT_FILE, '.prreceipt.json');
  });

  it('ignores fields it doesn’t know, and doesn’t carry them along', () => {
    const raw = JSON.parse(serializeReceipt(sampleReceipt(), NOW)) as Record<string, Record<string, unknown>>;
    raw.note = { by: 'hand' };
    raw.receipt.extra = 'x';
    const file = parseReceiptFile(JSON.stringify(raw), 'r.json');
    assert.deepEqual(file.receipt, sampleReceipt());
    assert.ok(!('extra' in file.receipt));
  });

  const cases: Array<[string, (f: Record<string, any>) => void, RegExp]> = [
    ['no receipt', (f) => delete f.receipt, /receipt must be an object/],
    ['an empty branch', (f) => (f.receipt.branch = ''), /receipt\.branch must be a non-empty string/],
    // asOf is rendered as is in the footer (it normally comes from prices.json), so it must be a plain date.
    ['markdown in the price date', (f) => (f.receipt.asOf = '2026-10-13 ![x](https://example.com/p.png) @team'), /receipt\.asOf must be a date \(YYYY-MM-DD\)/],
    ['a fractional session count', (f) => (f.receipt.sessions = 1.5), /receipt\.sessions must be a whole number/],
    ['a negative cost', (f) => (f.receipt.totalCost = -1), /receipt\.totalCost must be a non-negative number/],
    ['a cost as text', (f) => (f.receipt.totalCost = '0.1'), /receipt\.totalCost must be a non-negative number/],
    ['a cache hit rate over 100%', (f) => (f.receipt.cacheHitRate = 1.5), /receipt\.cacheHitRate must be a number from 0 to 1, or null/],
    ['models that aren’t a list', (f) => (f.receipt.models = {}), /receipt\.models must be a list/],
    ['a model cost as text', (f) => (f.receipt.models[0].cost = 'x'), /receipt\.models\[0\]\.cost must be a non-negative number or null/],
    ['a numeric model name', (f) => (f.receipt.models[0].model = 5), /receipt\.models\[0\]\.model must be a string/],
    ['a non-string unpriced model', (f) => (f.receipt.unpriced = [1]), /receipt\.unpriced\[0\] must be a string/],
    // Names are printed outside code spans in the comment the bot posts: no links, images, URLs or #refs.
    ['a model name that is a markdown link', (f) => (f.receipt.models[0].model = '[Approve this PR](https://example.com/x)'), /receipt\.models\[0\]\.model must be a model id/],
    ['an unpriced name that is an image', (f) => (f.receipt.unpriced = ['![p](https://example.com/p.png)']), /receipt\.unpriced\[0\] must be a model id/],
    ['a model name that is a URL', (f) => (f.receipt.models[0].model = 'https://example.com/login'), /receipt\.models\[0\]\.model must be a model id/],
    ['a model name starting with www.', (f) => (f.receipt.models[0].model = 'www.example.com'), /receipt\.models\[0\]\.model must be a model id/],
    ['a model name with an issue reference', (f) => (f.receipt.models[0].model = 'acme/shop#1'), /receipt\.models\[0\]\.model must be a model id/],
    ['a control character in the branch', (f) => (f.receipt.branch = 'a\u0000b'), /receipt\.branch must be a non-empty string without control characters/],
    ['no unattributed summary', (f) => delete f.receipt.unattributed, /receipt\.unattributed must be an object/],
    ['a window that ends before it starts', (f) => (f.receipt.window = { start: 5, end: 1 }), /receipt\.window must not end before it starts/],
    ['a window without a start', (f) => (f.receipt.window = { start: null, end: 1 }), /receipt\.window\.start must be a time/],
    ['a negative file count', (f) => (f.receipt.diff.files = -1), /receipt\.diff\.files must be a whole number/],
    ['a diff without a base', (f) => delete f.receipt.diff.base, /receipt\.diff\.base must be a non-empty string/],
    ['an unreadable export time', (f) => (f.exportedAt = 'yesterday'), /exportedAt must be an ISO date/],
    ['another tool’s format', (f) => (f.format = 'other/1'), /is not a prreceipt export/],
    ['a newer format', (f) => (f.format = 'prreceipt/12'), /has format prreceipt\/12, but this prreceipt reads prreceipt\/1/],
  ];
  for (const [what, change, message] of cases) {
    it(`rejects ${what}, naming the file and the field`, () => {
      const raw = JSON.parse(serializeReceipt(sampleReceipt(), NOW)) as Record<string, any>;
      change(raw);
      assert.throws(
        () => parseReceiptFile(JSON.stringify(raw), 'ci/receipt.json'),
        (e: unknown) => e instanceof ReceiptFileError && message.test(e.message) && e.message.startsWith('ci/receipt.json '),
      );
    });
  }

  it('reads a file from disk, and explains a missing file, a directory, an empty or oversized file', async () => {
    const dir = await tempDir('prr-rf-');
    const path = await writeReceipt(dir, sampleReceipt());
    assert.deepEqual((await readReceiptFile(path, 'r.json')).receipt, sampleReceipt());

    const fails = async (target: string, message: RegExp) =>
      assert.rejects(readReceiptFile(target, 'r.json'), (e: unknown) => e instanceof ReceiptFileError && message.test(e.message));
    await fails(join(dir, 'nope.json'), /^no receipt file at r\.json\. Run `prreceipt export`/);
    await mkdir(join(dir, 'd'));
    await fails(join(dir, 'd'), /^r\.json is a directory/);
    await writeFile(join(dir, 'empty.json'), '  \n');
    await fails(join(dir, 'empty.json'), /^r\.json is empty/);
    await writeFile(join(dir, 'big.json'), ' '.repeat(MAX_FILE_BYTES + 1));
    await fails(join(dir, 'big.json'), /^r\.json is larger than 1 MB/);
  });

  it('accepts the model ids real logs produce, Bedrock and Vertex style included', () => {
    const receipt = sampleReceipt();
    const ids = ['gpt-5.1-codex-max', 'codex-unknown-model', 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc', 'anthropic/claude-sonnet-4.5', 'claude-opus-4@20250514', 'my_proxy+model'];
    receipt.models = ids.map((model) => ({ ...sampleReceipt().models[1], model }));
    receipt.unpriced = ids;
    assert.deepEqual(parseReceiptFile(serializeReceipt(receipt, NOW), 'r.json').receipt, receipt);
  });

  it('accepts a byte-order mark (an editor may add one), and never echoes file content in a JSON error', () => {
    const bom = String.fromCodePoint(0xfeff);
    assert.equal(parseReceiptFile(bom + serializeReceipt(sampleReceipt(), NOW), 'r.json').receipt.branch, 'feat/cart');
    assert.throws(
      () => parseReceiptFile('HOME=/home/runner\nGH_TOKEN=abc\n', 'r.json'),
      (e: unknown) => e instanceof ReceiptFileError && /^r\.json is not valid JSON/.test(e.message) && !/HOME|GH_TOKEN|runner/.test(e.message),
    );
  });

  it('refuses a symbolic link, so a PR can’t point the Action at another file', async () => {
    const dir = await tempDir('prr-rf-');
    await writeReceipt(dir, sampleReceipt(), 'real.json');
    await symlink(join(dir, 'real.json'), join(dir, RECEIPT_FILE));
    await assert.rejects(readReceiptFile(join(dir, RECEIPT_FILE), RECEIPT_FILE), (e: unknown) => e instanceof ReceiptFileError && /^\.prreceipt\.json is a symbolic link/.test(e.message));
    await symlink('/dev/zero', join(dir, 'zero.json'));
    await assert.rejects(readReceiptFile(join(dir, 'zero.json'), 'zero.json'), /symbolic link/);
  });

  it('renders a hostile branch or base name from the file through the markdown sanitizer, and refuses hostile model names', () => {
    const receipt = sampleReceipt();
    receipt.branch = 'feat/x`<img src=x onerror=alert(1)>|';
    receipt.diff = { base: 'main`<b>@team</b>', files: 1, insertions: 1, deletions: 0 };
    const out = renderReceipt(parseReceiptFile(serializeReceipt(receipt, NOW), 'r.json').receipt);
    assert.doesNotMatch(out, /<img|<b>/);
    receipt.models[0].model = '@everyone <b>|';
    assert.throws(() => parseReceiptFile(serializeReceipt(receipt, NOW), 'r.json'), /receipt\.models\[0\]\.model must be a model id/);
  });
});

describe('`export`', () => {
  it('writes .prreceipt.json at the repository root, even from a subdirectory, and prints the receipt', async () => {
    const { repo, logs } = await repoScenario();
    await mkdir(join(repo, 'src', 'deep'), { recursive: true });
    const { code, out, err } = await run(['export', '--logs', logs], { cwd: join(repo, 'src', 'deep'), now: () => NOW });
    assert.equal(code, 0, err);
    assert.match(out, /^## 🧾 PR Receipt: `feat\/x`/);
    assert.match(err, /wrote \.\.\/\.\.\/\.prreceipt\.json \(`feat\/x`, 1 session, \$0\.0105\)/);
    assert.match(err, /commit it/i);
    const file = await readReceiptFile(join(repo, '.prreceipt.json'));
    assert.equal(file.receipt.branch, 'feat/x');
    assert.equal(file.receipt.sessions, 1);
    assert.equal(file.exportedAt, NOW);
    assert.deepEqual(file.receipt.diff, { base: 'main', files: 1, insertions: 10, deletions: 0 });
    assert.ok(!existsSync(join(repo, 'src', 'deep', '.prreceipt.json')));
  });

  it('writes to --out, relative to the working directory', async () => {
    const { repo, logs } = await repoScenario();
    const { code, err } = await run(['export', '--logs', logs, '--out', 'ci/receipt.json'], { cwd: repo, now: () => NOW });
    assert.equal(code, 1, 'a missing directory is not created');
    assert.match(err, /cannot write ci\/receipt\.json/);
    await mkdir(join(repo, 'ci'));
    const ok = await run(['export', '--logs', logs, '--out', 'ci/receipt.json'], { cwd: repo, now: () => NOW });
    assert.equal(ok.code, 0, ok.err);
    assert.equal((await readReceiptFile(join(repo, 'ci', 'receipt.json'))).receipt.branch, 'feat/x');
    assert.ok(!existsSync(join(repo, '.prreceipt.json')));
  });

  it('exports a named branch', async () => {
    const { repo, logs } = await repoScenario();
    git(repo, ['checkout', '-q', 'main']);
    const { code, err } = await run(['export', 'feat/x', '--logs', logs], { cwd: repo, now: () => NOW });
    assert.equal(code, 0, err);
    assert.equal((await readReceiptFile(join(repo, '.prreceipt.json'))).receipt.branch, 'feat/x');
  });

  it('counts only this repository and its worktrees; --repo replaces the scope', async () => {
    const { repo, logs } = await repoScenario();
    await writeFile(join(logs, 'p', 'other.jsonl'), JSON.stringify(assistant({ session: 'o1', branch: 'feat/x', cwd: '/elsewhere/other', input: 50_000 })) + '\n');
    await run(['export', '--logs', logs], { cwd: repo, now: () => NOW });
    assert.equal((await readReceiptFile(join(repo, '.prreceipt.json'))).receipt.sessions, 1);
    await run(['export', '--logs', logs, '--repo', '/elsewhere/other'], { cwd: repo, now: () => NOW });
    const other = (await readReceiptFile(join(repo, '.prreceipt.json'))).receipt;
    assert.equal(other.sessions, 1);
    assert.equal(other.input, 50_000);
  });

  it('writes nothing when the branch has no sessions in this repository', async () => {
    const { repo } = await repoScenario();
    const empty = await writeLogs({ 'p/s.jsonl': [assistant({ session: 's', branch: 'feat/other', cwd: repo })] });
    const { code, out } = await run(['export', '--logs', empty], { cwd: repo, now: () => NOW });
    assert.equal(code, 0);
    assert.match(out, /no sessions found for branch `feat\/x` in this repository; nothing written/);
    assert.ok(!existsSync(join(repo, '.prreceipt.json')));
  });

  it('must run inside a git repository and on a branch, and says so before reading any logs', async () => {
    const outside = await run(['export', '--logs', '/nonexistent-logs'], {});
    assert.equal(outside.code, 1);
    assert.match(outside.err, /export must run inside the repository/);
    assert.doesNotMatch(outside.err + outside.out, /no sessions|looked in|scanned/);

    const { repo, logs } = await repoScenario();
    git(repo, ['checkout', '-q', '--detach']);
    const detached = await run(['export', '--logs', logs], { cwd: repo });
    assert.equal(detached.code, 1);
    assert.match(detached.err, /no branch to export: check out the pull request's branch or pass its name/);
  });

  it('warns when there is no base to compare with, and still writes the receipt', async () => {
    const { repo, logs } = await repoScenario();
    git(repo, ['branch', '-q', '-m', 'main', 'trunk']);
    const { code, err } = await run(['export', '--logs', logs], { cwd: repo, now: () => NOW });
    assert.equal(code, 0, err);
    assert.match(err, /no base branch found, so lines changed and the commit window are left out/);
    assert.equal((await readReceiptFile(join(repo, '.prreceipt.json'))).receipt.diff, null);
    const withBase = await run(['export', '--logs', logs, '--base', 'trunk'], { cwd: repo, now: () => NOW });
    assert.equal(withBase.code, 0);
    assert.doesNotMatch(withBase.err, /left out/);
    assert.equal((await readReceiptFile(join(repo, '.prreceipt.json'))).receipt.diff?.base, 'trunk');
  });

  it('replaces a symlinked .prreceipt.json instead of writing through it to the link’s target', async () => {
    const { repo, logs } = await repoScenario();
    const victim = join(await tempDir('prr-victim-'), 'profile');
    await writeFile(victim, 'export PATH=/usr/bin\n');
    await symlink(victim, join(repo, '.prreceipt.json'));
    const { code, err } = await run(['export', '--logs', logs], { cwd: repo, now: () => NOW });
    assert.equal(code, 0, err);
    assert.equal(await readFile(victim, 'utf8'), 'export PATH=/usr/bin\n', 'the link target is untouched');
    assert.ok((await lstat(join(repo, '.prreceipt.json'))).isFile());
    assert.equal((await readReceiptFile(join(repo, '.prreceipt.json'))).receipt.branch, 'feat/x');
  });

  it('refuses to write a receipt the Action would reject (a model id that isn’t safe to post)', async () => {
    const { repo } = await repoScenario();
    const logs = await writeLogs({ 'p/s.jsonl': [assistant({ session: 's', branch: 'feat/x', cwd: repo, model: 'proxy (see https://example.com)', input: 1000 })] });
    const { code, err } = await run(['export', '--logs', logs], { cwd: repo, now: () => NOW });
    assert.equal(code, 1);
    assert.match(err, /can't export: .*receipt\.models\[0\]\.model must be a model id/);
    assert.ok(!existsSync(join(repo, '.prreceipt.json')));
  });

  it('fails clearly when the output path can’t be written', async () => {
    const { repo, logs } = await repoScenario();
    await mkdir(join(repo, 'taken'));
    const { code, err } = await run(['export', '--logs', logs, '--out', 'taken'], { cwd: repo });
    assert.equal(code, 1);
    assert.match(err, /^prreceipt: cannot write taken: EISDIR/m);
  });

  it('writes aggregates only: no prompt or response text, local paths or session ids', async () => {
    const { repo } = await repoScenario();
    const reply = assistant({ session: 'secret-session-42', branch: 'feat/x', cwd: repo, input: 1000, ts: '2026-10-02T09:55:00Z' }) as { message: { content: unknown } };
    reply.message.content = [{ type: 'text', text: 'RESPONSE-MARKER-m4 the API key lives in config/prod.env' }];
    const logs = await writeLogs({
      'p/s.jsonl': [user({ session: 'secret-session-42', branch: 'feat/x', cwd: repo, ts: '2026-10-02T09:50:00Z', text: 'PROMPT-MARKER-m4 rotate the billing secret' }), reply],
    });
    const { code, err } = await run(['export', '--logs', logs], { cwd: repo, now: () => NOW });
    assert.equal(code, 0, err);
    const text = await readFile(join(repo, '.prreceipt.json'), 'utf8');
    assert.doesNotMatch(text, /MARKER|billing secret|config\/prod|secret-session-42|msg_gen|req_gen/);
    assert.ok(!text.includes(repo), 'no local paths');
  });

  it('doesn’t count a committed .prreceipt.json as changed lines', async () => {
    const { repo, logs } = await repoScenario();
    await run(['export', '--logs', logs], { cwd: repo, now: () => NOW });
    await commit(repo, {}, '2026-10-02T11:00:00Z', 'Add PR receipt');
    const before = branchContext(repo, 'main', 'feat/x').diff;
    assert.deepEqual(before, { base: 'main', files: 1, insertions: 10, deletions: 0 });
    await mkdir(join(repo, 'src'), { recursive: true });
    assert.deepEqual(branchContext(join(repo, 'src'), 'main', 'feat/x').diff, before, 'the same from a subdirectory');
    await run(['export', '--logs', logs], { cwd: repo, now: () => NOW });
    assert.equal((await readReceiptFile(join(repo, '.prreceipt.json'))).receipt.diff?.insertions, 10);
  });

  it('doesn’t let the receipt commit stretch the commit window', async () => {
    const { repo, logs } = await repoScenario();
    const before = branchContext(repo, 'main', 'feat/x').window;
    await run(['export', '--logs', logs], { cwd: repo, now: () => NOW });
    await commit(repo, {}, '2026-10-05T18:00:00Z', 'Add PR receipt');
    assert.deepEqual(branchContext(repo, 'main', 'feat/x').window, before);
  });

  it('counts the whole repository from a subdirectory, even with diff.relative set', async () => {
    const { repo } = await repoScenario();
    git(repo, ['config', 'diff.relative', 'true']);
    await mkdir(join(repo, 'docs'));
    assert.deepEqual(branchContext(join(repo, 'docs'), 'main', 'feat/x').diff, { base: 'main', files: 1, insertions: 10, deletions: 0 });
  });
});

describe('`comment --from`', () => {
  it('--dry-run prints the body it would post and posts nothing', async () => {
    const dir = await tempDir('prr-from-');
    await writeReceipt(dir, sampleReceipt());
    const fake = new FakeGitHub({ pr: { number: 7, head: 'feat/cart', base: 'main' } });
    const { code, out, err } = await run(['comment', '--from', RECEIPT_FILE, '--pr', '7', '--dry-run'], { cwd: dir, gh: fake.gh });
    assert.equal(code, 0, err);
    assert.ok(out.includes(`${MARKER}\n${renderReceipt(sampleReceipt())}`));
    assert.equal(fake.creates().length + fake.updates().length, 0);
  });

  it('without --pr, finds the pull request of the receipt’s branch', async () => {
    const dir = await tempDir('prr-from-');
    await writeReceipt(dir, sampleReceipt());
    const fake = new FakeGitHub({ pr: { number: 7, head: 'feat/cart', base: 'main' } });
    const { code, err } = await run(['comment', '--from', RECEIPT_FILE], { cwd: dir, gh: fake.gh });
    assert.equal(code, 0, err);
    assert.deepEqual(fake.views()[0].args.slice(0, 3), ['pr', 'view', 'feat/cart']);
    assert.equal(fake.creates().length, 1);
  });

  it('refuses a receipt exported for another branch, e.g. one inherited from main', async () => {
    const dir = await tempDir('prr-from-');
    await writeReceipt(dir, sampleReceipt());
    const fake = new FakeGitHub({ pr: { number: 8, head: 'feat/search', base: 'main' } });
    const { code, err } = await run(['comment', '--from', RECEIPT_FILE, '--pr', '8'], { cwd: dir, gh: fake.gh });
    assert.equal(code, 1);
    assert.match(err, /\.prreceipt\.json is the receipt for `feat\/cart`, but PR #8's branch is `feat\/search`\. Run `prreceipt export` on `feat\/search` and commit it; nothing posted/);
    assert.equal(fake.creates().length + fake.updates().length, 0);
  });

  it('posts nothing for a receipt without sessions', async () => {
    const dir = await tempDir('prr-from-');
    await writeReceipt(dir, { ...sampleReceipt(), sessions: 0, models: [], unpriced: [] });
    const fake = new FakeGitHub({ pr: { number: 7, head: 'feat/cart', base: 'main' } });
    const { code, out } = await run(['comment', '--from', RECEIPT_FILE, '--pr', '7'], { cwd: dir, gh: fake.gh });
    assert.equal(code, 0);
    assert.match(out, /has no sessions; nothing posted to #7/);
    assert.equal(fake.creates().length, 0);
  });

  it('reports gh errors with exit 1', async () => {
    const dir = await tempDir('prr-from-');
    await writeReceipt(dir, sampleReceipt());
    const fake = new FakeGitHub({ pr: null });
    const { code, err } = await run(['comment', '--from', RECEIPT_FILE, '--pr', '7'], { cwd: dir, gh: fake.gh });
    assert.equal(code, 1);
    assert.match(err, /no pull requests found/);
  });

  it('needs a pull request number for --pr', async () => {
    for (const pr of ['', 'abc', '0', '-1', '7a', '12345678901']) {
      const fake = new FakeGitHub();
      const { code, err } = await run(['comment', '--from', RECEIPT_FILE, `--pr=${pr}`], { gh: fake.gh });
      assert.equal(code, 1, pr);
      assert.match(err, /--pr needs a pull request number/, pr);
      assert.equal(fake.state.calls.length, 0);
    }
  });

  it('`comment --pr` without --from still checks that the PR is the branch’s', async () => {
    const { repo, logs } = await repoScenario('feat/c');
    const right = new FakeGitHub({ pr: { number: 7, head: 'feat/c', base: 'main' } });
    const ok = await run(['comment', '--pr', '7', '--logs', logs], { cwd: repo, gh: right.gh });
    assert.equal(ok.code, 0, ok.err);
    assert.deepEqual(right.views()[0].args.slice(0, 3), ['pr', 'view', '7']);
    assert.equal(right.creates().length, 1);

    const wrong = new FakeGitHub({ pr: { number: 7, head: 'feat/other', base: 'main' } });
    const refused = await run(['comment', '--pr', '7', '--logs', logs], { cwd: repo, gh: wrong.gh });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /PR #7, whose branch is `feat\/other`, not `feat\/c`; nothing posted/);
    assert.equal(wrong.creates().length, 0);
  });
});

describe('M4 flag misuse', () => {
  const misuse: Array<[string[], RegExp]> = [
    [['show', 'feat/a', '--from', 'r.json'], /--from reads a finished receipt/],
    [['show', '--from', 'r.json', '--logs', THREE_MESSAGES], /--from reads a finished receipt/],
    [['show', '--from', 'r.json', '--prices', 'p.json'], /--from reads a finished receipt/],
    [['show', '--from', 'r.json', '--repo', '.'], /--from reads a finished receipt/],
    [['show', '--from', 'r.json', '--base', 'main'], /--from reads a finished receipt/],
    [['show', '--from', 'r.json', '--all'], /--from reads a finished receipt/],
    [['show', '--from', ''], /--from needs a file/],
    [['report', '--from', 'r.json'], /--from only works with show and comment/],
    [['export', '--from', 'r.json'], /--from only works with show and comment/],
    [['show', '--out', 'r.json'], /--out only works with export/],
    [['export', '--out', ''], /--out needs a file/],
    [['show', '--pr', '7'], /--pr only works with comment/],
    [['export', '--all'], /--all only works with show/],
    [['export', '--dry-run'], /--dry-run only works with comment/],
    [['export', '--since', '30d'], /--since only works with report/],
    [['export', 'a', 'b'], /export takes at most one branch/],
  ];
  for (const [argv, message] of misuse) {
    it(`rejects \`${argv.join(' ')}\``, async () => {
      const fake = new FakeGitHub();
      const { code, err, out } = await run(argv, { gh: fake.gh });
      assert.equal(code, 1);
      assert.match(err, message);
      assert.equal(out, '');
      assert.equal(fake.state.calls.length, 0);
    });
  }

  it('documents export, --from, --out and --pr in --help', async () => {
    const { out } = await run(['--help']);
    assert.match(out, /prreceipt export \[branch\]/);
    assert.match(out, /--from <file>/);
    assert.match(out, /--out <file>/);
    assert.match(out, /--pr <number>/);
  });
});

describe('action.yml', () => {
  const action = loadAction();

  it('is a composite action that sets up Node 24 (built-in TypeScript) and runs the CLI from its own checkout', () => {
    assert.equal(action.runs.using, 'composite');
    assert.ok(action.name && action.description);
    const [setup, post] = action.runs.steps;
    assert.equal(setup.uses, 'actions/setup-node@v5');
    assert.equal(String(setup.with?.['node-version']), '24');
    assert.equal(setup.with?.['package-manager-cache'], false, 'no cache lookups in the user’s repo');
    // --from="…" keeps a path that starts with "-" from being read as an option.
    assert.match(post.run ?? '', /node .*"\$GITHUB_ACTION_PATH\/src\/bin\.ts" comment --from="\$PRR_FILE" --pr="\$PRR_PR"/);
    assert.equal(action.runs.steps.length, 2);
  });

  it('never pastes an expression into a shell script (values reach `run:` only through env)', () => {
    for (const step of action.runs.steps) assert.doesNotMatch(step.run ?? '', /\$\{\{/);
  });

  it('documents every input; path defaults to .prreceipt.json', () => {
    for (const [name, input] of Object.entries(action.inputs)) assert.ok(input.description, name);
    assert.equal(action.inputs.path.default, '.prreceipt.json');
    assert.equal(action.inputs['github-token'].default, '${{ github.token }}');
  });

  /** The Action on PR #7 of acme/shop; `push: true` runs it for an event without a pull request. */
  async function setup(inputs?: Record<string, string>, opts: { push?: boolean } = {}) {
    const workspace = await tempDir('prr-ws-');
    await writeReceipt(workspace, sampleReceipt());
    const gh = await installFakeGh({ pr: { number: 7, head: 'feat/cart', base: 'main' } });
    const result = runAction({
      workspace,
      prNumber: opts.push ? undefined : 7,
      headRef: 'feat/cart',
      token: FAKE_TOKEN,
      inputs,
      binDir: gh.binDir,
      env: { PRR_FAKE_GH_STATE: gh.statePath, PRR_FAKE_GH_TOKEN: FAKE_TOKEN },
      home: await tempDir('prr-runner-home-'),
    });
    return { workspace, gh, result };
  }

  it('hands the github-token input to gh', async () => {
    const ok = await setup();
    assert.equal(ok.result.code, 0, ok.result.stderr);
    const other = await setup({ 'github-token': ['ghs', 'Other0Tk'.repeat(4)].join('_') });
    assert.notEqual(other.result.code, 0, 'gh rejects a token other than the one it expects');
    assert.match(other.result.stderr, /GH_TOKEN/);
  });

  it('fails clearly when the workflow wasn’t triggered by a pull request', async () => {
    const { gh, result } = await setup(undefined, { push: true });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--pr needs a pull request number; in GitHub Actions, run on pull_request events/);
    assert.equal((await gh.read()).state.calls.length, 0);
  });

  it('treats a hostile path input as a file name, not as shell code or an option', async () => {
    const { workspace, result } = await setup({ path: '$(touch pwned).json' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no receipt file at \$\(touch pwned\)\.json/);
    assert.ok(!existsSync(join(workspace, 'pwned')));
    const dash = await setup({ path: '--help' });
    assert.equal(dash.result.code, 1);
    assert.match(dash.result.stderr, /no receipt file at --help/);
  });

  it('names the repository for gh (the CI workspace may have no git remote to infer it from)', async () => {
    const action = loadAction();
    delete action.runs.steps[1].env?.GH_REPO;
    const workspace = await tempDir('prr-ws-');
    await writeReceipt(workspace, sampleReceipt());
    const gh = await installFakeGh({ pr: { number: 7, head: 'feat/cart', base: 'main' } });
    const result = runAction(
      { workspace, prNumber: 7, token: FAKE_TOKEN, binDir: gh.binDir, env: { PRR_FAKE_GH_STATE: gh.statePath, PRR_FAKE_GH_TOKEN: FAKE_TOKEN }, home: await tempDir('prr-runner-home-') },
      action,
    );
    assert.notEqual(result.code, 0, 'without GH_REPO, gh has no repository');
    assert.match(result.stderr, /GH_REPO|repository/i);
  });

  it('reads the receipt from the path input (e.g. a file an earlier step downloaded)', async () => {
    const workspace = await tempDir('prr-ws-');
    await mkdir(join(workspace, 'artifacts'));
    await writeReceipt(join(workspace, 'artifacts'), sampleReceipt(), 'receipt.json');
    const gh = await installFakeGh({ pr: { number: 7, head: 'feat/cart', base: 'main' } });
    const result = runAction({
      workspace,
      prNumber: 7,
      token: FAKE_TOKEN,
      inputs: { path: 'artifacts/receipt.json' },
      binDir: gh.binDir,
      env: { PRR_FAKE_GH_STATE: gh.statePath, PRR_FAKE_GH_TOKEN: FAKE_TOKEN },
      home: await tempDir('prr-runner-home-'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await gh.read()).creates().length, 1);
  });
});

describe('examples/prreceipt-workflow.yml', () => {
  it('runs on pull requests that change .prreceipt.json, with write access to PRs only, one run per PR at a time', async () => {
    const workflow = parse(await readFile(join(ROOT, 'examples', 'prreceipt-workflow.yml'), 'utf8')) as Record<string, any>;
    assert.deepEqual(workflow.on.pull_request.paths, ['.prreceipt.json']);
    assert.deepEqual(workflow.permissions, { contents: 'read', 'pull-requests': 'write' });
    assert.match(workflow.concurrency.group, /\$\{\{ github\.event\.pull_request\.number \}\}/);
    const job = Object.values(workflow.jobs as Record<string, { if?: string; steps: Array<{ uses?: string }> }>)[0];
    assert.equal(job.if, 'github.event.pull_request.head.repo.full_name == github.repository', 'fork PRs (read-only token) are skipped, not failed');
    const steps = job.steps;
    assert.match(steps[0].uses ?? '', /^actions\/checkout@v5$/);
    assert.match(steps[1].uses ?? '', /^smithdavedesign\/pr-receipt@/);
  });
});
