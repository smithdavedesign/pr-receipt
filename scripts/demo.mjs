// Sample data for the screenshots and the website: a repo "shop" with branch feat/checkout-flow (4 commits),
// and Claude Code + Codex logs for it in a temp dir. 5 sessions on the branch, one of them matched by the
// commit window, plus one unattributed. Names, prompts and ids are made up; nothing comes from a real machine.
//
//   import { createDemo } from './demo.mjs'   →  { work, repo, home, logsDir, git, prreceipt, cleanup }
//   node scripts/demo.mjs site/sample.prreceipt.json   →  runs `prreceipt export` on it and keeps the file
//                                                      (the website's sample receipt; `npm run site:sample`)
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'src', 'bin.ts');
export const BRANCH = 'feat/checkout-flow';
export const PR = { number: 42, head: BRANCH, base: 'main', title: 'Checkout flow with address validation' };

export async function createDemo() {
  const work = await mkdtemp(join(tmpdir(), 'prr-demo-'));
  const repo = join(work, 'shop');
  const logsDir = join(work, 'agent-logs');
  const home = join(work, 'home');
  await mkdir(home);
  const gitEnv = { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

  function sh(cmd, args, cwd, env = gitEnv) {
    const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
    if (r.error) throw r.error;
    return r;
  }
  function git(args, cwd = repo, date) {
    const env = date ? { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : gitEnv;
    const r = sh('git', ['-c', 'user.name=Sam Example', '-c', 'user.email=sam@example.com', '-c', 'commit.gpgsign=false', ...args], cwd, env);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  }
  const code = (name, n) => Array.from({ length: n }, (_, i) => `export const ${name}${i + 1} = ${i + 1};\n`).join('');
  async function put(files) {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(repo, rel)), { recursive: true });
      await writeFile(join(repo, rel), text);
    }
  }

  await mkdir(repo);
  git(['init', '-q']);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await put({ 'README.md': '# shop\n', 'src/cart/cart.ts': code('cart', 120), 'src/checkout/legacy.ts': code('legacy', 60) });
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Initial shop'], repo, '2026-10-01T09:00:00Z');
  git(['checkout', '-q', '-b', BRANCH]);
  const commits = [
    ['2026-10-06T09:50:00Z', { 'src/checkout/CheckoutForm.tsx': code('field', 140) }, 'Checkout form'],
    ['2026-10-06T16:10:00Z', { 'src/checkout/address.ts': code('rule', 96), 'src/checkout/legacy.ts': code('legacy', 22) }, 'Address validation'],
    ['2026-10-07T11:30:00Z', { 'test/checkout.test.ts': code('checks', 88) }, 'Checkout tests'],
    ['2026-10-08T14:50:00Z', { 'src/checkout/address.ts': code('rule', 104) }, 'Postcode edge cases'],
  ];
  for (const [date, files, message] of commits) {
    await put(files);
    git(['add', '-A']);
    git(['commit', '-q', '-m', message], repo, date);
  }

  let n = 0;
  function claudeTurns(session, model, start, turns, { branch = BRANCH, cwd = repo } = {}) {
    const lines = [];
    let t = Date.parse(start);
    turns.forEach(([input, output, cacheWrite, cacheRead], i) => {
      n += 1;
      const base = { parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: session, version: '2.0.31', timestamp: new Date(t).toISOString() };
      if (branch) base.gitBranch = branch;
      if (i === 0) lines.push({ ...base, type: 'user', uuid: `u${n}`, message: { role: 'user', content: 'Sample prompt (never read by prreceipt)' } });
      t += 90_000 + (i % 3) * 60_000;
      lines.push({
        ...base,
        timestamp: new Date(t).toISOString(),
        type: 'assistant',
        uuid: `a${n}`,
        requestId: `req_demo_${n}`,
        message: {
          id: `msg_demo_${n}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'Sample response' }],
          usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, service_tier: 'standard' },
        },
      });
    });
    return lines;
  }
  const ramp = (count, f) => Array.from({ length: count }, (_, i) => f(i));
  const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const project = join(logsDir, 'claude', 'projects', '-home-sam-shop');
  await mkdir(project, { recursive: true });
  const SONNET = 'claude-sonnet-4-5-20250929';
  const OPUS = 'claude-opus-4-5-20251101';
  await writeFile(join(project, 'plan.jsonl'), jsonl(claudeTurns('5a1e0001-plan', OPUS, '2026-10-06T09:05:00Z', ramp(4, (i) => [6_000, 2_400 + i * 300, i === 0 ? 14_000 : 3_000, 30_000 + i * 20_000]))));
  await writeFile(join(project, 'build.jsonl'), jsonl(claudeTurns('5a1e0002-build', SONNET, '2026-10-06T13:10:00Z', ramp(14, (i) => [2_500 + (i % 4) * 700, 1_800 + (i % 5) * 450, i % 4 === 0 ? 9_000 : 1_200, 60_000 + i * 9_000]))));
  await writeFile(join(project, 'tests.jsonl'), jsonl(claudeTurns('5a1e0003-tests', SONNET, '2026-10-07T10:00:00Z', ramp(8, (i) => [3_000, 2_200 + i * 150, i === 0 ? 11_000 : 900, 48_000 + i * 7_500]))));
  // During a rebase (detached HEAD, no branch recorded), inside the branch's commit window: matched by time.
  await writeFile(join(project, 'rebase.jsonl'), jsonl(claudeTurns('5a1e0004-rebase', SONNET, '2026-10-07T16:30:00Z', ramp(3, () => [4_000, 1_500, 0, 52_000]), { branch: null })));
  // After the branch's last commit, no branch recorded: stays "unattributed".
  await writeFile(join(project, 'later.jsonl'), jsonl(claudeTurns('5a1e0005-later', SONNET, '2026-10-10T09:00:00Z', ramp(2, () => [3_500, 900, 0, 20_000]), { branch: null })));

  const codexId = '0199c0de-7a10-7c2e-9d01-5a3f00000042';
  const codexDir = join(logsDir, 'codex', 'sessions', '2026', '10', '08');
  await mkdir(codexDir, { recursive: true });
  const codexLines = [
    { timestamp: '2026-10-08T14:00:00Z', type: 'session_meta', payload: { id: codexId, timestamp: '2026-10-08T14:00:00Z', cwd: repo, originator: 'codex_cli_rs', cli_version: '0.160.1', git: { branch: BRANCH } } },
    { timestamp: '2026-10-08T14:00:02Z', type: 'turn_context', payload: { cwd: repo, model: 'gpt-5-codex', effort: 'medium' } },
  ];
  let total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  for (let i = 0; i < 5; i += 1) {
    const last = { input_tokens: 26_000 + i * 4_000, cached_input_tokens: 18_000 + i * 3_500, output_tokens: 2_100 + i * 200, reasoning_output_tokens: 900, total_tokens: 0 };
    last.total_tokens = last.input_tokens + last.output_tokens;
    total = Object.fromEntries(Object.entries(total).map(([k, v]) => [k, v + last[k]]));
    const ts = new Date(Date.parse('2026-10-08T14:03:00Z') + i * 540_000).toISOString();
    codexLines.push({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 272_000 }, rate_limits: null } });
  }
  await writeFile(join(codexDir, `rollout-2026-10-08T14-00-00-${codexId}.jsonl`), jsonl(codexLines));

  const cliEnv = { PATH: process.env.PATH ?? '', HOME: home };
  /** Runs the real CLI from src/ with a throwaway HOME, so nothing on this machine is read. */
  const prreceipt = (args, cwd) => sh(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, ...args], cwd, cliEnv);

  return {
    work,
    repo,
    home,
    logsDir,
    sh,
    git,
    prreceipt,
    /** A unique number, for naming more checkouts. */
    next: () => n++,
    cleanup: () => rm(work, { recursive: true, force: true }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/demo.mjs <out.prreceipt.json>');
    process.exit(1);
  }
  const demo = await createDemo();
  try {
    const exported = demo.prreceipt(['export', '--logs', '../agent-logs'], demo.repo);
    if (exported.status !== 0) throw new Error(`export failed: ${exported.stderr}`);
    await copyFile(join(demo.repo, '.prreceipt.json'), resolve(target));
    console.log(`wrote ${target}`);
  } finally {
    await demo.cleanup();
  }
}
