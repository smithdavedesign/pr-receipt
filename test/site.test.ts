// The public website (site/): pages, search and sharing tags, robots.txt and sitemap.xml, the share image, the
// Buy button, RepoHQ's visit beacon, the preview server and the deploy config. No network, no browser.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { DEFAULT_OUT, SAMPLE_RECEIPT, buildSite, sampleReceiptHtml } from '../site/build.ts';
import { HEIGHT, SHARE_RECEIPT, WIDTH, crc32, drawShareImage } from '../site/og-image.ts';
import {
  ISSUES_URL,
  PAGES,
  REFUND_DAYS,
  SiteConfigError,
  TRY_COMMANDS,
  paymentLink,
  renderPage,
  robotsTxt,
  siteConfig,
  sitemapXml,
  type SiteConfig,
} from '../site/pages.ts';
import { createSiteServer, resolveFile, vercelHeaders } from '../site/serve.ts';
import {
  ACTIVATE_KEY,
  NOTRACK_KEY,
  SIGNAL_URL,
  SLUG,
  VISIT_KEY,
  externalReferrer,
  start,
  track,
  type Win,
} from '../site/static/site.js';
import { parseReceiptFile } from '../src/receipt-file.ts';
import { formatUsd, formatUsdShort } from '../src/receipt.ts';
import { tempDir } from './helpers.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAY = 'https://example.com/pay';
const config = (over: Partial<SiteConfig> = {}): SiteConfig => ({ url: 'https://pr-receipt.vercel.app', paymentLink: null, env: '', ...over });
/** An https URL carrying a user and password, built at runtime so the repo holds nothing credential-shaped. */
const withUserInfo = (rest: string) => `https://${['demo', 'Filler0'.repeat(3)].join(':')}@${rest}`;

// ── tiny HTML readers (the pages are generated, so their shape is known) ────

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function meta(html: string, attr: 'name' | 'property', key: string): string | undefined {
  const m = new RegExp(`<meta ${attr}="${escapeRe(key)}" content="([^"]*)">`).exec(html);
  return m ? decode(m[1]) : undefined;
}
const title = (html: string) => decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '');
const canonicalOf = (html: string) => /<link rel="canonical" href="([^"]*)">/.exec(html)?.[1];
function jsonLdOf(html: string): Record<string, any> {
  const m = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html);
  assert.ok(m, 'page has JSON-LD');
  return JSON.parse(m[1]);
}
const checkoutLinks = (html: string) => [...html.matchAll(/<a [^>]*data-track="checkout"[^>]*>/g)].map((m) => m[0]);

async function built(env: Record<string, string | undefined> = {}) {
  const out = await tempDir('prr-site-');
  const result = await buildSite(out, env);
  const read = (name: string) => readFile(join(out, name), 'utf8');
  return { out, result, read };
}

describe('site: every public page renders with its own search and sharing tags', async () => {
  const { out, result, read } = await built({ STRIPE_PAYMENT_LINK: PAY });
  const pages = await Promise.all(PAGES.map(async (p) => ({ page: p, html: await read(p.file) })));

  it('writes the pages, robots.txt, sitemap.xml, the share image and the assets', async () => {
    const expected = ['favicon.svg', 'index.html', 'og.png', 'privacy.html', 'robots.txt', 'site.css', 'site.js', 'sitemap.xml', 'terms.html'];
    assert.deepEqual(result.files, expected);
    assert.deepEqual((await readdir(out)).sort(), expected);
    assert.deepEqual(PAGES.map((p) => p.path), ['/', '/privacy', '/terms']);
  });

  it('gives each page a unique title and meta description', () => {
    const titles = pages.map(({ html }) => title(html));
    const descriptions = pages.map(({ html }) => meta(html, 'name', 'description') ?? '');
    assert.equal(new Set(titles).size, PAGES.length);
    assert.equal(new Set(descriptions).size, PAGES.length);
    for (const [i, { page }] of pages.entries()) {
      assert.equal(titles[i], page.title);
      assert.equal(descriptions[i], page.description);
      assert.ok(page.title.length > 10 && page.title.length <= 70, `title length: ${page.title}`);
      assert.ok(page.description.length >= 70 && page.description.length <= 160, `description length ${page.description.length}`);
    }
  });

  it('has a canonical URL, Open Graph and Twitter card tags with the 1200×630 image', () => {
    for (const { page, html } of pages) {
      const url = `https://pr-receipt.vercel.app${page.path}`;
      assert.equal(canonicalOf(html), url);
      assert.equal(meta(html, 'property', 'og:url'), url);
      assert.equal(meta(html, 'property', 'og:type'), 'website');
      assert.equal(meta(html, 'property', 'og:title'), page.title);
      assert.equal(meta(html, 'property', 'og:description'), page.description);
      assert.equal(meta(html, 'property', 'og:image'), 'https://pr-receipt.vercel.app/og.png');
      assert.equal(meta(html, 'property', 'og:image:width'), '1200');
      assert.equal(meta(html, 'property', 'og:image:height'), '630');
      assert.ok(meta(html, 'property', 'og:image:alt'));
      assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image');
      assert.equal(meta(html, 'name', 'twitter:title'), page.title);
      assert.equal(meta(html, 'name', 'twitter:description'), page.description);
      assert.equal(meta(html, 'name', 'twitter:image'), 'https://pr-receipt.vercel.app/og.png');
    }
  });

  it('has SoftwareApplication JSON-LD with a $9/month offer', () => {
    for (const { html } of pages) {
      const ld = jsonLdOf(html);
      assert.equal(ld['@context'], 'https://schema.org');
      assert.equal(ld['@type'], 'SoftwareApplication');
      assert.equal(ld.name, 'PR Receipt');
      assert.equal(ld.url, 'https://pr-receipt.vercel.app/');
      assert.equal(ld.offers['@type'], 'Offer');
      assert.equal(ld.offers.price, '9.00');
      assert.equal(ld.offers.priceCurrency, 'USD');
      assert.equal(ld.offers.priceSpecification['@type'], 'UnitPriceSpecification');
      assert.equal(ld.offers.priceSpecification.price, '9.00');
      assert.equal(ld.offers.priceSpecification.referenceQuantity.unitCode, 'MON');
    }
  });

  it('links Privacy, Terms and the GitHub issues from every footer, and loads the beacon everywhere', () => {
    for (const { html } of pages) {
      const foot = /<footer[\s\S]*<\/footer>/.exec(html)?.[0] ?? '';
      assert.match(foot, /<a href="\/privacy">Privacy<\/a>/);
      assert.match(foot, /<a href="\/terms">Terms<\/a>/);
      assert.ok(foot.includes(`href="${ISSUES_URL}"`));
      assert.ok(html.includes('<script type="module" src="/site.js"></script>'));
    }
  });

  it('stays within the CSP: no inline script, style attribute or event handler', () => {
    for (const { html } of pages) {
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      assert.deepEqual(scripts, ['<script type="application/ld+json">', '<script type="module" src="/site.js">']);
      assert.doesNotMatch(html, /\sstyle=/);
      assert.doesNotMatch(html, /\son[a-z]+=/i);
    }
  });

  it('shows the real sample receipt on the home page, and the try-it commands to copy', async () => {
    const home = pages[0].html;
    assert.ok(home.includes(await sampleReceiptHtml()));
    assert.match(home, /\$3\.03/);
    assert.match(home, /feat\/checkout-flow/);
    assert.match(home, /data-copy="try-command" hidden/);
    assert.ok(home.includes(`<pre id="try-command" data-command><code>${TRY_COMMANDS.join('\n')}</code></pre>`));
    // The commands run prreceipt from a clone: that file has to exist.
    assert.ok(existsSync(join(ROOT, 'src', 'bin.ts')));
    assert.match(TRY_COMMANDS[2], /src\/bin\.ts show$/);
  });

  it('writes robots.txt allowing indexing and pointing at the sitemap', async () => {
    assert.equal(await read('robots.txt'), 'User-agent: *\nAllow: /\n\nSitemap: https://pr-receipt.vercel.app/sitemap.xml\n');
  });

  it('lists exactly the public pages in sitemap.xml, at their canonical URLs', async () => {
    const xml = await read('sitemap.xml');
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(locs, pages.map(({ html }) => canonicalOf(html)));
    assert.deepEqual(locs, ['https://pr-receipt.vercel.app/', 'https://pr-receipt.vercel.app/privacy', 'https://pr-receipt.vercel.app/terms']);
    assert.equal([...xml.matchAll(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g)].length, 3);
  });

  it('copies the share image and assets that the pages reference', async () => {
    assert.deepEqual(await readFile(join(out, 'og.png')), drawShareImage());
    for (const asset of ['site.css', 'site.js', 'favicon.svg']) {
      assert.equal(await read(asset), await readFile(join(ROOT, 'site', 'static', asset), 'utf8'));
    }
  });
});

describe('site: privacy and terms say what the product does and costs', () => {
  const html = (path: string) => renderPage(PAGES.find((p) => p.path === path)!, config(), '');

  it('privacy: nothing collected by the tool, no cookies, and the three beacon events named', () => {
    const privacy = html('/privacy');
    assert.match(privacy, /the prreceipt tool collects nothing/);
    assert.match(privacy, /No cookies/);
    for (const kind of ['visit', 'activate', 'checkout']) assert.match(privacy, new RegExp(`<strong>${kind}</strong>`));
    assert.match(privacy, /idea-factory\.1426davejobs\.workers\.dev/);
    assert.match(privacy, /repohq:notrack/);
    assert.match(privacy, /automated browsers/);
    assert.match(privacy, /preview deployments/);
    assert.ok(privacy.includes(`href="${ISSUES_URL}"`));
  });

  it('terms: no warranty, the MIT license, the $9/month price and the refund line', () => {
    const terms = html('/terms');
    assert.match(terms, /provided "as is", without warranty of any kind/);
    assert.match(terms, /MIT License/);
    assert.match(terms, /\$9\/month per team \(flat, up to 10 developers\)/);
    assert.match(terms, new RegExp(`within ${REFUND_DAYS} days of a payment and it is refunded in full`));
    assert.match(terms, /estimates/);
    assert.ok(terms.includes(`href="${ISSUES_URL}"`));
  });
});

describe('site: the Buy button follows STRIPE_PAYMENT_LINK', () => {
  const home = PAGES[0];

  it('is hidden when the variable is unset or blank', async () => {
    for (const env of [{}, { STRIPE_PAYMENT_LINK: '' }, { STRIPE_PAYMENT_LINK: '   ' }]) {
      const { config: c, warnings } = siteConfig(env);
      assert.equal(c.paymentLink, null);
      assert.deepEqual(warnings, []);
      for (const page of PAGES) assert.deepEqual(checkoutLinks(renderPage(page, c, '')), []);
      assert.match(renderPage(home, c, ''), /Not on sale yet/);
      assert.doesNotMatch(renderPage(home, c, ''), /Get Team Pack/);
    }
    // And in a real build with no environment at all.
    const { read, result } = await built({});
    assert.equal(result.config.paymentLink, null);
    for (const page of PAGES) assert.deepEqual(checkoutLinks(await read(page.file)), []);
  });

  it('links to the variable, in the top bar and in the pricing, and fires "checkout"', () => {
    const { config: c } = siteConfig({ STRIPE_PAYMENT_LINK: PAY });
    const links = checkoutLinks(renderPage(home, c, ''));
    assert.equal(links.length, 2);
    for (const link of links) assert.ok(link.includes(`href="${PAY}"`));
    assert.doesNotMatch(renderPage(home, c, ''), /Not on sale yet/);
    // The top bar's button is on the other pages too.
    for (const page of PAGES.slice(1)) assert.equal(checkoutLinks(renderPage(page, c, '')).length, 1);
  });

  it('stays hidden, with a warning, for a value that is not a plain https link', () => {
    for (const bad of ['javascript:alert(1)', 'http://example.com/pay', 'not a url', withUserInfo('example.com/pay'), 'data:text/html,hi']) {
      const { config: c, warnings } = siteConfig({ STRIPE_PAYMENT_LINK: bad });
      assert.equal(c.paymentLink, null, bad);
      assert.equal(warnings.length, 1, bad);
      assert.doesNotMatch(warnings[0], new RegExp(escapeRe(bad)), 'the value is not echoed');
      assert.deepEqual(checkoutLinks(renderPage(home, c, '')), []);
    }
  });

  it('cannot break out of the href attribute', () => {
    const { link } = paymentLink('https://example.com/pay?x="><script>alert(1)</script>');
    assert.ok(link);
    const html = renderPage(home, config({ paymentLink: link }), '');
    assert.doesNotMatch(html, /<script>alert/);
    for (const a of checkoutLinks(html)) assert.match(a, /^<a class="[^"]+" href="[^"<>]+" data-track="checkout">$/);
  });

  it('keeps the $9/month offer in the JSON-LD either way', () => {
    for (const paymentLink of [null, PAY]) assert.equal(jsonLdOf(renderPage(home, config({ paymentLink }), '')).offers.price, '9.00');
  });

  it('is never hard-coded: no Stripe URL in the site, scripts or deploy config', async () => {
    const files = [
      ...(await readdir(join(ROOT, 'site'), { recursive: true })).map((f) => join('site', String(f))),
      ...(await readdir(join(ROOT, 'scripts'))).map((f) => join('scripts', f)),
      'vercel.json',
      '.provision',
    ].filter((f) => !f.startsWith(join('site', 'out')) && /\.(ts|js|mjs|json|css|svg)$|^\.provision$/.test(f));
    assert.ok(files.length > 8);
    for (const f of files) assert.doesNotMatch(await readFile(join(ROOT, f), 'utf8'), /stripe\.com/i, f);
  });
});

describe('site: configuration from the environment', () => {
  it('takes the canonical origin from SITE_URL, then Vercel production URL, then the default', () => {
    assert.equal(siteConfig({}).config.url, 'https://pr-receipt.vercel.app');
    assert.equal(siteConfig({ VERCEL_PROJECT_PRODUCTION_URL: 'prreceipt.dev' }).config.url, 'https://prreceipt.dev');
    assert.equal(siteConfig({ SITE_URL: 'https://example.org/', VERCEL_PROJECT_PRODUCTION_URL: 'prreceipt.dev' }).config.url, 'https://example.org');
    const c = siteConfig({ SITE_URL: 'https://example.org' }).config;
    assert.equal(robotsTxt(c), 'User-agent: *\nAllow: /\n\nSitemap: https://example.org/sitemap.xml\n');
    assert.match(sitemapXml(c), /<loc>https:\/\/example\.org\/privacy<\/loc>/);
    assert.equal(canonicalOf(renderPage(PAGES[2], c, '')), 'https://example.org/terms');
  });

  it('refuses a SITE_URL that is not a plain https origin', () => {
    for (const bad of ['example.org', 'http://example.org', withUserInfo('example.org'), 'ftp://example.org']) {
      assert.throws(() => siteConfig({ SITE_URL: bad }), SiteConfigError, bad);
    }
  });

  it('marks the page with VERCEL_ENV, which the beacon reads', () => {
    const env = (v?: string) => /<html lang="en" data-env="([^"]*)">/.exec(renderPage(PAGES[0], siteConfig({ VERCEL_ENV: v }).config, ''))?.[1];
    assert.equal(env('production'), 'production');
    assert.equal(env('preview'), 'preview');
    assert.equal(env(undefined), '');
    assert.equal(env('"><b>'), '');
  });
});

describe('site: the share image', () => {
  const png = drawShareImage();

  it('is a valid 1200×630 RGB PNG with intact chunks', () => {
    assert.equal(WIDTH, 1200);
    assert.equal(HEIGHT, 630);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks: Array<{ type: string; data: Buffer }> = [];
    for (let at = 8; at < png.length; ) {
      const length = png.readUInt32BE(at);
      const type = png.toString('ascii', at + 4, at + 8);
      const data = png.subarray(at + 8, at + 8 + length);
      assert.equal(png.readUInt32BE(at + 8 + length), crc32(png.subarray(at + 4, at + 8 + length)), `${type} CRC`);
      chunks.push({ type, data });
      at += 12 + length;
    }
    assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
    const ihdr = chunks[0].data;
    assert.equal(ihdr.readUInt32BE(0), 1200);
    assert.equal(ihdr.readUInt32BE(4), 630);
    assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0]);
    const raw = inflateSync(chunks[1].data);
    assert.equal(raw.length, (1200 * 3 + 1) * 630);
    // Something is drawn: many distinct colours, not a blank canvas.
    const colours = new Set<number>();
    for (let y = 0; y < 630; y += 3) for (let x = 0; x < 1200; x += 3) colours.add(raw.readUIntBE(y * 3601 + 1 + x * 3, 3));
    assert.ok(colours.size >= 8, `${colours.size} colours`);
    assert.ok(png.length < 200_000, `${png.length} bytes`);
  });

  it('is the same every build', () => {
    assert.deepEqual(drawShareImage(), png);
  });

  it("prints the home page's sample receipt, rounded to cents", async () => {
    const { receipt: r } = parseReceiptFile(await readFile(SAMPLE_RECEIPT, 'utf8'), 'sample');
    const cents = (n: number) => `$${n.toFixed(2)}`;
    assert.equal(SHARE_RECEIPT.branch, r.branch);
    assert.equal(SHARE_RECEIPT.total, cents(r.totalCost));
    assert.equal(SHARE_RECEIPT.total, formatUsd(r.totalCost));
    assert.deepEqual(
      SHARE_RECEIPT.models.map(([, cost]) => cost),
      r.models.map((m) => cents(m.cost ?? 0)),
    );
    assert.deepEqual(
      SHARE_RECEIPT.models.map(([name]) => name),
      r.models.map((m) => m.model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').toUpperCase()),
    );
    assert.equal(SHARE_RECEIPT.sessions, String(r.sessions));
    assert.equal(SHARE_RECEIPT.tokens, `${(r.totalTokens / 1e6).toFixed(1)}M`);
    assert.equal(SHARE_RECEIPT.linesChanged, String(r.diff!.insertions + r.diff!.deletions));
    assert.equal(SHARE_RECEIPT.perLine, formatUsdShort(r.costPerLine!));
  });
});

// ── the beacon, against a stand-in window ───────────────────────────────────

interface FakeEl {
  nodeType: 1;
  id?: string;
  hidden?: boolean;
  textContent: string;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  parentElement: FakeEl | null;
  closest(selector: string): FakeEl | null;
}

function el(attrs: Record<string, string>, parent: FakeEl | null = null, text = ''): FakeEl {
  const dataset = Object.fromEntries(
    Object.entries(attrs)
      .filter(([k]) => k.startsWith('data-'))
      .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
  );
  const self: FakeEl = {
    nodeType: 1,
    id: attrs.id,
    hidden: 'hidden' in attrs,
    textContent: text,
    dataset,
    attrs,
    parentElement: parent,
    closest(selector) {
      const [, name, value] = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector) ?? [];
      if (!name) throw new Error(`fake closest() can't match ${selector}`);
      for (let e: FakeEl | null = self; e; e = e.parentElement) {
        if (name in e.attrs && (value === undefined || e.attrs[name] === value)) return e;
      }
      return null;
    },
  };
  return self;
}

function storage(opts: { throws?: boolean } = {}): Storage {
  const m = new Map<string, string>();
  const guard = () => {
    if (opts.throws) throw new Error('SecurityError: storage is blocked');
  };
  return {
    getItem: (k: string) => (guard(), m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => (guard(), void m.set(k, String(v))),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

interface FakeOpts {
  env?: string;
  webdriver?: boolean;
  referrer?: string;
  local?: Storage;
  session?: Storage;
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
}

function fakeWindow(opts: FakeOpts = {}) {
  const sent: Array<{ url: string; init: RequestInit; body: { slug: string; kind: string; referrer: string | null } }> = [];
  const copied: string[] = [];
  const listeners: Record<string, Array<(event: { target: unknown }) => void>> = {};
  const command = el({ id: 'try-command', 'data-command': '' }, null, '\n git clone x\nnode y show \n');
  const copyButton = el({ 'data-copy': 'try-command', hidden: '' }, null, 'Copy');
  const buyLink = el({ 'data-track': 'checkout', href: PAY }, null);
  const buyLabel = el({}, buyLink, 'Get Team Pack');
  const elements = [command, copyButton, buyLink, buyLabel];
  const win = {
    navigator: { webdriver: opts.webdriver ?? false, clipboard: { writeText: async (t: string) => void copied.push(t) } },
    location: { origin: 'https://pr-receipt.vercel.app' },
    document: {
      referrer: opts.referrer ?? '',
      documentElement: { dataset: { env: opts.env ?? 'production' } },
      querySelectorAll: (selector: string) => elements.filter((e) => e.closest(selector) === e),
      getElementById: (id: string) => elements.find((e) => e.id === id) ?? null,
      addEventListener: (type: string, fn: (event: { target: unknown }) => void) => void (listeners[type] ??= []).push(fn),
    },
    localStorage: opts.local ?? storage(),
    sessionStorage: opts.session ?? storage(),
    setTimeout: () => 0,
    fetch: (url: string, init: RequestInit) => {
      sent.push({ url, init, body: JSON.parse(String(init.body)) });
      return opts.fetch ? opts.fetch(url, init) : Promise.resolve(new Response(null, { status: 204 }));
    },
  } as unknown as Win;
  const fire = (type: string, target: unknown) => {
    for (const fn of listeners[type] ?? []) fn({ target });
  };
  return { win, sent, copied, command, copyButton, buyLink, buyLabel, fire, kinds: () => sent.map((s) => s.body.kind) };
}

/** Lets the clipboard promise settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('site: RepoHQ visit beacon (site/static/site.js)', () => {
  it('POSTs {slug, kind, referrer} as JSON to RepoHQ, keepalive and without cookies', () => {
    const f = fakeWindow({ referrer: 'https://news.ycombinator.com/item?id=1' });
    assert.equal(track(f.win, 'visit'), true);
    assert.equal(f.sent.length, 1);
    const [{ url, init, body }] = f.sent;
    assert.equal(url, SIGNAL_URL);
    assert.equal(url, 'https://idea-factory.1426davejobs.workers.dev/api/ideas/signal');
    assert.equal(init.method, 'POST');
    assert.equal(init.keepalive, true);
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(body, { slug: 'pr-receipt', kind: 'visit', referrer: 'https://news.ycombinator.com/item?id=1' });
    assert.equal(SLUG, 'pr-receipt');
  });

  it('sends "visit" on page load once per browser session', () => {
    const local = storage();
    const session = storage();
    const first = fakeWindow({ local, session });
    start(first.win);
    assert.deepEqual(first.kinds(), ['visit']);
    const samePage = fakeWindow({ local, session });
    start(samePage.win); // another page, same tab session
    assert.deepEqual(samePage.kinds(), []);
    const newSession = fakeWindow({ local, session: storage() });
    start(newSession.win);
    assert.deepEqual(newSession.kinds(), ['visit']);
    assert.equal(session.getItem(VISIT_KEY), '1');
  });

  it('sends "activate" on the first copy of the try-it command, once per browser', async () => {
    const local = storage();
    const f = fakeWindow({ local });
    start(f.win);
    assert.equal(f.copyButton.hidden, false, 'the Copy button shows once the script runs');
    f.fire('click', f.copyButton);
    await tick();
    assert.deepEqual(f.copied, ['git clone x\nnode y show']);
    assert.equal(f.copyButton.textContent, 'Copied');
    f.fire('click', f.copyButton);
    f.fire('copy', { nodeType: 3, parentElement: f.command }); // selecting the text and copying it by hand
    assert.deepEqual(f.kinds(), ['visit', 'activate']);
    assert.equal(local.getItem(ACTIVATE_KEY), '1');
    const later = fakeWindow({ local, session: storage() });
    start(later.win);
    later.fire('click', later.copyButton);
    assert.deepEqual(later.kinds(), ['visit'], 'a new session in the same browser does not activate again');
  });

  it('still counts "activate" when the clipboard refuses, and says how to copy instead', async () => {
    const f = fakeWindow();
    (f.win.navigator.clipboard as { writeText: (t: string) => Promise<void> }).writeText = () => Promise.reject(new Error('NotAllowedError'));
    start(f.win);
    f.fire('click', f.copyButton);
    await tick();
    assert.equal(f.copyButton.textContent, 'Select it to copy');
    assert.deepEqual(f.kinds(), ['visit', 'activate']);
  });

  it('counts a hand copy of the command as "activate" too, but not copying anything else', () => {
    const f = fakeWindow();
    start(f.win);
    f.fire('copy', f.buyLabel);
    f.fire('copy', null);
    assert.deepEqual(f.kinds(), ['visit']);
    f.fire('copy', { nodeType: 3, parentElement: f.command });
    assert.deepEqual(f.kinds(), ['visit', 'activate']);
  });

  it('sends "checkout" on each click of a Buy button, including on its label', () => {
    const f = fakeWindow();
    start(f.win);
    f.fire('click', f.buyLabel);
    f.fire('click', f.buyLink);
    f.fire('click', el({}));
    assert.deepEqual(f.kinds(), ['visit', 'checkout', 'checkout']);
  });

  it('sends the referrer only when it is another site', () => {
    const origin = 'https://pr-receipt.vercel.app';
    assert.equal(externalReferrer('https://www.reddit.com/r/ClaudeAI/', origin), 'https://www.reddit.com/r/ClaudeAI/');
    assert.equal(externalReferrer('https://pr-receipt.vercel.app/privacy?ref=share', origin), null);
    assert.equal(externalReferrer('https://pr-receipt.vercel.app/', origin), null);
    assert.equal(externalReferrer('http://pr-receipt.vercel.app/', origin), 'http://pr-receipt.vercel.app/', 'another scheme is another origin');
    assert.equal(externalReferrer('https://other.vercel.app/', origin), 'https://other.vercel.app/');
    assert.equal(externalReferrer('', origin), null);
    assert.equal(externalReferrer('not a url', origin), null);
    const f = fakeWindow({ referrer: 'https://pr-receipt.vercel.app/terms' });
    track(f.win, 'checkout');
    assert.equal(f.sent[0].body.referrer, null);
  });

  it('sends nothing to automated browsers, outside production, or with repohq:notrack set', () => {
    const cases: Array<[string, FakeOpts]> = [
      ['navigator.webdriver', { webdriver: true }],
      ['a preview deployment', { env: 'preview' }],
      ['a development build', { env: 'development' }],
      ['a local build (no VERCEL_ENV)', { env: '' }],
      ['storage blocked', { local: storage({ throws: true }) }],
    ];
    const notrack = storage();
    notrack.setItem(NOTRACK_KEY, '');
    cases.push(['repohq:notrack set (even empty)', { local: notrack }]);
    for (const [why, opts] of cases) {
      const f = fakeWindow(opts);
      start(f.win);
      f.fire('click', f.copyButton);
      f.fire('click', f.buyLink);
      for (const kind of ['visit', 'activate', 'checkout'] as const) assert.equal(track(f.win, kind), false, `${why}: ${kind}`);
      assert.deepEqual(f.sent, [], why);
    }
  });

  it('never throws or leaves a rejected promise when sending fails', async () => {
    const rejecting = fakeWindow({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    assert.equal(track(rejecting.win, 'checkout'), true);
    const throwing = fakeWindow({
      fetch: () => {
        throw new TypeError('keepalive quota exceeded');
      },
    });
    assert.equal(track(throwing.win, 'checkout'), false);
    const session = storage({ throws: true });
    assert.equal(track(fakeWindow({ session }).win, 'visit'), false);
    await tick();
  });
});

// ── preview server and deploy config ────────────────────────────────────────

describe('site: preview server (site/serve.ts)', async () => {
  const { out } = await built({ STRIPE_PAYMENT_LINK: PAY });

  it('serves pages at clean URLs with vercel.json headers, and nothing outside the build', async () => {
    const server = createSiteServer(out);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const home = await fetch(`${base}/`);
      assert.equal(home.status, 200);
      assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.match(home.headers.get('content-security-policy') ?? '', /connect-src 'self' https:\/\/idea-factory\.1426davejobs\.workers\.dev/);
      assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
      assert.match(await home.text(), /<title>PR Receipt: what did this pull request cost/);
      for (const path of ['/privacy', '/terms']) {
        const r = await fetch(base + path);
        assert.equal(r.status, 200, path);
        assert.equal(canonicalOf(await r.text()), `https://pr-receipt.vercel.app${path}`);
      }
      const png = await fetch(`${base}/og.png`);
      assert.equal(png.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await png.arrayBuffer()), drawShareImage());
      assert.equal((await fetch(`${base}/robots.txt`)).headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal((await fetch(`${base}/sitemap.xml`)).headers.get('content-type'), 'application/xml; charset=utf-8');
      for (const path of ['/nope', '/%2e%2e/package.json', '/..%2fpackage.json', '/%00']) {
        assert.equal((await fetch(base + path)).status, 404, path);
      }
      assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('maps paths the way cleanUrls does', async () => {
    assert.equal(await resolveFile(out, '/'), join(out, 'index.html'));
    assert.equal(await resolveFile(out, '/privacy'), join(out, 'privacy.html'));
    assert.equal(await resolveFile(out, '/terms.html'), join(out, 'terms.html'));
    assert.equal(await resolveFile(out, '/../vercel.json'), null);
    assert.equal(await resolveFile(out, '/%E0%A4%A'), null);
  });
});

describe('site: deploy config', () => {
  it('vercel.json builds the site with npm run site:build into site/out, with clean URLs', async () => {
    const vercel = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(vercel.buildCommand, 'npm run site:build');
    assert.match(pkg.scripts['site:build'], /site\/build\.ts$/);
    assert.equal(vercel.outputDirectory, relative(ROOT, DEFAULT_OUT));
    assert.equal(vercel.cleanUrls, true);
    assert.equal(vercel.framework, null);
    // The npm package ships dist/ at the root only, never the website build.
    assert.deepEqual(pkg.files, ['dist', 'prices.json', 'README.md']);
  });

  it("the CSP lets the beacon reach RepoHQ and allows nothing else off-site", () => {
    const csp = vercelHeaders()['content-security-policy'];
    const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    assert.deepEqual(directives['connect-src'], ["'self'", new URL(SIGNAL_URL).origin]);
    assert.deepEqual(directives['script-src'], ["'self'"]);
    assert.deepEqual(directives['default-src'], ["'self'"]);
    assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
  });

  it('.provision asks the broker for the Vercel project and the Stripe payment link', async () => {
    assert.equal(
      await readFile(join(ROOT, '.provision'), 'utf8'),
      'vercel project pr-receipt\nrequest "Stripe payment link for pr-receipt: $9/month, per REVENUE.md"\n',
    );
  });

  it('the build output directory is git-ignored, and not named like the npm package dist/', async () => {
    assert.equal(relative(ROOT, DEFAULT_OUT), join('site', 'out'));
    assert.match(await readFile(join(ROOT, '.gitignore'), 'utf8'), /^site\/out\/$/m);
  });
});
