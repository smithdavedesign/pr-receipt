// `npm run screenshots`: proof that M4 works, as PNGs in docs/screenshots/. prreceipt is a CLI and a GitHub
// Action, so this runs them for real on sample data and screenshots their output on plain HTML pages:
//   1. `prreceipt export` in a sample repo (Claude Code + Codex logs), then `git commit` of the receipt;
//   2. the Action's steps from action.yml on a clone of that repo, posting through a stand-in for gh (no
//      network here), and the comment it posted, rendered like a PR comment;
//   3. the Action on a pull request whose receipt is missing or broken.
// Each page is served on 127.0.0.1 and captured at 1280×800 and as an iPhone 13 (viewport only). Chromium
// comes from $CHROMIUM_PATH; nothing is downloaded. Needs Node ≥ 22.18 (it imports the TypeScript test helpers).
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';
import { runAction } from '../test/action-runner.ts';
import { installFakeGh } from '../test/fake-gh.ts';
import { FAKE_TOKEN } from '../test/helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const BIN = join(ROOT, 'src', 'bin.ts');
const BRANCH = 'feat/checkout-flow';
const PR = { number: 42, head: BRANCH, base: 'main', title: 'Checkout flow with address validation' };

if (!process.env.CHROMIUM_PATH) {
  console.error('screenshots: set CHROMIUM_PATH to a Chromium or Chrome binary (no browser is downloaded)');
  process.exit(1);
}

// ── sample data ─────────────────────────────────────────────────────────────

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

// ── run it ──────────────────────────────────────────────────────────────────

const cliEnv = { PATH: process.env.PATH ?? '', HOME: home };
const prreceipt = (args, cwd) => sh(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, ...args], cwd, cliEnv);

const exported = prreceipt(['export', '--logs', '../agent-logs'], repo);
if (exported.status !== 0) throw new Error(`export failed: ${exported.stderr}`);
git(['add', '.prreceipt.json']);
const committed = git(['commit', '-m', 'PR receipt'], repo, '2026-10-08T15:00:00Z');

/** The Action on a fresh clone of the branch (what actions/checkout gives it), posting through the fake gh. */
async function action(prepare) {
  const workspace = join(work, `checkout-${n++}`);
  git(['clone', '-q', '--branch', BRANCH, repo, workspace], work);
  await prepare?.(workspace);
  const gh = await installFakeGh({ pr: { number: PR.number, head: PR.head, base: PR.base }, owner: 'acme', repo: 'shop' });
  const result = runAction({
    workspace,
    prNumber: PR.number,
    headRef: BRANCH,
    token: FAKE_TOKEN,
    binDir: gh.binDir,
    env: { PRR_FAKE_GH_STATE: gh.statePath, PRR_FAKE_GH_TOKEN: FAKE_TOKEN },
    home,
  });
  return { result, fake: await gh.read() };
}
const ok = await action();
if (ok.result.code !== 0) throw new Error(`action failed: ${ok.result.stderr}`);
const [posted] = ok.fake.sentBodies();
const missing = await action((ws) => rm(join(ws, '.prreceipt.json')));
const broken = await action((ws) => writeFile(join(ws, '.prreceipt.json'), '{\n  "format": "prreceipt/1",\n  "exportedAt": "2026-10-08T15:00:00.000Z",\n  "receipt": {\n    "branch": "feat/checkout-flow",\n'));

// ── pages ───────────────────────────────────────────────────────────────────

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/`([^`]*)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

/** The markdown subset prreceipt writes (headings, lists, tables, italic notes, quotes, <sub>), as GitHub shows it. */
function markdown(md) {
  const html = [];
  for (const block of md.trim().split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => !/^<!--.*-->$/.test(l));
    if (lines.length === 0) continue;
    const first = lines[0];
    if (first.startsWith('## ')) html.push(`<h2>${inline(first.slice(3))}</h2>`);
    else if (first.startsWith('### ')) html.push(`<h3>${inline(first.slice(4))}</h3>`);
    else if (first.startsWith('- ')) html.push(`<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`);
    else if (first.startsWith('|')) {
      const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
      const right = cells(lines[1]).map((c) => c.endsWith(':'));
      const row = (l, tag) => `<tr>${cells(l).map((c, i) => `<${tag}${right[i] ? ' class="r"' : ''}>${inline(c)}</${tag}>`).join('')}</tr>`;
      html.push(`<div class="scroll"><table><thead>${row(first, 'th')}</thead><tbody>${lines.slice(2).map((l) => row(l, 'td')).join('')}</tbody></table></div>`);
    } else if (first.startsWith('> ')) html.push(`<blockquote>${inline(lines.map((l) => l.slice(2)).join(' '))}</blockquote>`);
    else if (/^<sub>.*<\/sub>$/.test(first)) html.push(`<p><sub>${inline(first.slice(5, -6))}</sub></p>`);
    else if (/^_.*_$/.test(first)) html.push(`<p><em>${inline(first.slice(1, -1))}</em></p>`);
    else html.push(`<p>${inline(lines.join(' '))}</p>`);
  }
  return html.join('\n');
}

const STYLE = `
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;background:#f6f8fa;color:#1f2328}
header{padding:14px 24px;background:#24292f;color:#fff;font-weight:600}header small{font-weight:400;opacity:.75;margin-left:8px}
main{padding:20px 24px;display:grid;gap:20px;max-width:1240px;margin:0 auto}
.two{grid-template-columns:minmax(0,1.45fr) minmax(0,1fr)}
h1{font-size:18px;margin:0 0 4px}.lead{margin:0;color:#59636e}
.term{background:#0d1117;color:#e6edf3;border-radius:8px;padding:14px 16px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.term .cmd{color:#7ee787}.term .err{color:#ffa198}.term .note{color:#8b949e}.term .ok{color:#56d364}.term .fail{color:#f85149;font-weight:600}
.card{background:#fff;border:1px solid #d1d9e0;border-radius:8px;overflow:hidden}
.card .who{padding:8px 16px;background:#f6f8fa;border-bottom:1px solid #d1d9e0;color:#59636e;font-size:14px}.who b{color:#1f2328}
.card .body{padding:4px 16px 12px}
.body h2{font-size:20px;border-bottom:1px solid #d1d9e0;padding-bottom:6px}.body ul{padding-left:22px}
.body code{background:#eff1f3;border-radius:5px;padding:.15em .35em;font-size:85%}
.scroll{overflow-x:auto}table{border-collapse:collapse;font-size:13.5px;margin:8px 0}th,td{border:1px solid #d1d9e0;padding:5px 10px;white-space:nowrap}th{background:#f6f8fa}.r{text-align:right}
.body em{color:#59636e}.body sub{color:#59636e}blockquote{margin:8px 0;padding:0 12px;border-left:4px solid #d1d9e0;color:#59636e}
.label{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#59636e;margin:0 0 6px}
@media (max-width:700px){main{padding:14px 12px}.two{grid-template-columns:minmax(0,1fr)}header{padding:12px}}`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
const prompt = (cwd, cmd) => `<span class="note">${esc(cwd)} (${BRANCH}) $</span> <span class="cmd">${esc(cmd)}</span>\n`;
const stepLog = (r) =>
  `<span class="note">Run node "$GITHUB_ACTION_PATH/src/bin.ts" comment --from="$PRR_FILE" --pr="$PRR_PR"</span>\n` +
  `<span class="err">${esc(r.stderr)}</span>${esc(r.stdout)}` +
  (r.code === 0 ? `<span class="ok">✅ Post the PR receipt: done</span>` : `<span class="fail">Error: Process completed with exit code ${r.code}.</span>`);

const pages = {
  export: page(
    'prreceipt export',
    `<header>prreceipt<small>on the developer's machine</small></header><main>
<div><h1>Export the branch's receipt, then commit it</h1><p class="lead">Claude Code and Codex logs on <code>${BRANCH}</code>: 5 sessions, one matched by the commit window. Real command output.</p></div>
<pre class="term">${prompt('~/shop', 'prreceipt export --logs ../agent-logs')}${esc(exported.stdout)}<span class="err">${esc(exported.stderr)}</span>
${prompt('~/shop', "git add .prreceipt.json && git commit -m 'PR receipt'")}${esc(committed)}</pre></main>`,
  ),
  comment: page(
    'PR receipt comment',
    `<header>acme/shop<small>#${PR.number} ${esc(PR.title)}</small></header><main class="two">
<div><p class="label">Comment posted by the action</p><div class="card"><div class="who"><b>github-actions</b> bot commented</div><div class="body">${markdown(posted)}</div></div></div>
<div><p class="label">Actions log: PR Receipt</p><pre class="term">${stepLog(ok.result)}</pre>
<p class="lead" style="margin-top:10px;font-size:13px">action.yml's steps run locally on a clone of the branch, against a stand-in for <code>gh</code> (no network in this sandbox). The comment is the posted body, rendered here.</p></div></main>`,
  ),
  error: page(
    'PR receipt action errors',
    `<header>acme/shop<small>#${PR.number} ${esc(PR.title)} · PR Receipt</small></header><main>
<div><h1>A missing or broken receipt fails the check, with a clear message</h1><p class="lead">Nothing is posted, and gh isn't called.</p></div>
<div><p class="label">.prreceipt.json not committed</p><pre class="term">${stepLog(missing.result)}</pre></div>
<div><p class="label">.prreceipt.json cut off mid-write</p><pre class="term">${stepLog(broken.result)}</pre></div></main>`,
  ),
};
if (missing.result.code === 0 || broken.result.code === 0) throw new Error('the error runs should fail');

// ── serve and capture ───────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const html = pages[(req.url ?? '/').slice(1)];
  res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html ?? 'not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
for (let tries = 0; ; tries += 1) {
  try {
    if ((await fetch(`${base}/export`)).ok) break;
  } catch {
    if (tries > 50) throw new Error('the page server never answered');
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const shots = [
  ['export', 'export'],
  ['comment', 'action-comment'],
  ['error', 'action-error'],
];
try {
  for (const [size, options] of [
    ['desktop', { viewport: { width: 1280, height: 800 } }],
    ['mobile', devices['iPhone 13']],
  ]) {
    const context = await browser.newContext(options);
    const tab = await context.newPage();
    for (const [path, name] of shots) {
      await tab.goto(`${base}/${path}`, { waitUntil: 'load' });
      await tab.screenshot({ path: join(OUT, `${name}-${size}.png`) });
      console.log(`docs/screenshots/${name}-${size}.png`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
  await rm(work, { recursive: true, force: true });
}
