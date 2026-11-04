// Notificações push: subscrições guardadas no Blob privado da Vercel e deteção de acontecimentos entre recolhas.
'use strict';
const crypto = require('node:crypto');
const { put, get, list, del } = require('@vercel/blob');
const webpush = require('web-push');

const OPT = { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' };

// strict: uma falha de leitura lança erro (em vez de devolver o valor por omissão e apagar o que lá está)
async function readJson(pathname, fallback, strict) {
  try {
    const r = await get(pathname, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return fallback;
    return JSON.parse(await new Response(r.stream).text());
  } catch (e) {
    if (strict && !/not.?found|404/i.test(String(e && (e.name + e.message)))) throw e;
    return fallback;
  }
}
const writeJson = (pathname, value) => put(pathname, JSON.stringify(value), OPT);

const subPath = (endpoint) => 'subs/' + crypto.createHash('sha1').update(endpoint).digest('hex') + '.json';
async function addSub(sub) { await writeJson(subPath(sub.endpoint), sub); }
async function removeSub(endpoint) {
  await del(subPath(endpoint)).catch(() => {});
  if (subsCache) subsCache.list = subsCache.list.filter((s) => s.endpoint !== endpoint);
}
// as subscrições ficam 5 minutos em memória: cada leitura do Blob conta para o limite grátis
let subsCache = null;
async function allSubs(fresh) {
  if (!fresh && subsCache && Date.now() - subsCache.at < 5 * 60000) return subsCache.list;
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix: 'subs/', cursor, limit: 1000 });
    const subs = await Promise.all(page.blobs.map((b) => readJson(b.pathname, null)));
    for (const s of subs) if (s && s.endpoint) out.push(s);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  subsCache = { list: out, at: Date.now() };
  return out;
}

// Resumo mínimo do estado para comparar com a recolha seguinte.
// Projeções e controlo nunca "desaparecem" (uma falha passageira da fonte não pode fazê-los reaparecer como novos);
// a liderança da estimativa só muda com folga (P(R) >= 65% ou <= 35%), para não avisar a cada oscilação.
function summarize(state, prev) {
  const p = prev || { calls: {}, lead: {}, ctrl: {} };
  const s = { calls: { ...p.calls }, lead: {}, ctrl: { ...p.ctrl }, hist: { S: [...((p.hist && p.hist.S) || [])], H: [...((p.hist && p.hist.H) || [])] } };
  for (const k of ['S', 'H']) {
    const g = state.control[k] && state.control[k].model && state.control[k].model.GOP;
    const list = s.hist[k], last = list[list.length - 1];
    if (g && g.p != null && (!last || Math.abs(last[1] - g.p) >= 0.02)) { list.push([state.generatedAt, Math.round(g.p * 1000) / 1000]); if (list.length > 200) list.shift(); }
  }
  for (const x of state.senate) if (x.call || x.runoff) s.calls['S:' + x.st] = x.call || 'RUNOFF';
  for (const x of state.governors) if (x.call || x.runoff) s.calls['G:' + x.st] = x.call || 'RUNOFF';
  for (const x of (state.house && state.house.watch) || []) if (x.call) s.calls['H:' + x.id] = x.call;
  for (const r of state.races) {
    const was = p.lead[r.id];
    if (r.radar.F < 25 || r.radar.pR == null) { if (was) s.lead[r.id] = was; continue; }
    if (r.radar.pR >= 0.65) s.lead[r.id] = 'R';
    else if (r.radar.pR <= 0.35) s.lead[r.id] = r.O.party;
    else if (was) s.lead[r.id] = was;
  }
  for (const k of ['S', 'H']) { const c = state.control[k]; if (c && c.winner) s.ctrl[k] = c.winner; }
  return s;
}

const STN = { FL: 'Florida', OH: 'Ohio', TX: 'Texas', MI: 'Michigan', NC: 'Carolina do Norte', ME: 'Maine', GA: 'Geórgia', IA: 'Iowa', AZ: 'Arizona', KS: 'Kansas', NH: 'New Hampshire' };
function diff(prev, cur, state) {
  const ev = [];
  for (const [k, who] of Object.entries(cur.calls)) {
    if (prev.calls[k] === who) continue;
    const [off, st] = k.split(':');
    if (off === 'H') {
      const h = ((state.house && state.house.watch) || []).find((y) => y.id === st) || {};
      const name = who === 'R' ? h.R : h.O;
      const flip = h.gained ? (who === 'R' ? ' e conquista o lugar' : ' e tira o lugar ao R') : '';
      ev.push({ tag: 'call-' + k, title: `AP: ${name || who} (${who}) vence ${st}${flip}`, body: `Câmara · ${h.zone || ''}`, url: '/#camara' });
      continue;
    }
    const list = off === 'S' ? state.senate : state.governors;
    const x = list.find((y) => y.st === st) || {};
    if (who === 'RUNOFF') {
      ev.push({ tag: 'runoff-' + k, title: `${STN[st] || st}: vai haver 2.ª volta`, body: `${off === 'S' ? 'Senado' : 'Governador'} · ninguém passou dos 50%`, url: '/' });
      continue;
    }
    const name = who === 'R' ? x.R : x.O;
    const flip = x.gained ? ' (conquista)' : '';
    ev.push({ tag: 'call-' + k, title: `AP: ${name || who} (${who}) vence${flip}`, body: `${off === 'S' ? 'Senado' : 'Governador'} · ${STN[st] || st}`, url: '/' });
  }
  for (const [id, who] of Object.entries(cur.lead)) {
    if (!prev.lead[id] || prev.lead[id] === who || cur.calls[(id.endsWith('-S') ? 'S:' : 'G:') + id.slice(0, 2)]) continue;
    const r = state.races.find((x) => x.id === id);
    if (!r) continue;
    ev.push({ tag: 'lead-' + id + '-' + who, title: `${STN[r.st]} (${r.office}): estimativa passa para ${who}`, body: `${who === 'R' ? r.R.name : r.O.name} · ${Math.round(r.radar.F)}% contado`, url: '/#' + id });
  }
  for (const [k, w] of Object.entries(cur.ctrl)) {
    if (prev.ctrl[k] === w) continue;
    ev.push({ tag: 'ctrl-' + k, title: `${w === 'GOP' ? 'Republicanos' : 'Democratas'} garantem ${k === 'S' ? 'o Senado' : 'a Câmara'}`, body: 'Segundo as projeções da AP', url: '/' });
  }
  return ev;
}

async function send(events, fresh) {
  if (!events.length) return { sent: 0, removed: 0 };
  webpush.setVapidDetails('mailto:radar@radar-republicano.vercel.app', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY); // lança erro se as chaves forem inválidas
  const subs = await allSubs(fresh);
  let sent = 0, removed = 0, failed = 0, lastError = null;
  // agrupa num único aviso quando há muitos de uma vez
  const payloads = events.length > 3
    ? [{ tag: 'batch', title: `${events.length} novidades no Radar R`, body: events.slice(0, 4).map((e) => e.title).join(' · '), url: '/' }]
    : events;
  await Promise.all(subs.map(async (s) => {
    for (const p of payloads) {
      try { await webpush.sendNotification(s, JSON.stringify(p), { TTL: 1800, urgency: 'high' }); sent++; } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { await removeSub(s.endpoint); removed++; return; }
        failed++; lastError = (e.statusCode || '') + ' ' + String(e.body || e.message || e).slice(0, 160);
      }
    }
  }));
  return { sent, removed, failed, lastError, subs: subs.length };
}

module.exports = { readJson, writeJson, addSub, removeSub, summarize, diff, send };
