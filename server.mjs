import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api/index.mjs';
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, 'public');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png' };
export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res);
  let file = url.pathname === '/' || url.pathname.startsWith('/room/') ? '/index.html' : url.pathname;
  if (!/^\/[a-zA-Z0-9/_.-]+$/.test(file) || file.includes('..')) { res.writeHead(404); return res.end(); }
  const target = path.resolve(root, '.' + file);
  if (!target.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw Error('Not file');
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': file === '/index.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(await readFile(target));
  } catch { res.writeHead(404); res.end('Not found'); }
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => console.log(`Jamlink running at http://localhost:${port}`));
}
