// One block per M2 exit criterion in ROADMAP.md (EC6–EC9, numbered after M1's five).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { branchContext } from '../src/git.ts';
import { MARKER } from '../src/github.ts';
import { parseLogs } from '../src/parse.ts';
import { loadPrices } from '../src/pricing.ts';
import { buildReceipt } from '../src/receipt.ts';
import { FakeGitHub, installFakeGh } from './fake-gh.ts';
import { BRANCHES, THREE_MESSAGES, assistant, commit, git, gitRepo, lines, near, run, tempDir, user, writeLogs } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_DATE = '2026-10-01T00:00:00Z';

/** A repo with one commit on main, then `branch` checked out with the given commits. */
async function repoWithBranch(branch: string, commits: Array<{ files: Record<string, string | null>; date: string }>, mainFiles: Record<string, string> = { 'README.md': 'hello\n' }): Promise<string> {
  const repo = await gitRepo('main');
  await commit(repo, mainFiles, MAIN_DATE, 'base');
  git(repo, ['checkout', '-q', '-b', branch]);
  for (const c of commits) await commit(repo, c.files, c.date);
  return repo;
}

describe('EC6: running `comment` twice yields exactly one comment', () => {
  it('creates on the first run, then updates that same comment instead of creating another', async () => {
    const repo = await repoWithBranch('feat/c', [{ files: { 'c.txt': lines(5) }, date: '2026-10-02T10:00:00Z' }]);
    const logs = await writeLogs({
      'p/s1.jsonl': [assistant({ session: 's1', branch: 'feat/c', cwd: repo, input: 1000, output: 500, ts: '2026-10-02T09:50:00Z' })],
    });
    const quoted = `quoting the bot:\n${MARKER}\nold numbers`;
    const fake = new FakeGitHub({
      pr: { number: 7, head: 'feat/c', base: 'main' },
      comments: [
        { databaseId: 1, author: 'reviewer', body: 'LGTM' },
        { databaseId: 2, author: 'reviewer', body: quoted },
      ],
    });

    const first = await run(['comment', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /posted/i);
    assert.equal(fake.creates().length, 1);
    assert.equal(fake.updates().length, 0);

    // More spend lands on the branch; the receipt is refreshed.
    await writeFile(
      join(logs, 'p', 's2.jsonl'),
      JSON.stringify(assistant({ session: 's2', branch: 'feat/c', cwd: repo, input: 2000, output: 1000, ts: '2026-10-02T09:55:00Z' })) + '\n',
    );
    const second = await run(['comment', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /updated/i);
    assert.equal(fake.creates().length, 1, 'the second run must not create a comment');
    assert.equal(fake.updates().length, 1, 'the second run is an update');

    const ours = fake.ours();
    assert.equal(ours.length, 1, 'exactly one receipt comment');
    assert.ok(ours[0].body.startsWith(MARKER), 'the comment carries the hidden marker');
    assert.match(ours[0].body, /\*\*Sessions:\*\* 2/, 'it holds the second run’s receipt');
    assert.match(ours[0].body, /\$0\.0315/);
    assert.equal(fake.state.comments.length, 3, 'nobody else’s comments were added or removed');
    assert.equal(fake.state.comments.find((c) => c.databaseId === 2)?.body, quoted, 'a reviewer’s comment containing the marker is left alone');
  });

  it('stays at one comment over three runs as a real process with a `gh` executable on PATH', async () => {
    const repo = await repoWithBranch('feat/c', [{ files: { 'c.txt': lines(5) }, date: '2026-10-02T10:00:00Z' }]);
    const logs = await writeLogs({
      'p/s1.jsonl': [assistant({ session: 's1', branch: 'feat/c', cwd: repo, input: 1000, output: 500, ts: '2026-10-02T09:50:00Z' })],
    });
    const fakeGh = await installFakeGh({ pr: { number: 7, head: 'feat/c', base: 'main' } });
    const home = await tempDir('prr-home-');
    const env = { PATH: `${fakeGh.binDir}:${process.env.PATH ?? ''}`, HOME: home, PRR_FAKE_GH_STATE: fakeGh.statePath };
    const outputs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const result = spawnSync(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', join(ROOT, 'src', 'bin.ts'), 'comment', '--logs', logs],
        { cwd: repo, env, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      outputs.push(result.stdout);
    }
    assert.match(outputs[0], /posted/i);
    assert.match(outputs[1], /updated/i);
    assert.match(outputs[2], /updated/i);
    const fake = await fakeGh.read();
    assert.equal(fake.ours().length, 1);
    assert.equal(fake.creates().length, 1);
    assert.equal(fake.updates().length, 2);
    assert.match(fake.ours()[0].body, /\$0\.0105/);
  });
});

describe('EC7: a no-branch session inside the branch’s commit window is attributed; one outside is not', () => {
  // main: 10-01 00:00. feat/w: commits at 10-02 10:00 and 10-02 12:00 → window 10:00–12:00.
  async function scenario() {
    const repo = await repoWithBranch('feat/w', [
      { files: { 'w.txt': lines(3) }, date: '2026-10-02T10:00:00Z' },
      { files: { 'w.txt': lines(6) }, date: '2026-10-02T12:00:00Z' },
    ]);
    const logs = await writeLogs({
      // Tagged with the branch: $0.0105
      'p/s-branch.jsonl': [assistant({ session: 's-branch', branch: 'feat/w', cwd: repo, input: 1000, output: 500, ts: '2026-10-02T10:05:00Z' })],
      // No branch, in this repo, inside the window: $0.006 → attributed
      'p/s-in.jsonl': [
        user({ session: 's-in', branch: null, cwd: repo, ts: '2026-10-02T10:30:00Z' }),
        assistant({ session: 's-in', branch: null, cwd: repo, input: 2000, ts: '2026-10-02T11:00:00Z' }),
      ],
      // No branch, in this repo, but after / before the window: $0.012 and $0.024 → not attributed
      'p/s-after.jsonl': [assistant({ session: 's-after', branch: null, cwd: repo, input: 4000, ts: '2026-10-03T09:00:00Z' })],
      'p/s-before.jsonl': [assistant({ session: 's-before', branch: null, cwd: repo, input: 8000, ts: '2026-10-01T12:00:00Z' })],
      // No branch, inside the window, but another directory: $0.048 → not attributed
      'p/s-elsewhere.jsonl': [assistant({ session: 's-elsewhere', branch: null, cwd: '/somewhere/else', input: 16000, ts: '2026-10-02T11:00:00Z' })],
    });
    return { repo, logs };
  }

  it('buildReceipt adds the in-window session and leaves the others unattributed', async () => {
    const { repo, logs } = await scenario();
    const { entries } = await parseLogs([logs]);
    const g = branchContext(repo, 'main', 'feat/w');
    assert.ok(g.window, g.problem ?? 'window expected');
    const r = buildReceipt(entries, 'feat/w', await loadPrices(), { window: g.window, roots: [repo], diff: g.diff });
    assert.equal(r.sessions, 2, 's-branch + s-in');
    assert.ok(near(r.totalCost, 0.0165, 1e-9), `total was ${r.totalCost}`);
    assert.equal(r.fromWindow.sessions, 1);
    assert.ok(near(r.fromWindow.cost, 0.006, 1e-9));
    assert.equal(r.unattributed.sessions, 3, 's-after, s-before and s-elsewhere');
    assert.ok(near(r.unattributed.cost, 0.084, 1e-9));
  });

  it('`show` prints the attributed session and says it came from the commit window', async () => {
    const { repo, logs } = await scenario();
    const { code, out } = await run(['show', 'feat/w', '--logs', logs], { cwd: repo });
    assert.equal(code, 0);
    assert.match(out, /\*\*Total:\*\* \$0\.0165/);
    assert.match(out, /\*\*Sessions:\*\* 2/);
    const windowLine = out.split('\n').find((l) => /commit window/.test(l));
    assert.ok(windowLine, 'receipt explains the window attribution');
    assert.match(windowLine, /1 session\b/);
    assert.match(windowLine, /\$0\.0060/);
    assert.match(windowLine, /2026-10-02 10:00 → 2026-10-02 12:00 UTC/);
    const unattributed = out.split('\n').find((l) => /^_Unattributed/.test(l));
    assert.ok(unattributed);
    assert.match(unattributed, /3 sessions/);
    assert.match(unattributed, /\$0\.0840/);
  });

  it('`comment` posts the same attribution', async () => {
    const { repo, logs } = await scenario();
    const fake = new FakeGitHub({ pr: { number: 9, head: 'feat/w', base: 'main' } });
    const { code, err } = await run(['comment', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(code, 0, err);
    const [body] = fake.sentBodies();
    assert.match(body, /\*\*Total:\*\* \$0\.0165/);
    assert.match(body, /\*\*Sessions:\*\* 2/);
    assert.match(body, /commit window/);
  });

  it('without a base there is no window, so nothing is attributed by time', async () => {
    const { repo, logs } = await scenario();
    git(repo, ['branch', '-q', '-m', 'main', 'trunk']); // no main/master/origin left to compare with
    const { out } = await run(['show', 'feat/w', '--logs', logs], { cwd: repo });
    assert.match(out, /\*\*Sessions:\*\* 1/);
    assert.doesNotMatch(out, /commit window/);
    const fixed = await run(['show', 'feat/w', '--logs', logs, '--base', 'trunk'], { cwd: repo });
    assert.match(fixed.out, /\*\*Sessions:\*\* 2/);
  });
});

describe('EC8: 40 changed lines and a $0.80 total → $0.02 per changed line', () => {
  // main has a.txt (20 lines); feat/lines deletes 10 of them and adds b.txt (30 lines): +30 −10 = 40.
  async function scenario() {
    const repo = await repoWithBranch(
      'feat/lines',
      [{ files: { 'a.txt': lines(20).split('\n').slice(10).join('\n'), 'b.txt': lines(30, 'new') }, date: '2026-10-02T10:00:00Z' }],
      { 'a.txt': lines(20) },
    );
    // Haiku 4.5 at $1/$5 per M: 300,000 × $1 + 100,000 × $5 = $0.80
    const logs = await writeLogs({
      'p/s.jsonl': [
        assistant({ session: 's', branch: 'feat/lines', cwd: repo, model: 'claude-haiku-4-5-20251001', input: 300_000, output: 100_000, ts: '2026-10-02T09:00:00Z' }),
      ],
    });
    return { repo, logs };
  }

  it('git counts 30 insertions and 10 deletions against main', async () => {
    const { repo } = await scenario();
    const g = branchContext(repo, 'main', 'feat/lines');
    assert.deepEqual(g.diff, { base: 'main', files: 2, insertions: 30, deletions: 10 });
  });

  it('`show` reports $0.02 per changed line', async () => {
    const { repo, logs } = await scenario();
    const { code, out } = await run(['show', 'feat/lines', '--logs', logs], { cwd: repo });
    assert.equal(code, 0);
    assert.match(out, /\*\*Total:\*\* \$0\.8000/);
    assert.match(out, /\*\*Lines changed:\*\* 40 \(\+30 \/ -10 vs `main`\)/);
    assert.match(out, /\$0\.02 per changed line/);
  });

  it('the posted comment reports $0.02 per changed line against the PR’s base', async () => {
    const { repo, logs } = await scenario();
    const fake = new FakeGitHub({ pr: { number: 4, head: 'feat/lines', base: 'main' } });
    const { code, err } = await run(['comment', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(code, 0, err);
    assert.match(fake.sentBodies()[0], /\$0\.02 per changed line/);
  });

  it('computes it in the receipt model as well', async () => {
    const { repo, logs } = await scenario();
    const g = branchContext(repo, 'main', 'feat/lines');
    const r = buildReceipt((await parseLogs([logs])).entries, 'feat/lines', await loadPrices(), { diff: g.diff });
    assert.ok(near(r.totalCost, 0.8, 1e-9));
    assert.ok(r.costPerLine !== null && near(r.costPerLine, 0.02, 1e-12));
  });
});

/** Every text value under message.content and every summary in the .jsonl files under `dir`. */
async function contentStrings(dir: string): Promise<string[]> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') found.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const name of await readdir(dir, { recursive: true })) {
    if (!name.endsWith('.jsonl')) continue;
    for (const line of (await readFile(join(dir, name), 'utf8')).split('\n')) {
      if (line.trim() === '') continue;
      const obj = JSON.parse(line) as { summary?: unknown; message?: { content?: unknown } };
      walk(obj.summary);
      walk(obj.message?.content);
    }
  }
  // Drop tiny tokens like "ok" or "sig" that could appear in any text by coincidence.
  return [...found].filter((s) => s.length >= 5);
}

describe('EC9: the comment body contains no prompt text', () => {
  for (const [fixture, branch, root] of [
    [BRANCHES, 'feat/a', '/home/dev/shop'],
    [THREE_MESSAGES, 'feat/demo', '/home/dev/demo'],
  ] as const) {
    it(`posted bodies for ${branch} contain none of the fixture's prompt, response or summary strings`, async () => {
      const strings = await contentStrings(fixture);
      assert.ok(strings.some((s) => s.includes('PROMPT-MARKER')), 'the fixture really has prompt text');
      const repo = await repoWithBranch('other', []);
      const fake = new FakeGitHub({ pr: { number: 3, head: branch, base: 'main' } });
      for (let i = 0; i < 2; i += 1) {
        const { code, err } = await run(['comment', branch, '--logs', fixture, '--repo', root], { cwd: repo, gh: fake.gh });
        assert.equal(code, 0, err);
      }
      const bodies = fake.sentBodies();
      assert.equal(bodies.length, 2, 'one create and one update');
      for (const body of bodies) {
        assert.match(body, /PR Receipt/);
        assert.equal((body.match(/PROMPT-MARKER|RESPONSE-MARKER/g) ?? []).length, 0);
        const leaked = strings.filter((s) => body.includes(s));
        assert.deepEqual(leaked, [], 'no transcript text in the comment');
        assert.ok(!body.includes(root), 'no local paths in the comment');
      }
    });
  }

  it('holds for sessions picked up by the commit window too', async () => {
    const repo = await repoWithBranch('feat/w', [{ files: { 'w.txt': lines(3) }, date: '2026-10-02T10:00:00Z' }]);
    const secret = assistant({ session: 's-in', branch: null, cwd: repo, input: 2000, ts: '2026-10-02T10:00:00Z' }) as {
      message: { content: unknown };
    };
    secret.message.content = [{ type: 'text', text: 'RESPONSE-MARKER-window the launch plan is in plans/q4.md' }];
    const logs = await writeLogs({
      'p/s-in.jsonl': [user({ session: 's-in', branch: null, cwd: repo, ts: '2026-10-02T09:58:00Z', text: 'PROMPT-MARKER-window refactor billing' }), secret],
      'p/s-b.jsonl': [assistant({ session: 's-b', branch: 'feat/w', cwd: repo, input: 1000, ts: '2026-10-02T09:00:00Z' })],
    });
    const fake = new FakeGitHub({ pr: { number: 5, head: 'feat/w', base: 'main' } });
    const { code, err } = await run(['comment', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(code, 0, err);
    const [body] = fake.sentBodies();
    assert.match(body, /\*\*Sessions:\*\* 2/, 'the window session is included');
    assert.doesNotMatch(body, /PROMPT-MARKER|RESPONSE-MARKER|refactor billing|launch plan|plans\/q4/);
    assert.ok(!body.includes(repo), 'no local paths in the comment');
  });
});
