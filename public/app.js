/* Radar Republicano: página. Lê /api/state (resumo calculado na Vercel a partir dos ficheiros do NYT). */
(function () {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');
  const TOPO_URL = 'https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-albers-10m.json';

  const S = {
    data: null, prev: null, at: 0, err: null,
    sel: decodeURIComponent(location.hash.slice(1)) || null,
    sort: 'close', mapMode: 'target',
    demoT: Math.max(0, Math.min(1, Number(params.get('demo')) || 0)), playing: false,
    seen: new Set(), feed: [], topo: null, notify: false,
  };

  // ---------------------------------------------------------------- formatação
  const nf1 = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 0 });
  const tLis = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon', hour: '2-digit', minute: '2-digit' });
  const tLisS = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const pct = (x) => nf1.format(x) + '%';
  const big = (x) => nf0.format(x);
  const compact = (x) => (x >= 1e6 ? nf1.format(x / 1e6) + ' M' : x >= 1e3 ? nf0.format(x / 1e3) + ' mil' : nf0.format(x));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // margem R−adversário → "R+3,2" / "D+1,5"
  function fm(m, opp = 'D') {
    if (m == null) return '—';
    if (Math.abs(m) < 0.05) return 'Empate';
    return (m > 0 ? 'R' : opp) + '+' + nf1.format(Math.abs(m));
  }
  const cls = (m, opp = 'D') => (m == null ? '' : m > 0 ? 'r' : opp === 'I' ? 'i' : 'd');
  const signed = (x) => (x == null ? '—' : (x > 0 ? '+' : x < 0 ? '−' : '') + nf1.format(Math.abs(x)));
  // probabilidade sem falsas certezas: nunca "100%" nem "0%"
  const pp = (p) => (p == null ? '—' : p >= 0.995 ? '>99%' : p <= 0.005 ? '<1%' : Math.round(p * 100) + '%');
  const pcls = (p) => (p == null ? '' : p >= 0.5 ? 'r' : 'd');
  // votos que faltam e margem de que o R precisa neles para chegar ao empate (pontos)
  function needed(r) {
    const left = Math.max(0, r.expected - r.total);
    if (!r.total || left < 1) return null;
    return { left, need: ((r.O.votes - r.R.votes) / left) * 100 };
  }
  const STNAME = { FL: 'Florida', OH: 'Ohio', TX: 'Texas', MI: 'Michigan', NC: 'Carolina do Norte', ME: 'Maine', GA: 'Geórgia', IA: 'Iowa', AZ: 'Arizona', KS: 'Kansas', NH: 'New Hampshire' };
  const RATING = { 'solid-rep': 'R seguro', 'likely-rep': 'R provável', 'lean-rep': 'Inclina R', tossup: 'Renhida', 'lean-dem': 'Inclina D', 'likely-dem': 'D provável', 'solid-dem': 'D seguro' };

  // ---------------------------------------------------------------- recolha
  async function load() {
    const url = '/api/state' + (DEMO ? '?demo=' + S.demoT.toFixed(3) : '');
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.races) throw new Error(data.error || 'resposta inválida');
      S.prev = S.data; S.data = data; S.at = Date.now(); S.err = null;
      detect(S.prev, data);
      render();
    } catch (e) {
      S.err = e.message;
      renderLive();
    }
  }
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    const ms = DEMO ? (S.playing ? 2500 : 60000) : document.hidden ? 60000 : 15000;
    timer = setTimeout(async () => { if (DEMO && S.playing) stepDemo(); await load(); schedule(); }, ms);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !DEMO) { load(); } schedule(); });

  // ---------------------------------------------------------------- relógio e estado
  function renderClock() {
    $('#clock').innerHTML = tLis.format(new Date()) + '<small>Lisboa</small>';
  }
  function renderLive() {
    const el = $('#live');
    if (!S.data) { el.innerHTML = '<span class="dot"></span><span class="txt">A ligar…</span>'; return; }
    const ago = Math.round((Date.now() - S.at) / 1000);
    const when = tLisS.format(new Date(S.at));
    if (S.err) el.innerHTML = `<span class="dot warn"></span><span class="txt">Sem ligação · dados das ${when}</span>`;
    else if (S.data.errors && S.data.errors.length) el.innerHTML = `<span class="dot warn"></span><span class="txt" title="${esc(S.data.errors.join(' · '))}">Algumas fontes falharam · a mostrar os últimos dados bons</span>`;
    else el.innerHTML = `<span class="dot on"></span><span class="txt">${DEMO ? 'Ensaio' : 'Ao vivo'} · atualizado há ${ago < 60 ? ago + ' s' : Math.round(ago / 60) + ' min'}</span>`;
  }
  setInterval(() => { renderClock(); renderLive(); }, 1000);

  // ---------------------------------------------------------------- veredicto
  function probSpark(ts, W = 220, H = 44) {
    const pts = (ts || []).map(([t, p]) => [Date.parse(t), p]).filter((x) => isFinite(x[0]) && x[1] != null);
    if (pts.length < 2) return '';
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
    const X = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W, Y = (p) => H - 3 - p * (H - 6);
    const d = pts.map(([t, p], i) => (i ? 'L' : 'M') + X(t).toFixed(1) + ' ' + Y(p).toFixed(1)).join(' ');
    const last = pts[pts.length - 1];
    return `<svg class="psp" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="${W}" y1="${Y(0.5)}" y2="${Y(0.5)}" stroke="#6f7d8f" stroke-dasharray="3 3"/>
      <path d="${d}" fill="none" stroke="#ef4444" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <circle cx="${X(last[0])}" cy="${Y(last[1])}" r="3" fill="#ef4444"/></svg>`;
  }
  function chamberVerdict(name, c, need) {
    if (!c || !c.model || !c.model.GOP) return '';
    const g = c.model.GOP;
    const p = g.p;
    const won = c.winner === 'GOP' ? 'R garantiu' : c.winner === 'DEM' ? 'D garantiu' : null;
    const word = won || (p >= 0.85 ? 'R muito favorito' : p >= 0.6 ? 'R favorito' : p > 0.4 ? 'Moeda ao ar' : p > 0.15 ? 'D favorito' : 'D muito favorito');
    const first = c.ts && c.ts.length ? c.ts[0][1] : null;
    const delta = first != null && c.ts.length > 1 ? Math.round((p - first) * 100) : null;
    return `<div class="vd-card ${won ? (c.winner === 'GOP' ? 'won-r' : 'won-d') : ''}">
      <div class="vd-k">${name} · probabilidade de controlo republicano</div>
      <div class="vd-row"><span class="vd-p ${pcls(p)} num">${pp(p)}</span><span class="vd-w">${word}${delta ? `<small class="${delta > 0 ? 'vs-up' : 'vs-dn'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)} pts desde o início</small>` : ''}</span></div>
      <div class="vd-meter"><span style="width:${(p * 100).toFixed(1)}%"></span><i></i></div>
      <div class="vd-foot"><span>Lugares R previstos: <b class="num">${g.seats}</b>${g.q ? ` <span class="muted num">(${g.q[1]}–${g.q[3]})</span>` : ''} · precisa de ${need}</span>${probSpark(c.ts)}</div>
    </div>`;
  }
  function renderVerdict() {
    const d = S.data, c = d.control;
    // caminho para os 50: lugares R garantidos + corridas por decidir ordenadas pela probabilidade do NYT
    const sen = d.senate.filter((x) => !x.call).slice().sort((a, b) => (b.pR == null ? -1 : b.pR) - (a.pR == null ? -1 : a.pR));
    const fav = sen.filter((x) => x.pR != null && x.pR >= 0.5).length;
    const have = c.S ? c.S.R : 0;
    const tracked = new Set(d.races.filter((r) => r.office.startsWith('Senado')).map((r) => r.st));
    const chips = sen.filter((x) => x.pR != null && x.pR > 0.02 && x.pR < 0.98).map((x) => {
      const id = d.races.find((r) => r.st === x.st && r.office.startsWith('Senado'));
      return `<${id ? `button data-id="${id.id}"` : 'span'} class="chip" style="--p:${x.pR}" title="${esc(x.R)} contra ${esc(x.O)}">${x.st}${tracked.has(x.st) ? '★' : ''} <b class="num">${pp(x.pR)}</b>${x.eevp ? `<i class="num">${Math.round(x.eevp)}%</i>` : ''}</${id ? 'button' : 'span'}>`;
    }).join('');
    // próximos fechos nos 11 estados do radar
    const now = Date.now();
    const groups = {};
    for (const st of Object.keys(STNAME)) {
      const t = d.closings[st];
      if (t && Date.parse(t) > now - 15 * 60000) (groups[t] = groups[t] || []).push(st);
    }
    const next = Object.entries(groups).sort((a, b) => Date.parse(a[0]) - Date.parse(b[0])).slice(0, 4)
      .map(([t, sts]) => `<span class="cl ${Date.parse(t) <= now ? 'past' : ''}"><b class="num">${tLis.format(new Date(t))}</b> ${sts.join(' · ')}</span>`).join('');
    const pS = c.S && c.S.model && c.S.model.GOP ? c.S.model.GOP.p : null;
    const counting = d.races.some((r) => r.total > 0);
    const head = !counting
      ? `Ainda não há votos contados. Antes da contagem, o modelo do NYT dá <b class="${pcls(pS)}">${pp(pS)}</b> aos republicanos no Senado.`
      : `${c.S && c.S.winner ? (c.S.winner === 'GOP' ? '<b class="r">Os republicanos garantiram o Senado.</b>' : '<b class="d">Os democratas garantiram o Senado.</b>') : `Senado: <b class="${pcls(pS)}">R com ${pp(pS)}</b> segundo o modelo ao vivo do NYT.`} Se cada partido ganhar onde é favorito agora, o R fica com <b class="num">${have + fav}</b> lugares (precisa de 50).`;
    $('#verdict').innerHTML = `
      <p class="vd-head">${head}</p>
      <div class="vd-grid">${chamberVerdict('Senado', c.S, '50 (Vance desempata)')}${chamberVerdict('Câmara', c.H, '218')}</div>
      <div class="vd-path"><div class="vd-k">Caminho para os 50 no Senado · R tem <b class="num">${have}</b> garantidos · corridas por decidir pela probabilidade R (NYT)</div><div class="chips">${chips || '<span class="muted">Sem corridas por decidir</span>'}</div></div>
      ${next ? `<div class="vd-close"><span class="vd-k">Fecho da maioria das urnas · hora de Lisboa</span>${next}</div>` : ''}`;
  }

  // ---------------------------------------------------------------- placar
  function chamberCard(title, c, needR, needText, total, extra) {
    if (!c) return `<div class="card"><div class="sc-title">${title}</div><p class="muted">Sem dados</p></div>`;
    const und = Math.max(0, total - c.R - c.D - c.I);
    const w = (x) => (x / total) * 100 + '%';
    const won = c.winner === 'GOP' ? '<span class="badge callR">R controla</span>' : c.winner === 'DEM' ? '<span class="badge callD">D controla</span>' : '';
    return `<div class="card">
      <div class="sc-head"><span class="sc-title">${title}</span>${won || `<span class="sc-need">R precisa de ${needR} ${needText}</span>`}</div>
      <div class="sc-big"><span class="n r num">${c.R}<small>R</small></span><span class="n d num">${c.D}<small>D</small></span>${c.I ? `<span class="n i num">${c.I}<small>I</small></span>` : ''}<span class="vs">${und} por decidir</span></div>
      <div class="bar"><span class="bR" style="width:${w(c.R)}"></span><span style="width:${w(und)}"></span><span class="bI" style="width:${w(c.I)}"></span><span class="bD" style="width:${w(c.D)}"></span><i class="mid" style="left:${(needR / total) * 100}%"></i></div>
      <div class="sc-foot"><span>Antes da noite: R ${c.current ? c.current.GOP : '—'} · D ${c.current ? c.current.DEM : '—'}${c.current && c.current.OTH ? ' · I ' + c.current.OTH : ''}</span><span>Lugares que mudam: <b class="r">R +${c.flipsR || 0}</b> · <b class="d">D +${c.flipsD || 0}</b></span></div>
      ${extra || ''}
    </div>`;
  }
  function houseExtra() {
    const h = S.data.house;
    if (!h) return '';
    const v = h.vote;
    const two = v && v.R + v.D > 0 ? ((v.R - v.D) / (v.R + v.D)) * 100 : null;
    const flips = h.flips.slice(0, 24).map((f) => `<span class="mini ${f.who === 'R' ? 'r' : 'd'}" title="${esc(f.name)}">${f.st}-${esc(f.seat)}</span>`).join('');
    return `<div class="sc-extra">${two != null ? `<span>Voto nacional contado: <b class="${cls(two)} num">${fm(two)}</b> <span class="muted">(2024: ≈ R+3)</span></span>` : ''}${flips ? `<div class="minis">${flips}</div>` : ''}</div>`;
  }
  function govCard(list) {
    const R = list.filter((r) => r.call === 'R').length, D = list.filter((r) => r.call === 'D').length, I = list.filter((r) => r.call === 'I').length;
    const und = list.length - R - D - I;
    const flipsR = list.filter((r) => r.call === 'R' && r.gained).length;
    const w = (x) => (x / Math.max(1, list.length)) * 100 + '%';
    return `<div class="card">
      <div class="sc-head"><span class="sc-title">Governadores</span><span class="sc-need">${list.length} corridas</span></div>
      <div class="sc-big"><span class="n r num">${R}<small>R</small></span><span class="n d num">${D}<small>D</small></span><span class="vs">${und} por decidir</span></div>
      <div class="bar"><span class="bR" style="width:${w(R)}"></span><span style="width:${w(und)}"></span><span class="bI" style="width:${w(I)}"></span><span class="bD" style="width:${w(D)}"></span></div>
      <div class="sc-foot"><span>Projeções da AP</span><span>${flipsR ? flipsR + ' conquistas R' : ''}</span></div>
    </div>`;
  }
  function renderScore() {
    const c = S.data.control;
    $('#score').innerHTML =
      chamberCard('Senado', c.S, 50, '(Vance desempata)', 100) +
      chamberCard('Câmara dos Representantes', c.H, 218, 'para a maioria', 435, houseExtra()) +
      govCard(S.data.governors);
  }

  // ---------------------------------------------------------------- pulso republicano
  function renderPulse() {
    const races = S.data.races;
    const counting = races.filter((r) => r.total > 0);
    const ahead = races.filter((r) => r.radar.proj > 0).length;
    // swing face a Trump 2024 (uma corrida por estado, para não contar votos duas vezes)
    const byState = {};
    for (const r of races) if (r.total > 0 && (!byState[r.st] || r.office.startsWith('Senado'))) byState[r.st] = r;
    let sw = 0, sv = 0;
    for (const r of Object.values(byState)) for (const c of r.counties) {
      const T = c[4];
      if (T > 0 && c[6] != null) { sw += T * (((c[2] - c[3]) / T) * 100 - c[6]); sv += T; }
    }
    const swing = sv ? sw / sv : null;
    let up = 0, wn = 0;
    for (const r of Object.values(byState)) if (r.watch) for (const w of r.watch.rows) if (w.m != null && w.f >= 10) { wn++; if (w.m >= w.target) up++; }
    const calls = S.data.senate.concat(S.data.governors).filter((x) => x.call);
    const cR = calls.filter((x) => x.call === 'R').length, cD = calls.filter((x) => x.call === 'D').length;
    // condados que mudaram de lado face a Trump 2024 (com pelo menos 20% contado)
    let fR = 0, fD = 0, above = 0, withT = 0;
    for (const r of Object.values(byState)) for (const c of r.counties) {
      const T = c[4];
      if (!(T > 0) || c[1] < 20 || c[6] == null) continue;
      const m = ((c[2] - c[3]) / T) * 100;
      if (m > 0 && c[6] < 0) fR++; else if (m < 0 && c[6] > 0) fD++;
      if (c[7] != null) { withT++; if (m >= c[7]) above++; }
    }
    $('#pulse').innerHTML = `
      <div class="kpi"><div class="k">Condados acima do alvo de empate</div><div class="v ${withT ? (above / withT >= 0.5 ? 'r' : 'd') : ''} num">${withT ? Math.round((above / withT) * 100) + '%' : '—'}</div><div class="s">${withT ? `${above} de ${withT} condados (≥20% contado) nos 11 estados` : 'Todos os condados dos 11 estados, com o alvo do NYT'}</div></div>
      <div class="kpi"><div class="k">Condados que viraram face a 2024</div><div class="v num">${fR + fD ? `<span class="r">${fR}</span> <span class="muted">·</span> <span class="d">${fD}</span>` : '—'}</div><div class="s">${fR + fD ? 'Harris→R · Trump→D (≥20% contado)' : 'Ainda nenhum'}</div></div>`;
    $('#pulse').innerHTML += `
      <div class="kpi"><div class="k">R à frente na estimativa</div><div class="v ${ahead >= races.length / 2 ? 'r' : 'd'} num">${ahead}<span class="muted" style="font-size:20px">/${races.length}</span></div><div class="s">corridas-chave · ${counting.length} já a contar</div></div>
      <div class="kpi"><div class="k">Face a Trump 2024</div><div class="v ${swing == null ? '' : swing >= 0 ? 'r' : 'd'} num">${swing == null ? '—' : signed(swing)}</div><div class="s">${swing == null ? 'Ainda sem votos contados' : swing >= 0 ? 'R a correr acima de Trump nos condados contados' : 'R a correr abaixo de Trump nos condados contados'}</div></div>
      <div class="kpi"><div class="k">Condados-chave acima do alvo</div><div class="v ${wn && up / wn >= 0.5 ? 'r' : wn ? 'd' : ''} num">${wn ? up + '<span class="muted" style="font-size:20px">/' + wn + '</span>' : '—'}</div><div class="s">dos condados do fio com ≥10% contado</div></div>
      <div class="kpi"><div class="k">Projeções AP · Senado e governos</div><div class="v num"><span class="r">${cR}</span> <span class="muted">·</span> <span class="d">${cD}</span></div><div class="s">${calls.length ? 'corridas projetadas R · D' : 'Ainda nenhuma projeção'}</div></div>`;
  }

  // ---------------------------------------------------------------- cartões das corridas
  function statusBadge(r) {
    if (r.call) return `<span class="badge call${r.call.who}">AP: ${r.call.who} vence</span>`;
    if (r.runoff) return '<span class="badge counting">2.ª volta</span>';
    if (r.total > 0) return '<span class="badge counting">A contar</span>';
    const close = S.data.closings[r.st];
    if (close && Date.parse(close) > Date.now()) return `<span class="badge">Fecha às ${tLis.format(new Date(close))}</span>`;
    return '<span class="badge">Urnas fechadas</span>';
  }
  function gauge(r) {
    const W = 300, X = (m) => W / 2 + (Math.max(-20, Math.min(20, m)) / 20) * (W / 2);
    const p = r.radar.proj, sd = r.radar.sd;
    const lo = X(p - 1.64 * sd), hi = X(p + 1.64 * sd);
    return `<svg viewBox="0 0 ${W} 34" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="12" width="${W / 2}" height="8" fill="rgba(59,130,246,.18)"/><rect x="${W / 2}" y="12" width="${W / 2}" height="8" fill="rgba(239,68,68,.18)"/>
      <rect x="${lo}" y="9" width="${Math.max(2, hi - lo)}" height="14" rx="3" fill="${p >= 0 ? 'rgba(239,68,68,.45)' : 'rgba(59,130,246,.45)'}"/>
      <line x1="${W / 2}" x2="${W / 2}" y1="4" y2="28" stroke="#e8edf3" stroke-width="1.5"/>
      ${r.m != null ? `<line x1="${X(r.m)}" x2="${X(r.m)}" y1="6" y2="26" stroke="#e0b341" stroke-width="2" stroke-dasharray="2 2"/>` : ''}
      <circle cx="${X(p)}" cy="16" r="5.5" fill="${p >= 0 ? '#ef4444' : '#3b82f6'}" stroke="#0b0f15" stroke-width="2"/>
      <text x="2" y="33" font-size="9" fill="#6f7d8f" font-family="IBM Plex Mono">${r.O.party}+20</text>
      <text x="${W - 2}" y="33" font-size="9" fill="#6f7d8f" text-anchor="end" font-family="IBM Plex Mono">R+20</text>
    </svg>`;
  }
  function raceCard(r) {
    const tot = r.R.votes + r.O.votes;
    const sR = r.total ? (r.R.votes / r.total) * 100 : null, sO = r.total ? (r.O.votes / r.total) * 100 : null;
    const nd = r.call ? null : needed(r);
    const pills = r.watch ? r.watch.rows.map((w) => `<span class="${w.m == null || w.f < 10 ? '' : w.m >= w.target ? 'up' : 'dn'}" title="${esc(w.n)}"></span>`).join('') : '';
    return `<button class="rc" data-id="${r.id}" aria-current="${S.sel === r.id}">
      <div class="rc-top"><span class="rc-st">${esc(STNAME[r.st] || r.stName)}<span class="rc-off">${esc(r.office)}</span></span>${statusBadge(r)}</div>
      <div class="rc-cands">
        <span class="nm r">${esc(r.R.name)} ${r.R.inc ? '<i>(no cargo)</i>' : ''}</span><span class="pc">${sR == null ? '' : pct(sR)}</span>
        <span class="nm ${cls(-1, r.O.party)}">${esc(r.O.name)} ${r.O.inc ? '<i>(no cargo)</i>' : ''}</span><span class="pc">${sO == null ? '' : pct(sO)}</span>
      </div>
      <div class="rc-mid"><span class="rc-m ${cls(r.m, r.O.party)} num">${r.total ? fm(r.m, r.O.party) : '—'}<small>${r.total ? 'contado' : 'sem votos'}</small></span>
        <span class="rc-f num">${r.total ? pct(r.eevp) + ' contado' : ''}<br><span class="muted">${r.total ? compact(tot) + ' votos' : ''}</span></span></div>
      <div class="prog"><span style="width:${Math.min(100, r.eevp)}%"></span></div>
      <div class="gauge">${gauge(r)}</div>
      <div class="rc-foot"><span>Estimativa: <b class="${cls(r.radar.proj, r.O.party)} num">${fm(r.radar.proj, r.O.party)}</b> ± ${nf1.format(1.64 * r.radar.sd)}</span><span class="pr ${pcls(r.radar.pR)}" title="Probabilidade de vitória do R segundo o radar">R ${pp(r.radar.pR)}</span></div>
      ${r.nyt || nd ? `<div class="rc-foot">${nd ? `<span>${nd.need <= 0 ? 'R pode perder o que falta por até <b class="r num">' + nf1.format(-nd.need) + '</b> e ainda ganha' : `R precisa de ganhar o resto por <b class="${nd.need > 15 ? 'd' : 'r'} num">${nf1.format(nd.need)}</b>`}</span>` : '<span></span>'}${r.nyt ? `<span class="pr muted" title="Modelo ao vivo do NYT">NYT ${pp(r.nyt.pR)}</span>` : ''}</div>` : ''}
      ${pills ? `<div class="wpills" aria-label="Condados-chave acima (vermelho) ou abaixo (azul) do alvo">${pills}</div>` : ''}
    </button>`;
  }
  function sortedRaces() {
    const rs = S.data.races.slice();
    const cl = (r) => Date.parse(S.data.closings[r.st] || '2026-11-04T06:00:00Z');
    if (S.sort === 'tight') rs.sort((a, b) => Math.abs(a.radar.proj) - Math.abs(b.radar.proj));
    else if (S.sort === 'office') rs.sort((a, b) => (a.office.startsWith('Senado') ? 0 : 1) - (b.office.startsWith('Senado') ? 0 : 1) || Math.abs(a.radar.proj) - Math.abs(b.radar.proj));
    else rs.sort((a, b) => cl(a) - cl(b) || Math.abs(a.radar.proj) - Math.abs(b.radar.proj));
    return rs;
  }
  function renderGrid() {
    $('#grid').innerHTML = sortedRaces().map(raceCard).join('');
  }

  // ---------------------------------------------------------------- detalhe de uma corrida
  async function getTopo() {
    if (!S.topo) S.topo = fetch(TOPO_URL).then((r) => r.json());
    return S.topo;
  }
  function diverging(lim) {
    return d3.scaleLinear().domain([-lim, -lim / 2, -lim / 8, 0, lim / 8, lim / 2, lim]).range(['#1e3a8a', '#2563eb', '#93c5fd', '#e5e7eb', '#fca5a5', '#dc2626', '#7f1d1d']).clamp(true);
  }
  const MAPMODES = {
    target: { label: 'Vs alvo', lim: 15, val: (c) => (c.T > 0 && c.tgt != null ? c.m - c.tgt : null), legend: ['Abaixo do alvo', 'Acima do alvo (bom para R)'] },
    swing: { label: 'Vs Trump 24', lim: 15, val: (c) => (c.T > 0 ? c.m - c.m24 : null), legend: ['Pior para R', 'Melhor para R'] },
    margin: { label: 'Margem', lim: 40, val: (c) => (c.T > 0 ? c.m : null), legend: ['D/I à frente', 'R à frente'] },
    prog: { label: '% contado', val: (c) => c.f, legend: ['0%', '100%'] },
    base: { label: 'Trump 24', lim: 40, val: (c) => c.m24, legend: ['Harris', 'Trump'] },
  };
  function countyObjs(r) {
    return r.counties.map(([k, f, R, O, T, E, m24, tgt]) => ({ k, f, R, O, T, E, m24, tgt, m: T > 0 ? ((R - O) / T) * 100 : null }));
  }

  let detailSig = '';
  function renderDetail(force) {
    const el = $('#detail');
    const r = S.data && S.data.races.find((x) => x.id === S.sel);
    if (!r) { el.innerHTML = ''; detailSig = ''; return; }
    // não redesenha (nem faz piscar o mapa) se nada mudou nesta corrida
    const sig = [r.id, r.updated, r.total, r.eevp, r.call && r.call.who, r.radar.proj, r.nyt && r.nyt.pR, S.mapMode, window.innerWidth < 600].join('|');
    if (!force && sig === detailSig && el.firstChild) return;
    detailSig = sig;
    const cs = countyObjs(r);
    const byK = Object.fromEntries(cs.map((c) => [c.k, c]));
    const names = {};
    if (r.watch) for (const w of r.watch.rows) names[w.k] = w.n;
    const op = r.O.party;
    const nd = r.call ? null : needed(r);

    // condados do fio
    const wt = r.watch ? `<div class="box"><div class="box-h"><h3>Condados-chave do fio de @earlyvotedata</h3><span class="muted" style="font-size:12px">R–D nas eleições anteriores</span></div>
      <div style="overflow-x:auto"><table><thead><tr><th>Condado</th>${r.watch.cols.map((c) => `<th title="${esc(c.label)}">${esc(c.label.split(' · ')[0])}</th>`).join('')}<th title="Margem R−D que o condado teria com o estado empatado, segundo as tabelas do fio">Alvo (fio)</th><th title="O mesmo alvo, calculado pelo NYT para 2026">Alvo NYT</th><th>Agora</th><th>Contado</th><th>R vs alvo</th></tr></thead><tbody>
      ${r.watch.rows.map((w) => {
        const vs = w.m != null ? w.m - w.target : null;
        return `<tr class="${w.m != null && w.f >= 10 ? 'hl' : ''}"><td>${esc(w.n)}</td>${w.v.map(([R, D]) => `<td class="hist"><span class="r">${nf1.format(R)}</span>–<span class="d">${nf1.format(D)}</span></td>`).join('')}
          <td class="${cls(w.target)}">${fm(w.target)}</td><td class="${cls(w.nyt)}">${fm(w.nyt)}</td><td class="${cls(w.m, op)}">${w.T ? fm(w.m, op) : '—'}</td><td>${w.T ? pct(w.f) : '—'}</td>
          <td class="${vs == null ? '' : vs >= 0 ? 'vs-up' : 'vs-dn'}">${vs == null ? '—' : (vs >= 0 ? '▲ ' : '▼ ') + signed(vs)}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="note">Estaduais: ${r.watch.cols.map((c) => `${esc(c.label)} <span class="r">${nf1.format(c.R)}</span>–<span class="d">${nf1.format(c.D)}</span>`).join(' · ')}. Com pouco contado, a margem de um condado ainda pode mudar muito.</p></div>` : '';

    // miragem
    const T = r.types || {};
    const tl = { absentee_mail: ['Correio', '#8b5cf6'], advance_in_person: ['Antecipado presencial', '#06b6d4'], advance: ['Antecipado', '#06b6d4'], election_day_in_person: ['No próprio dia', '#e0b341'], provisional: ['Provisório', '#64748b'] };
    const keys = Object.keys(T);
    let mirage = '<p class="note">O NYT não divide o voto por tipo neste estado.</p>';
    if (keys.length) {
      const expT = keys.reduce((a, k) => a + T[k].exp, 0);
      const cnt = keys.map((k) => T[k].exp * (T[k].pct / 100));
      const cntT = cnt.reduce((a, b) => a + b, 0);
      const seg = (vals, tot) => vals.map((v, i) => { const w = tot ? (v / tot) * 100 : 0; return w > 0.5 ? `<span style="width:${w}%;background:${tl[keys[i]][1]}" title="${tl[keys[i]][0]}">${w > 12 ? Math.round(w) + '%' : ''}</span>` : ''; }).join('');
      const early = (arr, tot) => keys.reduce((a, k, i) => a + (k === 'election_day_in_person' ? 0 : arr[i]), 0) / (tot || 1);
      const eC = early(cnt, cntT), eE = early(keys.map((k) => T[k].exp), expT);
      let chip = '';
      if (cntT > 0 && eC - eE > 0.12) chip = '<span class="warn-chip">⚠ Até agora entrou sobretudo voto antecipado ou por correio. Costuma favorecer os democratas, por isso o R tende a subir com o voto do dia.</span>';
      else if (cntT > 0 && eE - eC > 0.12) chip = '<span class="warn-chip">⚠ Até agora entrou sobretudo voto do próprio dia. Costuma favorecer os republicanos, por isso o R pode descer quando chegar o voto antecipado.</span>';
      mirage = `<div style="display:grid;grid-template-columns:110px 1fr;gap:6px 10px;align-items:center;font-size:12px">
        <span class="muted">Já contado</span><div class="stack">${cntT ? seg(cnt, cntT) : '<span style="width:100%;color:#6f7d8f">ainda nada</span>'}</div>
        <span class="muted">Esperado no total</span><div class="stack">${seg(keys.map((k) => T[k].exp), expT)}</div></div>
        <div class="legend">${keys.map((k) => `<span style="display:inline-flex;gap:4px;align-items:center"><i style="width:9px;height:9px;border-radius:2px;background:${tl[k][1]}"></i>${tl[k][0]}</span>`).join('')}</div>
        ${chip ? `<p class="note">${chip}</p>` : ''}`;
    }

    // votos por contar
    const left = cs.map((c) => ({ ...c, left: Math.max(0, c.E * (1 - c.f / 100)) })).sort((a, b) => b.left - a.left);
    const LR = r.radar.leftR, LO = r.radar.leftO, LT = LR + LO || 1;
    const nameOf = (c) => names[c.k] || countyName(c.k) || c.k;
    const remaining = `<div class="stack" style="height:26px"><span style="width:${(LR / LT) * 100}%;background:var(--rep)">${LR / LT > 0.15 ? compact(LR) : ''}</span><span style="width:${(LO / LT) * 100}%;background:var(--dem)">${LO / LT > 0.15 ? compact(LO) : ''}</span></div>
      <p class="note">Faltam cerca de <b>${compact(LR)}</b> votos em condados que Trump ganhou em 2024 e <b>${compact(LO)}</b> em condados que Harris ganhou.</p>
      <table style="margin-top:8px"><thead><tr><th>Mais votos por contar</th><th>Por contar</th><th>Trump 2024</th><th>Agora</th></tr></thead><tbody>
      ${left.slice(0, 6).map((c) => `<tr><td>${esc(nameOf(c))}</td><td>${compact(c.left)}</td><td class="${cls(c.m24)}">${fm(c.m24)}</td><td class="${cls(c.m, op)}">${c.T ? fm(c.m, op) : '—'}</td></tr>`).join('')}</tbody></table>`;

    el.innerHTML = `<div class="dt">
      <div class="dt-head">
        <div class="dt-title">${esc(r.stName)} · ${esc(r.office)}<small><span class="r">${esc(r.R.name)} (R)</span> contra <span class="${cls(-1, op)}">${esc(r.O.name)} (${op})</span>${r.rating ? ' · classificação NYT: ' + (RATING[r.rating] || r.rating) : ''}</small></div>
        <div class="dt-stats">
          <div><div class="k">Contado</div><div class="v num">${pct(r.eevp)}</div></div>
          <div><div class="k">Margem agora</div><div class="v ${cls(r.m, op)} num">${r.total ? fm(r.m, op) : '—'}</div></div>
          <div><div class="k">Estimativa final</div><div class="v ${cls(r.radar.proj, op)} num">${fm(r.radar.proj, op)}</div></div>
          <div><div class="k">Probabilidade R</div><div class="v ${pcls(r.radar.pR)} num">${pp(r.radar.pR)}</div></div>
          ${r.nyt ? `<div><div class="k">Modelo NYT</div><div class="v ${pcls(r.nyt.pR)} num">${pp(r.nyt.pR)}</div></div>` : ''}
          ${nd ? `<div><div class="k">${nd.need > 0 ? 'R precisa no resto' : 'Folga do R no resto'}</div><div class="v ${nd.need > 0 ? 'd' : 'r'} num">${nd.need > 0 ? 'R+' : ''}${nf1.format(Math.abs(nd.need))}</div></div>` : ''}
          <div><div class="k">Trump 2024</div><div class="v ${cls(r.m24)} num">${fm(r.m24)}</div></div>
          <div><div class="k">Projeção AP</div><div class="v num">${r.call ? `<span class="${r.call.who === 'R' ? 'r' : r.call.who === 'D' ? 'd' : 'i'}">${esc(r.call.name.split(' ').slice(-1)[0])}</span>` : '<span class="muted">—</span>'}</div></div>
        </div>
        <button class="close-x" id="closeDetail">Fechar ✕</button>
      </div>
      ${notes(r)}
      ${modelBox(r)}
      <div class="dt-grid">
        <div>
          <div class="box map"><div class="box-h"><h3>Mapa por condado</h3><div class="seg" id="mapSeg">${Object.entries(MAPMODES).map(([k, m]) => `<button data-mode="${k}" aria-pressed="${S.mapMode === k}">${m.label}</button>`).join('')}</div></div>
            <div id="mapSvg" style="min-height:240px"></div><div class="legend" id="mapLegend"></div>
            <p class="note">Contorno dourado: condados-chave do fio. "Vs alvo" compara cada condado com a margem que teria se o estado ficasse empatado${r.tgtSrc === 'trump24' ? ' (aqui calculada a partir de Trump 2024)' : r.tgtSrc === 'nyt-senado' ? ' (alvo do NYT para a corrida ao Senado no mesmo estado)' : ' (alvo do NYT)'}. Passa o cursor ou toca num condado para ver os números.</p></div>
          <div class="box spark"><div class="box-h"><h3>Evolução da margem ao longo da contagem</h3></div><div id="spark"></div></div>
        </div>
        <div>
          ${wt}
          <div class="box"><div class="box-h"><h3>Que votos já entraram (miragem)</h3></div>${mirage}</div>
          <div class="box"><div class="box-h"><h3>Onde estão os votos que faltam</h3></div>${remaining}</div>
        </div>
      </div>
    </div>`;
    $('#closeDetail').onclick = () => select(null);
    $('#mapSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.mapMode = b.dataset.mode; renderDetail(); } };
    drawMap(r, byK, names);
    drawSpark(r);
  }

  // avisos de regras especiais da corrida
  function notes(r) {
    const n = [];
    if (r.rcv || r.st === 'ME') n.push('O Maine usa voto por ordem de preferência: se ninguém passar dos 50%, os votos dos últimos classificados são redistribuídos. A contagem dessa fase pode levar dias.');
    if (r.st === 'GA' || (r.threshold && r.threshold >= 50)) n.push('Na Geórgia, quem não passar dos 50% vai a uma segunda volta, em dezembro.');
    if (r.call) n.push(`Projeção da AP${r.call.at ? ' às ' + tLis.format(new Date(r.call.at)) : ''}: ${esc(r.call.name)} (${r.call.who}).`);
    return n.length ? `<div class="notes">${n.map((x) => `<p>${x}</p>`).join('')}</div>` : '';
  }
  // as duas estimativas lado a lado, no mesmo eixo
  function modelBox(r) {
    const W = window.innerWidth < 600 ? 340 : 600, lim = 25, X = (m) => 44 + ((Math.max(-lim, Math.min(lim, m)) + lim) / (2 * lim)) * (W - 64);
    const p = r.radar.proj, sd = r.radar.sd;
    const row = (y, lo, mid, hi, color, label) => `<text x="0" y="${y + 4}" font-size="11" fill="#a7b3c2" font-family="Public Sans">${label}</text>
      <rect x="${X(lo)}" y="${y - 6}" width="${Math.max(2, X(hi) - X(lo))}" height="12" rx="3" fill="${color}" opacity=".35"/>
      <circle cx="${X(mid)}" cy="${y}" r="6" fill="${color}" stroke="#0b0f15" stroke-width="2"/>`;
    const q = r.nyt && r.nyt.q;
    const ticks = (W < 600 ? [-20, 0, 20] : [-20, -10, 0, 10, 20]).map((t) => `<line x1="${X(t)}" x2="${X(t)}" y1="8" y2="${q ? 74 : 48}" stroke="${t ? '#233041' : '#a7b3c2'}" ${t ? 'stroke-dasharray="2 3"' : ''}/><text x="${X(t)}" y="${q ? 88 : 62}" font-size="10" text-anchor="middle" fill="#6f7d8f" font-family="IBM Plex Mono">${t ? (t > 0 ? 'R+' : r.O.party + '+') + Math.abs(t) : '0'}</text>`).join('');
    return `<div class="box model"><div class="box-h"><h3>Onde vai acabar: as duas estimativas</h3><span class="muted" style="font-size:12px">ponto = mais provável · barra = intervalo de 80%${q ? ' (NYT: metade central e extremos)' : ''}</span></div>
      <svg viewBox="0 0 ${W} ${q ? 92 : 66}" style="width:100%;height:auto;display:block">${ticks}
        ${row(26, p - 1.28 * sd, p, p + 1.28 * sd, p >= 0 ? '#ef4444' : '#3b82f6', 'Radar')}
        ${q ? `<line x1="${X(q[0])}" x2="${X(q[4])}" y1="56" y2="56" stroke="#a7b3c2" stroke-width="1.5"/>${row(56, q[1], q[2], q[3], q[2] >= 0 ? '#ef4444' : '#3b82f6', 'NYT')}` : ''}
      </svg>
      <p class="note">Radar: <b class="${cls(p, r.O.party)}">${fm(p, r.O.party)}</b>, R vence em ${pp(r.radar.pR)} dos casos.${q ? ` NYT: <b class="${cls(q[2], r.O.party)}">${fm(q[2], r.O.party)}</b>, R vence em ${pp(r.nyt.pR)}${r.nyt.status === 'inactive' ? ' (o modelo do NYT ainda está à espera de resultados)' : ''}.` : ' O NYT não publica modelo ao vivo para esta corrida.'}</p></div>`;
  }

  let countyNames = {};
  function countyName(k) { return countyNames[k]; }

  async function drawMap(r, byK, names) {
    const holder = $('#mapSvg');
    let topo;
    try { topo = await getTopo(); } catch (e) { holder.innerHTML = '<p class="note">Não foi possível carregar o mapa.</p>'; return; }
    if (!document.body.contains(holder)) return;
    const all = topojson.feature(topo, topo.objects.counties).features;
    if (!Object.keys(countyNames).length) for (const f of all) countyNames[f.id] = f.properties.name;
    const feats = all.filter((f) => String(f.id).startsWith(r.fipsState));
    const path = d3.geoPath();
    const [[x0, y0], [x1, y1]] = path.bounds({ type: 'FeatureCollection', features: feats });
    const mode = MAPMODES[S.mapMode];
    const color = S.mapMode === 'prog' ? d3.scaleSequential([0, 100], d3.interpolateRgb('#1d2633', '#e0b341')) : diverging(mode.lim);
    const pad = 4;
    holder.innerHTML = `<svg viewBox="${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}" role="img" aria-label="Mapa dos condados de ${esc(r.stName)}">${feats.map((f) => {
      const c = byK[f.id];
      const v = c ? mode.val(c) : null;
      return `<path d="${path(f)}" data-k="${f.id}" fill="${v == null ? '#222c39' : color(v)}" class="${names[f.id] ? 'watch' : ''}"/>`;
    }).join('')}${feats.filter((f) => names[f.id]).map((f) => `<path d="${path(f)}" fill="none" class="watch" style="pointer-events:none"/>`).join('')}</svg>`;
    $('#mapLegend').innerHTML = `<span>${mode.legend[0]}</span><span class="ramp" style="background:linear-gradient(90deg, ${S.mapMode === 'prog' ? '#1d2633, #e0b341' : '#1e3a8a, #2563eb, #93c5fd, #e5e7eb, #fca5a5, #dc2626, #7f1d1d'})"></span><span>${mode.legend[1]}</span><span style="display:inline-flex;gap:4px;align-items:center;margin-left:8px"><i style="width:10px;height:10px;background:#222c39;border-radius:2px"></i>sem votos</span>`;
    const tip = $('#tip');
    const svg = holder.querySelector('svg');
    const show = (e) => {
      const p = e.target.closest('path[data-k]');
      if (!p) { tip.hidden = true; return; }
      const c = byK[p.dataset.k];
      const n = names[p.dataset.k] || countyNames[p.dataset.k] || p.dataset.k;
      tip.innerHTML = `<b>${esc(n)}</b>${names[p.dataset.k] ? ' <span style="color:#e0b341">★ condado-chave</span>' : ''}<br>` + (c
        ? `Contado: ${pct(c.f)}${c.T ? ` · ${compact(c.T)} votos` : ''}${c.tgt != null ? `<br>Alvo de empate: <span class="${cls(c.tgt)}">${fm(c.tgt)}</span>` : ''}<br>Agora: <span class="${cls(c.m, r.O.party)}">${c.T ? fm(c.m, r.O.party) : '—'}</span><br>Trump 2024: <span class="${cls(c.m24)}">${fm(c.m24)}</span>${c.T ? `<br>Face a 2024: <b class="${c.m - c.m24 >= 0 ? 'r' : 'd'}">${signed(c.m - c.m24)}</b> para o R` : ''}`
        : 'Sem dados');
      tip.hidden = false;
      const x = Math.min(window.innerWidth - 270, e.clientX + 14);
      tip.style.left = x + 'px'; tip.style.top = (e.clientY + 14) + 'px';
    };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', () => { tip.hidden = true; });
  }

  function drawSpark(r) {
    const el = $('#spark');
    const pts = (r.ts || []).map(([t, T, R, O]) => ({ t: Date.parse(t), m: T ? ((R - O) / T) * 100 : 0, T }));
    if (pts.length < 2) { el.innerHTML = '<p class="note">A evolução aparece quando houver várias atualizações da contagem.</p>'; return; }
    const W = 560, H = 120, P = 26;
    const x = d3.scaleTime().domain(d3.extent(pts, (p) => p.t)).range([P, W - 8]);
    const lim = Math.max(5, d3.max(pts, (p) => Math.abs(p.m)) * 1.1);
    const y = d3.scaleLinear().domain([-lim, lim]).range([H - 16, 6]);
    const line = d3.line().x((p) => x(p.t)).y((p) => y(p.m)).curve(d3.curveStepAfter);
    const last = pts[pts.length - 1];
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-label="Evolução da margem">
      <rect x="${P}" y="6" width="${W - P - 8}" height="${y(0) - 6}" fill="rgba(239,68,68,.06)"/><rect x="${P}" y="${y(0)}" width="${W - P - 8}" height="${H - 16 - y(0)}" fill="rgba(59,130,246,.06)"/>
      <line x1="${P}" x2="${W - 8}" y1="${y(0)}" y2="${y(0)}" stroke="#6f7d8f" stroke-dasharray="3 3"/>
      <path d="${line(pts)}" fill="none" stroke="#e0b341" stroke-width="2"/>
      <circle cx="${x(last.t)}" cy="${y(last.m)}" r="4" fill="${last.m >= 0 ? '#ef4444' : '#3b82f6'}"/>
      <text x="2" y="12" font-size="10" fill="#6f7d8f" font-family="IBM Plex Mono">R+${Math.round(lim)}</text>
      <text x="2" y="${H - 18}" font-size="10" fill="#6f7d8f" font-family="IBM Plex Mono">${r.O.party}+${Math.round(lim)}</text>
      <text x="${P}" y="${H - 2}" font-size="10" fill="#6f7d8f" font-family="IBM Plex Mono">${tLis.format(new Date(pts[0].t))}</text>
      <text x="${W - 8}" y="${H - 2}" font-size="10" fill="#6f7d8f" text-anchor="end" font-family="IBM Plex Mono">${tLis.format(new Date(last.t))}</text>
    </svg>`;
  }

  // ---------------------------------------------------------------- tabelas do Senado e dos governadores
  function overviewTable(list, tracked) {
    const sorted = list.slice().sort((a, b) => (a.st > b.st ? 1 : -1));
    return `<table><thead><tr><th>Estado</th><th>Republicano</th><th>Adversário</th><th>Contado</th><th>Margem</th><th>Classificação</th><th title="Probabilidade de vitória do R no modelo ao vivo do NYT">NYT R</th><th>AP</th></tr></thead><tbody>
      ${sorted.map((x) => {
        const t = tracked[x.st];
        return `<tr class="${t ? 'hl' : ''}" ${t ? `data-id="${t}" style="cursor:pointer"` : ''}><td>${x.st}${x.special ? ' <span class="muted">(esp.)</span>' : ''}${t ? ' <span style="color:var(--gold)">★</span>' : ''}</td>
          <td class="r" style="font-family:var(--sans)">${esc(x.R || '—')}</td><td class="${x.Op === 'I' ? 'i' : 'd'}" style="font-family:var(--sans)">${esc(x.O || '—')}${x.Op === 'I' ? ' (I)' : ''}</td>
          <td>${x.eevp ? pct(x.eevp) : '—'}</td><td class="${cls(x.m, x.Op)}">${x.eevp ? fm(x.m, x.Op) : '—'}</td>
          <td style="font-family:var(--sans);font-size:12px" class="muted">${RATING[x.rating] || '—'}</td>
          <td class="${pcls(x.pR)}">${x.call ? '' : pp(x.pR)}</td>
          <td>${x.call ? `<span class="badge call${x.call}">${x.call}${x.gained ? ' ganha' : ''}</span>` : ''}</td></tr>`;
      }).join('')}</tbody></table>`;
  }
  function renderTables() {
    const trS = {}, trG = {};
    for (const r of S.data.races) (r.office.startsWith('Senado') ? trS : trG)[r.st] = r.id;
    $('#senate').innerHTML = overviewTable(S.data.senate, trS);
    $('#governors').innerHTML = overviewTable(S.data.governors, trG);
  }

  // ---------------------------------------------------------------- acontecimentos (feed, avisos, notificações)
  function addEvent(id, text, kind, party, important) {
    if (S.seen.has(id)) return;
    S.seen.add(id);
    const ev = { id, t: Date.now(), text, kind, party };
    S.feed.unshift(ev);
    S.feed = S.feed.slice(0, 200);
    if (important) toast(ev);
  }
  function detect(prev, cur) {
    const first = !prev;
    const label = (r) => `${STNAME[r.st] || r.stName} (${r.office})`;
    for (const r of cur.races) {
      const p = prev && prev.races.find((x) => x.id === r.id);
      const off = r.office.startsWith('Senado') ? 'S' : 'G';
      if (r.call) addEvent('srv:call-' + off + ':' + r.st, `<b>AP projeta:</b> ${esc(r.call.name)} (${r.call.who}) vence em ${esc(label(r))}.`, 'call', r.call.who, !first);
      if (p && p.total === 0 && r.total > 0) addEvent('start:' + r.id, `Primeiros votos em ${esc(label(r))}: ${fm(r.m, r.O.party)}.`, 'info', null, false);
      if (p && r.radar.F >= 25 && p.radar.proj != null && Math.sign(p.radar.proj) !== Math.sign(r.radar.proj) && r.radar.proj !== 0) {
        addEvent('srv:lead-' + r.id + '-' + (r.radar.proj > 0 ? 'R' : r.O.party), `A estimativa em ${esc(label(r))} passa para <b>${r.radar.proj > 0 ? 'R' : r.O.party}</b> (${fm(r.radar.proj, r.O.party)}, ${pct(r.radar.F)} contado).`, 'flip', r.radar.proj > 0 ? 'R' : 'D', true);
      }
      if (p && r.watch && p.watch && r.office.startsWith('Senado')) {
        r.watch.rows.forEach((w, i) => {
          const pw = p.watch.rows[i];
          if (w.m == null || pw.m == null || w.f < 25) return;
          // folga de 1 ponto para não avisar a cada oscilação em cima do alvo
          const a = w.m >= w.target, b = pw.m >= pw.target;
          if (a !== b && Math.abs(w.m - w.target) >= 1) addEvent(`wt:${r.id}:${w.k}:${a}`, `<b>${esc(w.n)}</b> (${STNAME[r.st]}): o R passa para ${a ? 'cima' : 'baixo'} do alvo (${fm(w.m, r.O.party)} com ${pct(w.f)} contado; alvo ${fm(w.target)}).`, 'watch', a ? 'R' : 'D', false);
        });
      }
    }
    // restantes corridas (as do radar já foram tratadas acima)
    const others = cur.senate.map((x) => ['S', x]).concat(cur.governors.map((x) => ['G', x]));
    for (const [off, x] of others) {
      if (!x.call || cur.races.some((r) => r.st === x.st && (r.office.startsWith('Senado') ? 'S' : 'G') === off)) continue;
      addEvent('srv:call-' + off + ':' + x.st, `<b>AP projeta:</b> ${x.call === 'R' ? esc(x.R) : esc(x.O)} (${x.call}) vence ${off === 'S' ? 'o Senado' : 'o governo'} em ${x.st}.`, 'call', x.call, false);
    }
    saveFeed();
    renderFeed();
  }
  async function loadServerEvents() {
    if (DEMO) return;
    try {
      const { events } = await (await fetch('/api/events')).json();
      let added = false;
      for (const e of (events || []).slice().reverse()) {
        const id = 'srv:' + e.tag;
        if (S.seen.has(id) || S.feed.some((f) => f.tag === e.tag)) continue;
        S.seen.add(id);
        S.feed.push({ id, tag: e.tag, t: Date.parse(e.at) || Date.now(), text: `<b>${esc(e.title)}</b> · ${esc(e.body)}`, kind: e.tag.startsWith('call') || e.tag.startsWith('ctrl') ? 'call' : 'flip', party: /\(R\)|para R|Republicanos/.test(e.title) ? 'R' : /\(D\)|para D|Democratas/.test(e.title) ? 'D' : null });
        added = true;
      }
      if (added) { S.feed.sort((a, b) => b.t - a.t); saveFeed(); renderFeed(); }
    } catch (e) { /* sem histórico do servidor */ }
  }
  function renderFeed() {
    $('#feed').innerHTML = S.feed.length
      ? S.feed.map((e) => `<div class="ev ${e.kind === 'call' ? 'call' : ''} ${e.party || ''}"><time>${tLis.format(new Date(e.t))}</time><div>${e.text}</div></div>`).join('')
      : '<div class="empty">Ainda nada. Aqui aparecem as projeções da AP, as viragens da estimativa e os condados-chave que passam o alvo.</div>';
  }
  function toast(ev) {
    const el = document.createElement('div');
    el.className = 'toast ' + (ev.party || '');
    el.innerHTML = ev.text;
    const box = $('#toasts');
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove(); // no máximo 4 avisos no ecrã
    setTimeout(() => el.remove(), 9000);
    if (S.notify && !S.push && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Radar R', { body: el.textContent, icon: 'icon.svg', tag: ev.id }); } catch (e) { /* sem notificações */ }
    }
    if (ev.kind === 'call') beep(ev.party === 'R' ? 660 : 440);
  }
  let actx = null;
  let lastBeep = 0;
  function beep(freq) {
    if (Date.now() - lastBeep < 3000) return; // um som de cada vez, mesmo com muitas projeções seguidas
    lastBeep = Date.now();
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = freq; g.gain.value = 0.05;
      o.connect(g); g.connect(actx.destination);
      o.start(); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.5); o.stop(actx.currentTime + 0.5);
    } catch (e) { /* sem som */ }
  }
  const FEED_KEY = DEMO ? 'radar-feed-demo' : 'radar-feed-2026';
  function saveFeed() { try { localStorage.setItem(FEED_KEY, JSON.stringify(S.feed.slice(0, 120))); } catch (e) { /* sem armazenamento */ } }
  function loadFeed() {
    try {
      const f = JSON.parse(localStorage.getItem(FEED_KEY) || '[]');
      if (Array.isArray(f)) { S.feed = f; f.forEach((e) => S.seen.add(e.id)); }
    } catch (e) { /* sem armazenamento */ }
  }

  // ---------------------------------------------------------------- ensaio
  function stepDemo() {
    S.demoT = Math.min(1, S.demoT + 0.02);
    if (S.demoT >= 1) S.playing = false;
    renderDemoBar();
  }
  function renderDemoBar() {
    if (!DEMO) return;
    const bar = $('#demoBar');
    bar.hidden = false;
    if (!bar.firstChild) {
      bar.innerHTML = `<div class="wrap"><b>ENSAIO · NÚMEROS FICTÍCIOS</b><span>Contagem simulada:</span><input type="range" min="0" max="1" step="0.01" id="demoT" aria-label="Momento da contagem simulada"><span class="num" id="demoV"></span><button id="demoPlay"></button><a href="/">Ir para os resultados reais</a></div>`;
      $('#demoT').addEventListener('change', (e) => { S.demoT = +e.target.value; renderDemoBar(); load(); });
      $('#demoPlay').addEventListener('click', () => { S.playing = !S.playing; if (S.demoT >= 1) S.demoT = 0; renderDemoBar(); schedule(); });
    }
    $('#demoT').value = S.demoT;
    $('#demoV').textContent = Math.round(S.demoT * 100) + '%';
    $('#demoPlay').textContent = S.playing ? '❚❚ Pausa' : '▶ Reproduzir';
  }

  // ---------------------------------------------------------------- navegação
  function select(id) {
    S.sel = id;
    history.replaceState(null, '', id ? '#' + id : location.pathname + location.search);
    document.querySelectorAll('.rc').forEach((b) => b.setAttribute('aria-current', String(b.dataset.id === id)));
    renderDetail();
    if (id) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-id]');
    if (card && (card.classList.contains('rc') || card.classList.contains('chip') || card.tagName === 'TR')) select(card.dataset.id);
    const sb = e.target.closest('#sortSeg button');
    if (sb) {
      S.sort = sb.dataset.sort;
      document.querySelectorAll('#sortSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b === sb)));
      renderGrid();
    }
  });
  let rz = null, lastW = window.innerWidth;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (Math.abs(window.innerWidth - lastW) > 40) { lastW = window.innerWidth; if (S.data) renderDetail(); } }, 250); });
  window.addEventListener('hashchange', () => { const id = decodeURIComponent(location.hash.slice(1)); if (id !== S.sel) select(id || null); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sel) select(null); });

  function render() {
    renderLive();
    renderVerdict();
    renderScore();
    renderPulse();
    renderGrid();
    renderTables();
    renderDetail();
  }

  // botão de alertas no topo: notificações push (chegam com o site fechado) e, sem push, avisos do browser
  const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
  async function pushSubscribe(on) {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!on) {
      if (sub) { await fetch('/api/push', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) }); await sub.unsubscribe(); }
      return false;
    }
    const { key } = await (await fetch('/api/push')).json();
    if (!key) throw new Error('sem chave');
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
    const r = await fetch('/api/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return true;
  }
  function setupNotify() {
    if (!('Notification' in window)) return;
    const canPush = 'serviceWorker' in navigator && 'PushManager' in window && !DEMO;
    if (canPush) navigator.serviceWorker.register('/sw.js').catch(() => {});
    const b = document.createElement('button');
    b.className = 'btn';
    b.style.fontSize = '12.5px';
    let pushOn = false;
    const upd = () => {
      S.push = pushOn;
      b.textContent = pushOn ? '🔔 Alertas push ligados' : S.notify ? '🔔 Alertas ligados' : '🔕 Ativar alertas';
      b.title = pushOn ? 'Recebes as projeções da AP e as viragens mesmo com o site fechado' : 'Ativar avisos das projeções e viragens';
    };
    S.notify = Notification.permission === 'granted';
    if (canPush && S.notify) navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => { pushOn = !!s; upd(); }).catch(() => {});
    upd();
    b.onclick = async () => {
      if (pushOn || S.notify) {
        S.notify = false;
        if (pushOn) { try { pushOn = await pushSubscribe(false); } catch (e) { pushOn = false; } }
        upd(); return;
      }
      const p = await Notification.requestPermission();
      S.notify = p === 'granted';
      if (S.notify && canPush) {
        try { pushOn = await pushSubscribe(true); } catch (e) { pushOn = false; toast({ id: 'pushfail', text: 'Não foi possível ativar o push neste aparelho. Os avisos só aparecem com o site aberto.', kind: 'info' }); }
      }
      if (S.notify) toast({ id: 'pushok', text: pushOn ? '<b>Alertas ligados.</b> Recebes as projeções da AP e as viragens mesmo com o site fechado.' : '<b>Alertas ligados</b> enquanto o site estiver aberto.', kind: 'info' });
      upd();
      beep(660);
    };
    $('.top-in').insertBefore(b, $('#clock'));
  }

  renderClock();
  renderLive();
  loadFeed();
  renderFeed();
  renderDemoBar();
  setupNotify();
  load().then(schedule);
  loadServerEvents();
  setInterval(loadServerEvents, 120000);
})();
