import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GhError,
  MARKER,
  commentApiTarget,
  createGh,
  findPullRequest,
  findReceiptComment,
  upsertReceipt,
  withMarker,
  type Gh,
  type PullRequest,
} from '../src/github.ts';
import { FakeGitHub, installFakeGh } from './fake-gh.ts';
import { tempDir } from './helpers.ts';

const pr = (comments: PullRequest['comments']): PullRequest => ({
  number: 7,
  url: 'https://github.com/acme/shop/pull/7',
  baseRefName: 'main',
  headRefName: 'feat/c',
  comments,
});

const comment = (id: number, body: string, viewerDidAuthor?: boolean) => ({
  id: `IC_${id}`,
  url: `https://github.com/acme/shop/pull/7#issuecomment-${id}`,
  body,
  ...(viewerDidAuthor === undefined ? {} : { viewerDidAuthor }),
});

describe('findPullRequest', () => {
  it('asks gh for the current branch’s PR when no branch is given, and for <branch> otherwise', async () => {
    const fake = new FakeGitHub({ pr: { number: 7, head: 'feat/c', base: 'develop' } });
    const current = await findPullRequest(fake.gh);
    assert.deepEqual(fake.views()[0].args, ['pr', 'view', '--json', 'number,url,baseRefName,headRefName,comments']);
    assert.equal(current.number, 7);
    assert.equal(current.baseRefName, 'develop');
    assert.equal(current.url, 'https://github.com/acme/shop/pull/7');
    await findPullRequest(fake.gh, 'feat/c');
    assert.deepEqual(fake.views()[1].args, ['pr', 'view', 'feat/c', '--json', 'number,url,baseRefName,headRefName,comments']);
  });

  it('returns comments with their URL, body and authorship', async () => {
    const fake = new FakeGitHub({ comments: [{ databaseId: 5, author: 'me', body: 'hi' }, { databaseId: 6, author: 'you', body: 'yo' }] });
    const found = await findPullRequest(fake.gh);
    assert.deepEqual(
      found.comments.map((c) => [c.url, c.body, c.viewerDidAuthor]),
      [
        ['https://github.com/acme/shop/pull/7#issuecomment-5', 'hi', true],
        ['https://github.com/acme/shop/pull/7#issuecomment-6', 'yo', false],
      ],
    );
  });

  it('passes gh’s own error through when there is no PR', async () => {
    const fake = new FakeGitHub({ pr: null });
    await assert.rejects(findPullRequest(fake.gh, 'feat/c'), (e: Error) => e instanceof GhError && /no pull requests found/.test(e.message));
  });

  it('rejects output that is not a pull request', async () => {
    const ok = { number: 7, url: 'https://github.com/acme/shop/pull/7', baseRefName: 'main', headRefName: 'feat/c', comments: [] };
    assert.equal((await findPullRequest(async () => JSON.stringify(ok))).number, 7, 'the baseline shape is accepted');
    for (const out of [
      'not json',
      '[]',
      JSON.stringify({ ...ok, number: '7' }),
      JSON.stringify({ ...ok, comments: [{ id: 1 }] }),
      JSON.stringify({ ...ok, comments: undefined }),
      JSON.stringify({ ...ok, headRefName: undefined }),
      JSON.stringify({ ...ok, url: '--web' }),
    ]) {
      const gh: Gh = async () => out;
      await assert.rejects(findPullRequest(gh), (e: Error) => e instanceof GhError && /unexpected output from gh pr view/.test(e.message), out);
    }
  });

  it('refuses a branch name that gh would read as a flag', async () => {
    const fake = new FakeGitHub();
    await assert.rejects(findPullRequest(fake.gh, '--web'), GhError);
    assert.equal(fake.state.calls.length, 0);
  });
});

describe('findReceiptComment', () => {
  it('finds the oldest marked comment written by the viewer', () => {
    const found = findReceiptComment(
      pr([comment(1, 'LGTM', false), comment(2, `${MARKER}\nsomeone else’s`, false), comment(3, `${MARKER}\nours`, true), comment(4, `${MARKER}\nlater`, true)]),
    );
    assert.equal(found?.url.endsWith('-3'), true);
  });

  it('ignores the viewer’s unmarked comments and returns null when there is none', () => {
    assert.equal(findReceiptComment(pr([comment(1, 'just a note', true)])), null);
    assert.equal(findReceiptComment(pr([])), null);
  });

  it('treats a comment as ours when gh does not report authorship', () => {
    assert.equal(findReceiptComment(pr([comment(9, `${MARKER}\nold gh`)]))?.id, 'IC_9');
  });
});

describe('commentApiTarget', () => {
  it('maps a github.com comment URL to its REST path', () => {
    assert.deepEqual(commentApiTarget('https://github.com/acme/shop/pull/7#issuecomment-123456789'), {
      hostname: 'github.com',
      path: 'repos/acme/shop/issues/comments/123456789',
    });
  });

  it('keeps the host for GitHub Enterprise Server', () => {
    assert.deepEqual(commentApiTarget('https://ghe.corp.example/team/app/pull/2#issuecomment-5'), {
      hostname: 'ghe.corp.example',
      path: 'repos/team/app/issues/comments/5',
    });
  });

  it('rejects URLs it cannot map', () => {
    for (const url of ['not a url', 'https://github.com/acme/shop/pull/7', 'https://github.com/#issuecomment-5']) {
      assert.throws(() => commentApiTarget(url), GhError, url);
    }
  });
});

describe('upsertReceipt', () => {
  it('creates a marked comment when there is none, then updates it in place', async () => {
    const fake = new FakeGitHub();
    const first = await upsertReceipt(fake.gh, await findPullRequest(fake.gh), '## receipt v1\n');
    assert.deepEqual(first, { action: 'created', url: 'https://github.com/acme/shop/pull/7#issuecomment-1001' });
    assert.equal(fake.ours()[0].body, withMarker('## receipt v1\n'));
    const second = await upsertReceipt(fake.gh, await findPullRequest(fake.gh), '## receipt v2\n');
    assert.deepEqual(second, { action: 'updated', url: 'https://github.com/acme/shop/pull/7#issuecomment-1001' });
    assert.equal(fake.ours().length, 1);
    assert.equal(fake.ours()[0].body, withMarker('## receipt v2\n'));
  });

  it('withMarker puts the hidden tag on its own first line', () => {
    assert.equal(withMarker('## hi\n'), `${MARKER}\n## hi\n`);
    assert.match(MARKER, /^<!-- .* -->$/);
  });
});

describe('createGh (the real process runner)', () => {
  it('explains how to install gh when the binary is missing', async () => {
    const gh = createGh(await tempDir(), join(await tempDir(), 'no-such-gh'));
    await assert.rejects(gh(['pr', 'view']), (e: Error) => e instanceof GhError && /cli\.github\.com/.test(e.message) && /gh auth login/.test(e.message));
  });

  it('includes gh’s stderr when it exits non-zero', async () => {
    const dir = await tempDir();
    const failing = join(dir, 'gh');
    await writeFile(failing, '#!/bin/sh\necho "To get started with GitHub CLI, please run:  gh auth login" >&2\nexit 4\n');
    await chmod(failing, 0o755);
    await assert.rejects(createGh(dir, failing)(['pr', 'view']), (e: Error) => e instanceof GhError && /gh pr view failed: .*gh auth login/.test(e.message));
  });

  it('sends input on stdin and returns stdout', async () => {
    const fakeGh = await installFakeGh();
    // The fake reads its state path from the environment it inherits.
    const previous = process.env.PRR_FAKE_GH_STATE;
    process.env.PRR_FAKE_GH_STATE = fakeGh.statePath;
    try {
      const gh = createGh(await tempDir(), join(fakeGh.binDir, 'gh'));
      const out = await gh(['pr', 'comment', 'https://github.com/acme/shop/pull/7', '--body-file', '-'], 'hello from stdin');
      assert.equal(out.trim(), 'https://github.com/acme/shop/pull/7#issuecomment-1001');
    } finally {
      if (previous === undefined) delete process.env.PRR_FAKE_GH_STATE;
      else process.env.PRR_FAKE_GH_STATE = previous;
    }
    assert.equal((await fakeGh.read()).ours()[0].body, 'hello from stdin');
  });
});
