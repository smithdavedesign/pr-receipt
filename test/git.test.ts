import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { currentBranch as cliCurrentBranch } from '../src/cli.ts';
import { branchContext, currentBranch, defaultBase, parseNumstat, prBase, repoRoots, resolveCommit, shortRef } from '../src/git.ts';
import { commit, git, gitRepo, lines, tempDir } from './helpers.ts';

const at = (iso: string) => Date.parse(iso);

describe('parseNumstat', () => {
  it('sums insertions and deletions over files, counting binary files as 0 lines', () => {
    assert.deepEqual(parseNumstat('30\t10\ta.txt\n0\t5\tsrc/b.ts\n-\t-\timg.png\n'), { files: 3, insertions: 30, deletions: 15 });
  });

  it('handles an empty diff and renamed paths', () => {
    assert.deepEqual(parseNumstat(''), { files: 0, insertions: 0, deletions: 0 });
    assert.deepEqual(parseNumstat('2\t1\tsrc/{old => new}.ts\n'), { files: 1, insertions: 2, deletions: 1 });
  });
});

describe('resolveCommit', () => {
  it('returns a full SHA for an existing ref and null otherwise', async () => {
    const repo = await gitRepo('main');
    await commit(repo, { f: 'x\n' }, '2026-10-01T00:00:00Z');
    assert.match(resolveCommit(repo, 'main') ?? '', /^[0-9a-f]{40}$/);
    assert.equal(resolveCommit(repo, 'refs/heads/nope'), null);
    assert.equal(resolveCommit(await tempDir(), 'main'), null, 'outside a repo');
  });

  it('refuses refs that git could read as options', async () => {
    const repo = await gitRepo('main');
    await commit(repo, { f: 'x\n' }, '2026-10-01T00:00:00Z');
    assert.equal(resolveCommit(repo, '--all'), null);
    assert.equal(resolveCommit(repo, '-h'), null);
    assert.equal(resolveCommit(repo, ''), null);
  });
});

describe('base detection', () => {
  it('defaultBase prefers origin/HEAD, then main, then master', async () => {
    const repo = await gitRepo('master');
    assert.equal(defaultBase(repo), null, 'unborn branch: nothing to compare with');
    await commit(repo, { f: 'x\n' }, '2026-10-01T00:00:00Z');
    assert.equal(defaultBase(repo), 'refs/heads/master');
    git(repo, ['branch', 'main']);
    assert.equal(defaultBase(repo), 'refs/heads/main');
    git(repo, ['update-ref', 'refs/remotes/origin/trunk', 'HEAD']);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
    assert.equal(defaultBase(repo), 'refs/remotes/origin/trunk');
    assert.equal(defaultBase(await tempDir()), null, 'outside a repo');
  });

  it('prBase prefers the fetched origin/<base> over the local branch', async () => {
    const repo = await gitRepo('main');
    await commit(repo, { f: 'x\n' }, '2026-10-01T00:00:00Z');
    assert.equal(prBase(repo, 'main'), 'refs/heads/main');
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    assert.equal(prBase(repo, 'main'), 'refs/remotes/origin/main');
    assert.equal(prBase(repo, 'release'), null);
  });

  it('shortRef strips refs/heads/ and refs/remotes/ for display', () => {
    assert.equal(shortRef('refs/heads/main'), 'main');
    assert.equal(shortRef('refs/remotes/origin/main'), 'origin/main');
    assert.equal(shortRef('v1.2'), 'v1.2');
  });
});

describe('repoRoots', () => {
  it('returns the top-level directory from a subdirectory, plus other worktrees', async () => {
    const repo = await gitRepo('main');
    await commit(repo, { f: 'x\n' }, '2026-10-01T00:00:00Z');
    const sub = join(repo, 'src', 'deep');
    await mkdir(sub, { recursive: true });
    assert.deepEqual(repoRoots(sub), [repo]);
    const wt = join(await tempDir('prr-wt-'), 'feature');
    git(repo, ['worktree', 'add', '-q', '-b', 'feat/wt', wt]);
    assert.deepEqual(repoRoots(repo).sort(), [repo, wt].sort());
    assert.deepEqual(repoRoots(wt).sort(), [repo, wt].sort());
  });

  it('is empty outside a repository', async () => {
    assert.deepEqual(repoRoots(await tempDir()), []);
  });
});

describe('currentBranch', () => {
  it('is the same function the CLI exported in M1', () => {
    assert.equal(cliCurrentBranch, currentBranch);
  });
});

describe('branchContext', () => {
  it('spans the earliest to the latest author/committer time of the branch’s own commits', async () => {
    const repo = await gitRepo('main');
    await commit(repo, { f: 'x\n' }, '2026-09-01T00:00:00Z');
    git(repo, ['checkout', '-q', '-b', 'feat/r']);
    // A rebased commit: authored on 10-02, re-committed on 10-04.
    await commit(repo, { g: lines(4) }, { author: '2026-10-02T08:00:00Z', committer: '2026-10-04T08:00:00Z' });
    await commit(repo, { g: lines(6) }, '2026-10-03T09:30:00Z');
    const g = branchContext(repo, 'main', 'feat/r');
    assert.equal(g.problem, null);
    assert.deepEqual(g.window, { start: at('2026-10-02T08:00:00Z'), end: at('2026-10-04T08:00:00Z') + 999 });
    assert.deepEqual(g.diff, { base: 'main', files: 1, insertions: 6, deletions: 0 });
  });

  it('ignores commits that are already on the base', async () => {
    const repo = await gitRepo('main');
    await commit(repo, { f: 'x\n' }, '2026-09-01T00:00:00Z');
    git(repo, ['checkout', '-q', '-b', 'feat/x']);
    await commit(repo, { g: 'y\n' }, '2026-10-02T08:00:00Z');
    git(repo, ['checkout', '-q', 'main']);
    await commit(repo, { h: lines(50) }, '2026-10-05T08:00:00Z');
    const g = branchContext(repo, 'main', 'feat/x');
    assert.deepEqual(g.window, { start: at('2026-10-02T08:00:00Z'), end: at('2026-10-02T08:00:00Z') + 999 });
    assert.equal(g.diff?.insertions, 1, 'three-dot diff: main’s later commits are not counted');
  });

  it('labels the base the way it was given, shortened for full refs', async () => {
    const repo = await gitRepo('main');
    await commit(repo, { f: 'x\n' }, '2026-09-01T00:00:00Z');
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(repo, ['checkout', '-q', '-b', 'feat/x']);
    await commit(repo, { g: 'y\n' }, '2026-10-02T08:00:00Z');
    assert.equal(branchContext(repo, 'refs/remotes/origin/main', 'feat/x').diff?.base, 'origin/main');
  });

  it('reports why there is no window: missing base, missing branch, no commits of its own', async () => {
    const repo = await gitRepo('main');
    await commit(repo, { f: 'x\n' }, '2026-09-01T00:00:00Z');
    git(repo, ['branch', 'feat/empty']);
    for (const [base, branch, why] of [
      ['nope', 'main', /base `nope` not found/],
      ['main', 'feat/gone', /branch `feat\/gone` not found/],
      ['main', 'feat/empty', /no commits of its own/],
    ] as const) {
      const g = branchContext(repo, base, branch);
      assert.equal(g.window, null);
      assert.equal(g.diff, null);
      assert.match(g.problem ?? '', why);
    }
  });

  it('falls back to origin/<branch> when the local branch was deleted', async () => {
    const repo = await gitRepo('main');
    await commit(repo, { f: 'x\n' }, '2026-09-01T00:00:00Z');
    git(repo, ['checkout', '-q', '-b', 'feat/pushed']);
    await commit(repo, { g: lines(3) }, '2026-10-02T08:00:00Z');
    git(repo, ['update-ref', 'refs/remotes/origin/feat/pushed', 'HEAD']);
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['branch', '-q', '-D', 'feat/pushed']);
    assert.equal(branchContext(repo, 'main', 'feat/pushed').diff?.insertions, 3);
  });
});
