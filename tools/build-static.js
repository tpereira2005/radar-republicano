// Gera data/static.json: cópia do que só o NYT tem (classificações, alvos de empate, votos esperados, horas de fecho),
// para a fonte de recurso (lib/fox.js) continuar a funcionar mesmo que o NYT desapareça.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '..', 'data', 'static.json');
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ races: {}, ratings: {}, house: {}, stateNames: {} }));
const { collect } = require('../lib/radar.js');

collect().then((s) => {
  const out = { races: {}, ratings: { S: {}, G: {} }, house: {}, stateNames: {}, closings: s.closings, houseCurrent: s.control.H && s.control.H.current };
  for (const r of s.races) {
    out.stateNames[r.st] = r.stName;
    out.races[r.id] = { rating: r.rating, expected: r.expected, counties: Object.fromEntries(r.counties.map((c) => [c[0], [c[5], c[7]]])) };
  }
  for (const x of s.senate) out.ratings.S[x.st] = x.rating;
  for (const x of s.governors) out.ratings.G[x.st] = x.rating;
  for (const w of s.house.watch) out.house[w.id] = { rating: w.rating };
  fs.writeFileSync(file, JSON.stringify(out));
  console.log('static.json', fs.statSync(file).size, 'bytes,', Object.keys(out.races).length, 'corridas,', Object.keys(out.house).length, 'distritos, erros:', s.errors);
});
