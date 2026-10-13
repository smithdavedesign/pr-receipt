// The website's only script: the Copy button on the home page, and RepoHQ's visit beacon (described on /privacy).
//
// Three events, each POSTed as JSON {slug, kind, referrer} to RepoHQ, fire-and-forget (keepalive, no cookies):
//   visit     every page, once per browser session (sessionStorage);
//   activate  the first copy of the try-it command, once per browser (localStorage). The CLI itself never
//             phones home, so copying the command to run it is the closest the site sees of the core action;
//   checkout  each click on a Buy button.
// The referrer is document.referrer only when another site sent the visitor, else null, so this site's own
// URLs (share links included) never leave the page. Nothing is sent from automated browsers
// (navigator.webdriver), from builds that aren't Vercel production (<html data-env>), or when localStorage
// "repohq:notrack" is set.

export const SIGNAL_URL = 'https://repohq.vercel.app/api/ideas/signal';
export const SLUG = 'pr-receipt';
export const NOTRACK_KEY = 'repohq:notrack';
export const VISIT_KEY = 'repohq:visit:pr-receipt';
export const ACTIVATE_KEY = 'repohq:activate:pr-receipt';
const COPIED_MS = 1500;

/**
 * The parts of `window` this script uses, so tests can pass a stand-in.
 * @typedef {Pick<Window, 'navigator' | 'document' | 'location' | 'localStorage' | 'sessionStorage' | 'fetch' | 'setTimeout'>} Win
 * @typedef {'visit' | 'activate' | 'checkout'} Kind
 */

/**
 * @param {string} referrer document.referrer
 * @param {string} origin location.origin
 * @returns {string | null} the referrer when it is another site's, else null
 */
export function externalReferrer(referrer, origin) {
  if (!referrer) return null;
  try {
    return new URL(referrer).origin === origin ? null : referrer;
  } catch {
    return null;
  }
}

/**
 * @param {Win} win
 * @returns {boolean} true when nothing may be sent
 */
export function trackingOff(win) {
  try {
    if (win.navigator.webdriver) return true;
    if (win.document.documentElement.dataset.env !== 'production') return true;
    return win.localStorage.getItem(NOTRACK_KEY) !== null;
  } catch {
    return true; // storage blocked: send nothing rather than risk counting twice
  }
}

/**
 * Marks `key` in `storage` and says whether it was unmarked before.
 * @param {Storage} storage
 * @param {string} key
 */
function firstTime(storage, key) {
  if (storage.getItem(key) !== null) return false;
  storage.setItem(key, '1');
  return true;
}

/**
 * @param {Win} win
 * @param {Kind} kind
 * @returns {boolean} whether a signal was sent
 */
export function track(win, kind) {
  if (trackingOff(win)) return false;
  try {
    if (kind === 'visit' && !firstTime(win.sessionStorage, VISIT_KEY)) return false;
    if (kind === 'activate' && !firstTime(win.localStorage, ACTIVATE_KEY)) return false;
    const body = JSON.stringify({ slug: SLUG, kind, referrer: externalReferrer(win.document.referrer, win.location.origin) });
    win
      .fetch(SIGNAL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'omit' })
      .catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * The element an event happened in (a text node's parent for selections), if any.
 * @param {EventTarget | null} target
 * @returns {Element | null}
 */
function elementOf(target) {
  const node = /** @type {Node | null} */ (target);
  if (!node) return null;
  const el = node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement;
  return el && typeof el.closest === 'function' ? el : null;
}

/**
 * @param {Win} win
 * @param {HTMLElement} button the Copy button; data-copy names the element whose text it copies
 */
function copyCommand(win, button) {
  const source = win.document.getElementById(button.dataset.copy ?? '');
  const text = source?.textContent?.trim();
  if (!text || !win.navigator.clipboard) return;
  const label = (/** @type {string} */ value) => {
    button.textContent = value;
    win.setTimeout(() => {
      button.textContent = 'Copy';
    }, COPIED_MS);
  };
  win.navigator.clipboard.writeText(text).then(
    () => label('Copied'),
    () => label('Select it to copy'),
  );
}

/** @param {Win} win */
export function start(win) {
  const doc = win.document;
  // The Copy button needs this script, so it is only shown once the script runs.
  for (const button of doc.querySelectorAll('[data-copy]')) /** @type {HTMLElement} */ (button).hidden = false;
  track(win, 'visit');
  doc.addEventListener('click', (event) => {
    const el = elementOf(event.target);
    if (!el) return;
    if (el.closest('[data-track="checkout"]')) track(win, 'checkout');
    const copy = /** @type {HTMLElement | null} */ (el.closest('[data-copy]'));
    if (copy) {
      copyCommand(win, copy);
      track(win, 'activate');
    }
  });
  // Selecting the commands and copying them by hand counts too.
  doc.addEventListener('copy', (event) => {
    if (elementOf(event.target)?.closest('[data-command]')) track(win, 'activate');
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') start(window);
