// The public website: three static pages (home, privacy, terms) plus robots.txt and sitemap.xml, rendered at
// build time by site/build.ts. Every page gets its own <title> and description, a canonical URL, Open Graph and
// Twitter card tags with the 1200×630 share image, and SoftwareApplication JSON-LD with the $9/month offer.
//
// Configuration comes from the build's environment (Vercel's, in production) and is checked here:
//   STRIPE_PAYMENT_LINK            the Buy button's target; no valid https link → no Buy button
//   VERCEL_ENV                     the visit beacon only runs in a "production" build
//   SITE_URL                       canonical origin; else https://$VERCEL_PROJECT_PRODUCTION_URL, else the default
import { escapeHtml } from './markdown.ts';
import { HEIGHT, SHARE_RECEIPT, WIDTH } from './og-image.ts';

export const REPO_URL = 'https://github.com/smithdavedesign/pr-receipt';
export const ISSUES_URL = `${REPO_URL}/issues`;
/** package.json's "license": "MIT". */
const MIT_URL = 'https://opensource.org/licenses/MIT';
export const DEFAULT_SITE_URL = 'https://pr-receipt.vercel.app';
export const NAME = 'PR Receipt';
/** REVENUE.md: $9/month per team, flat, up to 10 developers. */
export const PRICE = { amount: '9.00', currency: 'USD', text: '$9/month' } as const;
export const REFUND_DAYS = 14;
export const SHARE_IMAGE = {
  path: '/og.png',
  width: WIDTH,
  height: HEIGHT,
  alt: `A PR Receipt for ${SHARE_RECEIPT.branch}: ${SHARE_RECEIPT.total} across Claude Code and Codex, ${SHARE_RECEIPT.perLine} per changed line.`,
} as const;

export interface SiteConfig {
  /** Canonical origin, no trailing slash. */
  url: string;
  /** A checked https URL for the Buy button, or null to leave the button out. */
  paymentLink: string | null;
  /** VERCEL_ENV at build time ("production", "preview", "development") or "" outside Vercel. */
  env: string;
}

type Env = Record<string, string | undefined>;

export class SiteConfigError extends Error {}

function siteUrl(env: Env): string {
  const explicit = env.SITE_URL?.trim();
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const raw = explicit || (vercelHost ? `https://${vercelHost}` : DEFAULT_SITE_URL);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SiteConfigError(`${explicit ? 'SITE_URL' : 'VERCEL_PROJECT_PRODUCTION_URL'} is not a valid URL; expected e.g. https://example.com`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new SiteConfigError(`${explicit ? 'SITE_URL' : 'VERCEL_PROJECT_PRODUCTION_URL'} must be a plain https:// origin`);
  }
  return url.origin;
}

/** The link as the browser will follow it, or null (with a reason when a value was set but unusable). */
export function paymentLink(value: string | undefined): { link: string | null; warning?: string } {
  const raw = value?.trim();
  if (!raw) return { link: null };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { link: null, warning: 'STRIPE_PAYMENT_LINK is not a URL, so the Buy button is hidden' };
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return { link: null, warning: 'STRIPE_PAYMENT_LINK must be a plain https:// link, so the Buy button is hidden' };
  }
  return { link: url.href };
}

export function siteConfig(env: Env): { config: SiteConfig; warnings: string[] } {
  const pay = paymentLink(env.STRIPE_PAYMENT_LINK);
  const vercelEnv = env.VERCEL_ENV?.trim() ?? '';
  return {
    config: { url: siteUrl(env), paymentLink: pay.link, env: /^[a-z]{1,20}$/.test(vercelEnv) ? vercelEnv : '' },
    warnings: pay.warning ? [pay.warning] : [],
  };
}

export interface Page {
  path: '/' | '/privacy' | '/terms';
  /** File in the build output; Vercel's cleanUrls serves privacy.html at /privacy. */
  file: string;
  title: string;
  description: string;
  /** Last real change to the page's content, for the sitemap. */
  updated: string;
  body: (config: SiteConfig, sample: string) => string;
}

export const canonical = (config: SiteConfig, page: Pick<Page, 'path'>): string => config.url + page.path;

export function jsonLd(config: SiteConfig): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: NAME,
    alternateName: 'prreceipt',
    description: HOME.description,
    url: `${config.url}/`,
    image: config.url + SHARE_IMAGE.path,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux',
    softwareRequirements: 'Node.js 22.18 or later, git',
    license: MIT_URL,
    sameAs: [REPO_URL],
    offers: {
      '@type': 'Offer',
      name: 'Team Pack',
      description: 'Per team, up to 10 developers, billed monthly',
      price: PRICE.amount,
      priceCurrency: PRICE.currency,
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: PRICE.amount,
        priceCurrency: PRICE.currency,
        referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON', unitText: 'month' },
      },
      url: `${config.url}/#pricing`,
    },
  };
}

const attr = escapeHtml;

function head(page: Page, config: SiteConfig): string {
  const url = canonical(config, page);
  const image = config.url + SHARE_IMAGE.path;
  // "<" escaped so no string in the data can close the script element.
  const ld = JSON.stringify(jsonLd(config)).replace(/</g, '\\u003c');
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<meta name="description" content="${attr(page.description)}">
<link rel="canonical" href="${attr(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${NAME}">
<meta property="og:title" content="${attr(page.title)}">
<meta property="og:description" content="${attr(page.description)}">
<meta property="og:url" content="${attr(url)}">
<meta property="og:image" content="${attr(image)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${SHARE_IMAGE.width}">
<meta property="og:image:height" content="${SHARE_IMAGE.height}">
<meta property="og:image:alt" content="${attr(SHARE_IMAGE.alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${attr(page.title)}">
<meta name="twitter:description" content="${attr(page.description)}">
<meta name="twitter:image" content="${attr(image)}">
<meta name="twitter:image:alt" content="${attr(SHARE_IMAGE.alt)}">
<meta name="theme-color" content="#101418">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
<script type="application/ld+json">${ld}</script>
<script type="module" src="/site.js"></script>
</head>`;
}

function buyButton(config: SiteConfig, className: string, label: string): string {
  if (!config.paymentLink) return '';
  return `<a class="${className}" href="${attr(config.paymentLink)}" data-track="checkout">${label}</a>`;
}

function topBar(config: SiteConfig): string {
  return `<header class="top"><div class="wrap">
<a class="brand" href="/"><img src="/favicon.svg" alt="" width="24" height="24">${NAME}</a>
<nav aria-label="Main"><a href="/#pricing">Pricing</a><a href="${REPO_URL}">GitHub</a>${buyButton(config, 'buy buy-small', 'Get Team Pack')}</nav>
</div></header>`;
}

function footer(): string {
  return `<footer class="foot"><div class="wrap">
<p>${NAME} · free and open source (MIT)</p>
<nav aria-label="Footer"><a href="${REPO_URL}">GitHub</a><a href="${ISSUES_URL}">Contact</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
</div></footer>`;
}

/** The commands a visitor copies (the "activate" event): run from a clone until prreceipt is on npm. */
export const TRY_COMMANDS = ['git clone https://github.com/smithdavedesign/pr-receipt ~/pr-receipt', 'cd your-repo', 'node ~/pr-receipt/src/bin.ts show'];

const HOME: Page = {
  path: '/',
  file: 'index.html',
  title: 'PR Receipt: what did this pull request cost in AI tokens?',
  description:
    'A free CLI that adds up the Claude Code and Codex tokens each git branch used and posts the cost on the pull request. Your logs never leave your machine.',
  updated: '2026-10-13',
  body: (config, sample) => `<main class="home"><div class="wrap">
<div class="pitch">
<p class="eyebrow">Free CLI · Claude Code + Codex · prompts never leave your machine</p>
<h1>What did this pull request cost in AI tokens?</h1>
<p class="lead">PR Receipt reads the Claude Code and Codex logs already on your machine, adds up what each git branch spent, and posts it on the pull request as one receipt comment.</p>
<div class="try">
<div class="try-head"><span>Try it in one of your repos · Node 22.18+, git</span><button type="button" class="copy" data-copy="try-command" hidden>Copy</button></div>
<pre id="try-command" data-command><code>${TRY_COMMANDS.map(escapeHtml).join('\n')}</code></pre>
</div>
</div>
<figure class="sample">
<figcaption>What lands on the pull request <span>sample data</span></figcaption>
<div class="comment"><div class="who"><b>github-actions</b> bot commented on #42</div><div class="md">${sample}</div></div>
</figure>
<section id="pricing" class="plans" aria-label="Pricing">
<div class="plan">
<h2>Free <span class="price">$0</span></h2>
<p>The whole CLI and the GitHub Action, MIT licensed.</p>
</div>
<div class="plan pro">
<h2>Team Pack <span class="price">${PRICE.text} per team</span></h2>
<p>Help setting up the Action and the cost-per-PR report on your repos, in a private repo for your team. Up to 10 developers.</p>
${
  config.paymentLink
    ? `<p class="cta">${buyButton(config, 'buy', 'Get Team Pack')}<span>Checkout by Stripe. Cancel any time; ${REFUND_DAYS}-day refund.</span></p>`
    : `<p class="cta"><span>Not on sale yet. Would your team pay for it? <a href="${ISSUES_URL}">Say so in an issue</a>.</span></p>`
}
</div>
</section>
</div></main>`,
};

const PRIVACY: Page = {
  path: '/privacy',
  file: 'privacy.html',
  title: 'Privacy | PR Receipt',
  description:
    'What PR Receipt collects: nothing from the CLI or your logs. This site sets no cookies and counts three anonymous events: visit, activate and checkout.',
  updated: '2026-10-13',
  body: () => `<main class="doc"><div class="wrap narrow">
<h1>Privacy</h1>
<p class="updated">Last updated 13 October 2026</p>
<p><strong>Short version:</strong> the prreceipt tool collects nothing. This website sets no cookies and counts three kinds of anonymous event.</p>

<h2>The prreceipt CLI and GitHub Action</h2>
<ul>
<li>prreceipt reads the Claude Code and Codex session logs on your own machine. It never uploads them, and it has no telemetry: it reports nothing about you or your usage to anyone, us included.</li>
<li><code>show</code> and <code>export</code> make no network calls. <code>comment</code> and <code>report</code> talk only to GitHub, through your own <code>gh</code> login.</li>
<li>A receipt (the PR comment, or <code>.prreceipt.json</code>) holds totals only: branch, base and model names, token counts, costs, number of sessions and times. Never prompts, responses, code, file paths or session ids.</li>
<li>The GitHub Action runs in your repository's own workflow, with that workflow's token, and posts the same comment.</li>
</ul>

<h2>This website</h2>
<ul>
<li>No cookies, accounts, forms, ads, or third-party scripts and fonts.</li>
<li>To count real use, the site sends three kinds of event to RepoHQ (<code>repohq.vercel.app</code>), the dashboard the maintainer tracks this project with:
<ul>
<li><strong>visit</strong>: when you open a page, once per browser session;</li>
<li><strong>activate</strong>: the first time you copy the try-it command on the home page, once per browser;</li>
<li><strong>checkout</strong>: when you click the button to buy Team Pack.</li>
</ul></li>
<li>Each event holds three things: the product (<code>pr-receipt</code>), the event's name, and the address of the other website that linked you here, if any. Addresses on this site are never sent, and neither is a cookie or any identifier. Your browser's session and local storage remember that an event was sent; that stays on your device.</li>
<li>Nothing is sent from automated browsers, from preview deployments, or when your browser has <code>repohq:notrack</code> in local storage. To opt out, run <code>localStorage.setItem('repohq:notrack', '1')</code> in your browser's console on this site.</li>
<li>Like every website, the hosts (Vercel, for this site and for RepoHQ) receive your IP address and browser details with each request and keep standard server logs. PR Receipt doesn't use them to identify anyone.</li>
</ul>

<h2>If you buy Team Pack</h2>
<p>Stripe runs the checkout and handles your card details; we never see them. We get what Stripe passes to sellers (your name, email address and billing country) and use it only to deliver Team Pack, send invoices and answer you. We'll ask for a GitHub username to invite your team to its private repo.</p>

<h2>Contact</h2>
<p>For questions, or to have anything we hold about you deleted, open an issue at <a href="${ISSUES_URL}">github.com/smithdavedesign/pr-receipt/issues</a>. Issues are public: if your question is private, say so there without the details, and we'll move to another channel.</p>
</div></main>`,
};

const TERMS: Page = {
  path: '/terms',
  file: 'terms.html',
  title: 'Terms | PR Receipt',
  description: `Terms for PR Receipt: free MIT-licensed software with no warranty, costs that are estimates rather than bills, and Team Pack at ${PRICE.text} per team.`,
  updated: '2026-10-13',
  body: () => `<main class="doc"><div class="wrap narrow">
<h1>Terms</h1>
<p class="updated">Last updated 13 October 2026</p>

<h2>The software</h2>
<p>prreceipt and its GitHub Action are free, open-source software under the <a href="${MIT_URL}">MIT License</a>. That license governs the code; these terms cover this website and Team Pack.</p>

<h2>Estimates, not bills</h2>
<p>Costs are API-equivalent estimates: token counts from your local logs multiplied by list prices, plus any overrides you set. They are not your invoice from Anthropic or OpenAI, and they can be off (missing logs, sessions without a branch, price changes). Check your provider's billing before relying on a number.</p>

<h2>No warranty</h2>
<p>PR Receipt is provided "as is", without warranty of any kind, express or implied, including merchantability, fitness for a particular purpose and non-infringement. The maintainer is not liable for any claim, damages or other liability arising from the software, this website or Team Pack, including wrong costs or comments posted on your pull requests. You decide what gets posted where; on a public repository, a receipt comment is public.</p>

<h2>Team Pack</h2>
<ul>
<li><strong>Price:</strong> ${PRICE.text} per team (flat, up to 10 developers), billed monthly in US dollars through Stripe.</li>
<li><strong>What you get:</strong> help setting up the GitHub Action and the cost-per-PR report on your repositories, in a private GitHub repository for your team. The invite goes out within a day of checkout.</li>
<li><strong>Cancelling:</strong> any time, by asking in an issue. The subscription stops renewing, and you keep access until the end of the month you paid for.</li>
<li><strong>Refunds:</strong> ask within ${REFUND_DAYS} days of a payment and it is refunded in full.</li>
</ul>

<h2>Changes</h2>
<p>If these terms change, the new version is posted here with a new date. A price change applies to Team Pack from your next billing month, and only after we tell you by email.</p>

<h2>Contact</h2>
<p>Open an issue at <a href="${ISSUES_URL}">github.com/smithdavedesign/pr-receipt/issues</a>.</p>
</div></main>`,
};

export const PAGES: readonly Page[] = [HOME, PRIVACY, TERMS];

export function renderPage(page: Page, config: SiteConfig, sample: string): string {
  return `<!doctype html>
<html lang="en" data-env="${attr(config.env)}">
${head(page, config)}
<body>
${topBar(config)}
${page.body(config, sample)}
${footer()}
</body>
</html>
`;
}

export function robotsTxt(config: SiteConfig): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${config.url}/sitemap.xml\n`;
}

export function sitemapXml(config: SiteConfig): string {
  const urls = PAGES.map((p) => `  <url>\n    <loc>${escapeHtml(canonical(config, p))}</loc>\n    <lastmod>${p.updated}</lastmod>\n  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
