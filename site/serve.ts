// `npm run site:serve [-- <dir>] [--port <n>]`: serves a built site on 127.0.0.1 the way Vercel's cleanUrls
// does (/privacy → privacy.html, / → index.html), with vercel.json's headers (the CSP included), for a local
// look and for `npm run screenshots`. Prints "site: serving <dir> on http://127.0.0.1:<port>" once it listens.
// GET and HEAD only, nothing outside <dir>.
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OUT } from './build.ts';

export const VERCEL_JSON = fileURLToPath(new URL('../vercel.json', import.meta.url));

/** The headers vercel.json sets on every path ("source": "/(.*)"). */
export function vercelHeaders(path = VERCEL_JSON): Record<string, string> {
  const config = JSON.parse(readFileSync(path, 'utf8')) as { headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
  const all = config.headers?.filter((h) => h.source === '/(.*)').flatMap((h) => h.headers) ?? [];
  return Object.fromEntries(all.map((h) => [h.key.toLowerCase(), h.value]));
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The file for a request path, or null: "/" → index.html, "/privacy" → privacy.html, "/og.png" → og.png. */
export async function resolveFile(root: string, urlPath: string): Promise<string | null> {
  let path: string;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (path.includes('\0') || !path.startsWith('/')) return null;
  const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
  if (file !== root && !file.startsWith(root + sep)) return null;
  for (const candidate of extname(file) ? [file] : [`${file}.html`, join(file, 'index.html')]) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

export function createSiteServer(dir: string): Server {
  const root = resolve(dir);
  const headers = vercelHeaders();
  return createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, allow: 'GET, HEAD' }).end();
      return;
    }
    const file = await resolveFile(root, new URL(req.url ?? '/', 'http://localhost').pathname);
    if (!file) {
      res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end('not found\n');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { ...headers, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--port');
  const port = at === -1 ? 4173 : Number(args[at + 1]);
  const rest = at === -1 ? args : args.filter((_, i) => i !== at && i !== at + 1);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || rest.length > 1) {
    console.error('usage: node site/serve.ts [dir] [--port <n>]');
    process.exit(1);
  }
  const dir = resolve(rest[0] ?? DEFAULT_OUT);
  if (!(await isFile(join(dir, 'index.html')))) {
    console.error(`site: no index.html in ${relative(process.cwd(), dir) || '.'}; run npm run site:build first`);
    process.exit(1);
  }
  const server = createSiteServer(dir);
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actual = typeof address === 'object' && address ? address.port : port;
    console.log(`site: serving ${relative(process.cwd(), dir) || '.'} on http://127.0.0.1:${actual}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
}
