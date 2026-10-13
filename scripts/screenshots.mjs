// `npm run screenshots`: proof of the launch-ready product, as PNGs in docs/screenshots/.
//   1. home: the website (site/), built for production with a placeholder STRIPE_PAYMENT_LINK so the Buy
//      button shows, started on localhost with site/serve.ts, and stopped at the end;
//   2. export: the core action, `prreceipt export` run for real on sample Claude Code + Codex logs
//      (scripts/demo.mjs), then `git commit` of the receipt;
//   3. action-comment: the result on the pull request: action.yml's steps on a clone of that branch, posting
//      through a stand-in for gh (no network here), and the comment it posted, rendered like a PR comment.
// Each is captured at 1280×800 and as an iPhone 13, viewport only. Chromium comes from $CHROMIUM_PATH; nothing
// is downloaded. Needs Node ≥ 22.18 (it imports TypeScript modules). Not part of `npm test`.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';
import { escapeHtml as esc, markdownToHtml as markdown } from '../site/markdown.ts';
import { runAction } from '../test/action-runner.ts';
import { installFakeGh } from '../test/fake-gh.ts';
import { FAKE_TOKEN } from '../test/helpers.ts';
import { BRANCH, PR, createDemo } from './demo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
/** A stand-in so the Buy button renders; the real link only ever comes from the deploy's environment. */
const PLACEHOLDER_PAYMENT_LINK = 'https://example.com/pay';
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];

if (!process.env.CHROMIUM_PATH) {
  console.error('screenshots: set CHROMIUM_PATH to a Chromium or Chrome binary (no browser is downloaded)');
  process.exit(1);
}

const demo = await createDemo();
const { work, repo, home, git } = demo;
const cleanups = [() => demo.cleanup()];

try {
  // ── the website: production build, then start it ───────────────────────────
  const siteDir = join(work, 'site');
  const built = spawnSync(NODE[0], [...NODE.slice(1), join(ROOT, 'site', 'build.ts'), '--out', siteDir], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', STRIPE_PAYMENT_LINK: PLACEHOLDER_PAYMENT_LINK },
    encoding: 'utf8',
  });
  if (built.status !== 0) throw new Error(`site build failed: ${built.stderr}`);
  const siteUrl = await startSite(siteDir);

  // ── the core action and its result, on sample data ──────────────────────────
  const exported = demo.prreceipt(['export', '--logs', '../agent-logs'], repo);
  if (exported.status !== 0) throw new Error(`export failed: ${exported.stderr}`);
  git(['add', '.prreceipt.json']);
  const committed = git(['commit', '-m', 'PR receipt'], repo, '2026-10-08T15:00:00Z');

  const workspace = join(work, `checkout-${demo.next()}`);
  git(['clone', '-q', '--branch', BRANCH, repo, workspace], work);
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
  if (result.code !== 0) throw new Error(`action failed: ${result.stderr}`);
  const [posted] = (await gh.read()).sentBodies();

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

  const page = (title, body) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
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
<div><p class="label">Actions log: PR Receipt</p><pre class="term">${stepLog(result)}</pre>
<p class="lead" style="margin-top:10px;font-size:13px">action.yml's steps run locally on a clone of the branch, against a stand-in for <code>gh</code> (no network in this sandbox). The comment is the posted body, rendered here.</p></div></main>`,
    ),
  };

  // The CLI pages are plain HTML, served in-process.
  const cliServer = createServer((req, res) => {
    const html = pages[(req.url ?? '/').slice(1)];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html ?? 'not found');
  });
  await new Promise((resolve) => cliServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => cliServer.close(resolve)));
  const cliUrl = `http://127.0.0.1:${cliServer.address().port}`;

  // ── capture ─────────────────────────────────────────────────────────────────
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  cleanups.push(() => browser.close());
  const shots = [
    [`${siteUrl}/`, 'home'],
    [`${cliUrl}/export`, 'export'],
    [`${cliUrl}/comment`, 'action-comment'],
  ];
  for (const [size, options] of [
    ['desktop', { viewport: { width: 1280, height: 800 } }],
    ['mobile', devices['iPhone 13']],
  ]) {
    const context = await browser.newContext(options);
    const tab = await context.newPage();
    for (const [url, name] of shots) {
      const response = await tab.goto(url, { waitUntil: 'load' });
      if (!response?.ok()) throw new Error(`${url} answered ${response?.status()}`);
      await tab.screenshot({ path: join(OUT, `${name}-${size}.png`) });
      console.log(`docs/screenshots/${name}-${size}.png`);
    }
    await context.close();
  }
  // The README shows exactly this set: older PNGs that this run didn't write are removed, not piled up.
  const written = new Set(shots.flatMap(([, name]) => [`${name}-desktop.png`, `${name}-mobile.png`]));
  for (const file of await readdir(OUT)) {
    if (file.endsWith('.png') && !written.has(file)) {
      await rm(join(OUT, file));
      console.log(`removed old docs/screenshots/${file}`);
    }
  }
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}

/** Starts site/serve.ts on a free port, waits until it answers, and registers its shutdown. */
async function startSite(dir) {
  const child = spawn(NODE[0], [...NODE.slice(1), join(ROOT, 'site', 'serve.ts'), dir, '--port', '0'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  cleanups.push(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (match) resolve(match[1]);
    });
    child.once('exit', (code) => reject(new Error(`the site server exited (${code}) before it listened`)));
  });
  for (let tries = 0; ; tries += 1) {
    try {
      if ((await fetch(`${url}/`)).ok) return url;
    } catch {
      // not up yet
    }
    if (tries > 50) throw new Error('the site never answered on localhost');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
