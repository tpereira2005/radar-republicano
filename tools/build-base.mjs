// Gera data/base.json: resultados de Trump 2024 por condado nos 11 estados do radar (fonte: ficheiros do NYT).
// No Maine e no New Hampshire o NYT publica por município; aqui agrega-se por condado.
import { writeFileSync } from 'node:fs';

const STATES = {
  FL: 'florida', OH: 'ohio', TX: 'texas', MI: 'michigan', NC: 'north-carolina', ME: 'maine',
  GA: 'georgia', IA: 'iowa', AZ: 'arizona', KS: 'kansas', NH: 'new-hampshire',
  AK: 'alaska', NE: 'nebraska', SC: 'south-carolina', MN: 'minnesota', MS: 'mississippi',
};
const URL24 = (s) => `https://static01.nyt.com/elections-assets/pages/data/2024-11-05/results-${s}-president.json`;

const out = {};
for (const [st, slug] of Object.entries(STATES)) {
  const j = await (await fetch(URL24(slug))).json();
  const race = j.races.find((r) => r.office_id === 'P') || j.races[0];
  const party = {};
  for (const [id, c] of Object.entries(race.candidate_metadata)) party[id] = c.party.nyt_id;
  const add = (acc, u) => {
    for (const c of u.candidates) {
      const p = party[c.nyt_id];
      if (p === 'GOP') acc.R += c.votes.total;
      else if (p === 'DEM') acc.D += c.votes.total;
      acc.T += c.votes.total;
    }
  };
  const counties = {};
  let fipsState = null;
  const state = { R: 0, D: 0, T: 0 };
  for (const u of race.reporting_units) {
    if (u.level === 'state') { add(state, u); fipsState = u.fips_state; continue; }
    if (!u.fips_county) continue;
    const k = u.fips_state + u.fips_county;
    const acc = counties[k] || (counties[k] = { R: 0, D: 0, T: 0, n: u.level === 'county' ? u.name : null });
    add(acc, u);
  }
  out[st] = { fips: fipsState, R: state.R, D: state.D, T: state.T, counties };
  console.log(st, Object.keys(counties).length, ((state.R - state.D) / state.T * 100).toFixed(1));
}
writeFileSync(new URL('../data/base.json', import.meta.url), JSON.stringify(out));
