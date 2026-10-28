import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ...['app', 'crdt', 'store', 'backup', 'peer'].map(name => [`/src/${name}.js`, [`src/${name}.js`, 'text/javascript; charset=utf-8']]),
]);

export function createAppServer() {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; }
    catch { res.writeHead(400); res.end(); return; }
    const asset = assets.get(path);
    if (!asset) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const body = await readFile(new URL(asset[0], ROOT));
      res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(500); res.end('Asset unavailable'); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4178);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
  const server = createAppServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Fieldnotes: http://127.0.0.1:${port} (static files only; notes stay in your browser)`));
}
