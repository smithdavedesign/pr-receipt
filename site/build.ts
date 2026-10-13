// `npm run site:build [-- --out <dir>]`: writes the static website to site/out (Vercel's output directory,
// see vercel.json; not "dist", so it can't be mistaken for the npm package's dist/): the three pages,
// robots.txt, sitemap.xml, the share image and the static assets.
// No dependencies and no network: the sample receipt is rendered by prreceipt's own code from
// site/sample.prreceipt.json, and the share image is drawn by site/og-image.ts.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReceiptFile } from '../src/receipt-file.ts';
import { renderReceipt } from '../src/receipt.ts';
import { markdownToHtml } from './markdown.ts';
import { drawShareImage } from './og-image.ts';
import { PAGES, SHARE_IMAGE, renderPage, robotsTxt, siteConfig, sitemapXml, type SiteConfig } from './pages.ts';

const SITE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = join(SITE, 'out');
export const SAMPLE_RECEIPT = join(SITE, 'sample.prreceipt.json');
const STATIC = ['site.css', 'site.js', 'favicon.svg'];

/** The home page's sample: `prreceipt export` output for the screenshot demo (`npm run site:sample`). */
export async function sampleReceiptHtml(path = SAMPLE_RECEIPT): Promise<string> {
  const { receipt } = parseReceiptFile(await readFile(path, 'utf8'), relative(process.cwd(), path) || path);
  return markdownToHtml(renderReceipt(receipt));
}

export interface BuildResult {
  config: SiteConfig;
  warnings: string[];
  /** Files written, relative to the output directory. */
  files: string[];
}

export async function buildSite(outDir: string, env: Record<string, string | undefined>): Promise<BuildResult> {
  const { config, warnings } = siteConfig(env);
  const sample = await sampleReceiptHtml();
  const files = new Map<string, string | Buffer>();
  for (const page of PAGES) files.set(page.file, renderPage(page, config, sample));
  files.set('robots.txt', robotsTxt(config));
  files.set('sitemap.xml', sitemapXml(config));
  files.set(SHARE_IMAGE.path.slice(1), drawShareImage());

  await mkdir(outDir, { recursive: true });
  for (const [name, content] of files) await writeFile(join(outDir, name), content);
  for (const name of STATIC) await copyFile(join(SITE, 'static', name), join(outDir, name));
  return { config, warnings, files: [...files.keys(), ...STATIC].sort() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  if ((at !== -1 && !args[at + 1]) || args.length !== (at === -1 ? 0 : 2)) {
    console.error('usage: node site/build.ts [--out <dir>]');
    process.exit(1);
  }
  const out = at === -1 ? DEFAULT_OUT : resolve(args[at + 1]);
  try {
    const { config, warnings, files } = await buildSite(out, process.env);
    for (const w of warnings) console.warn(`site: ${w}`);
    const buy = config.paymentLink ? 'on' : 'off (STRIPE_PAYMENT_LINK not set)';
    const beacon = config.env === 'production' ? 'on' : 'off (not a Vercel production build)';
    console.log(`site: ${files.length} files in ${relative(process.cwd(), out) || '.'} for ${config.url}; Buy button ${buy}; visit beacon ${beacon}`);
  } catch (e) {
    console.error(`site: ${(e as Error).message}`);
    process.exit(1);
  }
}
