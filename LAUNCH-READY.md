# Launch-ready: PR Receipt

PR Receipt is a CLI plus a GitHub Action. This change gives it a public website and leaves the product
itself alone: nothing in `src/`, `action.yml` or the CLI's behaviour changed. `npm test` passes (377 tests:
338 existing + 39 for the site), and so does `npm run typecheck`.

## What I did

1. **Search and sharing.** `site/` is a small static site with three public pages: `/` (home), `/privacy`
   and `/terms`. `site/build.ts` writes it to `site/out/`, with no dependencies and no network. Each page gets:
   - its own `<title>` and meta description;
   - a canonical URL;
   - Open Graph and Twitter `summary_large_image` tags pointing at `/og.png` (1200×630);
   - SoftwareApplication JSON-LD with an `Offer` of $9.00 USD per month (`UnitPriceSpecification`,
     `unitCode: MON`).

   The build also writes `robots.txt` (allow all, `Sitemap:` line) and `sitemap.xml` (the three pages). The
   share image is drawn pixel by pixel in `site/og-image.ts`: a dot-matrix receipt with the sample's numbers,
   encoded as a PNG with `node:zlib`. Nothing is copied from the web.
2. **Privacy and terms**, linked from every footer next to GitHub and Contact (the repo's issues).
   - Privacy: the CLI collects nothing and has no telemetry. The site sets no cookies. It names the three
     beacon events and what each one carries, how to opt out, and Vercel's own server logs. If someone
     buys, Stripe handles checkout.
   - Terms: MIT for the code, costs are estimates rather than bills, "as is" with no warranty, Team Pack at
     $9/month per team (flat, up to 10 developers), cancelling, and a refund line (see decisions).
3. **Payment.** A "Get Team Pack" button sits in the top bar and in the pricing block.
   - It links to `STRIPE_PAYMENT_LINK`, read when the site is built.
   - It is left out when the variable is unset or blank, or isn't a plain `https://` URL (that case logs a
     build warning that doesn't echo the value).
   - Without it, the pricing says "Not on sale yet … say so in an issue". No link is hard-coded, and a test
     checks that no `stripe.com` URL appears in the site, the scripts or the deploy config.
4. **Visit beacon** (`site/static/site.js`). It POSTs `{"slug":"pr-receipt","kind":…,"referrer":…}` as JSON to
   `https://idea-factory.1426davejobs.workers.dev/api/ideas/signal` with `keepalive: true` and `credentials: 'omit'`, and never
   waits for an answer.
   - `visit`: on every page, once per browser session (sessionStorage).
   - `activate`: the first time someone copies the try-it command on the home page, by the Copy button or by
     selecting and copying it. Once per browser (localStorage). **This is the core action the site can see:
     copying the command to run `prreceipt show`.** The CLI itself doesn't phone home, and adding that would
     break the "nothing leaves your machine" promise.
   - `checkout`: each click on a Buy button.
   - `referrer` is `document.referrer` only when its origin differs from `location.origin`, otherwise `null`.
   - Nothing is sent when `navigator.webdriver` is true, when the build isn't Vercel production
     (`VERCEL_ENV` is baked into `<html data-env>` at build time), or when localStorage `repohq:notrack`
     holds any value. If storage is blocked, nothing is sent either.
5. **Deployment.**
   - `vercel.json`: build command `npm run site:build`, output `site/out`, `cleanUrls`, and a CSP whose
     `connect-src` allows only the site itself and idea-factory.1426davejobs.workers.dev, plus `nosniff` and a referrer policy.
   - `.provision` has the two lines the pipeline runs through the credential broker.
6. **Tests.** `test/site.test.ts` (39 tests, part of `npm test`) covers:
   - the pages render, with unique titles and descriptions, canonical, OG, Twitter and JSON-LD;
   - footer links;
   - robots.txt and sitemap.xml;
   - the Buy button hidden without the variable, or with a bad value, and shown with a good one;
   - href escaping;
   - the PNG (signature, size, CRCs, pixels, and the numbers matching the sample receipt);
   - every beacon rule, against a stand-in `window`;
   - the preview server (clean URLs, the CSP header, no path traversal);
   - `vercel.json`, the CSP and `.provision`.
7. **Screenshots.** `npm run screenshots` does the whole run:
   - builds the site for production with the placeholder `STRIPE_PAYMENT_LINK=https://example.com/pay`;
   - starts it with `site/serve.ts` (which sends the same headers as `vercel.json`, CSP included) and waits
     until it answers on localhost;
   - runs `prreceipt export` and the Action for real on sample logs;
   - captures 6 PNGs (home, export and action-comment, each at 1280×800 and on an iPhone 13), then stops
     the server.

   It removes older PNGs it didn't write. That dropped `action-error-*.png`, to stay within six. I opened
   every PNG. They're at the top of README.md with a caption each.
8. This file.
9. **Self-review** against gstack's checklist (below).

Also changed:
- The demo data moved from `scripts/screenshots.mjs` to `scripts/demo.mjs`, so the screenshots and the
  site's sample receipt share it.
- `site/sample.prreceipt.json` is a real `prreceipt export` of that demo; regenerate it with
  `npm run site:sample`.
- The markdown-to-HTML helper moved to `site/markdown.ts`.
- README.md got a short "Website" section, and BUILD.md's infrastructure and deploy notes now mention the
  site.

## Decisions (made without asking)

- **No framework.** The product is a CLI, and the site is three pages. A Next.js app would add a large
  dependency tree (with install scripts disabled) for no gain. `site/build.ts` is a short TypeScript
  script that Node runs directly, like the rest of the repo. `robots.txt` and `sitemap.xml` are
  generated files: the static version of `robots.ts` and `sitemap.ts`.
- **Configuration is read at build time.**
  - `STRIPE_PAYMENT_LINK` and `VERCEL_ENV` are baked in when Vercel builds the site, so no
    `NEXT_PUBLIC_*` variable is needed.
  - The catch: **changing an env var needs a redeploy.**
  - The canonical origin is `SITE_URL`, else `https://$VERCEL_PROJECT_PRODUCTION_URL` (Vercel sets that to
    the production domain, so a custom domain is picked up on the next deploy), else
    `https://pr-receipt.vercel.app`.
- **Try-it command.** prreceipt isn't on npm yet, so the site says
  `git clone … ~/pr-receipt && node ~/pr-receipt/src/bin.ts show`. That works with Node ≥ 22.18 and no
  install, since the CLI has no runtime dependencies.
- **What Team Pack is.**
  - REVENUE.md's Team Pack would gate the team report and the Action. Both already ship free under MIT in
    the public repo, and this job doesn't change what the product does.
  - So the site sells what REVENUE.md says can be delivered by hand: help setting up the Action and the
    cost-per-PR report, in a private repo for the team, with the invite sent within a day of checkout.
  - The copy is in `site/pages.ts` (the home and terms pages).
- **Refunds.** REVENUE.md has a price but no refund line. The terms say: cancel any time by asking in an
  issue; access lasts to the end of the paid month; a full refund if asked within 14 days of a payment
  (`REFUND_DAYS`).
- **The $90/year option isn't shown**, because there's no payment link for it.
- **The beacon uses `fetch`, not `sendBeacon`.** `sendBeacon` always sends cookies, and the spec says no
  cookies.
- **Build output is `site/out`, not `site/dist`**, so it can never be mistaken for the npm package's `dist/`
  (`"files": ["dist"]`).
- **The share image shows the sample receipt's numbers.** A test fails if the sample and the image drift
  apart.

## How to check it

```sh
npm test                                   # 377 tests, all passing
npm run typecheck
npm run site:build                         # → site/out (Buy button off: no STRIPE_PAYMENT_LINK here)
STRIPE_PAYMENT_LINK=https://example.com/pay npm run site:build   # Buy button on
npm run site:serve                         # → http://127.0.0.1:4173 (/, /privacy, /terms, /robots.txt, /sitemap.xml, /og.png)
CHROMIUM_PATH=/path/to/chromium npm run screenshots              # docs/screenshots/*.png
```

After the first production deploy:
- View source on `/`, `/privacy` and `/terms`: title, description, canonical, `og:*`, `twitter:*` and the JSON-LD
  block. Open `/robots.txt`, `/sitemap.xml` and `/og.png`.
- Paste the URL into a card previewer (LinkedIn Post Inspector, opengraph.xyz) and into Google's Rich Results
  Test. The SoftwareApplication is valid, but there's no rating to show, so expect no rich result. No ratings
  were invented.
- Beacon: open the site in a normal browser with DevTools → Network.
  - Expect one POST to `idea-factory.1426davejobs.workers.dev/api/ideas/signal` with `"kind":"visit"`, and none on reload.
  - Click Copy: `"activate"` once.
  - Click Buy: `"checkout"`.
  - A preview deployment sends nothing.
  - The request is a CORS one with a JSON body: if the console shows a CORS error, RepoHQ's endpoint needs to
    answer the preflight. Events are dropped silently until it does.

## What's left for David

1. **The Stripe payment link.** `.provision` asks the broker for it: $9/month subscription, per REVENUE.md.
   - Put it in the Vercel project's Production env as **`STRIPE_PAYMENT_LINK`** and **redeploy**. The
     button appears only after a build.
   - In the link's settings, consider a custom field for the buyer's GitHub username (the invite needs it).
   - Consider turning on Stripe's customer portal so people can cancel on their own.
   - REVENUE.md says to offer it only once 3+ outside users run the free CLI. Until the variable is set, the
     site says "Not on sale yet".
2. **A custom domain, if you want one.** Add it in Vercel and redeploy. Canonical URLs, the sitemap and
   `og:image` follow it through `VERCEL_PROJECT_PRODUCTION_URL`, or set `SITE_URL` to pin it.
3. **Confirm the Team Pack promise and the 14-day refund** (`site/pages.ts`), or change them before turning
   the button on.
4. **Add a `LICENSE` file.** package.json says MIT, and so does the site, but the repo has no license text.
   GitHub's "Add file → LICENSE → MIT" with your name does it.
5. **Make the GitHub repo public** if it isn't yet. The try-it command clones it, and the footer links to it.
6. **After `npm publish`,** change `TRY_COMMANDS` in `site/pages.ts` to `npx prreceipt show`.
7. **In your own browser**, on the production domain, run `localStorage.setItem('repohq:notrack', '1')`.
8. **Vercel project settings.**
   - Node.js 22.x or 24.x: the site build runs TypeScript through Node's type stripping, which needs
     ≥ 22.18.
   - Keep "Automatically expose System Environment Variables" on: `VERCEL_ENV` and
     `VERCEL_PROJECT_PRODUCTION_URL` come from it.

## Self-review (gstack checklist)

Step 0:
- **Reuse.** The sample receipt is rendered by prreceipt's own `renderReceipt` from a real export, and the
  demo data and markdown renderer are shared with the screenshots.
- **Complexity.** It touches more than 8 files. Each one maps to a required deliverable, and there are two
  small classes (`Canvas`, `SiteConfigError`). Accepted.
- Search unavailable: proceeding with in-distribution knowledge only.
- There's no TODOS.md.
- **Distribution.** The site deploys through Vercel (`vercel.json` + `.provision`). npm publish was already
  on BUILD.md's list.

**Pass 1, CRITICAL: no findings.**
- SQL and data safety: not applicable (no database).
- Race conditions: nothing server-side. Two tabs copying in the same instant could both send `activate`;
  that's accepted for a usage count.
- XSS:
  - The receipt markdown is HTML-escaped.
  - The payment link must be https, is normalised by `URL` and is attribute-escaped. A test tries to break
    out of the href.
  - `VERCEL_ENV` is limited to `[a-z]`, and JSON-LD escapes `<`.
  - `site.js` only sets `textContent`.
  - The CSP allows no inline script or style, and a test checks the pages for both.
- LLM trust boundary: not applicable.
- Shell injection: every spawn uses argument arrays and no shell.
- Enum completeness: the new kinds `visit` / `activate` / `checkout` are traced through `track`, the
  `data-track` / `data-copy` attributes, the privacy page and the tests.

**Pass 2, INFORMATIONAL.**

Fixed:
- The share image's hard-coded numbers became one constant, tested against the sample.
- Added a test for the copy-button failure path.
- BUILD.md's "no `.provision`" and "nothing to host" notes were stale; updated.
- The terms linked "MIT License" to a repo with no LICENSE file; it now links to the MIT text.
- The build output was renamed `site/dist` → `site/out`.

Left:
- The repo still has no CI workflow of its own; that was already on BUILD.md's list.
- The beacon assumes RepoHQ answers CORS preflights.
