/* Radar Republicano: página. Lê /api/state (resumo calculado na Vercel a partir dos ficheiros do NYT). */
(function () {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');
  const TOPO_URL = 'https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-albers-10m.json';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sem armazenamento */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* sem armazenamento */ } },
  };
  function hashId() { try { return decodeURIComponent(location.hash.slice(1)) || null; } catch (e) { return null; } }

  const S = {
    data: null, prev: null, at: 0, err: null, renderErr: null,
    sel: null, sort: 'close', sortUser: false, mapMode: 'target',
    demoT: Math.max(0, Math.min(1, Number(params.get('demo')) || 0)), playing: false,
    seen: new Set(), feed: [], topo: null, notify: false, push: false,
    lastVisit: Number(store.get(DEMO ? 'radar-visit-demo' : 'radar-visit')) || 0,
  };
  const visitStart = Date.now();
  const saveVisit = () => store.set(DEMO ? 'radar-visit-demo' : 'radar-visit', String(Date.now()));
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveVisit(); });
  window.addEventListener('pagehide', saveVisit);

  // ---------------------------------------------------------------- formatação
  const nf1 = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 0 });
  const tLis = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon', hour: '2-digit', minute: '2-digit' });
  const pct = (x) => nf1.format(x) + '%';
  const compact = (x) => (x >= 999500 ? nf1.format(x / 1e6) + ' M' : x >= 1e3 ? nf0.format(x / 1e3) + ' mil' : nf0.format(x));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // margem R−adversário → "R+3,2" / "D+1,5"
  function fm(m, opp = 'D') {
    if (m == null) return '—';
    if (Math.abs(m) < 0.05) return 'Empate';
    return (m > 0 ? 'R' : opp) + '+' + nf1.format(Math.abs(m));
  }
  const cls = (m, opp = 'D') => (m == null ? '' : m > 0 ? 'r' : opp === 'I' ? 'i' : 'd');
  const signed = (x) => (x == null ? '—' : (x > 0 ? '+' : x < 0 ? '−' : '') + nf1.format(Math.abs(x)));
  // probabilidade sem falsas certezas: nunca "100%" nem "0%" (exceto com projeção da AP)
  const pp = (p) => (p == null ? '—' : p >= 0.995 ? '>99%' : p <= 0.005 ? '<1%' : Math.round(p * 100) + '%');
  const pcls = (p) => (p == null ? '' : p >= 0.5 ? 'r' : 'd');
  const good = (x) => (x == null ? '' : x >= 0 ? 'good' : 'bad'); // bom ou mau para o R
  // votos que faltam e margem de que o R precisa neles para empatar (pontos)
  function needed(r) {
    const left = Math.max(0, r.expected - r.total);
    if (!r.total || left < 1 || r.eevp < 1) return null; // com quase nada contado, a conta não diz nada
    return { left, need: ((r.O.votes - r.R.votes) / left) * 100 };
  }
  const STNAME = { FL: 'Florida', OH: 'Ohio', TX: 'Texas', MI: 'Michigan', NC: 'Carolina do Norte', ME: 'Maine', GA: 'Geórgia', IA: 'Iowa', AZ: 'Arizona', KS: 'Kansas', NH: 'New Hampshire' };
  const RATING = { 'solid-rep': 'R seguro', 'likely-rep': 'R provável', 'lean-rep': 'Inclina R', tossup: 'Renhida', 'lean-dem': 'Inclina D', 'likely-dem': 'D provável', 'solid-dem': 'D seguro' };
  const isSen = (r) => r.office.startsWith('Senado');

  // ---------------------------------------------------------------- recolha
  let reqSeq = 0;
  async function load() {
    const seq = ++reqSeq;
    const url = '/api/state' + (DEMO ? '?demo=' + S.demoT.toFixed(3) : '');
    let data;
    try {
      const res = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
      if (!data.races) throw new Error(data.error || 'resposta inválida');
    } catch (e) {
      if (seq === reqSeq) { S.err = e.message || 'erro'; renderLive(); }
      return;
    }
    if (seq !== reqSeq) return; // chegou uma resposta mais recente entretanto
    S.prev = S.data; S.data = data; S.at = Date.now(); S.err = null;
    try {
      detect(S.prev, data);
      render();
      S.renderErr = null;
    } catch (e) {
      S.renderErr = e.message;
      console.error(e);
      renderLive();
    }
  }
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    const ms = DEMO ? (S.playing ? 2500 : 60000) : document.hidden ? 60000 : 20000;
    timer = setTimeout(async () => { if (DEMO && S.playing) stepDemo(); await load(); schedule(); }, ms);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !DEMO) load(); schedule(); });

  // ---------------------------------------------------------------- relógio e estado da ligação
  function renderClock() { $('#clock').innerHTML = tLis.format(new Date()) + '<small>Lisboa</small>'; }
  function renderLive() {
    const el = $('#live');
    if (!S.data) { el.innerHTML = S.err ? '<span class="dot warn"></span><span class="txt">Sem ligação ao servidor · a tentar de novo</span>' : '<span class="dot"></span><span class="txt">A ligar…</span>'; return; }
    const ago = Math.round((Date.now() - S.at) / 1000);
    const src = S.data.sourceUpdatedAt ? Date.parse(S.data.sourceUpdatedAt) : null;
    const srcTxt = src ? ` · NYT ${tLis.format(new Date(src))}` : '';
    if (S.err) el.innerHTML = `<span class="dot warn"></span><span class="txt">Sem ligação · dados das ${tLis.format(new Date(S.at))}</span>`;
    else if (S.renderErr) el.innerHTML = `<span class="dot warn"></span><span class="txt" title="${esc(S.renderErr)}">Erro interno da página · recarrega</span>`;
    else if (S.data.errors && S.data.errors.length) el.innerHTML = `<span class="dot warn"></span><span class="txt" title="${esc(S.data.errors.join(' · '))}">Uma fonte falhou · a mostrar os últimos dados bons</span>`;
    else el.innerHTML = `<span class="dot on"></span><span class="txt">${DEMO ? 'Ensaio' : 'Ao vivo'} · há ${ago < 60 ? ago + ' s' : Math.round(ago / 60) + ' min'}${srcTxt}</span>`;
  }
  setInterval(() => { renderClock(); renderLive(); }, 1000);

  // ---------------------------------------------------------------- resumo (veredicto)
  function probSpark(ts, W = 220, H = 44) {
    const pts = (ts || []).map(([t, p]) => [Date.parse(t), p]).filter((x) => isFinite(x[0]) && x[1] != null);
    if (pts.length < 2) return '';
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
    const X = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W, Y = (p) => H - 3 - p * (H - 6);
    const d = pts.map(([t, p], i) => (i ? 'L' : 'M') + X(t).toFixed(1) + ' ' + Y(p).toFixed(1)).join(' ');
    const last = pts[pts.length - 1];
    return `<svg class="psp" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Evolução da probabilidade ao longo da noite">
      <line x1="0" x2="${W}" y1="${Y(0.5)}" y2="${Y(0.5)}" stroke="#8593a5" stroke-dasharray="3 3"/>
      <path d="${d}" fill="none" stroke="#ef4444" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <circle cx="${X(last[0])}" cy="${Y(last[1])}" r="3" fill="#ef4444"/></svg>`;
  }
  function chamberVerdict(name, c, need) {
    if (!c || !c.model || !c.model.GOP) return '';
    const g = c.model.GOP;
    const p = c.winner === 'GOP' ? 1 : c.winner === 'DEM' ? 0 : g.p;
    const won = c.winner === 'GOP' ? 'R garantiu' : c.winner === 'DEM' ? 'D garantiu' : null;
    const word = won || (p >= 0.85 ? 'R muito favorito' : p >= 0.6 ? 'R favorito' : p > 0.4 ? 'Moeda ao ar' : p > 0.15 ? 'D favorito' : 'D muito favorito');
    const hist = (S.hist && S.hist[name === 'Senado' ? 'S' : 'H']) || c.ts || [];
    const first = hist.length ? hist[0][1] : null;
    const delta = first != null && hist.length > 1 ? Math.round((p - first) * 100) : null;
    return `<div class="vd-card ${won ? (c.winner === 'GOP' ? 'won-r' : 'won-d') : ''}">
      <div class="vd-k">${name} · hipótese de maioria republicana <span class="src">modelo NYT</span></div>
      <div class="vd-row"><span class="vd-p ${pcls(p)} num">${won ? (c.winner === 'GOP' ? 'R' : 'D') : pp(p)}</span><span class="vd-w">${word}${delta ? `<small class="${delta > 0 ? 'good' : 'bad'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)} pontos desde o início da noite</small>` : ''}</span></div>
      <div class="vd-meter" aria-hidden="true"><span style="width:${(p * 100).toFixed(1)}%"></span><i></i></div>
      <div class="vd-foot"><span>Lugares R previstos: <b class="num">${g.seats}</b>${g.q ? ` <span class="muted num">(entre ${g.q[1]} e ${g.q[3]})</span>` : ''} · precisa de ${need}</span>${probSpark(hist)}</div>
    </div>`;
  }
  function keyCounties() {
    // condados-chave da lista (um estado conta uma vez: prefere a corrida ao Senado)
    const byState = {};
    for (const r of S.data.races) if (!byState[r.st] || isSen(r)) byState[r.st] = r;
    let up = 0, n = 0;
    for (const r of Object.values(byState)) if (r.watch) for (const w of r.watch.rows) if (w.m != null && w.f >= 10 && !w.flag) { n++; if (w.m >= w.target) up++; }
    return { up, n, byState };
  }
  function renderVerdict() {
    const d = S.data, c = d.control;
    const open = d.senate.filter((x) => !x.call);
    const fav = open.filter((x) => x.pR != null && x.pR >= 0.5).length;
    const have = c.S ? c.S.R : 0;
    const proj = have + fav;
    const pS = c.S && c.S.model && c.S.model.GOP ? c.S.model.GOP.p : null;
    const pH = c.H && c.H.model && c.H.model.GOP ? c.H.model.GOP.p : null;
    const counting = d.races.some((r) => r.total > 0);
    // corridas decisivas: as por decidir mais perto de 50%
    const decisive = open.filter((x) => x.pR != null && x.pR > 0.15 && x.pR < 0.85).sort((a, b) => Math.abs(a.pR - 0.5) - Math.abs(b.pR - 0.5)).slice(0, 4);
    const kc = keyCounties();
    const sWon = c.S && c.S.winner;
    // tom da noite: modelo do NYT para o Senado; com votos contados, se o caminho para os 50 disser o contrário, fica "equilibrada"
    let lvl = pS == null ? null : pS >= 0.6 ? 2 : pS > 0.4 ? 1 : 0;
    if (counting && lvl != null && ((proj >= 50 && lvl === 0) || (proj < 50 && lvl === 2))) lvl = 1;
    const tone = sWon ? (sWon === 'GOP' ? 'good' : 'bad') : lvl == null ? '' : ['bad', 'mid', 'good'][lvl];
    const toneTxt = sWon ? (sWon === 'GOP' ? 'Os republicanos garantiram o Senado' : 'Os democratas garantiram o Senado') : lvl == null ? '' : ['Noite difícil para os republicanos', 'Noite equilibrada', 'Noite boa para os republicanos'][lvl];
    const lines = [
      `<li><b>Senado:</b> ${sWon ? toneTxt + '.' : `se cada partido ganhar onde é favorito agora, o R fica com <b class="num ${proj >= 50 ? 'good' : 'bad'}">${proj}</b> lugares (precisa de 50).`}${!sWon && decisive.length ? ` Decidem-se em ${decisive.map((x) => { const t = d.races.find((r) => r.st === x.st && isSen(r)); return t ? `<a href="#${t.id}" class="st">${esc(x.st)}</a>` : `<b>${esc(x.st)}</b>`; }).join(', ')}.` : ''}</li>`,
      `<li><b>Condados-chave:</b> ${kc.n ? `<b class="num ${kc.up / kc.n >= 0.5 ? 'good' : 'bad'}">${kc.up} de ${kc.n}</b> com o R acima do alvo de empate${kc.up / kc.n >= 0.5 ? ', o que chega para ganhar os estados' : ', abaixo do que precisa'}.` : 'ainda sem votos comparáveis (10% contado e os dois tipos de voto).'}</li>`,
      `<li><b>Câmara:</b> ${c.H && c.H.winner ? (c.H.winner === 'GOP' ? 'os republicanos garantiram a maioria.' : 'os democratas garantiram a maioria.') : `hipótese republicana de <b class="num ${pcls(pH)}">${pp(pH)}</b> no modelo do NYT.`}${(() => { const h = houseStats(); return h.w.length ? ` Nos <a href="#camara">${h.w.length} distritos a seguir</a>, o R é favorito em <b class="num ${h.fav >= h.w.length / 2 ? 'good' : 'bad'}">${h.fav}</b>${h.callR + h.callD ? ` e a AP já lhe deu <b class="num">${h.callR}</b>` : ''}.` : ''; })()}</li>`,
    ];
    // fecho das urnas nos 11 estados, com o estado de cada um
    const now = Date.now();
    const groups = {};
    for (const st of Object.keys(STNAME)) { const t = d.closings[st]; if (t) (groups[t] = groups[t] || []).push(st); }
    const stStatus = (st) => {
      const rs = d.races.filter((r) => r.st === st);
      if (rs.length && rs.every((r) => r.call)) return 'done';
      if (rs.some((r) => r.total > 0)) return 'live';
      return '';
    };
    const slots = Object.entries(groups).sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
    const nextSlot = slots.find(([t]) => Date.parse(t) > now);
    let countdown = '';
    if (nextSlot) {
      const mins = Math.round((Date.parse(nextSlot[0]) - now) / 60000);
      countdown = `<span class="cd">Próximo fecho: <b class="num">${tLis.format(new Date(nextSlot[0]))}</b> (${nextSlot[1].join(', ')}) · faltam ${mins >= 60 ? Math.floor(mins / 60) + ' h ' : ''}${mins % 60} min</span>`;
    }
    const strip = slots.map(([t, sts]) => `<span class="cl ${Date.parse(t) <= now ? 'past' : ''}"><b class="num">${tLis.format(new Date(t))}</b> ${sts.map((st) => `<i class="s-${stStatus(st)}">${st}</i>`).join(' ')}</span>`).join('');
    $('#verdict').innerHTML = `
      <div class="vd-top"><span class="tone ${tone}">${toneTxt || 'A carregar'}</span>${!counting ? '<span class="muted">Ainda não há votos contados: os números abaixo são as expectativas antes da contagem.</span>' : ''}</div>
      <ul class="vd-lines">${lines.join('')}</ul>
      <div class="vd-grid">${chamberVerdict('Senado', c.S, '50 (Vance desempata)')}${chamberVerdict('Câmara', c.H, '218')}</div>
      <div class="vd-path"><div class="vd-k">Caminho para os 50 no Senado · R tem <b class="num">${have}</b> lugares garantidos · corridas por decidir pela hipótese republicana (NYT)</div><div class="chips">${pathChips()}</div></div>
      <div class="vd-close"><span class="vd-k">Fecho da maioria das urnas (Lisboa)</span>${strip}${countdown}<span class="legend-s"><i class="s-live">a contar</i> <i class="s-done">projetado</i></span></div>`;
  }
  function pathChips() {
    const d = S.data;
    const open = d.senate.filter((x) => !x.call).slice().sort((a, b) => (b.pR == null ? -1 : b.pR) - (a.pR == null ? -1 : a.pR));
    const chips = open.filter((x) => x.pR != null && x.pR > 0.02 && x.pR < 0.98).map((x) => {
      const r = d.races.find((y) => y.st === x.st && isSen(y));
      const inner = `${esc(x.st)}${r ? '★' : ''} <b class="num">${pp(x.pR)}</b>${x.eevp ? `<i class="num">${Math.round(x.eevp)}% contado</i>` : ''}`;
      const title = `${esc(x.R)} (R) contra ${esc(x.O)} (${esc(x.Op)}): hipótese R ${pp(x.pR)} no modelo do NYT`;
      return r ? `<a class="chip" href="#${r.id}" style="--p:${x.pR}" title="${title}">${inner}</a>` : `<span class="chip" style="--p:${x.pR}" title="${title}">${inner}</span>`;
    }).join('');
    return chips || '<span class="muted">Sem corridas por decidir</span>';
  }

  // ---------------------------------------------------------------- últimos acontecimentos (logo abaixo do resumo)
  function renderLatest() {
    const ev = S.feed.slice(0, 3);
    $('#latest').innerHTML = ev.length
      ? `<div class="lt-head"><b>Ao minuto</b><a href="#minuto">ver tudo (${S.feed.length})</a></div>${ev.map((e) => `<div class="ev ${e.kind === 'call' ? 'call' : ''} ${e.party || ''} ${e.t > S.lastVisit && S.lastVisit && e.t < visitStart ? 'new' : ''}"><time>${tLis.format(new Date(e.t))}</time><div>${e.text}</div></div>`).join('')}`
      : '';
  }

  // ---------------------------------------------------------------- pulso republicano
  function renderPulse() {
    const { up, n, byState } = keyCounties();
    let sw = 0, sv = 0, fR = 0, fD = 0, above = 0, withT = 0;
    for (const r of Object.values(byState)) for (const c of r.counties) {
      const T = c[4];
      if (!(T > 0) || c[6] == null || c[9]) continue; // c[9]: só um tipo de voto contado, ainda não compara
      const m = ((c[2] - c[3]) / T) * 100;
      sw += T * (m - c[6]); sv += T;
      if (c[1] < 20) continue;
      if (m > 0 && c[6] < 0) fR++; else if (m < 0 && c[6] > 0) fD++;
      if (c[7] != null) { withT++; if (m >= c[7]) above++; }
    }
    const swing = sv ? sw / sv : null;
    const calls = S.data.senate.concat(S.data.governors).filter((x) => x.call);
    const cR = calls.filter((x) => x.call === 'R').length, cD = calls.filter((x) => x.call === 'D').length;
    $('#pulse').innerHTML = `
      <div class="kpi"><div class="k">Condados-chave acima do alvo</div><div class="v num ${n ? (up / n >= 0.5 ? 'good' : 'bad') : ''}">${n ? `${up}<span class="of">/${n}</span>` : '—'}</div><div class="s">${n ? (up / n >= 0.5 ? 'Bom sinal: a maioria está onde o R precisa.' : 'Mau sinal: a maioria está abaixo do que o R precisa.') : 'Os condados da lista, com pelo menos 10% contado e os dois tipos de voto.'}${withT ? ` Em todos os condados: ${Math.round((above / withT) * 100)}% acima.` : ''}</div></div>
      <div class="kpi"><div class="k">Face a Trump 2024</div><div class="v num ${good(swing)}">${swing == null ? '—' : signed(swing)}</div><div class="s">${swing == null ? 'Margem do R menos a de Trump, nos condados já contados.' : swing >= 0 ? `O R está ${nf1.format(swing)} pontos melhor do que Trump nos condados contados.` : `O R está ${nf1.format(-swing)} pontos pior do que Trump nos condados contados.`}</div></div>
      <div class="kpi"><div class="k">Condados que mudaram de lado</div><div class="v num">${fR + fD ? `<span class="r">${fR}</span><span class="of"> para R · </span><span class="d">${fD}</span><span class="of"> para D</span>` : '—'}</div><div class="s">Face a 2024, com pelo menos 20% contado.</div></div>
      <div class="kpi"><div class="k">Projeções da AP</div><div class="v num">${calls.length ? `<span class="r">${cR}</span><span class="of"> R · </span><span class="d">${cD}</span><span class="of"> D</span>` : '—'}</div><div class="s">${calls.length ? 'Corridas ao Senado e a governador já projetadas.' : 'Ainda nenhuma projeção.'}</div></div>`;
  }

  // ---------------------------------------------------------------- cartões das corridas
  function statusBadge(r) {
    if (r.call) return `<span class="badge call${r.call.who}">${esc((r.call.by && r.call.by[0] || 'AP').toUpperCase())}: ${r.call.who} vence</span>`;
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
    return `<svg viewBox="0 0 ${W} 36" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="12" width="${W / 2}" height="8" fill="rgba(59,130,246,.18)"/><rect x="${W / 2}" y="12" width="${W / 2}" height="8" fill="rgba(239,68,68,.18)"/>
      <rect x="${lo}" y="9" width="${Math.max(2, hi - lo)}" height="14" rx="3" fill="${p >= 0 ? 'rgba(239,68,68,.45)' : 'rgba(59,130,246,.45)'}"/>
      <line x1="${W / 2}" x2="${W / 2}" y1="4" y2="28" stroke="#e8edf3" stroke-width="1.5"/>
      ${r.m != null ? `<line x1="${X(r.m)}" x2="${X(r.m)}" y1="6" y2="26" stroke="#e0b341" stroke-width="2" stroke-dasharray="2 2"/>` : ''}
      <circle cx="${X(p)}" cy="16" r="5.5" fill="${p >= 0 ? '#ef4444' : '#3b82f6'}" stroke="#0b0f15" stroke-width="2"/>
      <text x="2" y="35" font-size="11" fill="#8593a5" font-family="IBM Plex Mono">${r.O.party}+20</text>
      <text x="${W - 2}" y="35" font-size="11" fill="#8593a5" text-anchor="end" font-family="IBM Plex Mono">R+20</text>
    </svg>`;
  }
  const srcTxt = (r) => (r.radar.src === 'nyt' ? 'NYT' : r.radar.src === 'nyt-senado' ? 'NYT + voto dividido' : 'radar');
  function raceCard(r) {
    const tot = r.R.votes + r.O.votes;
    const sR = r.total ? (r.R.votes / r.total) * 100 : null, sO = r.total ? (r.O.votes / r.total) * 100 : null;
    const nd = r.call ? null : needed(r);
    const lo = r.radar.proj - 1.64 * r.radar.sd, hi = r.radar.proj + 1.64 * r.radar.sd;
    const pills = r.watch ? r.watch.rows.map((w) => `<span class="${w.m == null || w.f < 10 || w.flag ? '' : w.m >= w.target ? 'up' : 'dn'}" title="${esc(w.n)}${w.flag ? ': só um tipo de voto contado' : w.m == null || w.f < 10 ? ': sem votos suficientes' : w.m >= w.target ? ': acima do alvo' : ': abaixo do alvo'}"></span>`).join('') : '';
    return `<a class="rc" href="#${r.id}" data-id="${r.id}" aria-current="${S.sel === r.id ? 'true' : 'false'}" aria-label="${esc(STNAME[r.st] || r.stName)}, ${esc(r.office)}: ${esc(r.R.name)} contra ${esc(r.O.name)}${r.total ? ', margem ' + fm(r.m, r.O.party) + ' com ' + pct(r.eevp) + ' contado' : ''}">
      <span class="rc-top"><span class="rc-st">${esc(STNAME[r.st] || r.stName)}<span class="rc-off">${esc(r.office)}</span></span>${statusBadge(r)}</span>
      <span class="rc-cands">
        <span class="nm r">${esc(r.R.name)} ${r.R.inc ? '<i>(no cargo)</i>' : ''}</span><span class="pc">${sR == null ? '' : pct(sR)}</span>
        <span class="nm ${cls(-1, r.O.party)}">${esc(r.O.name)} ${r.O.inc ? '<i>(no cargo)</i>' : ''}</span><span class="pc">${sO == null ? '' : pct(sO)}</span>
      </span>
      <span class="rc-mid"><span class="rc-m ${cls(r.m, r.O.party)} num">${r.total ? fm(r.m, r.O.party) : '—'}<small>${r.total ? 'agora' : 'sem votos'}</small></span>
        <span class="rc-f num">${r.total ? pct(r.eevp) + ' contado' : ''}<br><span class="muted">${r.total ? compact(tot) + ' votos' : ''}</span></span></span>
      <span class="prog"><span style="width:${Math.min(100, r.eevp)}%"></span></span>
      <span class="gauge">${gauge(r)}</span>
      <span class="rc-foot"><span>Final estimado: <b class="${cls(r.radar.proj, r.O.party)} num">${fm(r.radar.proj, r.O.party)}</b> <span class="muted">(entre ${fm(hi, r.O.party)} e ${fm(lo, r.O.party)})</span></span></span>
      <span class="rc-foot"><span class="pr ${pcls(r.radar.pR)}" title="Hipótese de vitória do R (${srcTxt(r)})">R ${r.call ? (r.call.who === 'R' ? 'ganhou' : 'perdeu') : pp(r.radar.pR)} <i class="srcs">${srcTxt(r)}</i></span></span>
      ${nd ? `<span class="rc-need ${nd.need > 0 ? 'bad' : 'good'}">${nd.need <= 0 ? `O R pode perder o que falta por até <b class="num">${nf1.format(-nd.need)}</b> pontos e ainda ganha` : `O R precisa de ganhar o que falta por <b class="num">${nf1.format(nd.need)}</b> pontos`}</span>` : ''}
      ${pills ? `<span class="wpills" aria-hidden="true">${pills}</span>` : ''}
    </a>`;
  }
  function sortedRaces() {
    const rs = S.data.races.slice();
    const cl = (r) => Date.parse(S.data.closings[r.st] || '2026-11-04T06:00:00Z');
    const tight = (r) => (r.call ? 1e3 : 0) + Math.abs(r.radar.proj);
    if (S.sort === 'tight') rs.sort((a, b) => tight(a) - tight(b));
    else if (S.sort === 'office') rs.sort((a, b) => (isSen(a) ? 0 : 1) - (isSen(b) ? 0 : 1) || tight(a) - tight(b));
    else rs.sort((a, b) => cl(a) - cl(b) || tight(a) - tight(b));
    return rs;
  }
  const detailEl = document.createElement('section');
  detailEl.className = 'detail';
  detailEl.id = 'detail';
  detailEl.setAttribute('aria-label', 'Detalhe da corrida');
  function renderGrid() {
    // com a contagem a decorrer, as mais renhidas vêm primeiro (a não ser que se tenha escolhido outra ordem)
    if (!S.sortUser && S.data.races.some((r) => r.total > 0) && S.sort !== 'tight') { S.sort = 'tight'; syncSort(); }
    const grid = $('#grid');
    const focusId = document.activeElement && document.activeElement.closest && document.activeElement.closest('.rc') ? document.activeElement.closest('.rc').dataset.id : null;
    if (detailEl.parentNode) detailEl.remove(); // preserva o mapa ao redesenhar a grelha
    grid.innerHTML = sortedRaces().map(raceCard).join('');
    placeDetail();
    if (focusId) { const f = grid.querySelector(`[data-id="${focusId}"]`); if (f) f.focus({ preventScroll: true }); }
  }
  // o detalhe abre logo a seguir à linha do cartão escolhido
  function placeDetail() {
    const grid = $('#grid');
    const card = S.sel && grid.querySelector(`.rc[data-id="${S.sel}"]`);
    if (!card) { if (detailEl.parentNode) detailEl.remove(); return; }
    const cards = [...grid.querySelectorAll('.rc')];
    const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
    const i = cards.indexOf(card);
    const after = cards[Math.min(cards.length - 1, Math.floor(i / cols) * cols + cols - 1)];
    after.after(detailEl);
  }
  function syncSort() { document.querySelectorAll('#sortSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === S.sort))); }

  // ---------------------------------------------------------------- detalhe de uma corrida
  function getTopo() {
    if (!S.topo) {
      S.topo = fetch(TOPO_URL).then((r) => { if (!r.ok) throw new Error('mapa ' + r.status); return r.json(); })
        .catch((e) => { S.topo = null; throw e; });
    }
    return S.topo;
  }
  function diverging(lim, colors) {
    return d3.scaleLinear().domain([-lim, -lim / 2, -lim / 8, 0, lim / 8, lim / 2, lim]).range(colors).clamp(true);
  }
  const PARTY = ['#1e3a8a', '#2563eb', '#93c5fd', '#e5e7eb', '#fca5a5', '#dc2626', '#7f1d1d'];
  const GOODBAD = ['#9a3412', '#ea580c', '#fdba74', '#e5e7eb', '#86efac', '#16a34a', '#14532d'];
  const MAPMODES = {
    target: { label: 'Vs alvo', lim: 15, colors: GOODBAD, val: (c) => (c.T > 0 && c.tgt != null && !c.flag ? c.m - c.tgt : null), legend: ['Abaixo do alvo (mau para o R)', 'Acima do alvo (bom para o R)'],
      note: 'compara cada condado com a margem que teria se o estado ficasse empatado. Verde: o R está a fazer o que precisa; laranja: não está.' },
    swing: { label: 'Face a Trump 2024', lim: 15, colors: GOODBAD, val: (c) => (c.T > 0 && !c.flag ? c.m - c.m24 : null), legend: ['Pior do que Trump', 'Melhor do que Trump'],
      note: 'mostra quanto o R está melhor (verde) ou pior (laranja) do que Trump em 2024 em cada condado.' },
    margin: { label: 'Margem', lim: 40, colors: PARTY, val: (c) => (c.T > 0 ? c.m : null), legend: ['D/I à frente', 'R à frente'], note: 'mostra quem está à frente em cada condado, com o que já foi contado.' },
    prog: { label: '% contado', colors: null, val: (c) => c.f, legend: ['0%', '100%'], note: 'mostra a percentagem estimada dos votos já contados em cada condado.' },
    base: { label: 'Trump 2024', lim: 40, colors: PARTY, val: (c) => c.m24, legend: ['Harris', 'Trump'], note: 'mostra o resultado presidencial de 2024, para referência.' },
  };
  function countyObjs(r) {
    return r.counties.map(([k, f, R, O, T, E, m24, tgt, n, flag]) => ({ k, f, R, O, T, E, m24, tgt, n, flag, m: T > 0 ? ((R - O) / T) * 100 : null }));
  }

  let detailSig = '';
  function renderDetail(force) {
    const r = S.data && S.data.races.find((x) => x.id === S.sel);
    if (!r) { detailEl.innerHTML = ''; detailSig = ''; if (detailEl.parentNode) detailEl.remove(); return; }
    // não redesenha (nem faz piscar o mapa) se nada mudou nesta corrida
    const sig = [r.id, r.updated, r.total, r.eevp, r.call && r.call.who, r.radar.proj, r.nyt && r.nyt.pR, S.mapMode, window.innerWidth < 600].join('|');
    if (!force && sig === detailSig && detailEl.firstChild) { placeDetail(); return; }
    detailSig = sig;
    const cs = countyObjs(r);
    const byK = Object.fromEntries(cs.map((c) => [c.k, c]));
    const names = {};
    if (r.watch) for (const w of r.watch.rows) names[w.k] = w.n;
    const op = r.O.party;
    const nd = r.call ? null : needed(r);
    const order = sortedRaces();
    const idx = order.findIndex((x) => x.id === r.id);
    const prevR = order[(idx - 1 + order.length) % order.length], nextR = order[(idx + 1) % order.length];

    // condados-chave da lista: a coluna que importa ("R vs alvo") vem logo a seguir ao nome
    const wt = r.watch ? `<div class="box"><div class="box-h"><h3>Condados-chave de @earlyvotedata</h3><span class="muted small">alvo = margem com o estado empatado</span></div>
      <div class="tscroll"><table class="watch"><thead><tr><th>Condado</th><th title="Margem atual menos o alvo da lista: positivo é bom para o R">R vs alvo</th><th>Agora</th><th>Contado</th><th title="Alvo da lista de @earlyvotedata">Alvo</th><th title="O mesmo alvo, calculado pelo NYT para 2026">Alvo NYT</th>${r.watch.cols.map((c) => `<th title="${esc(c.label)}">${esc(c.label.split(' · ')[0])}</th>`).join('')}</tr></thead><tbody>
      ${r.watch.rows.map((w) => {
        const vs = w.m != null && !w.flag ? w.m - w.target : null;
        const bar = vs == null ? '' : `<i class="vbar ${vs >= 0 ? 'good' : 'bad'}" style="width:${Math.min(40, Math.abs(vs) * 2)}px"></i>`;
        return `<tr class="${w.m != null && w.f >= 10 ? 'hl' : ''}"><th scope="row">${esc(w.n)}</th>
          <td class="${vs == null ? '' : vs >= 0 ? 'good' : 'bad'}">${w.flag ? `<span class="muted small">só ${w.flag > 0 ? 'antecipado' : 'do dia'}</span>` : vs == null ? '—' : (vs >= 0 ? '▲ ' : '▼ ') + signed(vs)}${bar}</td>
          <td class="${cls(w.m, op)}">${w.T ? fm(w.m, op) : '—'}</td><td>${w.T ? pct(w.f) : '—'}</td>
          <td class="${cls(w.target)}">${fm(w.target)}</td><td class="${cls(w.nyt)}">${fm(w.nyt)}</td>
          ${w.v.map(([R, D]) => `<td class="hist"><span class="r">${nf1.format(R)}</span>–<span class="d">${nf1.format(D)}</span></td>`).join('')}</tr>`;
      }).join('')}</tbody></table></div>
      <p class="note">As três últimas colunas são os resultados R–D da lista original. "só antecipado": ainda só entrou esse tipo de voto, por isso a margem ainda não se compara com o alvo.</p></div>` : '';

    // miragem
    const T = r.types || {};
    const tl = { advance: ['Antecipado e correio', '#06b6d4'], election_day_in_person: ['No próprio dia', '#e0b341'], provisional: ['Provisório', '#64748b'] };
    const keys = Object.keys(T);
    let mirage = '<p class="note">O NYT não publica a divisão por tipo de voto neste estado.</p>';
    if (keys.length) {
      const expT = keys.reduce((a, k) => a + T[k].exp, 0);
      const cnt = keys.map((k) => T[k].exp * (T[k].pct / 100));
      const cntT = cnt.reduce((a, b) => a + b, 0);
      const seg = (vals, tot) => vals.map((v, i) => { const w = tot ? (v / tot) * 100 : 0; return w > 0.5 ? `<span style="width:${w}%;background:${tl[keys[i]][1]}" title="${tl[keys[i]][0]}">${w > 12 ? Math.round(w) + '%' : ''}</span>` : ''; }).join('');
      let chip = '';
      if (cntT > 0 && r.skew > 12) chip = '<span class="warn-chip">⚠ Até agora entrou sobretudo voto antecipado ou por correio, que costuma favorecer os democratas. O R tende a subir quando chegar o voto do dia.</span>';
      else if (cntT > 0 && r.skew < -12) chip = '<span class="warn-chip">⚠ Até agora entrou sobretudo voto do próprio dia, que costuma favorecer os republicanos. O R pode descer quando chegar o voto antecipado.</span>';
      mirage = `<div class="mir"><span class="muted">Já contado</span><div class="stack">${cntT ? seg(cnt, cntT) : '<span style="width:100%;color:#8593a5">ainda nada</span>'}</div>
        <span class="muted">Esperado no total</span><div class="stack">${seg(keys.map((k) => T[k].exp), expT)}</div></div>
        <div class="legend">${keys.map((k) => `<span class="lg"><i style="background:${tl[k][1]}"></i>${tl[k][0]}</span>`).join('')}</div>
        ${keys.some((k) => T[k].m != null) ? `<table class="types"><thead><tr><th>Tipo de voto</th><th>Contado</th><th>Margem</th></tr></thead><tbody>${keys.filter((k) => T[k].exp > 0 && (k !== 'provisional' || T[k].m != null)).map((k) => `<tr><th scope="row">${tl[k][0]}</th><td>${pct(T[k].pct)}</td><td class="${cls(T[k].m, op)}">${T[k].m != null ? fm(T[k].m, op) : '—'}</td></tr>`).join('')}</tbody></table>` : ''}
        ${chip ? `<p class="note">${chip}</p>` : ''}`;
    }

    // votos por contar
    const nameOf = (c) => names[c.k] || c.n || countyNames[c.k] || c.k;
    const left = cs.map((c) => ({ ...c, left: Math.max(0, c.E * (1 - c.f / 100)) })).sort((a, b) => b.left - a.left);
    const LR = r.radar.leftR, LO = r.radar.leftO, LT = LR + LO || 1;
    const remaining = `<div class="stack tall"><span style="width:${(LR / LT) * 100}%;background:var(--rep)">${LR / LT > 0.15 ? compact(LR) : ''}</span><span style="width:${(LO / LT) * 100}%;background:var(--dem)">${LO / LT > 0.15 ? compact(LO) : ''}</span></div>
      <p class="note">Faltam cerca de <b>${compact(LR)}</b> votos em condados que Trump ganhou em 2024 e <b>${compact(LO)}</b> em condados que Harris ganhou.</p>
      <table><thead><tr><th>Mais votos por contar</th><th>Por contar</th><th>Trump 2024</th><th>Agora</th></tr></thead><tbody>
      ${left.slice(0, 6).map((c) => `<tr><th scope="row">${esc(nameOf(c))}</th><td>${compact(c.left)}</td><td class="${cls(c.m24)}">${fm(c.m24)}</td><td class="${cls(c.m, op)}">${c.T ? fm(c.m, op) : '—'}</td></tr>`).join('')}</tbody></table>`;

    detailEl.innerHTML = `<div class="dt">
      <div class="dt-nav">
        <a class="btn" href="#${prevR.id}" aria-label="Corrida anterior: ${esc(STNAME[prevR.st])} ${esc(prevR.office)}">← ${esc(prevR.st)} ${isSen(prevR) ? 'Sen.' : 'Gov.'}</a>
        <a class="btn" href="#${nextR.id}" aria-label="Corrida seguinte: ${esc(STNAME[nextR.st])} ${esc(nextR.office)}">${esc(nextR.st)} ${isSen(nextR) ? 'Sen.' : 'Gov.'} →</a>
        <button class="btn" id="shareBtn" type="button">🔗 Copiar ligação</button>
        <button class="btn" id="closeDetail" type="button">Fechar ✕</button>
      </div>
      <div class="dt-head">
        <h2 class="dt-title">${esc(STNAME[r.st] || r.stName)} · ${esc(r.office)}<small><span class="r">${esc(r.R.name)} (R)</span> contra <span class="${cls(-1, op)}">${esc(r.O.name)} (${op})</span>${r.rating ? ' · classificação do NYT: ' + esc(RATING[r.rating] || r.rating) : ''}</small></h2>
        <div class="dt-stats">
          <div><div class="k">Contado</div><div class="v num">${pct(r.eevp)}</div></div>
          <div><div class="k">Margem agora</div><div class="v ${cls(r.m, op)} num">${r.total ? fm(r.m, op) : '—'}</div></div>
          <div><div class="k">Final estimado</div><div class="v ${cls(r.radar.proj, op)} num">${fm(r.radar.proj, op)}</div></div>
          <div><div class="k">Hipótese R (${srcTxt(r)})</div><div class="v ${pcls(r.radar.pR)} num">${r.call ? (r.call.who === 'R' ? 'Ganhou' : 'Perdeu') : pp(r.radar.pR)}</div></div>
          ${nd ? `<div><div class="k">${nd.need > 0 ? 'R precisa no que falta' : 'Folga do R no que falta'}</div><div class="v ${nd.need > 0 ? 'bad' : 'good'} num">${nd.need > 0 ? 'R+' : ''}${nf1.format(Math.abs(nd.need))}</div></div>` : ''}
          <div><div class="k">Trump 2024</div><div class="v ${cls(r.m24)} num">${fm(r.m24)}</div></div>
        </div>
      </div>
      ${notes(r)}
      ${modelBox(r)}
      <div class="dt-grid">
        <div>
          <div class="box map"><div class="box-h"><h3>Mapa por condado</h3><div class="seg" id="mapSeg" role="group" aria-label="O que mostrar no mapa">${Object.entries(MAPMODES).map(([k, m]) => `<button data-mode="${k}" aria-pressed="${S.mapMode === k}">${m.label}</button>`).join('')}</div></div>
            <div id="mapSvg" class="mapsvg"></div><div class="legend" id="mapLegend"></div>
            <p class="note">Contorno dourado: condados-chave. "${MAPMODES[S.mapMode].label}" ${MAPMODES[S.mapMode].note}${S.mapMode === 'target' ? (r.tgtSrc === 'trump24' ? ' (Aqui o alvo é calculado a partir de Trump 2024.)' : r.tgtSrc === 'nyt-senado' ? ' (Alvo do NYT para a corrida ao Senado no mesmo estado.)' : ' (Alvo do NYT.)') : ''} Toca num condado para ver os números.</p></div>
          <div class="box spark"><div class="box-h"><h3>Evolução da margem ao longo da contagem</h3></div><div id="spark"></div></div>
        </div>
        <div>
          ${wt}
          <div class="box"><div class="box-h"><h3>Que votos já entraram (miragem)</h3></div>${mirage}</div>
          <div class="box"><div class="box-h"><h3>Onde estão os votos que faltam</h3></div>${remaining}</div>
        </div>
      </div>
    </div>`;
    $('#closeDetail', detailEl).onclick = () => select(null);
    $('#shareBtn', detailEl).onclick = async (e) => {
      const url = location.origin + '/#' + r.id;
      try {
        if (navigator.share && window.innerWidth < 800) await navigator.share({ title: 'Radar R · ' + (STNAME[r.st] || r.stName) + ' ' + r.office, url });
        else { await navigator.clipboard.writeText(url); e.target.textContent = '✓ Copiada'; }
      } catch (err) { /* cancelado */ }
    };
    $('#mapSeg', detailEl).onclick = (e) => { const b = e.target.closest('button'); if (b) { S.mapMode = b.dataset.mode; renderDetail(); } };
    placeDetail();
    drawMap(r, byK, names);
    drawSpark(r);
  }

  // avisos de regras especiais da corrida
  function notes(r) {
    const n = [];
    const ro = r.nyt && r.nyt.runoff != null ? ` O modelo do NYT dá ${pp(r.nyt.runoff)} de hipótese de isso acontecer.` : '';
    if (r.rcv || r.st === 'ME') n.push(`O Maine usa voto por ordem de preferência: se ninguém passar dos 50%, os votos dos últimos classificados são redistribuídos e a contagem dessa fase pode levar dias. A estimativa refere-se à 1.ª contagem.${ro}`);
    if (r.st === 'GA' || (r.threshold && r.threshold >= 50)) n.push(`Na Geórgia, quem não passar dos 50% vai a uma 2.ª volta, em dezembro. A hipótese do radar refere-se a ficar à frente.${ro}`);
    if (r.call) n.push(`Projeção da ${esc((r.call.by && r.call.by[0] || 'AP').toUpperCase())}${r.call.at ? ' às ' + tLis.format(new Date(r.call.at)) : ''}: ${esc(r.call.name)} (${r.call.who}).`);
    return n.length ? `<div class="notes">${n.map((x) => `<p>${x}</p>`).join('')}</div>` : '';
  }
  // as duas estimativas lado a lado, no mesmo eixo
  function modelBox(r) {
    const W = window.innerWidth < 600 ? 340 : 600, lim = 25, X = (m) => 44 + ((Math.max(-lim, Math.min(lim, m)) + lim) / (2 * lim)) * (W - 64);
    const p = r.own.proj, sd = r.own.sd;
    const row = (y, lo, mid, hi, color, label) => `<text x="0" y="${y + 4}" font-size="12" fill="#a7b3c2" font-family="Public Sans">${label}</text>
      <rect x="${X(lo)}" y="${y - 6}" width="${Math.max(2, X(hi) - X(lo))}" height="12" rx="3" fill="${color}" opacity=".35"/>
      <circle cx="${X(mid)}" cy="${y}" r="6" fill="${color}" stroke="#0b0f15" stroke-width="2"/>`;
    // segunda linha: o modelo do NYT ou, nos governadores, o do Senado mais o voto dividido
    const q = r.nyt && r.nyt.q ? r.nyt.q : r.radar.src === 'nyt-senado' ? [r.radar.proj - 2 * r.radar.sd, r.radar.proj - 0.67 * r.radar.sd, r.radar.proj, r.radar.proj + 0.67 * r.radar.sd, r.radar.proj + 2 * r.radar.sd] : null;
    const qName = r.nyt && r.nyt.q ? 'NYT' : 'NYT+div.';
    const ticks = (W < 600 ? [-20, 0, 20] : [-20, -10, 0, 10, 20]).map((t) => `<line x1="${X(t)}" x2="${X(t)}" y1="8" y2="${q ? 74 : 48}" stroke="${t ? '#233041' : '#a7b3c2'}" ${t ? 'stroke-dasharray="2 3"' : ''}/><text x="${X(t)}" y="${q ? 89 : 63}" font-size="11" text-anchor="middle" fill="#8593a5" font-family="IBM Plex Mono">${t ? (t > 0 ? 'R+' : r.O.party + '+') + Math.abs(t) : '0'}</text>`).join('');
    return `<div class="box model"><div class="box-h"><h3>Onde vai acabar: as duas estimativas</h3><span class="muted small">ponto = mais provável · barra = intervalo provável</span></div>
      <svg viewBox="0 0 ${W} ${q ? 93 : 67}" class="msvg" role="img" aria-label="Estimativa do radar ${fm(p, r.O.party)}${q ? ' e do NYT ' + fm(q[2], r.O.party) : ''}">${ticks}
        ${row(26, p - 1.28 * sd, p, p + 1.28 * sd, p >= 0 ? '#ef4444' : '#3b82f6', 'Radar')}
        ${q ? `<line x1="${X(q[0])}" x2="${X(q[4])}" y1="56" y2="56" stroke="#a7b3c2" stroke-width="1.5"/>${row(56, q[1], q[2], q[3], q[2] >= 0 ? '#ef4444' : '#3b82f6', qName)}` : ''}
      </svg>
      <p class="note">Radar (condado a condado, face a Trump 2024): <b class="${cls(p, r.O.party)}">${fm(p, r.O.party)}</b>, o R ganha em ${pp(r.own.pR)} dos cenários.${r.nyt && r.nyt.q ? ` Modelo do NYT, que é a estimativa principal porque conta com o que falta por tipo de voto: <b class="${cls(q[2], r.O.party)}">${fm(q[2], r.O.party)}</b>, o R ganha em ${pp(r.nyt.pR)}${r.nyt.status === 'inactive' ? ' (ainda à espera de resultados)' : ''}.` : r.radar.src === 'nyt-senado' ? ` O NYT não tem modelo para esta corrida; a estimativa principal parte do modelo dele para o Senado no mesmo estado e soma a diferença entre as duas corridas nos condados contados: <b class="${cls(q[2], r.O.party)}">${fm(q[2], r.O.party)}</b>, o R ganha em ${pp(r.radar.pR)}.` : ' O NYT não publica modelo ao vivo para esta corrida.'}</p></div>`;
  }

  let countyNames = {};
  const tip = $('#tip');
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#mapSvg')) tip.hidden = true; });

  async function drawMap(r, byK, names) {
    const holder = $('#mapSvg', detailEl);
    if (!holder) return;
    let topo;
    try { topo = await getTopo(); } catch (e) { holder.innerHTML = '<p class="note">Não foi possível carregar o mapa. Volta a abrir a corrida para tentar de novo.</p>'; return; }
    if (!detailEl.contains(holder)) return;
    const all = topojson.feature(topo, topo.objects.counties).features;
    if (!Object.keys(countyNames).length) for (const f of all) countyNames[f.id] = f.properties.name;
    const feats = all.filter((f) => String(f.id).startsWith(r.fipsState));
    const path = d3.geoPath();
    const [[x0, y0], [x1, y1]] = path.bounds({ type: 'FeatureCollection', features: feats });
    const mode = MAPMODES[S.mapMode];
    const color = mode.colors ? diverging(mode.lim, mode.colors) : d3.scaleSequential([0, 100], d3.interpolateRgb('#1d2633', '#e0b341'));
    const pad = 4;
    holder.innerHTML = `<svg viewBox="${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}" role="img" aria-label="Mapa dos condados de ${esc(r.stName)}: ${esc(mode.label)}">${feats.map((f) => {
      const c = byK[f.id];
      const v = c ? mode.val(c) : null;
      return `<path d="${path(f)}" data-k="${f.id}" fill="${v == null ? (c && c.flag && c.T > 0 ? '#46536a' : '#222c39') : color(v)}"/>`;
    }).join('')}${feats.filter((f) => names[f.id]).map((f) => `<path d="${path(f)}" fill="none" class="watch"/>`).join('')}</svg>`;
    const ramp = mode.colors ? mode.colors.join(', ') : '#1d2633, #e0b341';
    const ticks = mode.colors ? `<span class="ticks num"><span>−${mode.lim}</span><span>0</span><span>+${mode.lim}</span></span>` : '';
    $('#mapLegend', detailEl).innerHTML = `<span>${mode.legend[0]}</span><span class="rampw"><span class="ramp" style="background:linear-gradient(90deg, ${ramp})"></span>${ticks}</span><span>${mode.legend[1]}</span><span class="lg"><i style="background:#222c39"></i>sem votos</span>${S.mapMode === 'target' || S.mapMode === 'swing' ? '<span class="lg"><i style="background:#46536a"></i>só um tipo de voto</span>' : ''}`;
    const svg = holder.querySelector('svg');
    const show = (e) => {
      const p = e.target.closest('path[data-k]');
      if (!p) { tip.hidden = true; return; }
      const c = byK[p.dataset.k];
      const n = names[p.dataset.k] || (c && c.n) || countyNames[p.dataset.k] || p.dataset.k;
      const v = c ? mode.val(c) : null;
      const head = v == null || S.mapMode === 'prog' || S.mapMode === 'base' || S.mapMode === 'margin' ? ''
        : `<b class="${v >= 0 ? 'good' : 'bad'}">${S.mapMode === 'target' ? (v >= 0 ? 'Acima do alvo: ' : 'Abaixo do alvo: ') : (v >= 0 ? 'Melhor do que Trump: ' : 'Pior do que Trump: ')}${signed(v)} ${v >= 0 ? '✔' : '✖'}</b><br>`;
      tip.innerHTML = `<b>${esc(n)}</b>${names[p.dataset.k] ? ' <span style="color:#e0b341">★ condado-chave</span>' : ''}<br>${c && c.flag && c.T > 0 ? `<span class="muted">Só entrou voto ${c.flag > 0 ? 'antecipado' : 'do próprio dia'}: ainda não compara</span><br>` : ''}${head}` + (c
        ? `Contado: ${pct(c.f)}${c.T ? ` · ${compact(c.T)} votos` : ''}<br>Agora: <span class="${cls(c.m, r.O.party)}">${c.T ? fm(c.m, r.O.party) : '—'}</span>${c.tgt != null ? ` · alvo <span class="${cls(c.tgt)}">${fm(c.tgt)}</span>` : ''}<br>Trump 2024: <span class="${cls(c.m24)}">${fm(c.m24)}</span>`
        : 'Sem dados');
      tip.hidden = false;
      const x = Math.min(window.innerWidth - 270, e.clientX + 14);
      tip.style.left = Math.max(8, x) + 'px'; tip.style.top = (e.clientY + 14) + 'px';
    };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') tip.hidden = true; });
  }

  function drawSpark(r) {
    const el = $('#spark', detailEl);
    const pts = (r.ts || []).map(([t, T, R, O]) => ({ t: Date.parse(t), m: T ? ((R - O) / T) * 100 : 0, T }));
    if (pts.length < 2) { el.innerHTML = '<p class="note">A evolução aparece quando houver várias atualizações da contagem.</p>'; return; }
    const W = 560, H = 120, P = 30;
    const x = d3.scaleTime().domain(d3.extent(pts, (p) => p.t)).range([P, W - 8]);
    const lim = Math.max(5, d3.max(pts, (p) => Math.abs(p.m)) * 1.1);
    const y = d3.scaleLinear().domain([-lim, lim]).range([H - 16, 6]);
    const line = d3.line().x((p) => x(p.t)).y((p) => y(p.m)).curve(d3.curveStepAfter);
    const last = pts[pts.length - 1];
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolução da margem: agora ${fm(last.m, r.O.party)}">
      <rect x="${P}" y="6" width="${W - P - 8}" height="${y(0) - 6}" fill="rgba(239,68,68,.06)"/><rect x="${P}" y="${y(0)}" width="${W - P - 8}" height="${H - 16 - y(0)}" fill="rgba(59,130,246,.06)"/>
      <line x1="${P}" x2="${W - 8}" y1="${y(0)}" y2="${y(0)}" stroke="#8593a5" stroke-dasharray="3 3"/>
      <path d="${line(pts)}" fill="none" stroke="#e0b341" stroke-width="2"/>
      <circle cx="${x(last.t)}" cy="${y(last.m)}" r="4" fill="${last.m >= 0 ? '#ef4444' : '#3b82f6'}"/>
      <text x="2" y="14" font-size="11" fill="#8593a5" font-family="IBM Plex Mono">R+${Math.round(lim)}</text>
      <text x="2" y="${H - 18}" font-size="11" fill="#8593a5" font-family="IBM Plex Mono">${r.O.party}+${Math.round(lim)}</text>
      <text x="${P}" y="${H - 2}" font-size="11" fill="#8593a5" font-family="IBM Plex Mono">${tLis.format(new Date(pts[0].t))}</text>
      <text x="${W - 8}" y="${H - 2}" font-size="11" fill="#8593a5" text-anchor="end" font-family="IBM Plex Mono">${tLis.format(new Date(last.t))}</text>
    </svg>`;
  }

  // ---------------------------------------------------------------- Câmara: distritos a seguir
  function houseStats() {
    const w = (S.data.house && S.data.house.watch) || [];
    const fav = w.filter((x) => x.pR != null && x.pR >= 0.5).length;
    const callR = w.filter((x) => x.call === 'R').length, callD = w.filter((x) => x.call === 'D').length;
    const gainR = w.filter((x) => x.call === 'R' && x.gained).length, gainD = w.filter((x) => x.call && x.call !== 'R' && x.gained).length;
    const counted = w.filter((x) => x.eevp >= 10 && !x.call);
    const ahead = counted.filter((x) => x.m > 0).length;
    return { w, fav, callR, callD, gainR, gainD, counted: counted.length, ahead };
  }
  function renderHouse() {
    if (!$('#house')) return; // página antiga em cache, sem esta secção
    const h = houseStats();
    if (!h.w.length) { $('#house').innerHTML = '<p class="muted">Sem dados da Câmara.</p>'; return; }
    const score = (x) => (x.call ? 2 : 0) + (x.pR != null ? Math.abs(x.pR - 0.5) : 0.5);
    const rows = h.w.slice().sort((a, b) => score(a) - score(b) || (a.id > b.id ? 1 : -1));
    const incTxt = (x) => (x.inc === 'R' ? '<span class="r">R</span>' : x.inc ? `<span class="d">${x.inc}</span>` : '<span class="muted">aberto</span>');
    $('#house').innerHTML = `
      <div class="hs">
        <div class="kpi"><div class="k">R favorito (NYT)</div><div class="v num ${h.fav >= h.w.length / 2 ? 'good' : 'bad'}">${h.fav}<span class="of">/${h.w.length}</span></div><div class="s">distritos com hipótese R de pelo menos 50%</div></div>
        <div class="kpi"><div class="k">R à frente agora</div><div class="v num">${h.counted ? `${h.ahead}<span class="of">/${h.counted}</span>` : '—'}</div><div class="s">${h.counted ? 'por decidir, com pelo menos 10% contado. Cuidado com a miragem.' : 'Ainda sem votos nestes distritos'}</div></div>
        <div class="kpi"><div class="k">Projeções da AP</div><div class="v num">${h.callR + h.callD ? `<span class="r">${h.callR}</span><span class="of"> R · </span><span class="d">${h.callD}</span><span class="of"> D</span>` : '—'}</div><div class="s">${h.gainR + h.gainD ? `Mudam de partido: <b class="r">R +${h.gainR}</b> · <b class="d">D +${h.gainD}</b>` : 'nestes 39 distritos'}</div></div>
      </div>
      <div class="tbl-wrap"><table class="ov house"><thead><tr><th>Distrito</th><th class="hide-sm">Zona</th><th class="sans">Republicano</th><th class="hide-sm">Democrata</th><th class="hide-sm" title="Partido de quem tem o lugar agora">Titular</th><th class="hide-sm">Classificação</th><th title="Hipótese de vitória do R no modelo ao vivo do NYT">NYT R</th><th>Contado</th><th>Margem</th><th>AP</th></tr></thead><tbody>
      ${rows.map((x) => `<tr><th scope="row">${esc(x.id)}${x.rcv ? ' <span class="muted" title="Voto por ordem de preferência">(VP)</span>' : ''}</th>
        <td class="sans small muted hide-sm">${esc(x.zone)}</td>
        <td class="r sans">${esc(x.R || '—')}${x.inc === 'R' ? '*' : ''}</td><td class="${x.Op === 'I' ? 'i' : 'd'} sans hide-sm">${esc(x.O || '—')}${x.inc && x.inc !== 'R' ? '*' : ''}</td>
        <td class="hide-sm">${incTxt(x)}</td><td class="sans small muted hide-sm">${esc(RATING[x.rating] || '—')}</td>
        <td class="${pcls(x.pR)}">${x.call ? '' : pp(x.pR)}</td>
        <td>${x.eevp ? pct(x.eevp) : '—'}</td><td class="${cls(x.m, x.Op)}">${x.eevp ? fm(x.m, x.Op) : '—'}</td>
        <td>${x.call ? `<span class="badge call${x.call}">${x.call}${x.gained ? ' ganha' : ''}</span>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="note">* titular. "Aberto": lugar sem titular a concorrer. O CO-03 substitui o MT-01, como o autor da lista corrigiu. No Alasca o voto é por ordem de preferência (VP).</p>`;
  }

  // ---------------------------------------------------------------- lugares projetados (placar)
  const BEFORE = { S: 'R 53 · D 45 · I 2', H: null };
  function chamberCard(title, c, needR, needText, total, before, extra) {
    if (!c) return `<div class="card"><div class="sc-title">${title}</div><p class="muted">Sem dados</p></div>`;
    const und = Math.max(0, total - c.R - c.D - c.I);
    const w = (x) => (x / total) * 100 + '%';
    const won = c.winner === 'GOP' ? '<span class="badge callR">R controla</span>' : c.winner === 'DEM' ? '<span class="badge callD">D controla</span>' : '';
    const none = c.R + c.D + c.I === 0;
    return `<div class="card">
      <div class="sc-head"><h3 class="sc-title">${title}</h3>${won || `<span class="sc-need">R precisa de ${needR} ${needText}</span>`}</div>
      ${none ? '<p class="sc-empty">Ainda nenhuma projeção da AP.</p>' : `<div class="sc-big"><span class="n r num">${c.R}<small>R</small></span><span class="n d num">${c.D}<small>D</small></span>${c.I ? `<span class="n i num">${c.I}<small>I</small></span>` : ''}<span class="vs">${und} por decidir</span></div>`}
      <div class="bar" aria-hidden="true"><span class="bR" style="width:${w(c.R)}"></span><span style="width:${w(und)}"></span><span class="bI" style="width:${w(c.I)}"></span><span class="bD" style="width:${w(c.D)}"></span><i class="mid" style="left:${(needR / total) * 100}%"></i></div>
      <div class="sc-foot"><span>Antes da noite: ${before || (c.current ? `R ${c.current.GOP} · D ${c.current.DEM}${c.current.OTH ? ' · I ' + c.current.OTH : ''}` : '—')}</span><span>Lugares que mudam de partido: <b class="r">R +${c.flipsR || 0}</b> · <b class="d">D +${c.flipsD || 0}</b></span></div>
      ${extra || ''}
    </div>`;
  }
  function houseExtra() {
    const h = S.data.house;
    if (!h) return '';
    const v = h.vote;
    const two = v && v.R + v.D > 0 ? ((v.R - v.D) / (v.R + v.D)) * 100 : null;
    const flips = h.flips.slice(0, 30).map((f) => `<span class="mini ${f.who === 'R' ? 'r' : 'd'}" title="${esc(f.name)}">${esc(f.st)}-${esc(f.seat)}</span>`).join('');
    return `<div class="sc-extra">${two != null ? `<span>Voto nacional já contado: <b class="${cls(two)} num">${fm(two)}</b> <span class="muted">(2024: cerca de R+3)</span></span>` : ''}${flips ? `<div class="minis" aria-label="Distritos que mudaram de partido">${flips}</div>` : ''}</div>`;
  }
  function govCard(list) {
    const R = list.filter((r) => r.call === 'R').length, D = list.filter((r) => r.call === 'D').length, I = list.filter((r) => r.call === 'I').length;
    const und = list.length - R - D - I;
    const flipsR = list.filter((r) => r.call === 'R' && r.gained).length, flipsD = list.filter((r) => r.call === 'D' && r.gained).length;
    const w = (x) => (x / Math.max(1, list.length)) * 100 + '%';
    return `<div class="card">
      <div class="sc-head"><h3 class="sc-title">Governadores</h3><span class="sc-need">${list.length} corridas</span></div>
      ${R + D + I === 0 ? '<p class="sc-empty">Ainda nenhuma projeção da AP.</p>' : `<div class="sc-big"><span class="n r num">${R}<small>R</small></span><span class="n d num">${D}<small>D</small></span><span class="vs">${und} por decidir</span></div>`}
      <div class="bar" aria-hidden="true"><span class="bR" style="width:${w(R)}"></span><span style="width:${w(und)}"></span><span class="bI" style="width:${w(I)}"></span><span class="bD" style="width:${w(D)}"></span></div>
      <div class="sc-foot"><span>Projeções da AP</span><span>Mudam de partido: <b class="r">R +${flipsR}</b> · <b class="d">D +${flipsD}</b></span></div>
    </div>`;
  }
  function renderScore() {
    const c = S.data.control;
    $('#score').innerHTML = `<h2 class="score-h">Lugares projetados pela AP</h2><div class="score-grid">` +
      chamberCard('Senado', c.S, 50, '(Vance desempata)', 100, BEFORE.S) +
      chamberCard('Câmara dos Representantes', c.H, 218, 'para a maioria', 435, null, houseExtra()) +
      govCard(S.data.governors) + '</div>';
  }

  // ---------------------------------------------------------------- tabelas do Senado e dos governadores
  const showSafe = { S: false, G: false };
  function overviewTable(list, tracked, key) {
    const hasNyt = list.some((x) => x.pR != null);
    const safe = (x) => !x.call && /solid/.test(x.rating || '') && !tracked[x.st] && (x.pR == null || x.pR > 0.95 || x.pR < 0.05);
    const score = (x) => (x.call ? 2 : 0) + (x.pR != null ? Math.abs(x.pR - 0.5) : 0.5);
    const rows = list.slice().sort((a, b) => score(a) - score(b) || (a.st > b.st ? 1 : -1));
    const nSafe = rows.filter(safe).length;
    const shown = showSafe[key] ? rows : rows.filter((x) => !safe(x));
    return `<table class="ov"><thead><tr><th>Estado</th><th class="hide-sm">Republicano</th><th class="hide-sm">Adversário</th><th>Contado</th><th>Margem</th><th class="hide-sm">Classificação</th>${hasNyt ? '<th title="Hipótese de vitória do R no modelo ao vivo do NYT">NYT R</th>' : ''}<th>AP</th></tr></thead><tbody>
      ${shown.map((x) => {
        const t = tracked[x.st];
        return `<tr class="${t ? 'hl' : ''}"><th scope="row">${t ? `<a href="#${t}">${esc(x.st)} ★</a>` : esc(x.st)}${x.special ? ' <span class="muted">(esp.)</span>' : ''}</th>
          <td class="r sans hide-sm">${esc(x.R || '—')}</td><td class="${x.Op === 'I' ? 'i' : 'd'} sans hide-sm">${esc(x.O || '—')}${x.Op === 'I' ? ' (I)' : ''}</td>
          <td>${x.eevp ? pct(x.eevp) : '—'}</td><td class="${cls(x.m, x.Op)}">${x.eevp ? fm(x.m, x.Op) : '—'}</td>
          <td class="sans small muted hide-sm">${esc(RATING[x.rating] || '—')}</td>
          ${hasNyt ? `<td class="${pcls(x.pR)}">${x.call ? '' : pp(x.pR)}</td>` : ''}
          <td>${x.call ? `<span class="badge call${x.call}">${x.call}${x.gained ? ' ganha' : ''}</span>` : x.runoff ? '<span class="badge counting">2.ª volta</span>' : ''}</td></tr>`;
      }).join('')}</tbody></table>
      ${nSafe ? `<button class="btn more" type="button" data-safe="${key}">${showSafe[key] ? 'Esconder' : 'Mostrar'} as ${nSafe} corridas seguras</button>` : ''}`;
  }
  function renderTables() {
    const trS = {}, trG = {};
    for (const r of S.data.races) (isSen(r) ? trS : trG)[r.st] = r.id;
    $('#senate').innerHTML = overviewTable(S.data.senate, trS, 'S');
    $('#governors').innerHTML = overviewTable(S.data.governors, trG, 'G');
  }

  // ---------------------------------------------------------------- acontecimentos (feed, avisos, notificações)
  function addEvent(id, text, kind, party, important, t) {
    if (S.seen.has(id)) return;
    S.seen.add(id);
    const ev = { id, t: t || Date.now(), text, kind, party };
    S.feed.push(ev);
    S.feed.sort((a, b) => b.t - a.t);
    S.feed = S.feed.slice(0, 200);
    if (important) toast(ev);
  }
  function detect(prev, cur) {
    const first = !prev;
    const label = (r) => `${STNAME[r.st] || r.stName} (${r.office})`;
    for (const r of cur.races) {
      const p = prev && prev.races.find((x) => x.id === r.id);
      const off = isSen(r) ? 'S' : 'G';
      if (r.call) addEvent('srv:call-' + off + ':' + r.st, `<b>${esc((r.call.by && r.call.by[0] || 'AP').toUpperCase())} projeta:</b> ${esc(r.call.name)} (${r.call.who}) vence em ${esc(label(r))}.`, 'call', r.call.who, !first, r.call.at ? Date.parse(r.call.at) : null);
      if (p && p.total === 0 && r.total > 0) addEvent('start:' + r.id, `Primeiros votos em ${esc(label(r))}: ${fm(r.m, r.O.party)}.`, 'info', null, false);
      // viragem da estimativa, com folga (como no servidor): só quando a hipótese passa 65% ou desce de 35%
      if (p && !r.call && r.radar.F >= 25 && r.radar.pR != null && p.radar.pR != null) {
        const was = p.radar.pR >= 0.5 ? 'R' : r.O.party, now = r.radar.pR >= 0.65 ? 'R' : r.radar.pR <= 0.35 ? r.O.party : null;
        if (now && now !== was) addEvent('srv:lead-' + r.id + '-' + now + ':' + Math.floor(Date.now() / 6e5), `A estimativa em ${esc(label(r))} passa para <b>${now}</b> (${fm(r.radar.proj, r.O.party)}, ${pct(r.radar.F)} contado).`, 'flip', now === 'R' ? 'R' : 'D', true);
      }
      if (p && r.watch && p.watch && isSen(r)) {
        for (const w of r.watch.rows) {
          const pw = p.watch.rows.find((x) => x.k === w.k);
          if (!pw || w.m == null || pw.m == null || w.f < 25) continue;
          // folga de 1 ponto para não avisar a cada oscilação em cima do alvo
          const a = w.m >= w.target, b = pw.m >= pw.target;
          if (a !== b && Math.abs(w.m - w.target) >= 1) addEvent(`wt:${r.id}:${w.k}:${a}:${Math.floor(Date.now() / 6e5)}`, `<b>${esc(w.n)}</b> (${STNAME[r.st]}): o R passa para ${a ? 'cima' : 'baixo'} do alvo (${fm(w.m, r.O.party)} com ${pct(w.f)} contado; alvo ${fm(w.target)}).`, 'watch', a ? 'R' : 'D', false);
        }
      }
    }
    // restantes corridas (as do radar já foram tratadas acima)
    const others = cur.senate.map((x) => ['S', x]).concat(cur.governors.map((x) => ['G', x]));
    for (const [off, x] of others) {
      if (x.runoff) addEvent('srv:runoff-' + off + ':' + x.st, `<b>${esc(x.st)}:</b> vai haver 2.ª volta (${off === 'S' ? 'Senado' : 'governador'}).`, 'call', null, !first);
      if (!x.call || cur.races.some((r) => r.st === x.st && (isSen(r) ? 'S' : 'G') === off)) continue;
      addEvent('srv:call-' + off + ':' + x.st, `<b>AP projeta:</b> ${x.call === 'R' ? esc(x.R) : esc(x.O)} (${x.call}) vence ${off === 'S' ? 'o Senado' : 'o governo'} em ${esc(x.st)}.`, 'call', x.call, false);
    }
    for (const x of (cur.house && cur.house.watch) || []) {
      if (x.call) addEvent('srv:call-H:' + x.id, `<b>AP projeta:</b> ${x.call === 'R' ? esc(x.R) : esc(x.O)} (${x.call}) vence ${esc(x.id)}${x.gained ? (x.call === 'R' ? ' e conquista o lugar' : ' e tira o lugar ao R') : ''} (Câmara, ${esc(x.zone)}).`, 'call', x.call, !first && x.gained);
    }
    for (const k of ['S', 'H']) {
      const c = cur.control[k];
      if (c && c.winner) addEvent('srv:ctrl-' + k, `<b>${c.winner === 'GOP' ? 'Os republicanos' : 'Os democratas'} garantem ${k === 'S' ? 'o Senado' : 'a Câmara'}</b>, segundo as projeções da AP.`, 'call', c.winner === 'GOP' ? 'R' : 'D', !first);
    }
    saveFeed();
    renderFeed();
  }
  function evRow(e) {
    const isNew = S.lastVisit && e.t > S.lastVisit && e.t < visitStart;
    return `<div class="ev ${e.kind === 'call' ? 'call' : ''} ${e.party || ''} ${isNew ? 'new' : ''}"><time>${tLis.format(new Date(e.t))}</time><div>${isNew ? '<span class="newtag">novo</span> ' : ''}${e.text}</div></div>`;
  }
  function renderFeed() {
    const nNew = S.feed.filter((e) => S.lastVisit && e.t > S.lastVisit && e.t < visitStart).length;
    $('#feed').innerHTML = (nNew ? `<div class="since">${nNew} novidade${nNew > 1 ? 's' : ''} desde a tua última visita</div>` : '') + (S.feed.length
      ? S.feed.map(evRow).join('')
      : '<div class="empty">Ainda nada. Aqui aparecem as projeções da AP, as viragens da estimativa e os condados-chave que passam o alvo.</div>');
    renderLatest();
  }
  async function loadServerEvents() {
    if (DEMO) return;
    try {
      const { events, hist } = await (await fetch('/api/events', { signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined })).json();
      if (hist) { S.hist = hist; if (S.data) renderVerdict(); }
      let added = false;
      for (const e of events || []) {
        const id = 'srv:' + e.tag;
        const t = Date.parse(e.at) || Date.now();
        const have = S.feed.find((f) => f.id === id);
        if (have) { if (t < have.t) { have.t = t; added = true; } continue; } // a hora do servidor é a certa
        if (S.seen.has(id)) continue;
        S.seen.add(id);
        S.feed.push({ id, t, text: `<b>${esc(e.title)}</b> · ${esc(e.body)}`, kind: /^(call|ctrl|runoff)/.test(e.tag) ? 'call' : 'flip', party: /\(R\)|para R|Republicanos/.test(e.title) ? 'R' : /\(D\)|para D|Democratas/.test(e.title) ? 'D' : null });
        added = true;
      }
      if (added) { S.feed.sort((a, b) => b.t - a.t); saveFeed(); renderFeed(); }
    } catch (e) { /* sem histórico do servidor */ }
  }
  function toast(ev) {
    const el = document.createElement('div');
    el.className = 'toast ' + (ev.party || '');
    el.innerHTML = ev.text;
    const box = $('#toasts');
    box.appendChild(el);
    const max = window.innerWidth < 600 ? 2 : 4; // no telemóvel não podem tapar o ecrã
    while (box.children.length > max) box.firstChild.remove();
    setTimeout(() => el.remove(), 9000);
    $('#sr').textContent = el.textContent; // leitores de ecrã: só os acontecimentos importantes
    if (S.notify && !S.push && document.hidden) localNotify(el.textContent, ev.id);
    if (ev.kind === 'call') beep(ev.party === 'R' ? 660 : 440);
  }
  async function localNotify(body, tag) {
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (reg) await reg.showNotification('Radar R', { body, icon: '/icon-192.png', badge: '/icon-192.png', tag });
      else new Notification('Radar R', { body, icon: '/icon-192.png', tag });
    } catch (e) { /* sem notificações */ }
  }
  let actx = null, lastBeep = 0;
  function beep(freq) {
    if (Date.now() - lastBeep < 3000) return; // um som de cada vez, mesmo com muitas projeções seguidas
    lastBeep = Date.now();
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = freq; g.gain.value = 0.05;
      o.connect(g); g.connect(actx.destination);
      o.start(); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.5); o.stop(actx.currentTime + 0.5);
    } catch (e) { /* sem som */ }
  }
  const FEED_KEY = DEMO ? 'radar-feed-demo' : 'radar-feed-2026';
  function saveFeed() { store.set(FEED_KEY, JSON.stringify(S.feed.slice(0, 120))); }
  function loadFeed() {
    try {
      const f = JSON.parse(store.get(FEED_KEY) || '[]');
      if (Array.isArray(f)) { S.feed = f.filter((e) => e && e.id && e.t); S.feed.forEach((e) => S.seen.add(e.id)); }
    } catch (e) { /* feed estragado: começa vazio */ }
  }

  // ---------------------------------------------------------------- ensaio
  function resetDemoFeed() { S.feed = []; S.seen = new Set(); S.prev = null; store.del(FEED_KEY); renderFeed(); }
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
      bar.innerHTML = `<div class="wrap"><b>ENSAIO · NÚMEROS FICTÍCIOS</b><label for="demoT">Contagem simulada:</label><input type="range" min="0" max="1" step="0.01" id="demoT"><span class="num" id="demoV"></span><button id="demoPlay" type="button"></button><a href="/">Ver os resultados reais</a></div>`;
      $('#demoT').addEventListener('change', (e) => { const t = +e.target.value; if (t < S.demoT) resetDemoFeed(); S.demoT = t; renderDemoBar(); load(); });
      $('#demoPlay').addEventListener('click', () => { S.playing = !S.playing; if (S.demoT >= 1) { S.demoT = 0; resetDemoFeed(); } renderDemoBar(); schedule(); });
    }
    $('#demoT').value = S.demoT;
    $('#demoV').textContent = Math.round(S.demoT * 100) + '%';
    $('#demoPlay').textContent = S.playing ? '❚❚ Pausa' : '▶ Reproduzir a noite';
  }

  // ---------------------------------------------------------------- navegação
  let lastCard = null;
  function select(id) {
    const prevSel = S.sel;
    S.sel = id;
    if (id) { if (location.hash !== '#' + id) history.pushState(null, '', '#' + id); }
    else history.replaceState(null, '', location.pathname + location.search);
    document.querySelectorAll('.rc').forEach((b) => b.setAttribute('aria-current', String(b.dataset.id === id)));
    renderDetail(true);
    if (id) {
      lastCard = id;
      setTimeout(() => { const c = $(`.rc[data-id="${id}"]`); (c || detailEl).scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 30);
    } else if (prevSel) {
      const c = $(`.rc[data-id="${prevSel}"]`);
      if (c) { c.focus({ preventScroll: true }); c.scrollIntoView({ block: 'center' }); }
    }
  }
  function onHash() {
    const id = hashId();
    if (id && S.data && S.data.races.some((r) => r.id === id)) { if (id !== S.sel) select(id); }
    else if (!id && S.sel) select(null);
  }
  window.addEventListener('hashchange', onHash);
  window.addEventListener('popstate', onHash);
  document.addEventListener('click', (e) => {
    const sb = e.target.closest('#sortSeg button');
    if (sb) { S.sort = sb.dataset.sort; S.sortUser = true; syncSort(); renderGrid(); return; }
    const more = e.target.closest('[data-safe]');
    if (more) { showSafe[more.dataset.safe] = !showSafe[more.dataset.safe]; renderTables(); return; }
    const a = e.target.closest('a[href^="#"]');
    if (a && S.data) {
      const id = decodeURIComponent(a.getAttribute('href').slice(1));
      if (S.data.races.some((r) => r.id === id)) { e.preventDefault(); select(id === S.sel && a.classList.contains('rc') ? null : id); }
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sel) select(null); });
  let rz = null, lastW = window.innerWidth;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (Math.abs(window.innerWidth - lastW) > 40) { lastW = window.innerWidth; if (S.data) { placeDetail(); renderDetail(); } } }, 250); });

  function render() {
    renderLive();
    renderVerdict();
    renderPulse();
    renderGrid();
    renderHouse();
    renderScore();
    renderTables();
    renderDetail();
    renderLatest();
  }

  // ---------------------------------------------------------------- alertas: push (com o site fechado) ou avisos do browser
  const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), ms))]);
  let vapidKey = null, swReg = null;
  async function postSub(sub, method) {
    const r = await fetch('/api/push', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  }
  function setupNotify() {
    if (!('Notification' in window)) return;
    const canPush = 'serviceWorker' in navigator && 'PushManager' in window && !DEMO;
    const b = document.createElement('button');
    b.className = 'btn alerts';
    b.type = 'button';
    const upd = () => {
      b.textContent = S.push ? '🔔 Alertas ligados' : S.notify ? '🔔 Alertas (site aberto)' : '🔕 Ativar alertas';
      b.title = S.push ? 'Recebes as projeções da AP e as viragens mesmo com o site fechado. Toca para desligar.' : 'Avisos das projeções da AP e das viragens das corridas-chave';
      b.setAttribute('aria-pressed', String(S.notify));
    };
    const off = store.get('radar-alerts') === 'off';
    S.notify = Notification.permission === 'granted' && !off;
    upd();
    if (canPush) {
      navigator.serviceWorker.register('/sw.js').then((reg) => { swReg = reg; }).catch(() => {});
      // a chave é pedida antes do clique: no iPhone a subscrição tem de acontecer logo a seguir ao toque
      fetch('/api/push').then((r) => r.json()).then((j) => { vapidKey = j.key; }).catch(() => {});
      if (S.notify) {
        withTimeout(navigator.serviceWorker.ready, 8000).then((r) => r.pushManager.getSubscription()).then(async (s) => {
          if (s) { S.push = true; upd(); try { await postSub(s, 'POST'); } catch (e) { /* o servidor volta a tê-la na próxima visita */ } }
        }).catch(() => {});
      }
    }
    b.onclick = async () => {
      if (S.notify || S.push) {
        S.notify = false; store.set('radar-alerts', 'off');
        if (S.push) {
          try {
            const reg = swReg || await withTimeout(navigator.serviceWorker.ready, 5000);
            const s = await reg.pushManager.getSubscription();
            if (s) { await s.unsubscribe(); postSub(s, 'DELETE').catch(() => {}); }
          } catch (e) { /* já não estava subscrito */ }
          S.push = false;
        }
        upd(); return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast({ id: 'perm', text: 'O browser não deu autorização para alertas. Podes ativá-los nas definições do site.', kind: 'info' }); return; }
      S.notify = true; store.del('radar-alerts');
      if (canPush) {
        try {
          const reg = swReg || await withTimeout(navigator.serviceWorker.ready, 8000);
          if (!vapidKey) vapidKey = (await (await fetch('/api/push')).json()).key;
          let s = await reg.pushManager.getSubscription();
          if (!s) s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(vapidKey) });
          await postSub(s, 'POST');
          S.push = true;
        } catch (e) { S.push = false; }
      }
      toast({ id: 'alerts', text: S.push ? '<b>Alertas ligados.</b> Recebes as projeções da AP e as viragens mesmo com o site fechado.' : '<b>Alertas ligados</b> enquanto o site estiver aberto. No iPhone, adiciona primeiro o site ao ecrã principal para os receberes com o site fechado.', kind: 'info' });
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
  load().then(() => {
    onHash();
    // ligações para secções (ex.: #camara, vindas das notificações) só funcionam depois de haver conteúdo
    const h = hashId();
    const sec = S.sel ? $(`.rc[data-id="${S.sel}"]`) : h && document.getElementById(h);
    if (sec) {
      const go = () => sec.scrollIntoView({ block: 'start' });
      setTimeout(go, 50);
      // as fontes, ao carregar, mudam a altura do que está acima: volta a posicionar
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => setTimeout(go, 50));
      setTimeout(go, 900);
    }
    schedule();
  });
  loadServerEvents();
  setInterval(loadServerEvents, 120000);
})();
