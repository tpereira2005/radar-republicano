// GET /api/tick?s=<segredo>: chamado pelo GitHub Actions de 30 em 30 s durante a noite.
// Recolhe o estado, compara com o anterior (guardado no Blob) e envia as notificações push.
'use strict';
const { collect } = require('../lib/radar.js');
const { readJson, writeJson, summarize, diff, send } = require('../lib/push.js');

let memo = null;

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
    // com a função "quente", reutiliza o último estado em memória e poupa leituras ao Blob
    const prev = memo && Date.now() - memo.at < 10 * 60000 ? memo.s : await readJson('state/last.json', null);
    memo = { s: cur, at: Date.now() };
    const events = prev ? diff(prev, cur, state) : [];
    // o plano grátis do Blob tem poucas escritas por mês: só se grava quando algo muda
    if (!prev || JSON.stringify(prev) !== JSON.stringify(cur)) await writeJson('state/last.json', cur);
    if (events.length) {
      const log = await readJson('state/events.json', []);
      const now = new Date().toISOString();
      await writeJson('state/events.json', events.map((e) => ({ ...e, at: now })).concat(log).slice(0, 300));
    }
    const out = await send(events);
    res.end(JSON.stringify({ ok: true, at: state.generatedAt, events: events.map((e) => e.title), ...out, errors: state.errors }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
