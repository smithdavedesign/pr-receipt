// `prreceipt show|comment|export [branch]` and `prreceipt report`: argv, defaults, git and gh. All I/O goes
// through CliContext so tests run in-process.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { branchContext, currentBranch, defaultBase, prBase, repoRoots, repoTop, withRealPaths } from './git.ts';
import {
  GhError,
  LIST_TIMEOUT_MS,
  MERGED_PR_LIMIT,
  createGh,
  findPullRequest,
  listMergedPullRequests,
  upsertReceipt,
  withMarker,
  type Gh,
  type PullRequest,
} from './github.ts';
import { parseLogs, type LogEntry } from './parse.ts';
import { PriceFileError, loadPrices, type PriceTable } from './pricing.ts';
import { RECEIPT_FILE, ReceiptFileError, parseReceiptFile, readReceiptFile, serializeReceipt } from './receipt-file.ts';
import { buildReport, parseSince, renderReport } from './report.ts';
import {
  buildOverview,
  buildReceipt,
  displayBranch,
  filterByRepo,
  formatUsd,
  renderOverview,
  renderReceipt,
  utcMinute,
  type BranchContext,
} from './receipt.ts';

export { currentBranch } from './git.ts';

export interface CliContext {
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Runs gh; defaults to the real binary. */
  gh?: Gh;
  /** The clock for `report --since` and `export`'s timestamp; defaults to Date.now. */
  now?: () => number;
}

const USAGE = `prreceipt: what did this branch cost in AI tokens?

Usage:
  prreceipt show [branch] [options]      Print a markdown receipt
  prreceipt comment [branch] [options]   Post it on the branch's pull request, or update the one posted before
  prreceipt export [branch] [options]    Write it to ${RECEIPT_FILE} at the repository root, for CI to post
  prreceipt report [options]             Cost per merged pull request: total, median and the top 5

show prints a receipt for [branch] (default: the current git branch). Outside a git repo or on
a detached HEAD, it lists every branch found in the logs.
comment and report need the GitHub CLI (gh), logged in, and run inside the repository. They
only count sessions run in that repository or its worktrees. report only reads from GitHub.
export writes the receipt comment would post. Commit the file: the PR Receipt GitHub Action
(action.yml) posts it with \`comment --from\`, so CI needs no logs and the developer needs no gh.

Options:
  --all            show: list every branch found in the logs instead of one receipt
  --dry-run        comment: print the comment instead of posting it (still reads the PR)
  --since <when>   report: PRs merged in the last <n>d or <n>w, or since a date (YYYY-MM-DD,
                   UTC). Default: 30d
  --base <ref>     Compare the branch with <ref> for lines changed and the commit window.
                   Default: the PR's base branch (comment), else origin/HEAD, main or master
  --out <file>     export: where to write the receipt. Default: ${RECEIPT_FILE} at the repo root
  --from <file>    show, comment: use a receipt written by export instead of reading the logs
  --pr <number>    comment: the pull request to post on. Default: the branch's pull request
  --logs <dir>     Claude Code or Codex logs to read (repeatable; replaces the defaults). Default:
                   $CLAUDE_CONFIG_DIR/projects, else ~/.config/claude/projects and ~/.claude/projects,
                   plus $CODEX_HOME/sessions, else ~/.codex/sessions
  --prices <file>  Price override file. Default: $XDG_CONFIG_HOME/prreceipt/prices.json
                   (else ~/.config/prreceipt/prices.json) if it exists
  --repo <dir>     Only count sessions whose working directory is inside <dir>
  -h, --help       Show this help

Sessions with no git branch recorded are added to a branch when they ran in its repository
during its commit window (first to last commit of the branch). report leaves them out: a PR
counts the sessions on its branch up to its merge.
`;

export function resolveLogDirs(flags: string[], env: CliContext['env'], home: string, cwd: string): string[] {
  if (flags.length > 0) return flags.map((dir) => resolve(cwd, dir));
  const configDirs = (env.CLAUDE_CONFIG_DIR ?? '')
    .split(',')
    .map((dir) => dir.trim())
    .filter((dir) => dir !== '');
  if (configDirs.length > 0) return configDirs.map((dir) => join(resolve(cwd, dir), 'projects'));
  return [join(home, '.config', 'claude', 'projects'), join(home, '.claude', 'projects')];
}

/** Codex CLI rollouts: $CODEX_HOME/sessions, else ~/.codex/sessions. */
export function resolveCodexDirs(env: CliContext['env'], home: string, cwd: string): string[] {
  const codexHome = env.CODEX_HOME?.trim();
  return [join(codexHome ? resolve(cwd, codexHome) : join(home, '.codex'), 'sessions')];
}

function defaultPricesPath(env: CliContext['env'], home: string): string | undefined {
  const path = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'prreceipt', 'prices.json');
  return existsSync(path) ? path : undefined;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const DEFAULT_SINCE = '30d';
const PR_NUMBER = /^[1-9]\d{0,9}$/;

type Values = ReturnType<typeof parse>['values'];

/** Window, repo roots and diff for one branch; `problem` says why window and diff are missing. */
function gitContextFor(cwd: string, branch: string, base: string | null, roots: string[]): { context: BranchContext; problem: string | null } {
  if (base === null) return { context: { roots }, problem: 'no base branch found' };
  const g = branchContext(cwd, base, branch);
  return { context: { roots, window: g.window, diff: g.diff }, problem: g.problem };
}

/** Flag combinations that make no sense; the message to print, or null. */
function misuse(command: string, rest: string[], values: Values): string | null {
  if (values.from !== undefined) {
    if (command !== 'show' && command !== 'comment') return '--from only works with show and comment';
    if (values.from === '') return '--from needs a file written by `prreceipt export`';
    if (rest.length > 0 || values.all || values.logs?.length || values.prices !== undefined || values.repo !== undefined || values.base !== undefined) {
      return "--from reads a finished receipt, so it can't be combined with a branch, --all, --base, --logs, --prices or --repo";
    }
  }
  if (values.out !== undefined && command !== 'export') return '--out only works with export';
  if (values.out === '') return '--out needs a file name';
  if (values.pr !== undefined) {
    if (command !== 'comment') return '--pr only works with comment';
    if (!PR_NUMBER.test(values.pr)) return '--pr needs a pull request number; in GitHub Actions, run on pull_request events';
  }
  return null;
}

export async function main(argv: string[], ctx: CliContext): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (e) {
    ctx.stderr(`prreceipt: ${(e as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = args;
  if (values.help) {
    ctx.stdout(USAGE);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (command !== 'show' && command !== 'comment' && command !== 'report' && command !== 'export') {
    ctx.stderr(command === undefined ? USAGE : `prreceipt: unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }
  const wrong = misuse(command, rest, values);
  if (wrong !== null) {
    ctx.stderr(`prreceipt: ${wrong}\n`);
    return 1;
  }
  if (command === 'report' && rest.length > 0) {
    ctx.stderr(`prreceipt: report takes no branch; it lists the pull requests merged since --since\n\n${USAGE}`);
    return 1;
  }
  if (rest.length > 1) {
    ctx.stderr(`prreceipt: ${command} takes at most one branch\n\n${USAGE}`);
    return 1;
  }
  if (command !== 'show' && values.all) {
    ctx.stderr(`prreceipt: --all only works with show\n`);
    return 1;
  }
  if (command !== 'comment' && values['dry-run']) {
    ctx.stderr(`prreceipt: --dry-run only works with comment\n`);
    return 1;
  }
  if (command === 'report' && values.base !== undefined) {
    ctx.stderr(`prreceipt: --base only works with show and comment (and export)\n`);
    return 1;
  }
  if (command !== 'report' && values.since !== undefined) {
    ctx.stderr(`prreceipt: --since only works with report\n`);
    return 1;
  }
  const since = command === 'report' ? parseSince(values.since ?? DEFAULT_SINCE, (ctx.now ?? Date.now)()) : null;
  if (command === 'report' && since === null) {
    ctx.stderr(`prreceipt: --since needs a number of days or weeks (30d, 2w) or a date (2026-09-01)\n`);
    return 1;
  }
  const reportRepo = command === 'report' ? repoRoots(ctx.cwd) : [];
  if (command === 'report' && reportRepo.length === 0) {
    ctx.stderr(`prreceipt: report must run inside the repository whose merged pull requests it lists\n`);
    return 1;
  }
  if (values.all && rest.length > 0) {
    ctx.stderr(`prreceipt: pass a branch or --all, not both\n`);
    return 1;
  }
  if (values.base !== undefined && (values.base === '' || values.base.startsWith('-'))) {
    ctx.stderr(`prreceipt: --base needs a branch or ref name\n`);
    return 1;
  }
  // A finished receipt: no logs, no prices, no git.
  if (values.from !== undefined && (command === 'show' || command === 'comment')) return fromFile(ctx, command, values.from, values);

  // export writes into the repository for one branch; say what's missing before reading any logs.
  let exportTo: { top: string; branch: string } | null = null;
  if (command === 'export') {
    const top = repoTop(ctx.cwd);
    if (top === null) {
      ctx.stderr(`prreceipt: export must run inside the repository whose pull request the receipt is for\n`);
      return 1;
    }
    const branch = rest[0] ?? currentBranch(ctx.cwd);
    if (branch === null) {
      ctx.stderr(`prreceipt: no branch to export: check out the pull request's branch or pass its name\n`);
      return 1;
    }
    exportTo = { top, branch };
  }

  let prices;
  try {
    prices = await loadPrices(values.prices ? resolve(ctx.cwd, values.prices) : defaultPricesPath(ctx.env, ctx.home));
  } catch (e) {
    if (!(e instanceof PriceFileError)) throw e;
    ctx.stderr(`prreceipt: ${e.message}\n`);
    return 1;
  }

  // --logs replaces every default; without it, both agents' default locations are read.
  const dirs = values.logs?.length
    ? resolveLogDirs(values.logs, ctx.env, ctx.home, ctx.cwd)
    : [...resolveLogDirs([], ctx.env, ctx.home, ctx.cwd), ...resolveCodexDirs(ctx.env, ctx.home, ctx.cwd)];
  const logs = await parseLogs(dirs);
  if (logs.skippedLines > 0) ctx.stderr(`prreceipt: skipped ${count(logs.skippedLines, 'unreadable line')}\n`);
  if (logs.unreadableFiles > 0) ctx.stderr(`prreceipt: could not read ${count(logs.unreadableFiles, 'log file')}\n`);

  if (command === 'comment') return comment(ctx, values, rest[0], logs.entries, prices);
  if (exportTo !== null) return exportReceipt(ctx, values, exportTo.branch, exportTo.top, logs.entries, prices);
  if (command === 'report' && since !== null) {
    // The report still lists what was merged; say why none of it has a cost.
    if (!logs.entries.some((e) => e.usage)) ctx.stderr(`prreceipt: no sessions found (scanned ${count(logs.files, 'log file')} in ${dirs.join(', ')})\n`);
    return report(ctx, values, since, reportRepo, logs.entries, prices);
  }

  const entries = values.repo ? filterByRepo(logs.entries, resolve(ctx.cwd, values.repo)) : logs.entries;
  if (!entries.some((e) => e.usage)) {
    ctx.stdout(`no sessions found (scanned ${count(logs.files, 'log file')})\n`);
    if (logs.files === 0) ctx.stderr(`prreceipt: looked in ${dirs.join(', ')}\n`);
    return 0;
  }

  const branch = values.all ? null : (rest[0] ?? currentBranch(ctx.cwd));
  if (branch === null) {
    ctx.stdout(renderOverview(buildOverview(entries, prices)));
    return 0;
  }
  // show stays quiet about missing git data: outside a repo it is M1's receipt.
  const roots = values.repo ? withRealPaths([resolve(ctx.cwd, values.repo)]) : repoRoots(ctx.cwd);
  const { context } = gitContextFor(ctx.cwd, branch, values.base ?? defaultBase(ctx.cwd), roots);
  ctx.stdout(renderReceipt(buildReceipt(entries, branch, prices, context)));
  return 0;
}

/** The PR for `selector` (a branch or a PR number; none: gh's own current-branch lookup), or null after saying why not. */
async function lookUpPullRequest(ctx: CliContext, gh: Gh, selector: string | undefined): Promise<PullRequest | null> {
  try {
    return await findPullRequest(gh, selector);
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    const hint = /no pull requests? found/i.test(e.message) ? '\nOpen one first, e.g. `gh pr create`.' : '';
    ctx.stderr(`prreceipt: ${e.message}${hint}\n`);
    return null;
  }
}

/** Posts the receipt on `pr` (updating ours if it's there), or prints the body with --dry-run. */
async function post(ctx: CliContext, gh: Gh, pr: PullRequest, markdown: string, dryRun: boolean | undefined): Promise<number> {
  if (dryRun) {
    ctx.stdout(withMarker(markdown));
    return 0;
  }
  try {
    const result = await upsertReceipt(gh, pr, markdown);
    ctx.stdout(`${result.action === 'created' ? 'posted' : 'updated'} PR receipt on #${pr.number}: ${result.url}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    ctx.stderr(`prreceipt: ${e.message}\n`);
    return 1;
  }
}

/** `prreceipt comment [branch]`: the show receipt, scoped to this repo, posted once per PR and updated after. */
async function comment(ctx: CliContext, values: Values, explicitBranch: string | undefined, all: LogEntry[], prices: PriceTable): Promise<number> {
  const branch = explicitBranch ?? currentBranch(ctx.cwd);
  if (branch === null) {
    ctx.stderr(`prreceipt: no branch to comment for: check out the pull request's branch or pass its name\n`);
    return 1;
  }
  const repoDirs = repoRoots(ctx.cwd);
  if (repoDirs.length === 0) {
    ctx.stderr(`prreceipt: comment must run inside the pull request's git repository\n`);
    return 1;
  }
  const roots = values.repo ? withRealPaths([resolve(ctx.cwd, values.repo)]) : repoDirs;

  const gh = ctx.gh ?? createGh(ctx.cwd);
  const selector = values.pr ?? explicitBranch;
  const pr = await lookUpPullRequest(ctx, gh, selector);
  if (pr === null) return 1;
  if (selector !== undefined && pr.headRefName !== branch) {
    // e.g. a branch named "123", which gh reads as PR #123: never post a receipt on someone else's PR
    ctx.stderr(`prreceipt: gh returned PR #${pr.number}, whose branch is \`${pr.headRefName}\`, not \`${branch}\`; nothing posted\n`);
    return 1;
  }

  const base = values.base ?? prBase(ctx.cwd, pr.baseRefName);
  const { context, problem } = gitContextFor(ctx.cwd, branch, base, roots);
  const receipt = buildReceipt(filterByRepo(all, roots), branch, prices, context);
  if (receipt.sessions === 0) {
    ctx.stdout(`no sessions found for branch ${displayBranch(branch)} in this repository; nothing posted to #${pr.number}\n`);
    return 0;
  }
  if (base === null) {
    ctx.stderr(`prreceipt: the PR's base branch \`${pr.baseRefName}\` isn't available locally (try \`git fetch\`), so lines changed and the commit window are left out\n`);
  } else if (problem) {
    ctx.stderr(`prreceipt: ${problem}, so lines changed and the commit window are left out\n`);
  }
  return post(ctx, gh, pr, renderReceipt(receipt), values['dry-run']);
}

/**
 * `show --from` / `comment --from`: a receipt written by export. `comment --from` is what the GitHub Action runs:
 * the file comes from the pull request, so it's checked first, and it's only posted on a PR whose branch it is for.
 */
async function fromFile(ctx: CliContext, command: 'show' | 'comment', source: string, values: Values): Promise<number> {
  let file;
  try {
    file = await readReceiptFile(resolve(ctx.cwd, source), source);
  } catch (e) {
    if (!(e instanceof ReceiptFileError)) throw e;
    ctx.stderr(`prreceipt: ${e.message}\n`);
    return 1;
  }
  const { receipt } = file;
  if (command === 'show') {
    ctx.stdout(renderReceipt(receipt));
    return 0;
  }

  ctx.stderr(`prreceipt: ${source}: receipt for ${displayBranch(receipt.branch)}, exported ${utcMinute(file.exportedAt)} UTC\n`);
  const gh = ctx.gh ?? createGh(ctx.cwd);
  const pr = await lookUpPullRequest(ctx, gh, values.pr ?? receipt.branch);
  if (pr === null) return 1;
  if (pr.headRefName !== receipt.branch) {
    const head = displayBranch(pr.headRefName);
    ctx.stderr(
      `prreceipt: ${source} is the receipt for ${displayBranch(receipt.branch)}, but PR #${pr.number}'s branch is ${head}. Run \`prreceipt export\` on ${head} and commit it; nothing posted\n`,
    );
    return 1;
  }
  if (receipt.sessions === 0) {
    ctx.stdout(`${source} has no sessions; nothing posted to #${pr.number}\n`);
    return 0;
  }
  return post(ctx, gh, pr, renderReceipt(receipt), values['dry-run']);
}

/** `prreceipt export [branch]`: the receipt comment would post (this repo's sessions), written for CI to post. */
async function exportReceipt(ctx: CliContext, values: Values, branch: string, top: string, all: LogEntry[], prices: PriceTable): Promise<number> {
  const roots = values.repo ? withRealPaths([resolve(ctx.cwd, values.repo)]) : repoRoots(ctx.cwd);
  const base = values.base ?? defaultBase(ctx.cwd);
  const { context, problem } = gitContextFor(ctx.cwd, branch, base, roots);
  const receipt = buildReceipt(filterByRepo(all, roots), branch, prices, context);
  if (receipt.sessions === 0) {
    ctx.stdout(`no sessions found for branch ${displayBranch(branch)} in this repository; nothing written\n`);
    return 0;
  }
  if (problem) ctx.stderr(`prreceipt: ${problem}, so lines changed and the commit window are left out${base === null ? ' (pass --base <ref>)' : ''}\n`);

  const out = values.out ? resolve(ctx.cwd, values.out) : join(top, RECEIPT_FILE);
  const shown = relative(ctx.cwd, out) || out;
  const text = serializeReceipt(receipt, (ctx.now ?? Date.now)());
  try {
    parseReceiptFile(text, shown); // never write a file the Action would refuse; say so here instead
  } catch (e) {
    if (!(e instanceof ReceiptFileError)) throw e;
    ctx.stderr(`prreceipt: can't export: ${e.message}\n`);
    return 1;
  }
  // Write a temp file and rename it over the target: a symlink at the target (an untrusted clone could
  // ship one) is replaced, not written through, and a crash never leaves half a receipt.
  const temp = join(dirname(out), `.prreceipt-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(temp, text, { flag: 'wx' });
    await rename(temp, out);
  } catch (e) {
    await rm(temp, { force: true });
    ctx.stderr(`prreceipt: cannot write ${shown}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}\n`);
    return 1;
  }
  ctx.stdout(renderReceipt(receipt));
  ctx.stderr(
    `prreceipt: wrote ${shown} (${displayBranch(branch)}, ${count(receipt.sessions, 'session')}, ${formatUsd(receipt.totalCost)}). Commit it and push; the PR Receipt action posts it on the pull request.\n`,
  );
  return 0;
}

/** `prreceipt report`: merged PRs from gh, costed from this repository's sessions. Read-only on GitHub. */
async function report(ctx: CliContext, values: Values, since: number, repoDirs: string[], all: LogEntry[], prices: PriceTable): Promise<number> {
  const roots = values.repo ? withRealPaths([resolve(ctx.cwd, values.repo)]) : repoDirs;
  let listed;
  try {
    listed = await listMergedPullRequests(ctx.gh ?? createGh(ctx.cwd, 'gh', LIST_TIMEOUT_MS), since);
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    ctx.stderr(`prreceipt: ${e.message}\n`);
    return 1;
  }
  if (listed.length >= MERGED_PR_LIMIT) {
    ctx.stderr(`prreceipt: gh returned ${MERGED_PR_LIMIT} merged PRs, GitHub search's maximum, so some may be missing; use a shorter --since\n`);
  }
  // GitHub search filters by day; keep only the PRs merged at or after the exact --since time.
  const merged = listed.filter((pr) => pr.mergedAt >= since);
  ctx.stdout(renderReport(buildReport(filterByRepo(all, roots), merged, prices, since)));
  return 0;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      all: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      since: { type: 'string' },
      base: { type: 'string' },
      out: { type: 'string' },
      from: { type: 'string' },
      pr: { type: 'string' },
      logs: { type: 'string', multiple: true },
      prices: { type: 'string' },
      repo: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}
