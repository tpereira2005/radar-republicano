// Radar republicano: recolha dos ficheiros de resultados do NYT e cálculos por corrida.
// Partilhado pela função da Vercel (api/state.js) e pelo servidor local de testes.
'use strict';
const BASE = require('../data/base.json');
const WATCH = require('../data/watch.json');

const NYT = 'https://static01.nyt.com/elections-assets/pages/data/2026-11-03/';

// Corridas acompanhadas ao condado (os 11 estados do fio).
const RACES = [
  ['TX-S', 'TX', 'Senado', 'texas-us-senate'],
  ['NC-S', 'NC', 'Senado', 'north-carolina-us-senate'],
  ['GA-S', 'GA', 'Senado', 'georgia-us-senate'],
  ['MI-S', 'MI', 'Senado', 'michigan-us-senate'],
  ['ME-S', 'ME', 'Senado', 'maine-us-senate'],
  ['OH-S', 'OH', 'Senado (especial)', 'ohio-us-senate-special'],
  ['NH-S', 'NH', 'Senado', 'new-hampshire-us-senate'],
  ['IA-S', 'IA', 'Senado', 'iowa-us-senate'],
  ['FL-S', 'FL', 'Senado (especial)', 'florida-us-senate-special'],
  ['KS-S', 'KS', 'Senado', 'kansas-us-senate'],
  ['AZ-G', 'AZ', 'Governador', 'arizona-governor'],
  ['GA-G', 'GA', 'Governador', 'georgia-governor'],
  ['MI-G', 'MI', 'Governador', 'michigan-governor'],
  ['KS-G', 'KS', 'Governador', 'kansas-governor'],
  ['IA-G', 'IA', 'Governador', 'iowa-governor'],
  ['OH-G', 'OH', 'Governador', 'ohio-governor'],
  ['NH-G', 'NH', 'Governador', 'new-hampshire-governor'],
  ['ME-G', 'ME', 'Governador', 'maine-governor'],
  ['TX-G', 'TX', 'Governador', 'texas-governor'],
  ['FL-G', 'FL', 'Governador', 'florida-governor'],
].map(([id, st, office, slug]) => ({ id, st, office, slug }));

// ---------------------------------------------------------------- recolha com cache por ficheiro
const files = new Map(); // slug -> { etag, json, at }

async function getFile(slug, maxAgeMs) {
  const prev = files.get(slug);
  if (prev && Date.now() - prev.at < maxAgeMs) return prev.json;
  const headers = prev && prev.etag ? { 'If-None-Match': prev.etag } : {};
  try {
    const res = await fetch(NYT + 'results-' + slug + '.json', { headers, signal: AbortSignal.timeout(8000) });
    if (res.status === 304 && prev) { prev.at = Date.now(); return prev.json; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    files.set(slug, { etag: res.headers.get('etag'), json, at: Date.now() });
    return json;
  } catch (e) {
    if (prev) return prev.json; // mantém os últimos dados bons
    throw e;
  }
}

// ---------------------------------------------------------------- utilitários
const margin = (r, o, t) => (t > 0 ? ((r - o) / t) * 100 : null);
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
// Margem R−D esperada antes da contagem, a partir da classificação do NYT (só serve de ponto de partida).
const RATING = { 'solid-rep': 15, 'likely-rep': 8, 'lean-rep': 3.5, tossup: 0, 'lean-dem': -3.5, 'likely-dem': -8, 'solid-dem': -15 };
const fullName =(c) => [c.first_name, c.last_name].filter(Boolean).join(' ');

// Escolhe o candidato republicano principal e o principal adversário.
function pickCandidates(race, stateUnit) {
  const meta = race.candidate_metadata;
  const votes = {};
  for (const c of stateUnit.candidates) votes[c.nyt_id] = c.votes.total;
  const ids = Object.keys(meta);
  const by = (a, b) => (votes[b] || 0) - (votes[a] || 0) || meta[a].order - meta[b].order;
  const gop = ids.filter((i) => meta[i].party && meta[i].party.nyt_id === 'GOP').sort(by)[0];
  const rest = ids.filter((i) => i !== gop).sort((a, b) => {
    const da = meta[a].party && meta[a].party.nyt_id === 'DEM' ? 0 : 1;
    const db = meta[b].party && meta[b].party.nyt_id === 'DEM' ? 0 : 1;
    return (votes[b] || 0) - (votes[a] || 0) || da - db || meta[a].order - meta[b].order;
  });
  return { R: gop, O: rest[0] };
}

function partyLetter(meta, id) {
  const p = meta[id] && meta[id].party && meta[id].party.nyt_id;
  return p === 'GOP' ? 'R' : p === 'DEM' ? 'D' : 'I';
}

// ---------------------------------------------------------------- uma corrida
function buildRace(def, json) {
  const race = json.races[0];
  const units = race.reporting_units;
  const su = units.find((u) => u.level === 'state');
  const ids = pickCandidates(race, su);
  const meta = race.candidate_metadata;
  const base = BASE[def.st];
  const vOf = (u, id) => { const c = u.candidates.find((x) => x.nyt_id === id); return c ? c.votes.total : 0; };

  // condados (no ME e no NH somam-se os municípios)
  // benchmark do NYT: quota que cada candidato teria no condado se o estado ficasse 50/50
  const benchOf = (u, id) => {
    const c = u.candidates.find((x) => x.nyt_id === id);
    const x = c && c.nyt_model_estimates && c.nyt_model_estimates.extra_columns;
    return x && x.share_benchmark != null ? x.share_benchmark : null;
  };
  const agg = {};
  for (const u of units) {
    if (u.level === 'state' || !u.fips_county) continue;
    const k = u.fips_state + u.fips_county;
    const a = agg[k] || (agg[k] = { R: 0, O: 0, T: 0, E: 0, EC: 0, n: null, tw: 0, tn: 0 });
    a.R += vOf(u, ids.R); a.O += vOf(u, ids.O); a.T += u.total_votes || 0;
    a.E += u.total_expected_vote || 0;
    a.EC += ((u.eevp || 0) / 100) * (u.total_expected_vote || 0);
    const bR = benchOf(u, ids.R), bO = benchOf(u, ids.O);
    if (bR != null && bO != null) { const w = u.total_expected_vote || 1; a.tw += w; a.tn += w * (bR - bO); }
    if (u.level === 'county') a.n = u.name;
  }

  // modelo: swing face a Trump 2024, com a classificação do NYT como ponto de partida
  const M24 = margin(base.R, base.D, base.T);
  const rating = race.rating || race.general_rating || null;
  const bench = RATING[rating] != null ? RATING[rating] : null;
  const prior = bench != null ? bench - M24 : 0;

  let sumE = 0, sumV = 0, sumW = 0, sumWS = 0;
  const counties = [];
  for (const [k, a] of Object.entries(agg)) {
    const b = base.counties[k];
    if (!b) continue;
    const m24 = margin(b.R, b.D, b.T);
    const E = a.E || b.T;
    const f = E > 0 ? Math.min(1, a.EC / E) : 0;
    const m = a.T > 0 ? margin(a.R, a.O, a.T) : null;
    sumE += E; sumV += a.T;
    if (m != null) { sumW += a.T; sumWS += a.T * (m - m24); }
    counties.push({ k, n: a.n || b.n, m24, E, f, m, R: a.R, O: a.O, T: a.T, tgt: a.tw ? a.tn / a.tw : null });
  }
  const k0 = 0.03 * sumE;
  const swing = (k0 * prior + sumWS) / (k0 + sumW || 1);
  let projNum = 0, varNum = 0, varDen = 0;
  for (const c of counties) {
    const sw = c.m != null ? c.m - c.m24 : null;
    c.proj = c.m != null ? c.f * c.m + (1 - c.f) * (c.m24 + swing) : c.m24 + swing;
    projNum += c.E * c.proj;
    if (sw != null) { varNum += c.T * (sw - swing) ** 2; varDen += c.T; }
  }
  const proj = sumE ? projNum / sumE : null;
  const F = sumE ? Math.min(1, sumV / sumE) : 0;
  const disp = varDen ? Math.sqrt(varNum / varDen) : 6;

  // composição do voto contado (correio/antecipado vs. dia da eleição)
  const vt = su.eevp_by_vote_type || {};
  const ev = su.expected_vote_by_vote_type || {};
  const types = {};
  for (const t of ['absentee_mail', 'advance_in_person', 'advance', 'election_day_in_person', 'provisional']) {
    if (ev[t]) types[t] = { exp: ev[t], pct: vt[t] || 0 };
  }
  let expT = 0, cntT = 0, expEarly = 0, cntEarly = 0;
  for (const [t, x] of Object.entries(types)) {
    const c = (x.exp * x.pct) / 100;
    expT += x.exp; cntT += c;
    if (t !== 'election_day_in_person') { expEarly += x.exp; cntEarly += c; }
  }
  // >0: o contado tem mais voto antecipado/correio do que o total esperado (tende a enganar a favor dos D)
  const skew = cntT > 0 && expT > 0 ? cntEarly / cntT - expEarly / expT : 0;

  // incerteza: larga no início (a ordem da contagem engana), maior se o contado for de um só tipo de voto
  const sd = Math.sqrt((7.5 * Math.pow(1 - F, 0.6)) ** 2 + (disp * (1 - F) * 0.35) ** 2 + (12 * Math.abs(skew) * (1 - F)) ** 2 + 0.8 ** 2);
  const pR = proj != null ? phi(proj / sd) : null;

  // modelo ao vivo do NYT (quando existe para esta corrida)
  const sR = su.candidates.find((c) => c.nyt_id === ids.R);
  const sO = su.candidates.find((c) => c.nyt_id === ids.O);
  const em = su.nyt_model_estimates || {};
  const mq = em.margin_quantile; // margem (1.º − 2.º no modelo) em fração
  const rankR = sR && sR.nyt_model_estimates ? sR.nyt_model_estimates.ranking : null;
  const nyt = sR && sR.nyt_model_estimates && sR.nyt_model_estimates.win_probability != null ? {
    pR: sR.nyt_model_estimates.win_probability,
    pO: sO && sO.nyt_model_estimates ? sO.nyt_model_estimates.win_probability : null,
    q: Array.isArray(mq) && (rankR === 1 || rankR === 2) ? (rankR === 1 ? mq.map((x) => r1(x * 100)) : mq.map((x) => r1(-x * 100)).reverse()) : null,
    status: (race.model_settings || {}).model_status || null,
    at: em.nyt_updated_at || null,
  } : null;

  // votos por contar em condados onde o R ganhou em 2024 vs. onde perdeu
  let leftR = 0, leftO = 0;
  for (const c of counties) {
    const left = Math.max(0, c.E * (1 - c.f));
    if (c.m24 >= 0) leftR += left; else leftO += left;
  }

  // condados-chave do fio
  const watch = WATCH[def.st] ? {
    cols: WATCH[def.st].cols,
    rows: WATCH[def.st].rows.map((w) => {
      const a = agg[w.fips] || {};
      const c = counties.find((x) => x.k === w.fips) || {};
      return { n: w.n, k: w.fips, v: w.v, target: w.target, nyt: r1(c.tgt), m: r1(c.m), f: r1((c.f || 0) * 100), T: a.T || 0, proj: r1(c.proj) };
    }),
  } : null;

  const out = race.outcome || {};
  const won = (out.won || [])[0];
  const ts = ((json.timeseries || {})[race.nyt_id] || []).map((p) => {
    const g = (id) => { const c = p.candidates.find((x) => x.nyt_id === id); return c ? c.votes.total : 0; };
    return [p.greatest_updated_at, p.total_votes, g(ids.R), g(ids.O)];
  }).filter((p) => p[1] > 0).slice(-240);

  return {
    id: def.id, st: def.st, office: def.office, stName: su.name, fipsState: su.fips_state,
    updated: race.updated_at, rating, callStatus: race.race_call_status,
    rcv: /rcv|ranked/i.test(race.tabulation_method || ''), threshold: race.win_threshold || null, nyt, skew: r1(skew * 100),
    call: won ? { who: partyLetter(meta, won), name: fullName(meta[won]), by: out.called_by || [], at: (out.winner_accepted_at || [])[0] || null } : null,
    runoff: (out.advanced_to_runoff || []).length > 0,
    R: { name: fullName(meta[ids.R] || {}), votes: vOf(su, ids.R), inc: !!(meta[ids.R] || {}).incumbent },
    O: { name: fullName(meta[ids.O] || {}), party: partyLetter(meta, ids.O), votes: vOf(su, ids.O), inc: !!(meta[ids.O] || {}).incumbent },
    total: su.total_votes || 0, expected: su.total_expected_vote || 0, eevp: su.eevp || 0,
    m: r1(margin(vOf(su, ids.R), vOf(su, ids.O), su.total_votes)),
    m24: r1(M24), bench: r1(bench),
    radar: { proj: r1(proj), sd: r1(sd), pR: pR == null ? null : Math.round(pR * 1000) / 1000, swing: r1(swing), F: r1(F * 100), leftR: Math.round(leftR), leftO: Math.round(leftO) },
    types,
    counties: counties.map((c) => [c.k, r1(c.f * 100), c.R, c.O, c.T, Math.round(c.E), r1(c.m24), r1(c.tgt)]),
    watch, ts,
  };
}

// ---------------------------------------------------------------- visão geral (Senado, Câmara, governadores)
function control(json, office) {
  const o = json && json.partyControlData && json.partyControlData.results[0].offices[office];
  if (!o) return null;
  const est = {};
  for (const e of o.nyt_model_estimates || []) est[e.nyt_party_id] = { p: e.win_probability, seats: e.seats, q: e.seats_quantile };
  const bal = (p) => (o.party_balance[p] || {}).seats || 0;
  // evolução do modelo do NYT ao longo da noite: [hora, P(R controla), lugares R]
  const ts = [];
  for (const p of (json.partyControlTimeseriesData && json.partyControlTimeseriesData.results) || []) {
    const g = ((p.nyt_model_estimates || {})[office] || []).find((e) => e.nyt_party_id === 'GOP');
    if (g) ts.push([p.nyt_updated_at, g.win_probability, g.seats]);
  }
  return {
    R: bal('GOP'), D: bal('DEM'), I: bal('OTH'), total: o.total, toWin: o.to_win, called: o.num_races_called,
    current: o.current_control, model: est, ts: ts.slice(-300),
    flipsR: (o.party_balance.GOP || {}).flip_count || 0, flipsD: (o.party_balance.DEM || {}).flip_count || 0,
    winner: Object.keys(o.party_balance).find((p) => o.party_balance[p].winner) || null,
  };
}

function overviewRaces(json) {
  if (!json) return [];
  return json.races.map((race) => {
    const su = race.reporting_units.find((u) => u.level === 'state') || race.reporting_units[0];
    const ids = pickCandidates(race, su);
    const meta = race.candidate_metadata;
    const v = (id) => { const c = su.candidates.find((x) => x.nyt_id === id); return c ? c.votes.total : 0; };
    const out = race.outcome || {};
    const won = (out.won || [])[0];
    const cR = su.candidates.find((c) => c.nyt_id === ids.R);
    const pR = cR && cR.nyt_model_estimates && cR.nyt_model_estimates.win_probability;
    return {
      st: su.state_postal, id: race.nyt_id, special: race.type && race.type.includes('Special'),
      R: (meta[ids.R] || {}).last_name || null, O: (meta[ids.O] || {}).last_name || null, Op: partyLetter(meta, ids.O),
      eevp: su.eevp || 0, m: r1(margin(v(ids.R), v(ids.O), su.total_votes)), rating: race.rating || race.general_rating || null,
      call: won ? partyLetter(meta, won) : null, gained: out.gained === true,
      pR: pR != null ? Math.round(pR * 1000) / 1000 : null,
    };
  });
}

// Câmara: lugares que mudaram de partido e voto nacional contado.
function houseSummary(json) {
  if (!json) return null;
  const flips = [];
  let vote = null;
  for (const race of json.races) {
    const su = race.reporting_units[0];
    const meta = race.candidate_metadata;
    if (su && su.level === 'national') {
      let R = 0, D = 0;
      for (const c of su.candidates) { const p = partyLetter(meta, c.nyt_id); if (p === 'R') R += c.votes.total; else if (p === 'D') D += c.votes.total; }
      vote = { R, D, T: su.total_votes || 0, eevp: su.eevp || 0 };
      continue;
    }
    const out = race.outcome || {};
    const won = (out.won || [])[0];
    if (won && out.gained) flips.push({ st: su ? su.state_postal : '', seat: race.seat_number || race.seat || '', who: partyLetter(meta, won), name: (meta[won] || {}).last_name || '' });
  }
  return { flips, vote };
}

function closings(json) {
  const out = {};
  for (const p of (json && json.pollClosingTimes) || []) out[p.reporting_unit.state_postal] = p.poll_closing_time;
  return out;
}

// ---------------------------------------------------------------- estado completo
async function collect(opts = {}) {
  const t0 = Date.now();
  const demo = opts.demo != null && isFinite(opts.demo) ? Math.max(0, Math.min(1, opts.demo)) : null;
  const errors = [];
  const safe = (p, what) => p.catch((e) => { errors.push(what + ': ' + e.message); return null; });
  const [sen, gov, house, ...raceJson] = await Promise.all([
    safe(getFile('senate', 8000), 'senate'),
    safe(getFile('governor', 8000), 'governor'),
    safe(getFile('house', 45000), 'house'),
    ...RACES.map((d) => safe(getFile(d.slug, 8000), d.slug)),
  ]);
  const races = [];
  RACES.forEach((d, i) => {
    if (!raceJson[i]) return;
    try {
      const json = demo != null ? require('./demo.js').demoRace(raceJson[i], d.st, demo) : raceJson[i];
      races.push(buildRace(d, json));
    } catch (e) { errors.push(d.id + ': ' + e.message); }
  });
  // alvos de empate por condado: os governadores sem modelo do NYT usam os do Senado no mesmo estado;
  // sem Senado (Arizona), usa-se a inclinação do condado em 2024
  for (const r of races) {
    if (r.counties.some((c) => c[7] != null)) { r.tgtSrc = 'nyt'; continue; }
    const s = races.find((x) => x.st === r.st && x.id !== r.id && x.counties.some((c) => c[7] != null));
    const byK = s ? Object.fromEntries(s.counties.map((c) => [c[0], c[7]])) : null;
    for (const c of r.counties) c[7] = byK ? byK[c[0]] : c[6] != null ? Math.round((c[6] - r.m24) * 10) / 10 : null;
    if (r.watch) for (const w of r.watch.rows) { const c = r.counties.find((x) => x[0] === w.k); w.nyt = c ? c[7] : null; }
    r.tgtSrc = s ? 'nyt-senado' : 'trump24';
  }
  const senate = overviewRaces(sen);
  const governors = overviewRaces(gov);
  if (demo != null) {
    // no ensaio, a tabela geral acompanha as corridas simuladas
    for (const r of races) {
      const list = r.office.startsWith('Senado') ? senate : governors;
      const x = list.find((y) => y.st === r.st);
      if (x) Object.assign(x, { eevp: r.eevp, m: r.m, call: r.call ? r.call.who : null, pR: r.radar.pR });
    }
  }
  const ctrlS = control(sen, 'S');
  if (demo != null && ctrlS) {
    for (const x of senate) if (x.call === 'R') ctrlS.R++; else if (x.call === 'D') ctrlS.D++; else if (x.call === 'I') ctrlS.I++;
  }
  const newest = races.reduce((a, r) => (r.updated && r.updated > a ? r.updated : a), '');
  return {
    schema: 'radar-r/2',
    demo,
    generatedAt: new Date().toISOString(),
    sourceUpdatedAt: newest || null,
    took: Date.now() - t0,
    control: { S: ctrlS, H: control(house, 'H'), G: control(gov, 'G') },
    house: houseSummary(house),
    senate,
    governors,
    closings: closings(sen),
    races,
    errors,
  };
}

module.exports = { collect, buildRace, RACES };
