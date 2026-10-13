import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentBranch, resolveLogDirs } from '../src/cli.ts';
import { BRANCHES, THREE_MESSAGES, assistant, run, tempDir, writeLogs } from './helpers.ts';

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

async function gitRepo(branch: string): Promise<string> {
  const dir = await tempDir('prr-repo-');
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv });
  execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: dir, env: gitEnv });
  return dir;
}

describe('help and usage errors', () => {
  it('prints help with --help and exits 0', async () => {
    const { code, out } = await run(['--help']);
    assert.equal(code, 0);
    assert.match(out, /prreceipt show \[branch\]/);
    assert.match(out, /--logs/);
    assert.match(out, /--prices/);
    assert.match(out, /--repo/);
    assert.match(out, /--all/);
  });

  it('prints help to stderr and exits 1 with no command', async () => {
    const { code, out, err } = await run([]);
    assert.equal(code, 1);
    assert.equal(out, '');
    assert.match(err, /prreceipt show/);
  });

  it('rejects unknown commands, unknown flags and extra arguments with exit 1', async () => {
    for (const argv of [['scan'], ['show', '--bogus'], ['show', 'a', 'b'], ['show', '--logs']]) {
      const { code, err } = await run(argv);
      assert.equal(code, 1, argv.join(' '));
      assert.match(err, /prreceipt/, argv.join(' '));
    }
  });
});

describe('branch selection', () => {
  it('defaults to the current git branch', async () => {
    const cwd = await gitRepo('feat/demo');
    const { code, out } = await run(['show', '--logs', THREE_MESSAGES], { cwd });
    assert.equal(code, 0);
    assert.match(out, /PR Receipt: `feat\/demo`/);
    assert.match(out, /\$0\.0315/);
  });

  it('reads the branch from a subdirectory of the repo', async () => {
    const repo = await gitRepo('feat/a');
    const sub = join(repo, 'src');
    await mkdir(sub);
    assert.equal(currentBranch(sub), 'feat/a');
  });

  it('returns null outside a git repo and on a detached HEAD', async () => {
    assert.equal(currentBranch(await tempDir()), null);
    const repo = await gitRepo('main');
    await writeFile(join(repo, 'f'), 'x');
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env: gitEnv, stdio: 'pipe' });
    git(['add', 'f']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init']);
    git(['checkout', '-q', '--detach']);
    assert.equal(currentBranch(repo), null);
  });

  it('prints the all-branches overview with --all, even inside a git repo', async () => {
    const cwd = await gitRepo('main');
    const { code, out } = await run(['show', '--all', '--logs', BRANCHES], { cwd });
    assert.equal(code, 0);
    assert.match(out, /PR Receipt: all branches/);
  });

  it('rejects a branch together with --all', async () => {
    const { code, err } = await run(['show', 'feat/a', '--all', '--logs', BRANCHES]);
    assert.equal(code, 1);
    assert.match(err, /--all/);
  });

  it('points at --all when the current branch has no sessions', async () => {
    const cwd = await gitRepo('main');
    const { code, out } = await run(['show', '--logs', BRANCHES], { cwd });
    assert.equal(code, 0);
    assert.match(out, /no sessions found for branch `main`/);
    assert.match(out, /prreceipt show --all/);
  });

  it('prints the all-branches overview outside a git repo', async () => {
    const { code, out } = await run(['show', '--logs', BRANCHES]);
    assert.equal(code, 0);
    assert.match(out, /PR Receipt: all branches/);
    assert.match(out, /`feat\/a`/);
    assert.match(out, /`feat\/b`/);
  });
});

describe('--repo', () => {
  it('only counts sessions run inside the given directory', async () => {
    const logs = await writeLogs({
      'p/s1.jsonl': [assistant({ session: 's1', branch: 'main', cwd: '/w/shop', input: 1000, output: 500 })],
      'p/s2.jsonl': [assistant({ session: 's2', branch: 'main', cwd: '/w/blog', input: 9000, output: 9000 })],
    });
    const all = await run(['show', 'main', '--logs', logs]);
    assert.match(all.out, /\*\*Sessions:\*\* 2/);
    const shop = await run(['show', 'main', '--logs', logs, '--repo', '/w/shop']);
    assert.match(shop.out, /\*\*Sessions:\*\* 1/);
    assert.match(shop.out, /\$0\.0105/);
  });

  it('resolves a relative --repo against the working directory', async () => {
    const logs = await writeLogs({
      'p/s1.jsonl': [assistant({ session: 's1', branch: 'main', cwd: '/w/shop', input: 1000, output: 500 })],
    });
    const { out } = await run(['show', 'main', '--logs', logs, '--repo', 'shop'], { cwd: '/w' });
    assert.match(out, /\*\*Sessions:\*\* 1/);
  });
});

describe('log directory resolution', () => {
  it('uses --logs when given (repeatable)', () => {
    assert.deepEqual(resolveLogDirs(['/a', 'b'], {}, '/home/u', '/cwd'), ['/a', '/cwd/b']);
  });

  it('uses $CLAUDE_CONFIG_DIR/projects, comma-separated', () => {
    assert.deepEqual(resolveLogDirs([], { CLAUDE_CONFIG_DIR: '/x, /y' }, '/home/u', '/cwd'), ['/x/projects', '/y/projects']);
  });

  it('defaults to both Claude Code locations under home', () => {
    assert.deepEqual(resolveLogDirs([], {}, '/home/u', '/cwd'), ['/home/u/.config/claude/projects', '/home/u/.claude/projects']);
  });

  it('reads logs from $CLAUDE_CONFIG_DIR end to end', async () => {
    const config = await tempDir('prr-claude-');
    await mkdir(join(config, 'projects', '-p'), { recursive: true });
    await writeFile(
      join(config, 'projects', '-p', 's.jsonl'),
      JSON.stringify(assistant({ session: 's', branch: 'feat/env', input: 1000, output: 500 })) + '\n',
    );
    const { out } = await run(['show', 'feat/env'], { env: { CLAUDE_CONFIG_DIR: config } });
    assert.match(out, /\$0\.0105/);
  });

  it('reads logs from ~/.claude/projects by default', async () => {
    const home = await tempDir('prr-home-');
    await mkdir(join(home, '.claude', 'projects', '-p'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'projects', '-p', 's.jsonl'),
      JSON.stringify(assistant({ session: 's', branch: 'feat/home', input: 1000, output: 500 })) + '\n',
    );
    const { out } = await run(['show', 'feat/home'], { home });
    assert.match(out, /\$0\.0105/);
  });

  it('honours $XDG_CONFIG_HOME for the default override file', async () => {
    const xdg = await tempDir('prr-xdg-');
    await mkdir(join(xdg, 'prreceipt'));
    await writeFile(join(xdg, 'prreceipt', 'prices.json'), JSON.stringify({ models: { 'claude-sonnet-4-5': { input: 6 } } }));
    const { out } = await run(['show', 'feat/demo', '--logs', THREE_MESSAGES], { env: { XDG_CONFIG_HOME: xdg } });
    assert.match(out, /\$0\.0405/);
  });
});

describe('warnings', () => {
  it('reports skipped lines on stderr, not in the receipt', async () => {
    const logs = await writeLogs({ 'p/s.jsonl': [assistant({ session: 's', input: 1000, output: 500 }), '{"half": '] });
    const { code, out, err } = await run(['show', 'feat/x', '--logs', logs]);
    assert.equal(code, 0);
    assert.match(err, /skipped 1 unreadable line/);
    assert.doesNotMatch(out, /skipped/);
  });

  it('says how many files it scanned when none had usage', async () => {
    const logs = await writeLogs({ 'p/s.jsonl': ['{"type":"summary","summary":"x"}'] });
    const { code, out } = await run(['show', 'feat/x', '--logs', logs]);
    assert.equal(code, 0);
    assert.match(out, /no sessions found \(scanned 1 log file\)/);
  });
});
