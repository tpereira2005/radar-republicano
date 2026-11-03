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
    if (url.searchParams.get('test') === '1') {
      // aviso de teste para todas as subscrições (confirma chaves VAPID, Blob e envio)
      const out = await send([{ tag: 'teste', title: 'Teste do Radar R', body: 'Se estás a ver isto, as notificações push funcionam.', url: '/' }], true);
      return res.end(JSON.stringify({ ok: true, test: true, ...out }));
    }
    const state = await collect();
    // lê sempre o último estado guardado: várias instâncias da função não podem comparar com estados diferentes
    const prev = await readJson('state/last.json', null, true);
    const cur = summarize(state, prev);
    const events = prev ? diff(prev, cur, state) : [];
    // primeiro envia (se o Blob esgotar a quota, as notificações continuam a sair), depois grava
    const out = await send(events).catch((e) => ({ sendError: String(e.message || e) }));
    const writeErrors = [];
    // o plano grátis do Blob tem poucas escritas por mês: só se grava quando algo muda
    if (!prev || JSON.stringify(prev) !== JSON.stringify(cur)) await writeJson('state/last.json', cur).catch((e) => writeErrors.push('last: ' + e.message));
    if (events.length) {
      try {
        const log = await readJson('state/events.json', [], true);
        const now = new Date().toISOString();
        await writeJson('state/events.json', events.map((e) => ({ ...e, at: now })).concat(log).slice(0, 300));
      } catch (e) { writeErrors.push('events: ' + e.message); }
    }
    res.end(JSON.stringify({ ok: true, at: state.generatedAt, events: events.map((e) => e.title), ...out, writeErrors, errors: state.errors }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
