// Everything prreceipt asks git: the current branch, the repo's directories, what to compare a branch with,
// and the branch's commit window and changed lines. git runs without a shell and with a timeout; refs are
// resolved to SHAs first, so only hex SHAs ever reach a range argument.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { CommitWindow, DiffStat } from './receipt.ts';
import { RECEIPT_FILE } from './receipt-file.ts';

const GIT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SECOND_MS = 1_000;

/** stdout of `git <args>` in `cwd`, or null when git is missing, fails or times out. */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
  } catch {
    return null;
  }
}

/** The checked-out branch in `cwd`, or null outside a repo, on a detached HEAD, or without git. */
export function currentBranch(cwd: string): string | null {
  return git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])?.trim() || null;
}

/** Each directory plus its resolved real path, so symlinked and physical spellings both match. */
export function withRealPaths(dirs: string[]): string[] {
  const out = new Set<string>();
  for (const dir of dirs) {
    out.add(dir);
    try {
      out.add(realpathSync(dir));
    } catch {
      // the directory may not exist (e.g. --repo for a project that was moved); keep it as given
    }
  }
  return [...out];
}

/** The top-level directory of the repo (or worktree) containing `cwd`, or null outside a repo. */
export function repoTop(cwd: string): string | null {
  return git(cwd, ['rev-parse', '--show-toplevel'])?.trim() || null;
}

/** The repo's top-level directory and those of its other worktrees; [] outside a repo. */
export function repoRoots(cwd: string): string[] {
  const top = repoTop(cwd);
  if (!top) return [];
  const roots = [top];
  for (const line of (git(cwd, ['worktree', 'list', '--porcelain']) ?? '').split('\n')) {
    if (line.startsWith('worktree ')) roots.push(line.slice('worktree '.length));
  }
  return withRealPaths(roots);
}

/** A ref's full commit SHA, or null. Refs starting with "-" are refused so they can never act as git options. */
export function resolveCommit(cwd: string, ref: string): string | null {
  if (ref === '' || ref.startsWith('-')) return null;
  const sha = git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim();
  return sha && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha) ? sha : null;
}

/** "refs/heads/main" → "main", "refs/remotes/origin/main" → "origin/main"; anything else as given. */
export function shortRef(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes)\//, '');
}

/** What `show` compares a branch with: origin's default branch, else main, else master. Full ref names. */
export function defaultBase(cwd: string): string | null {
  const originHead = git(cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])?.trim();
  const candidates = [originHead, 'refs/heads/main', 'refs/heads/master'];
  return candidates.find((ref): ref is string => !!ref && resolveCommit(cwd, ref) !== null) ?? null;
}

/** The local ref for a PR's base branch: the fetched origin/<base> if present, else the local branch. */
export function prBase(cwd: string, baseRefName: string): string | null {
  const candidates = [`refs/remotes/origin/${baseRefName}`, `refs/heads/${baseRefName}`];
  return candidates.find((ref) => resolveCommit(cwd, ref) !== null) ?? null;
}

export function parseNumstat(text: string): Omit<DiffStat, 'base'> {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of text.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files += 1;
    if (m[1] !== '-') insertions += Number(m[1]); // "-" marks a binary file
    if (m[2] !== '-') deletions += Number(m[2]);
  }
  return { files, insertions, deletions };
}

export interface GitContext {
  window: CommitWindow | null;
  diff: DiffStat | null;
  /** Why window and diff are missing, for a warning; null when both are present. */
  problem: string | null;
}

/**
 * The branch's own commits (`base..branch`) give the window: earliest to latest of their author and committer
 * times, so a rebase or amend doesn't shrink it. Lines changed come from `git diff --numstat base...branch`
 * (numstat rather than shortstat: shortstat's wording is translated in non-English locales). Both leave out
 * a committed .prreceipt.json, so commits that only touch it (or nothing) don't count.
 */
export function branchContext(cwd: string, base: string, branch: string): GitContext {
  const none = (problem: string): GitContext => ({ window: null, diff: null, problem });
  const label = shortRef(base);
  const baseSha = resolveCommit(cwd, base);
  if (!baseSha) return none(`base \`${label}\` not found`);
  const headSha = resolveCommit(cwd, `refs/heads/${branch}`) ?? resolveCommit(cwd, `refs/remotes/origin/${branch}`);
  if (!headSha) return none(`branch \`${branch}\` not found in this repository`);

  // From the top level, so a `diff.relative` setting can't narrow anything to cwd; the whole tree (`:/`) minus a
  // committed receipt, because exporting it isn't work: it neither stretches the window nor counts as lines.
  const root = repoTop(cwd) ?? cwd;
  const paths = ['--', ':/', `:(top,exclude)${RECEIPT_FILE}`];
  // --full-history: no merge side is pruned for not touching the paths.
  const log = git(root, ['log', '--no-show-signature', '--full-history', '--format=%at %ct', `${baseSha}..${headSha}`, ...paths]);
  if (log === null) return none('git log failed');
  let first = Infinity;
  let last = -Infinity;
  for (const word of log.split(/\s+/)) {
    const seconds = Number(word);
    if (word === '' || !Number.isFinite(seconds)) continue;
    first = Math.min(first, seconds);
    last = Math.max(last, seconds);
  }
  if (first > last) return none(`branch \`${branch}\` has no commits of its own vs \`${label}\``);

  const numstat = git(root, ['diff', '--numstat', '--no-ext-diff', '--no-textconv', '--find-renames', `${baseSha}...${headSha}`, ...paths]);
  return {
    // Commit times have one-second resolution; the window covers the whole last second.
    window: { start: first * SECOND_MS, end: last * SECOND_MS + SECOND_MS - 1 },
    diff: numstat === null ? null : { base: label, ...parseNumstat(numstat) },
    problem: numstat === null ? 'git diff failed' : null,
  };
}
