// Fonte de recurso: feeds públicos da Fox News, usados quando o NYT falha.
// Converte tudo para a forma dos ficheiros do NYT, para o resto do código não mudar.
// Os alvos de empate, as classificações e os votos esperados vêm de data/static.json (cópia guardada do NYT).
'use strict';
const STATIC = require('../data/static.json');

const FOX = 'https://feeds-elections.foxnews.com/archive/politics/elections/2026/3/2026_Generals/';
const cache = new Map(); // caminho -> { json, at }

async function getFox(path, maxAgeMs = 8000) {
  const prev = cache.get(path);
  if (prev && Date.now() - prev.at < maxAgeMs) return prev.json;
  try {
    const res = await fetch(FOX + path + '/file.json', { headers: { 'User-Agent': 'radar-republicano' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('Fox HTTP ' + res.status);
    const json = await res.json();
    cache.set(path, { json, at: Date.now() });
    return json;
  } catch (e) {
    if (prev) return prev.json;
    throw e;
  }
}

const PARTY = { R: 'GOP', D: 'DEM' };
const partyOf = (code) => PARTY[code] || 'IND';
const metaOf = (c) => ({
  nyt_id: String(c.npid), first_name: c.firstName, last_name: c.lastName, incumbent: !!c.isIncumbent, order: 0,
  party: { nyt_id: partyOf(c.partyCode) },
});

// Uma corrida ao Senado ou a governador, na forma de um ficheiro do NYT.
async function foxRace(def) {
  const off = def.office.startsWith('Senado') ? 'Senate' : 'Governor';
  const [cty, stt] = await Promise.all([
    getFox(`${off}/${def.st}/county_level_results`).catch(() => ({ lookup: { counties: {} }, results: [] })), // o Alasca não tem condados
    getFox(`${off}/${def.st}/state_level_results`),
  ]);
  const s = (Array.isArray(stt) ? stt[0] : stt) || {};
  const st = STATIC.races[def.id] || { counties: {} };
  const meta = {};
  for (const r of s.results || []) meta[r.candidate.npid] = metaOf({ ...r.candidate, partyCode: r.partyCode, isIncumbent: r.isIncumbent });
  for (const r of cty.results || []) meta[r.candidate.npid] = meta[r.candidate.npid] || metaOf(r.candidate);
  const gop = Object.values(meta).find((m) => m.party.nyt_id === 'GOP');
  const dem = Object.values(meta).find((m) => m.party.nyt_id === 'DEM');

  // condados
  const units = {};
  for (const [id, c] of Object.entries(cty.lookup.counties)) {
    const fips = String(c.fipsCode).padStart(5, '0');
    const [E, tgt] = st.counties[fips] || [0, null];
    units[id] = {
      level: 'county', name: c.name, fips_state: fips.slice(0, 2), fips_county: fips.slice(2), eevp: c.precinctsReporting || 0,
      total_votes: 0, total_expected_vote: E, candidates: [], tgt,
    };
  }
  for (const r of cty.results || []) {
    for (const v of r.countyVotes || []) {
      const u = units[v.countyId];
      if (!u) continue;
      const count = (v.votes && v.votes.count) || 0;
      const id = String(r.candidate.npid);
      const est = u.tgt != null && gop && dem && (id === gop.nyt_id || id === dem.nyt_id)
        ? { extra_columns: { share_benchmark: id === gop.nyt_id ? u.tgt : 0 } } : null;
      u.candidates.push({ nyt_id: id, votes: { total: count }, nyt_model_estimates: est });
      u.total_votes += count;
    }
  }
  const totals = s.stateTotals || {};
  const state = {
    level: 'state', name: STATIC.stateNames[def.st] || def.st, state_postal: def.st, fips_state: Object.values(units)[0] ? Object.values(units)[0].fips_state : null,
    eevp: totals.expectedPercentage || 0, total_votes: totals.votes || 0, total_expected_vote: totals.expected || st.expected || 0,
    candidates: (s.results || []).map((r) => ({ nyt_id: String(r.candidate.npid), votes: { total: (r.votes && r.votes.count) || 0 }, nyt_model_estimates: null })),
  };
  const winner = (s.results || []).find((r) => r.isWinner);
  return {
    timeseries: {},
    races: [{
      nyt_id: def.id, rating: st.rating || null, updated_at: s.last_updated || null, candidate_metadata: meta,
      outcome: winner ? { won: [String(winner.candidate.npid)], called_by: ['fox'], winner_accepted_at: [s.last_updated || new Date().toISOString()], advanced_to_runoff: [], gained: !!s.isFlipped }
        : { won: [], called_by: [], winner_accepted_at: [], advanced_to_runoff: [] },
      reporting_units: [state, ...Object.values(units)],
    }],
  };
}

// Resumo de todas as corridas de um cargo.
async function foxOverview(kind) {
  const list = await getFox(`${kind === 'S' ? 'Senate' : 'Governor'}/national_level_results`);
  const ratings = STATIC.ratings[kind] || {};
  return list.map((x) => {
    const res = x.results || [];
    const R = res.find((r) => r.partyCode === 'R');
    const O = res.find((r) => r.partyCode === 'D') || res.filter((r) => r.partyCode !== 'R').sort((a, b) => b.votes.count - a.votes.count)[0];
    const total = res.reduce((a, r) => a + ((r.votes && r.votes.count) || 0), 0);
    const won = res.find((r) => r.isWinner);
    const letter = (r) => (r.partyCode === 'R' ? 'R' : r.partyCode === 'D' ? 'D' : 'I');
    return {
      st: x.stateCode, id: x.stateCode + '-' + kind, special: /special/i.test(x.raceName || ''),
      R: R ? R.candidate.lastName : null, O: O ? O.candidate.lastName : null, Op: O ? letter(O) : 'D',
      eevp: x.expectedPercentage || 0, m: total && R && O ? Math.round(((R.votes.count - O.votes.count) / total) * 1000) / 10 : null,
      rating: ratings[x.stateCode] || null, call: won ? letter(won) : null, callName: won ? won.candidate.lastName : null, gained: !!x.isFlipped, runoff: !!x.isRunoff, pR: null,
    };
  });
}

// Lugares projetados no Senado e na Câmara.
async function foxControl() {
  const b = await getFox('Congress/balance_of_power');
  const one = (o, total, toWin, current) => {
    const p = (c) => (o.partyResults || []).find((x) => x.partyCode === c) || {};
    const win = (o.partyResults || []).find((x) => x.isWinner);
    return {
      R: (o.startValues.R || 0) + (p('R').count || 0), D: (o.startValues.D || 0) + (p('D').count || 0), I: (o.startValues.Oth || 0) + (p('Oth').count || 0),
      total, toWin, called: (p('R').count || 0) + (p('D').count || 0) + (p('Oth').count || 0), current, model: {}, ts: [],
      flipsR: p('R').flipped || 0, flipsD: p('D').flipped || 0, winner: win ? (win.partyCode === 'R' ? 'GOP' : win.partyCode === 'D' ? 'DEM' : 'OTH') : null,
    };
  };
  return { S: one(b.senate, 100, { GOP: 50, DEM: 51 }, null), H: one(b.house, 435, { GOP: 218, DEM: 218 }, STATIC.houseCurrent || null) };
}

// Os distritos da Câmara a seguir.
async function foxHouse(watch) {
  const states = [...new Set(watch.map(([st]) => st))];
  const files = await Promise.all(states.map((st) => getFox(`House/${st}/state_level_results`, 20000).then((j) => [st, j]).catch(() => [st, null])));
  const byState = Object.fromEntries(files);
  const out = [];
  const flips = [];
  for (const [st, seat, zone] of watch) {
    const f = byState[st];
    const race = f && (f.races || []).find((r) => ((r.district && r.district.districtNumber) || 1) === seat);
    if (!race) continue;
    const res = race.results || [];
    const R = res.find((r) => r.partyCode === 'R');
    const O = res.find((r) => r.partyCode === 'D') || res.find((r) => r.partyCode !== 'R');
    const T = (race.districtTotals && race.districtTotals.votes) || 0;
    const won = res.find((r) => r.isWinner);
    const letter = (r) => (r.partyCode === 'R' ? 'R' : r.partyCode === 'D' ? 'D' : 'I');
    const id = st + '-' + seat;
    out.push({
      id, st, seat, zone, rating: (STATIC.house[id] || {}).rating || null,
      R: R ? R.candidate.lastName : null, O: O ? O.candidate.lastName : null, Op: O ? letter(O) : 'D',
      inc: R && R.isIncumbent ? 'R' : O && O.isIncumbent ? letter(O) : null,
      eevp: (race.districtTotals && race.districtTotals.expectedPercentage) || 0,
      m: T && R && O ? Math.round(((R.votes.count - O.votes.count) / T) * 1000) / 10 : null,
      pace: null, pR: won ? (won.partyCode === 'R' ? 1 : 0) : null, call: won ? letter(won) : null, callName: won ? won.candidate.lastName : null, gained: !!race.isFlipped, rcv: st === 'AK' || st === 'ME',
    });
    if (won && race.isFlipped) flips.push({ st, seat, who: letter(won), name: won.candidate.lastName });
  }
  return { flips, vote: null, watch: out };
}

module.exports = { foxRace, foxOverview, foxControl, foxHouse, staticClosings: () => STATIC.closings || {} };
