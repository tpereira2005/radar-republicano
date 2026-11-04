// Modo de ensaio: preenche os ficheiros reais do NYT com uma contagem FICTÍCIA no instante t (0 a 1).
// Serve para testar o site antes de haver votos; nunca é usado sem ?demo= no endereço.
'use strict';
const BASE = require('../data/base.json');

function rng(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h |= 0; h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

function demoRace(json, st, t) {
  const j = JSON.parse(JSON.stringify(json));
  const race = j.races[0];
  const base = BASE[st];
  const r = rng(race.nyt_id);
  const meta = race.candidate_metadata;
  const ids = Object.keys(meta);
  const gop = ids.find((i) => meta[i].party && meta[i].party.nyt_id === 'GOP');
  const opp = ids.find((i) => meta[i].party && meta[i].party.nyt_id === 'DEM') || ids.find((i) => i !== gop);
  const natSwing = -4 + gauss(r) * 5; // swing verdadeiro (fictício) face a 2024
  const cty = {};
  for (const k of Object.keys(base.counties)) {
    const rc = rng(race.nyt_id + k);
    cty[k] = { sw: natSwing + gauss(rc) * 4, d: rc() * 0.45, speed: 0.25 + rc() * 0.5 };
  }
  const st0 = race.reporting_units.find((u) => u.level === 'state');
  let sumR = 0, sumO = 0, sumT = 0, sumEC = 0, sumE = 0;
  for (const u of race.reporting_units) {
    if (u.level === 'state' || !u.fips_county) continue;
    const k = u.fips_state + u.fips_county;
    const b = base.counties[k];
    const c = cty[k];
    if (!b || !c) continue;
    const f = Math.max(0, Math.min(0.99, (t - c.d) / c.speed));
    const E = u.total_expected_vote || 0;
    const T = Math.round(E * f);
    // os primeiros votos (correio) puxam para D; a diferença desaparece no fim
    const m = ((b.R - b.D) / b.T) * 100 + c.sw - 7 * (1 - f);
    const R = Math.round((T * (97 + m)) / 200);
    const O = Math.round((T * (97 - m)) / 200);
    for (const cand of u.candidates) cand.votes = { total: cand.nyt_id === gop ? R : cand.nyt_id === opp ? O : Math.round(T * 0.015) };
    u.total_votes = T; u.eevp = f * 100; u.eevp_by_vote_type = {}; u.expected_vote_by_vote_type = {};
    sumR += R; sumO += O; sumT += T; sumEC += f * E; sumE += E;
  }
  for (const cand of st0.candidates) cand.votes = { total: cand.nyt_id === gop ? sumR : cand.nyt_id === opp ? sumO : 0 };
  st0.eevp_by_vote_type = {}; st0.expected_vote_by_vote_type = {};
  st0.total_votes = sumT; st0.eevp = sumE ? (sumEC / sumE) * 100 : 0;
  const fm = sumT ? ((sumR - sumO) / sumT) * 100 : 0;
  if (t > 0.8 && Math.abs(fm) > 4) {
    race.outcome = { won: [fm > 0 ? gop : opp], called_by: ['ap'], winner_accepted_at: [new Date().toISOString()], advanced_to_runoff: [] };
  }
  j.timeseries = {};
  return j;
}

module.exports = { demoRace };
