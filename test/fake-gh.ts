// An in-memory stand-in for the three gh calls prreceipt makes. It is strict about argument shapes, so a
// wrong gh invocation fails the test instead of quietly "working".
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhError, type Gh } from '../src/github.ts';
import { tempDir } from './helpers.ts';

export interface FakeComment {
  databaseId: number;
  author: string;
  body: string;
}

export interface FakeCall {
  args: string[];
  input?: string;
}

export interface FakeMergedPr {
  number: number;
  title: string;
  head: string;
  /** Default: main. */
  base?: string;
  /** ISO time of the merge. */
  mergedAt: string;
  additions?: number;
  deletions?: number;
}

export interface FakeState {
  viewer: string;
  host: string;
  owner: string;
  repo: string;
  /** null: no pull request exists for any branch. */
  pr: { number: number; head: string; base: string } | null;
  comments: FakeComment[];
  /** What `gh pr list --state merged` knows about. */
  merged: FakeMergedPr[];
  calls: FakeCall[];
  nextId: number;
}

const REQUIRED_FIELDS = ['number', 'url', 'baseRefName', 'headRefName', 'comments'];
const REQUIRED_LIST_FIELDS = ['number', 'title', 'url', 'headRefName', 'baseRefName', 'mergedAt'];

export class FakeGitHub {
  state: FakeState;

  constructor(state: Partial<FakeState> = {}) {
    this.state = {
      viewer: 'me',
      host: 'github.com',
      owner: 'acme',
      repo: 'shop',
      pr: { number: 7, head: 'feat/c', base: 'main' },
      comments: [],
      merged: [],
      calls: [],
      nextId: 1001,
      ...structuredClone(state),
    };
  }

  get prUrl(): string {
    return `https://${this.state.host}/${this.state.owner}/${this.state.repo}/pull/${this.state.pr?.number ?? 0}`;
  }

  readonly gh: Gh = async (args, input) => this.handle(args, input);

  handle(args: string[], input?: string): string {
    this.state.calls.push(input === undefined ? { args: [...args] } : { args: [...args], input });
    const [a, b] = args;
    if (a === 'pr' && b === 'view') return this.view(args.slice(2));
    if (a === 'pr' && b === 'list') return this.list(args.slice(2));
    if (a === 'pr' && b === 'comment') return this.create(args.slice(2), input);
    if (a === 'api') return this.update(args.slice(1), input);
    throw new GhError(`fake gh: unexpected command: gh ${args.join(' ')}`);
  }

  /** Calls that created a comment / updated one / read the PR. */
  creates(): FakeCall[] {
    return this.state.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'comment');
  }

  updates(): FakeCall[] {
    return this.state.calls.filter((c) => c.args[0] === 'api');
  }

  views(): FakeCall[] {
    return this.state.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'view');
  }

  lists(): FakeCall[] {
    return this.state.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'list');
  }

  /** Comments written by the logged-in user. */
  ours(): FakeComment[] {
    return this.state.comments.filter((c) => c.author === this.state.viewer);
  }

  /** Every comment body prreceipt sent, in order (created and updated). */
  sentBodies(): string[] {
    return this.state.calls.flatMap((c) => {
      if (c.args[0] === 'pr' && c.args[1] === 'comment') return [c.input ?? ''];
      if (c.args[0] === 'api') return [(JSON.parse(c.input ?? '{}') as { body: string }).body];
      return [];
    });
  }

  private view(rest: string[]): string {
    const at = rest.indexOf('--json');
    if (at === -1 || at + 1 >= rest.length) throw new GhError('fake gh: pr view without --json');
    const fields = rest[at + 1].split(',');
    for (const f of REQUIRED_FIELDS) if (!fields.includes(f)) throw new GhError(`fake gh: pr view --json is missing ${f}`);
    const selectors = rest.filter((_, i) => i !== at && i !== at + 1);
    if (selectors.length > 1) throw new GhError(`fake gh: pr view got extra arguments ${selectors.join(' ')}`);
    const pr = this.state.pr;
    const selector = selectors[0];
    // Like gh: a selector made of digits is a PR number, anything else a head branch.
    const matches = selector === undefined || (/^\d+$/.test(selector) ? Number(selector) === pr?.number : selector === pr?.head);
    if (!pr || !matches) {
      throw new GhError(`no pull requests found for branch "${selectors[0] ?? 'current'}"`);
    }
    const all: Record<string, unknown> = {
      number: pr.number,
      url: this.prUrl,
      baseRefName: pr.base,
      headRefName: pr.head,
      comments: this.state.comments.map((c) => ({
        id: `IC_kwFake${c.databaseId}`,
        author: { login: c.author },
        authorAssociation: 'MEMBER',
        body: c.body,
        createdAt: '2026-10-05T10:00:00Z',
        url: `${this.prUrl}#issuecomment-${c.databaseId}`,
        viewerDidAuthor: c.author === this.state.viewer,
      })),
    };
    return JSON.stringify(Object.fromEntries(fields.map((f) => [f, all[f]])), null, 2) + '\n';
  }

  /** gh pr list --state merged --search "merged:>=YYYY-MM-DD" --limit N --json fields. Like GitHub search, the date covers the whole UTC day. */
  private list(rest: string[]): string {
    const [state, merged, search, query, limitFlag, limit, json, fieldList, ...extra] = rest;
    const day = /^merged:>=(\d{4}-\d{2}-\d{2})$/.exec(query ?? '')?.[1];
    if (state !== '--state' || merged !== 'merged' || search !== '--search' || !day || limitFlag !== '--limit' || !/^\d+$/.test(limit ?? '') || json !== '--json' || extra.length > 0) {
      throw new GhError(`fake gh: unexpected call: gh pr list ${rest.join(' ')}`);
    }
    const fields = (fieldList ?? '').split(',');
    for (const f of REQUIRED_LIST_FIELDS) if (!fields.includes(f)) throw new GhError(`fake gh: pr list --json is missing ${f}`);
    const base = `https://${this.state.host}/${this.state.owner}/${this.state.repo}/pull`;
    const rows = this.state.merged
      .filter((pr) => pr.mergedAt.slice(0, 10) >= day)
      .sort((x, y) => y.mergedAt.localeCompare(x.mergedAt))
      .slice(0, Number(limit))
      .map((pr) => {
        const all: Record<string, unknown> = {
          number: pr.number,
          title: pr.title,
          url: `${base}/${pr.number}`,
          headRefName: pr.head,
          baseRefName: pr.base ?? 'main',
          mergedAt: pr.mergedAt,
          additions: pr.additions ?? 0,
          deletions: pr.deletions ?? 0,
          state: 'MERGED',
        };
        return Object.fromEntries(fields.map((f) => [f, all[f]]));
      });
    return JSON.stringify(rows, null, 2) + '\n';
  }

  private create(rest: string[], input?: string): string {
    const expected = [this.prUrl, '--body-file', '-'];
    if (JSON.stringify(rest) !== JSON.stringify(expected)) {
      throw new GhError(`fake gh: expected "pr comment ${expected.join(' ')}", got "pr comment ${rest.join(' ')}"`);
    }
    if (!input) throw new GhError('fake gh: empty comment body on stdin');
    const databaseId = this.state.nextId++;
    this.state.comments.push({ databaseId, author: this.state.viewer, body: input });
    return `${this.prUrl}#issuecomment-${databaseId}\n`;
  }

  private update(rest: string[], input?: string): string {
    const path = rest[4] ?? '';
    const shape = ['--method', 'PATCH', '--hostname', this.state.host, path, '--input', '-'];
    const prefix = `repos/${this.state.owner}/${this.state.repo}/issues/comments/`;
    if (JSON.stringify(rest) !== JSON.stringify(shape) || !path.startsWith(prefix)) {
      throw new GhError(`fake gh: unexpected api call: gh api ${rest.join(' ')}`);
    }
    const comment = this.state.comments.find((c) => String(c.databaseId) === path.slice(prefix.length));
    if (!comment) throw new GhError('gh: Not Found (HTTP 404)');
    if (comment.author !== this.state.viewer) throw new GhError('gh: Forbidden (HTTP 403)');
    const body = (JSON.parse(input ?? 'null') as { body?: unknown } | null)?.body;
    if (typeof body !== 'string' || body === '') throw new GhError('fake gh: PATCH needs {"body": "..."} on stdin');
    comment.body = body;
    return JSON.stringify({ id: comment.databaseId, html_url: `${this.prUrl}#issuecomment-${comment.databaseId}`, body }) + '\n';
  }
}

const FAKE_GH_BIN = join(dirname(fileURLToPath(import.meta.url)), 'fake-gh-bin.ts');

/**
 * Installs an executable named `gh` (a shell wrapper around fake-gh-bin.ts) in a fresh directory.
 * Put `binDir` first on PATH; the fake keeps its state in `statePath`.
 */
export async function installFakeGh(state: Partial<FakeState> = {}): Promise<{ binDir: string; statePath: string; read: () => Promise<FakeGitHub> }> {
  const binDir = await tempDir('prr-ghbin-');
  const statePath = join(await tempDir('prr-ghstate-'), 'state.json');
  await writeFile(statePath, JSON.stringify(new FakeGitHub(state).state));
  const wrapper = join(binDir, 'gh');
  await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath}' --disable-warning=ExperimentalWarning '${FAKE_GH_BIN}' "$@"\n`);
  await chmod(wrapper, 0o755);
  return {
    binDir,
    statePath,
    read: async () => new FakeGitHub(JSON.parse(await readFile(statePath, 'utf8')) as FakeState),
  };
}
