// Local preview of docs/ on http://localhost:5178 (dev only; never deployed).
// /__devpass hands the local passphrase to the browser so testing doesn't need it typed.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__devpass') {
    const s = JSON.parse(await readFile(join(process.env.USERPROFILE, '.house-hunt', 'secret.json'), 'utf8'));
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end(s.passphrase);
  }
  const p = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try { const b = await readFile(p); res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(b); }
  catch { res.writeHead(404); res.end('not found'); }
}).listen(5178, '127.0.0.1', () => console.log('serving docs on http://localhost:5178'));
