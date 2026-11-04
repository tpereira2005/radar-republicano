// GET /api/push: chave pública VAPID. POST: guarda uma subscrição. DELETE: remove-a.
'use strict';
const { addSub, removeSub } = require('../lib/push.js');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 8000) reject(new Error('demasiado grande')); });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.end(JSON.stringify({ key: process.env.VAPID_PUBLIC_KEY || null }));
    const body = JSON.parse((await readBody(req)) || '{}');
    const sub = body.subscription;
    // só serviços de push reais (Google, Mozilla, Apple, Microsoft) e chaves com o formato certo
    let host = '';
    try { host = new URL(sub && sub.endpoint).hostname; } catch (e) { /* endereço inválido */ }
    const okHost = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/.test(host);
    const okKeys = sub && sub.keys && /^[\w-]{80,100}$/.test(sub.keys.p256dh || '') && /^[\w-]{16,30}$/.test(sub.keys.auth || '');
    if (!okHost || (req.method === 'POST' && !okKeys)) {
      res.statusCode = 400; return res.end('{"error":"subscrição inválida"}');
    }
    if (req.method === 'POST') await addSub({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, level: ['senado', 'principais', 'tudo'].includes(body.level) ? body.level : 'tudo' });
    else if (req.method === 'DELETE') await removeSub(sub.endpoint);
    else { res.statusCode = 405; return res.end('{}'); }
    res.end('{"ok":true}');
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
