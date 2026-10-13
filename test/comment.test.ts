import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GhError, MARKER, type Gh } from '../src/github.ts';
import { FakeGitHub } from './fake-gh.ts';
import { assistant, commit, git, gitRepo, lines, run, tempDir, writeLogs } from './helpers.ts';

/** main + feat/c (one commit) checked out, and logs with one $0.0105 session on feat/c in the repo. */
async function setup() {
  const repo = await gitRepo('main');
  await commit(repo, { 'README.md': 'hi\n' }, '2026-10-01T00:00:00Z');
  git(repo, ['checkout', '-q', '-b', 'feat/c']);
  await commit(repo, { 'c.txt': lines(15) }, '2026-10-02T10:00:00Z');
  const logs = await writeLogs({
    'p/s1.jsonl': [assistant({ session: 's1', branch: 'feat/c', cwd: repo, input: 1000, output: 500, ts: '2026-10-02T09:00:00Z' })],
  });
  return { repo, logs, fake: new FakeGitHub({ pr: { number: 7, head: 'feat/c', base: 'main' } }) };
}

describe('comment', () => {
  it('prints the comment URL after posting', async () => {
    const { repo, logs, fake } = await setup();
    const { code, out } = await run(['comment', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(code, 0);
    assert.equal(out, 'posted PR receipt on #7: https://github.com/acme/shop/pull/7#issuecomment-1001\n');
  });

  it('--dry-run prints the exact body and writes nothing', async () => {
    const { repo, logs, fake } = await setup();
    const { code, out } = await run(['comment', '--dry-run', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(code, 0);
    assert.ok(out.startsWith(`${MARKER}\n## 🧾 PR Receipt: \`feat/c\``), out);
    assert.match(out, /\$0\.0105/);
    assert.match(out, /\*\*Lines changed:\*\* 15 \(\+15 \/ -0 vs `main`\) · \$0\.0007 per changed line/);
    assert.equal(fake.creates().length + fake.updates().length, 0);
    assert.equal(fake.views().length, 1, 'it still reads the PR to find its base');
  });

  it('passes an explicit branch to gh and uses it for the receipt', async () => {
    const { repo, logs, fake } = await setup();
    git(repo, ['checkout', '-q', 'main']);
    const { code, err } = await run(['comment', 'feat/c', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(code, 0, err);
    assert.deepEqual(fake.views()[0].args.slice(0, 3), ['pr', 'view', 'feat/c']);
    assert.match(fake.sentBodies()[0], /PR Receipt: `feat\/c`/);
  });

  it('posts nothing when the branch has no sessions', async () => {
    const { repo, fake } = await setup();
    const logs = await writeLogs({ 'p/s.jsonl': [assistant({ session: 's', branch: 'feat/other', cwd: repo, input: 5 })] });
    const { code, out } = await run(['comment', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(code, 0);
    assert.match(out, /no sessions found for branch `feat\/c`.*nothing posted/);
    assert.equal(fake.creates().length + fake.updates().length, 0);
  });

  it('only counts sessions from this repository and its worktrees', async () => {
    const { repo, fake } = await setup();
    const wt = join(await tempDir('prr-wt-'), 'second');
    git(repo, ['worktree', 'add', '-q', '-b', 'scratch', wt]);
    const logs = await writeLogs({
      'p/here.jsonl': [assistant({ session: 'here', branch: 'feat/c', cwd: join(repo, 'packages', 'api'), input: 1000, output: 500 })],
      'p/wt.jsonl': [assistant({ session: 'wt', branch: 'feat/c', cwd: wt, input: 2000 })],
      'p/other-repo.jsonl': [assistant({ session: 'other', branch: 'feat/c', cwd: '/w/another-project', input: 900000 })],
    });
    const { code, err } = await run(['comment', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(code, 0, err);
    const [body] = fake.sentBodies();
    assert.match(body, /\*\*Sessions:\*\* 2/);
    assert.match(body, /\*\*Total:\*\* \$0\.0165/);
  });

  it('--repo replaces the default repository scope', async () => {
    const { repo, fake } = await setup();
    const logs = await writeLogs({
      'p/a.jsonl': [assistant({ session: 'a', branch: 'feat/c', cwd: '/w/mono/web', input: 1000, output: 500 })],
      'p/b.jsonl': [assistant({ session: 'b', branch: 'feat/c', cwd: repo, input: 2000 })],
    });
    await run(['comment', '--logs', logs, '--repo', '/w/mono'], { cwd: repo, gh: fake.gh });
    assert.match(fake.sentBodies()[0], /\*\*Sessions:\*\* 1/);
    assert.match(fake.sentBodies()[0], /\$0\.0105/);
  });

  it('warns but still posts when the PR’s base branch is not available locally', async () => {
    const { repo, logs } = await setup();
    const fake = new FakeGitHub({ pr: { number: 7, head: 'feat/c', base: 'release/2026' } });
    const { code, err } = await run(['comment', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(code, 0);
    assert.match(err, /release\/2026/);
    assert.match(err, /git fetch/);
    assert.equal(fake.ours().length, 1);
    assert.doesNotMatch(fake.ours()[0].body, /Lines changed/);
  });

  it('--base overrides the PR’s base', async () => {
    const { repo, logs } = await setup();
    git(repo, ['branch', 'stable', 'main']);
    const fake = new FakeGitHub({ pr: { number: 7, head: 'feat/c', base: 'release/2026' } });
    const { code, err } = await run(['comment', '--logs', logs, '--base', 'stable'], { cwd: repo, gh: fake.gh });
    assert.equal(code, 0);
    assert.equal(err, '');
    assert.match(fake.ours()[0].body, /vs `stable`/);
  });
});

describe('comment errors', () => {
  it('exits 1 with gh’s message when there is no pull request', async () => {
    const { repo, logs } = await setup();
    const fake = new FakeGitHub({ pr: null });
    const { code, out, err } = await run(['comment', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(code, 1);
    assert.equal(out, '');
    assert.match(err, /no pull requests found/);
    assert.match(err, /gh pr create/);
  });

  it('refuses to post when gh returns a PR for a different branch (a branch named "7" is read as PR #7)', async () => {
    const { repo, fake } = await setup();
    git(repo, ['checkout', '-q', '-b', '7']);
    const logs = await writeLogs({ 'p/s.jsonl': [assistant({ session: 's', branch: '7', cwd: repo, input: 1000 })] });
    const { code, err } = await run(['comment', '7', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(code, 1);
    assert.match(err, /PR #7.*`feat\/c`.*not `7`/);
    assert.equal(fake.creates().length + fake.updates().length, 0);
  });

  it('exits 1 when there is no branch to comment for (detached HEAD)', async () => {
    const { repo, logs, fake } = await setup();
    git(repo, ['checkout', '-q', '--detach']);
    const { code, err } = await run(['comment', '--logs', logs], { cwd: repo, gh: fake.gh });
    assert.equal(code, 1);
    assert.match(err, /branch/);
    assert.equal(fake.state.calls.length, 0);
  });

  it('exits 1 outside a git repository', async () => {
    const { logs, fake } = await setup();
    const { code, err } = await run(['comment', 'feat/c', '--logs', logs], { cwd: await tempDir(), gh: fake.gh });
    assert.equal(code, 1);
    assert.match(err, /git repository/);
    assert.equal(fake.state.calls.length, 0);
  });

  it('exits 1 when gh fails while posting', async () => {
    const { repo, logs } = await setup();
    const fake = new FakeGitHub({ pr: { number: 7, head: 'feat/c', base: 'main' } });
    const gh: Gh = async (args, input) => {
      if (args[0] === 'pr' && args[1] === 'comment') throw new GhError('gh pr comment failed: HTTP 403');
      return fake.gh(args, input);
    };
    const { code, err } = await run(['comment', '--logs', logs], { cwd: repo, gh });
    assert.equal(code, 1);
    assert.match(err, /HTTP 403/);
  });

  it('rejects flags that belong to the other command, and bad --base values', async () => {
    const { repo, logs, fake } = await setup();
    for (const [argv, why] of [
      [['comment', '--all', '--logs', logs], /--all/],
      [['show', '--dry-run', '--logs', logs], /--dry-run/],
      [['comment', '--base=-x', '--logs', logs], /--base/],
      [['show', '--base=--output=/tmp/x', '--logs', logs], /--base/],
      [['comment', 'a', 'b', '--logs', logs], /at most one branch/],
    ] as const) {
      const { code, err } = await run([...argv], { cwd: repo, gh: fake.gh });
      assert.equal(code, 1, argv.join(' '));
      assert.match(err, why, argv.join(' '));
    }
    assert.equal(fake.state.calls.length, 0);
  });

  it('documents comment in --help', async () => {
    const { out } = await run(['--help']);
    assert.match(out, /prreceipt comment \[branch\]/);
    assert.match(out, /--dry-run/);
    assert.match(out, /--base/);
    assert.match(out, /gh/);
  });
});

describe('PRD target: comment finishes in under 5 s for 1,000 sessions', () => {
  it('parses 1,000 sessions (20,000 lines) and posts within budget', async () => {
    const { repo, fake } = await setup();
    const logs = await tempDir('prr-big-');
    const dir = join(logs, 'p');
    await mkdir(dir);
    for (let s = 0; s < 1000; s += 1) {
      const rows: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        const minute = String(i).padStart(2, '0');
        rows.push(
          JSON.stringify(
            assistant({ session: `s${s}`, branch: s % 2 === 0 ? 'feat/c' : `feat/other-${s % 7}`, cwd: repo, input: 100, output: 50, ts: `2026-10-02T09:${minute}:00Z` }),
          ),
        );
      }
      await writeFile(join(dir, `s${s}.jsonl`), rows.join('\n') + '\n');
    }
    const started = performance.now();
    const { code, err } = await run(['comment', '--logs', logs], { cwd: repo, gh: fake.gh });
    const elapsed = performance.now() - started;
    assert.equal(code, 0, err);
    assert.match(fake.sentBodies()[0], /\*\*Sessions:\*\* 500/);
    assert.ok(elapsed < 5000, `took ${Math.round(elapsed)} ms`);
  });
});
