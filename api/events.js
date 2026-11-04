// GET /api/events: acontecimentos da noite detetados pelo servidor (os mesmos das notificações push).
// Cache de 60 s na CDN para gastar poucas leituras do Blob.
'use strict';
const { readJson } = require('../lib/push.js');

module.exports = async (req, res) => {
  const [log, last] = await Promise.all([readJson('state/events.json', []), readJson('state/last.json', null)]);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=120');
  res.end(JSON.stringify({ events: log.map(({ tag, title, body, url, at }) => ({ tag, title, body, url, at })), hist: (last && last.hist) || null }));
};
