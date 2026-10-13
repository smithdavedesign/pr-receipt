// GitHub I/O through the gh CLI (its own login, host and fork handling): find the branch's pull request, then
// create one receipt comment or update the one already there (our comment is recognised by a hidden marker);
// and, for `report`, list the merged pull requests.
import { execFile } from 'node:child_process';

/** Runs gh with `args`, writing `input` to its stdin; resolves to stdout. Tests pass a fake. */
export type Gh = (args: string[], input?: string) => Promise<string>;

export class GhError extends Error {}

/** Hidden HTML comment on the first line of our comment, so later runs update it instead of adding another. */
export const MARKER = '<!-- prreceipt:receipt -->';

const GH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PR_FIELDS = 'number,url,baseRefName,headRefName,comments';

export interface PrComment {
  /** GraphQL node id. */
  id: string;
  /** https://<host>/<owner>/<repo>/pull/<n>#issuecomment-<id> */
  url: string;
  body: string;
  /** Missing on gh versions that don't report it. */
  viewerDidAuthor?: boolean;
}

export interface PullRequest {
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  /** Oldest first, as gh returns them. */
  comments: PrComment[];
}

/** The real runner: `command` (default gh) in `cwd`, no shell, 30 s timeout unless given. */
export function createGh(cwd: string, command = 'gh', timeoutMs = GH_TIMEOUT_MS): Gh {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const what = `gh ${args.slice(0, 2).join(' ')}`;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new GhError('gh (GitHub CLI) not found. Install it from https://cli.github.com and run `gh auth login`.'));
        } else if (error.killed) {
          reject(new GhError(`${what} timed out after ${timeoutMs / 1000} s`));
        } else {
          reject(new GhError(`${what} failed: ${stderr.trim() || error.message}`));
        }
      });
      child.stdin?.on('error', () => {
        // gh can exit before reading stdin (e.g. not logged in); the exit status reports the real problem
      });
      child.stdin?.end(input ?? '');
    });
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function toComment(raw: unknown): PrComment | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.url !== 'string' || typeof raw.body !== 'string') return null;
  const comment: PrComment = { id: raw.id, url: raw.url, body: raw.body };
  if (typeof raw.viewerDidAuthor === 'boolean') comment.viewerDidAuthor = raw.viewerDidAuthor;
  return comment;
}

/**
 * The pull request for `branch`. Without a branch, gh looks up the checked-out branch itself, which also
 * finds PRs opened from a fork. gh reads a branch made only of digits as a PR number; callers that pass a
 * branch should check `headRefName`.
 */
export async function findPullRequest(gh: Gh, branch?: string): Promise<PullRequest> {
  if (branch?.startsWith('-')) throw new GhError(`invalid branch name "${branch}"`);
  const out = await gh(['pr', 'view', ...(branch === undefined ? [] : [branch]), '--json', PR_FIELDS]);
  const bad = () => new GhError('unexpected output from gh pr view; is gh up to date?');
  let raw: unknown;
  try {
    raw = JSON.parse(out);
  } catch {
    throw bad();
  }
  if (!isObject(raw) || typeof raw.number !== 'number' || typeof raw.baseRefName !== 'string' || typeof raw.headRefName !== 'string') throw bad();
  // The URL is later passed to `gh pr comment` as an argument, so it must look like one.
  if (typeof raw.url !== 'string' || !/^https?:\/\//.test(raw.url)) throw bad();
  const comments = Array.isArray(raw.comments) ? raw.comments.map(toComment) : null;
  if (!comments || comments.some((c) => c === null)) throw bad();
  return {
    number: raw.number,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    comments: comments as PrComment[],
  };
}

export interface MergedPullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  /** ms since the epoch. */
  mergedAt: number;
  /** GitHub's diff size; null when gh didn't report it. */
  additions: number | null;
  deletions: number | null;
}

/** GitHub search returns at most 1,000 results. */
export const MERGED_PR_LIMIT = 1000;
const MERGED_FIELDS = 'number,title,url,headRefName,baseRefName,mergedAt,additions,deletions';
/** A search of up to 1,000 merged PRs is paged 100 at a time, so it gets more time than one PR read. */
export const LIST_TIMEOUT_MS = 120_000;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function toMerged(raw: unknown): MergedPullRequest | null {
  if (!isObject(raw) || !isCount(raw.number) || typeof raw.title !== 'string' || typeof raw.headRefName !== 'string' || typeof raw.baseRefName !== 'string') return null;
  if (typeof raw.url !== 'string' || !/^https?:\/\//.test(raw.url) || typeof raw.mergedAt !== 'string') return null;
  const mergedAt = Date.parse(raw.mergedAt);
  if (!Number.isFinite(mergedAt)) return null;
  const diff = (v: unknown): number | null | undefined => (v === undefined || v === null ? null : isCount(v) ? v : undefined);
  const additions = diff(raw.additions);
  const deletions = diff(raw.deletions);
  if (additions === undefined || deletions === undefined) return null;
  return { number: raw.number, title: raw.title, url: raw.url, headRefName: raw.headRefName, baseRefName: raw.baseRefName, mergedAt, additions, deletions };
}

/**
 * Pull requests of this repository merged on or after the UTC day of `since` (GitHub search is per day; callers
 * filter on the exact time). Read-only. At most MERGED_PR_LIMIT results.
 */
export async function listMergedPullRequests(gh: Gh, since: number): Promise<MergedPullRequest[]> {
  const day = new Date(since).toISOString().slice(0, 10);
  const out = await gh(['pr', 'list', '--state', 'merged', '--search', `merged:>=${day}`, '--limit', String(MERGED_PR_LIMIT), '--json', MERGED_FIELDS]);
  const bad = () => new GhError('unexpected output from gh pr list; is gh up to date?');
  let raw: unknown;
  try {
    raw = JSON.parse(out);
  } catch {
    throw bad();
  }
  if (!Array.isArray(raw)) throw bad();
  const prs = raw.map(toMerged);
  if (prs.some((p) => p === null)) throw bad();
  return prs as MergedPullRequest[];
}

/** Our earlier receipt: the oldest comment with the marker that the logged-in user wrote. */
export function findReceiptComment(pr: PullRequest): PrComment | null {
  return pr.comments.find((c) => c.viewerDidAuthor !== false && c.body.includes(MARKER)) ?? null;
}

/** "https://github.com/o/r/pull/7#issuecomment-123" → gh api --hostname github.com repos/o/r/issues/comments/123 */
export function commentApiTarget(url: string): { hostname: string; path: string } {
  const fail = () => new GhError(`cannot update the receipt comment: unexpected URL ${url}`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw fail();
  }
  const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
  const id = /^#issuecomment-(\d+)$/.exec(parsed.hash)?.[1];
  if (!owner || !repo || !id) throw fail();
  return { hostname: parsed.host, path: `repos/${owner}/${repo}/issues/comments/${id}` };
}

export function withMarker(markdown: string): string {
  return `${MARKER}\n${markdown}`;
}

/** Updates our receipt comment if the PR has one, otherwise creates it. The body always gets the marker. */
export async function upsertReceipt(gh: Gh, pr: PullRequest, markdown: string): Promise<{ action: 'created' | 'updated'; url: string }> {
  const body = withMarker(markdown);
  const existing = findReceiptComment(pr);
  if (existing) {
    const { hostname, path } = commentApiTarget(existing.url);
    await gh(['api', '--method', 'PATCH', '--hostname', hostname, path, '--input', '-'], JSON.stringify({ body }));
    return { action: 'updated', url: existing.url };
  }
  const out = await gh(['pr', 'comment', pr.url, '--body-file', '-'], body);
  return { action: 'created', url: out.trim().split('\n').pop() || pr.url };
}
