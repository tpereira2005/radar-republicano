// Servidor local de testes: serve public/ e a mesma função de /api/state que corre na Vercel.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('../api/state.js');

const root = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  if (req.url.startsWith('/api/state')) return handler(req, res);
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('404'); }
  res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(f).pipe(res);
}).listen(process.env.PORT || 5190, () => console.log('http://localhost:' + (process.env.PORT || 5190)));
