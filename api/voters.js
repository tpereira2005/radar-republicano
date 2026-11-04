// GET /api/voters?race=GA-S: sondagem aos eleitores (Fox News Voter Poll) de uma corrida, resumida e em português.
'use strict';
const { RACES } = require('../lib/radar.js');

const BASE = 'https://feeds-elections.foxnews.com/voter_analysis/2026_Generals/';
const WHO = [
  ['gender', 'Sexo'], ['age', 'Idade'], ['race4', 'Origem'], ['genderbyrace', 'Sexo e origem'], ['educcoll', 'Educação'],
  ['income3', 'Rendimento familiar'], ['sizeplace3', 'Onde vive'], ['partylean', 'Partido'], ['phil3', 'Ideologia'],
  ['whtevang', 'Evangélicos brancos'], ['vote2024', 'Voto em 2024'],
];
const WHY = [
  ['issue26', 'Tema mais importante'], ['trump2', 'Aprovação de Trump'], ['fortrumph', 'Trump como razão do voto'],
  ['nec2', 'Estado da economia'], ['finsit2', 'Finanças da família'], ['trumpinflation', 'Preços altos: de quem é a culpa'],
  ['tariff26a', 'Tarifas de Trump'], ['immenforce', 'Imigração: atuação de Trump'], ['abort2', 'Aborto'],
  ['time26smonth', 'Quando decidiu o voto'], ['time26gmonth', 'Quando decidiu o voto'],
];
const PT = {
  Male: 'Homens', Female: 'Mulheres', '65 or over': '65 ou mais', White: 'Brancos', 'African American or Black': 'Negros', 'Hispanic/Latino': 'Latinos', Other: 'Outros',
  'White Men': 'Homens brancos', 'White women': 'Mulheres brancas', 'Black men': 'Homens negros', 'Black women': 'Mulheres negras', 'Latino men': 'Homens latinos', 'Latino women': 'Mulheres latinas', 'All others': 'Restantes',
  'College graduate': 'Com licenciatura', 'No college degree': 'Sem licenciatura',
  'Under $50,000': 'Menos de 50 mil $', '$50,000-$99,999': '50 a 100 mil $', '$100,000 or more': '100 mil $ ou mais',
  Urban: 'Cidade', Suburban: 'Subúrbios', 'Small town or rural': 'Vila ou meio rural',
  'Democrat/Lean Democrat': 'Democratas', 'Republican/Lean Republican': 'Republicanos', 'Independent or something else': 'Independentes',
  Liberal: 'Liberais', Moderate: 'Moderados', Conservative: 'Conservadores',
  'White evangelical or white born-again Christian': 'Evangélicos brancos',
  'Kamala Harris (Dem)': 'Votou Harris', 'Donald Trump (Rep)': 'Votou Trump', 'Did not vote': 'Não votou',
  Crime: 'Criminalidade', 'The economy': 'Economia', 'Foreign policy': 'Política externa', Healthcare: 'Saúde', Immigration: 'Imigração', 'The state of democracy': 'Estado da democracia',
  Approve: 'Aprova', Disapprove: 'Desaprova',
  'To express support for Donald Trump': 'Para apoiar Trump', 'To express opposition to Donald Trump': 'Para se opor a Trump', 'Donald Trump was not a factor': 'Trump não pesou',
  'Excellent or good': 'Boa', 'Not so good or poor': 'Má',
  Better: 'Melhor', Worse: 'Pior', 'About the same': 'Igual',
  'More because of Trump’s policies': 'Políticas de Trump', 'More because of factors outside Trump’s control': 'Fatores fora do controlo de Trump',
  Helped: 'Ajudaram', Hurt: 'Prejudicaram', 'No difference': 'Sem efeito',
  'Gone too far': 'Foi longe demais', 'Not gone far enough': 'Não foi suficiente', 'Been about right': 'Foi adequada',
  Legal: 'Legal', Illegal: 'Ilegal', 'In the last month': 'No último mês', 'Before that': 'Antes disso',
};

const cache = new Map();
async function getJson(path, maxAge) {
  const c = cache.get(path);
  if (c && Date.now() - c.at < maxAge) return c.json;
  try {
    const r = await fetch(BASE + path, { headers: { 'User-Agent': 'radar-republicano' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const json = await r.json();
    cache.set(path, { json, at: Date.now() });
    return json;
  } catch (e) {
    if (c) return c.json;
    throw e;
  }
}

function build(q, label) {
  const rows = (q.h_answers || []).map((a) => {
    const res = a.results || [];
    const R = res.find((x) => x.party === 'Republican');
    const O = res.filter((x) => x.party !== 'Republican' && x.name !== 'Another candidate').sort((x, y) => Number(y.result_percent) - Number(x.result_percent))[0];
    return { a: PT[a.answer] || a.answer, share: Number(a.variable_percent), R: R ? Number(R.result_percent) : null, O: O ? Number(O.result_percent) : null };
  }).filter((x) => x.R != null && x.O != null);
  return rows.length ? { label, rows } : null;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const id = new URL(req.url, 'http://localhost').searchParams.get('race');
  const def = RACES.find((d) => d.id === id);
  if (!def) { res.statusCode = 400; res.setHeader('Cache-Control', 'no-store'); return res.end('{"error":"corrida desconhecida"}'); }
  try {
    const list = await getJson('race_list.json', 600000);
    const prefix = `${def.st}-${def.office.startsWith('Senado') ? 'S' : 'G'}-`;
    const foxId = list.find((x) => x.startsWith(prefix));
    const data = foxId ? await getJson(`${def.st}/${foxId}.json`, 120000) : [];
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=120, stale-while-revalidate=300');
    if (!Array.isArray(data) || data.length < 2) return res.end(JSON.stringify({ available: false }));
    const head = Object.values(data[0])[0] || {};
    const qs = Object.values(data[1]);
    const pick = (spec) => spec.map(([code, label]) => { const q = qs.find((x) => x.qcode === code); return q ? build(q, label) : null; }).filter(Boolean);
    const cand = head.candidates || [];
    const R = cand.find((c) => c.party === 'Republican');
    const O = cand.find((c) => c.party !== 'Republican' && c.name !== 'Another candidate');
    res.end(JSON.stringify({
      available: true, interviews: head.interviews || null, updated: head.last_updated || null, wave: head.wave || null,
      R: R ? R.name : null, O: O ? O.name : null, who: pick(WHO), why: pick(WHY),
    }));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
