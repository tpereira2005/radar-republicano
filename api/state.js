// GET /api/state: estado completo do radar. A CDN da Vercel guarda a resposta 8 s,
// por isso, com muitas pessoas a ver, só há um pedido ao NYT de poucos em poucos segundos.
'use strict';
const { collect } = require('../lib/radar.js');

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const demoParam = url.searchParams.get('demo');
  const demo = demoParam != null ? Number(demoParam) : null;
  try {
    const body = await collect({ demo, source: url.searchParams.get('source') });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=8, stale-while-revalidate=30');
    res.end(JSON.stringify(body));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
