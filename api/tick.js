// GET /api/tick?s=<segredo>: chamado pelo GitHub Actions de 30 em 30 s durante a noite.
// Recolhe o estado, compara com o anterior (guardado no Blob) e envia as notificações push.
'use strict';
const { collect } = require('../lib/radar.js');
const { readJson, writeJson, summarize, diff, send } = require('../lib/push.js');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'http://localhost');
  if (!process.env.TICK_SECRET || url.searchParams.get('s') !== process.env.TICK_SECRET) {
    res.statusCode = 403; return res.end('{"error":"proibido"}');
  }
  try {
    const state = await collect();
    const cur = summarize(state);
    const prev = await readJson('state/last.json', null);
    const events = prev ? diff(prev, cur, state) : [];
    await writeJson('state/last.json', cur);
    const out = await send(events);
    res.end(JSON.stringify({ ok: true, at: state.generatedAt, events: events.map((e) => e.title), ...out, errors: state.errors }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
