// Notificações push: subscrições guardadas no Blob privado da Vercel e deteção de acontecimentos entre recolhas.
'use strict';
const crypto = require('node:crypto');
const { put, get, list, del } = require('@vercel/blob');
const webpush = require('web-push');

const OPT = { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' };

async function readJson(pathname, fallback) {
  try {
    const r = await get(pathname, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return fallback;
    return JSON.parse(await new Response(r.stream).text());
  } catch (e) {
    return fallback;
  }
}
const writeJson = (pathname, value) => put(pathname, JSON.stringify(value), OPT);

const subPath = (endpoint) => 'subs/' + crypto.createHash('sha1').update(endpoint).digest('hex') + '.json';
async function addSub(sub) { await writeJson(subPath(sub.endpoint), sub); }
async function removeSub(endpoint) { await del(subPath(endpoint)).catch(() => {}); }
async function allSubs() {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix: 'subs/', cursor, limit: 1000 });
    for (const b of page.blobs) { const s = await readJson(b.pathname, null); if (s && s.endpoint) out.push(s); }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// Resumo mínimo do estado para comparar com a recolha seguinte.
function summarize(state) {
  const s = { calls: {}, lead: {}, ctrl: {} };
  for (const x of state.senate) if (x.call) s.calls['S:' + x.st] = x.call;
  for (const x of state.governors) if (x.call) s.calls['G:' + x.st] = x.call;
  for (const r of state.races) if (r.radar.F >= 25 && r.radar.proj != null) s.lead[r.id] = r.radar.proj > 0 ? 'R' : r.O.party;
  for (const k of ['S', 'H']) { const c = state.control[k]; if (c && c.winner) s.ctrl[k] = c.winner; }
  return s;
}

const STN = { FL: 'Florida', OH: 'Ohio', TX: 'Texas', MI: 'Michigan', NC: 'Carolina do Norte', ME: 'Maine', GA: 'Geórgia', IA: 'Iowa', AZ: 'Arizona', KS: 'Kansas', NH: 'New Hampshire' };
function diff(prev, cur, state) {
  const ev = [];
  for (const [k, who] of Object.entries(cur.calls)) {
    if (prev.calls[k] === who) continue;
    const [off, st] = k.split(':');
    const list = off === 'S' ? state.senate : state.governors;
    const x = list.find((y) => y.st === st) || {};
    const name = who === 'R' ? x.R : x.O;
    const flip = x.inParty === false ? ' (conquista)' : '';
    ev.push({ tag: 'call-' + k, title: `AP: ${name || who} (${who}) vence${flip}`, body: `${off === 'S' ? 'Senado' : 'Governador'} · ${STN[st] || st}`, url: '/' });
  }
  for (const [id, who] of Object.entries(cur.lead)) {
    if (!prev.lead[id] || prev.lead[id] === who || cur.calls[(id.endsWith('-S') ? 'S:' : 'G:') + id.slice(0, 2)]) continue;
    const r = state.races.find((x) => x.id === id);
    ev.push({ tag: 'lead-' + id, title: `${STN[r.st]} (${r.office}): estimativa passa para ${who}`, body: `${who === 'R' ? r.R.name : r.O.name} · ${Math.round(r.radar.F)}% contado`, url: '/#' + id });
  }
  for (const [k, w] of Object.entries(cur.ctrl)) {
    if (prev.ctrl[k] === w) continue;
    ev.push({ tag: 'ctrl-' + k, title: `${w === 'GOP' ? 'Republicanos' : 'Democratas'} garantem ${k === 'S' ? 'o Senado' : 'a Câmara'}`, body: 'Segundo as projeções da AP', url: '/' });
  }
  return ev;
}

async function send(events) {
  if (!events.length) return { sent: 0, removed: 0 };
  webpush.setVapidDetails('mailto:radar@radar-republicano.vercel.app', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const subs = await allSubs();
  let sent = 0, removed = 0;
  // agrupa num único aviso quando há muitos de uma vez
  const payloads = events.length > 3
    ? [{ tag: 'batch', title: `${events.length} novidades no Radar R`, body: events.slice(0, 4).map((e) => e.title).join(' · '), url: '/' }]
    : events;
  await Promise.all(subs.map(async (s) => {
    for (const p of payloads) {
      try { await webpush.sendNotification(s, JSON.stringify(p), { TTL: 1800, urgency: 'high' }); sent++; } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { await removeSub(s.endpoint); removed++; return; }
      }
    }
  }));
  return { sent, removed, subs: subs.length };
}

module.exports = { readJson, writeJson, addSub, removeSub, summarize, diff, send };
