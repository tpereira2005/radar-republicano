// Gera data/watch.json a partir de watch-src.mjs e acrescenta os nomes dos condados do Maine e do New Hampshire a base.json.
// "alvo" = margem R−D que o condado costuma ter quando o estado está empatado (média das 3 colunas do fio).
import { readFileSync, writeFileSync } from 'node:fs';
import SRC from './watch-src.mjs';

const basePath = new URL('../data/base.json', import.meta.url);
const base = JSON.parse(readFileSync(basePath, 'utf8'));
const EXTRA = {
  ME: ['Androscoggin', 'Aroostook', 'Cumberland', 'Franklin', 'Hancock', 'Kennebec', 'Knox', 'Lincoln', 'Oxford', 'Penobscot', 'Piscataquis', 'Sagadahoc', 'Somerset', 'Waldo', 'Washington', 'York'],
  NH: ['Belknap', 'Carroll', 'Cheshire', 'Coos', 'Grafton', 'Hillsborough', 'Merrimack', 'Rockingham', 'Strafford', 'Sullivan'],
};
for (const [st, names] of Object.entries(EXTRA)) {
  names.forEach((n, i) => {
    const k = base[st].fips + String(i * 2 + 1).padStart(3, '0');
    if (base[st].counties[k]) base[st].counties[k].n = n;
  });
}
writeFileSync(basePath, JSON.stringify(base));

const out = {};
for (const [st, { cols, rows }] of Object.entries(SRC)) {
  const byName = {};
  for (const [k, c] of Object.entries(base[st].counties)) byName[c.n] = k;
  out[st] = {
    cols: cols.map(([label, R, D]) => ({ label, R, D })),
    rows: rows.map(([n, ...v]) => {
      const fips = byName[n];
      if (!fips) throw new Error(`${st}: condado não encontrado: ${n}`);
      const leans = v.map(([R, D], i) => R - D - (cols[i][1] - cols[i][2]));
      return { n, fips, v, target: Math.round((leans.reduce((a, b) => a + b, 0) / leans.length) * 10) / 10 };
    }),
  };
}
writeFileSync(new URL('../data/watch.json', import.meta.url), JSON.stringify(out));
console.log(Object.entries(out).map(([s, w]) => s + ' ' + w.rows.map((r) => r.n + ':' + r.target).join(' ')).join('\n'));
