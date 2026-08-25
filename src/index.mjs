import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * මේක ඉතාම කුඩා server එකක් — npm dependency එකක්වත් නෑ, node එකෙන් කෙලින්ම දුවනවා.
 * වැඩ දෙකයි:
 *   1. /intx/* requests Coinbase INTX API එකට forward කරනවා
 *      (browser එකෙන් කෙලින්ම කරන්න බැරි නිසා — ඒ API එකේ CORS headers නෑ).
 *   2. build කරපු web app එක (apps2/web/dist) serve කරනවා.
 */

const PORT = Number(process.env.PORT ?? 3002);
const COINBASE = 'https://api.international.coinbase.com/api/v1';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIST = resolve(HERE, '../../web/dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** /intx/xxx එකක් Coinbase API එකට යවලා, උත්තරේ එහෙම්මම browser එකට දෙනවා. */
async function proxyToCoinbase(req, res, url) {
  const target = `${COINBASE}${url.pathname.slice('/intx'.length)}${url.search}`;
  try {
    const upstream = await fetch(target, { headers: { accept: 'application/json' } });
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      // Cache නොකර, හැම විටම අලුත් data.
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream_failed', message: String(err) }));
  }
}

/**
 * dist එකේ file එකක් යවනවා. හොයාගන්න බැරි path එකක් නම් index.html එක
 * යවනවා (single page app එකක් නිසා).
 */
async function serveStatic(req, res, url) {
  // `..` වගේ දේවල් වලින් dist එකෙන් පිටතට යන්න බැරි වෙන්න normalize කරනවා.
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\.]+)/, '');
  let filePath = join(WEB_DIST, rel);

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    filePath = join(WEB_DIST, 'index.html');
  }

  try {
    await stat(filePath);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found. `npm run build` in apps2/web first.');
    return;
  }

  res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/intx' || url.pathname.startsWith('/intx/')) {
    void proxyToCoinbase(req, res, url);
  } else {
    void serveStatic(req, res, url);
  }
});

server.listen(PORT, () => {
  console.log(`apps2 server: http://localhost:${PORT}  (serving ${WEB_DIST})`);
});
