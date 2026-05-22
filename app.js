'use strict';

const REFRESH_SECONDS = 60;
const COLS = 9;

const QUOTE_POLL_SECONDS = 20;
const MOVERS_PER_SIDE = 5;

// Up to six holdings overlay in the comparison chart, each in the next colour.
const MAX_COMPARE = 6;
const COMPARE_COLORS = [
  'var(--accent)', 'var(--blue)', 'var(--up)', 'var(--amber)', '#b07cff', 'var(--down)',
];

// A snapshot older than this points to a stuck refresh pipeline. The cron is
// idle overnight and at weekends, so the longest legitimate gap is the
// Friday-evening-to-Monday-open window (~64 h); 72 h clears it without false
// alarms.
const STALE_AFTER_MS = 72 * 60 * 60 * 1000;

// Highest data-document schemaVersion this build understands.
const KNOWN_SCHEMA = 1;

// Sort keys accepted from the table headers and the shareable URL.
const SORT_KEYS = new Set(
  ['rank', 'ticker', 'name', 'sector', 'weight', 'price', 'changePct', 'mom']
);

const state = {
  holdings: null,
  monthly: null,
  changes: null,
  prices: null,
  refreshStatus: null,
  sort: { key: 'weight', dir: 'desc' },
  search: '',
  sector: '',
  compare: [],
  weightChart: { ticker: '', months: 12 },
  open: new Set(),
  auto: true,
  countdown: REFRESH_SECONDS,
  busy: false,
  liveQuotes: null,
  livePricesAt: 0,
};

const $ = (sel) => document.querySelector(sel);

/* ---------- formatting helpers ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtSigned(n, d = 2, unit = '%') {
  if (!Number.isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(d) + unit;
}
function fmtPrice(n) {
  return Number.isFinite(n)
    ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
}
function fmtMarketCap(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  return '$' + Math.round(n).toLocaleString('en-US');
}
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function classOf(n) {
  return !Number.isFinite(n) || Math.abs(n) < 1e-9 ? 'flat' : n > 0 ? 'up' : 'down';
}
function relTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(diff)) return '—';
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
  return Math.floor(diff / 86400) + ' d ago';
}

// A snapshot is "stale" once it is older than the longest gap the refresh
// cron could legitimately leave between runs (see STALE_AFTER_MS).
function freshnessOf(asOfIso) {
  const ageMs = Date.now() - new Date(asOfIso).getTime();
  return { ageMs, stale: Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS };
}

/* ---------- monthly series ---------- */
function monthSeries(ticker) {
  const months = state.monthly ? state.monthly.months : [];
  const rec = (state.monthly && state.monthly.allocations[ticker]) || {};
  return months.map((m) => (Number.isFinite(rec[m]) ? rec[m] : null));
}
function momDelta(ticker) {
  const s = monthSeries(ticker).filter((v) => v != null);
  return s.length >= 2 ? s[s.length - 1] - s[s.length - 2] : null;
}

/* ---------- SVG charts ---------- */
function sparkline(values) {
  const W = 104, H = 28, P = 3;
  const pts = values.map((v, i) => ({ v, i })).filter((p) => p.v != null);
  if (pts.length < 2) {
    return `<svg class="spark" width="${W}" height="${H}" aria-hidden="true"></svg>`;
  }
  const vals = pts.map((p) => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => P + (i / (values.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const trend = vals[vals.length - 1] - vals[0];
  const color = trend > 0 ? 'var(--up)' : trend < 0 ? 'var(--down)' : 'var(--muted)';
  const last = pts[pts.length - 1];
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8"
      stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.4" fill="${color}"/>
  </svg>`;
}

function barChart(ticker) {
  const months = state.monthly ? state.monthly.months : [];
  const series = monthSeries(ticker);
  if (!months.length) return '<p class="empty">No monthly history yet.</p>';
  const W = 460, H = 190, padX = 34, padT = 22, padB = 26;
  const vals = series.filter((v) => v != null);
  const max = Math.max(...vals, 0.0001);
  const min = Math.min(...vals, max);
  const lo = Math.max(0, min - (max - min) * 0.35);
  const innerW = W - padX - 8;
  const innerH = H - padT - padB;
  const bw = (innerW / months.length) * 0.62;
  const y = (v) => padT + innerH - ((v - lo) / (max - lo || 1)) * innerH;
  let bars = '';
  months.forEach((m, i) => {
    const v = series[i];
    const cx = padX + (i + 0.5) * (innerW / months.length);
    if (v == null) return;
    const top = y(v);
    bars += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}"
      width="${bw.toFixed(1)}" height="${(padT + innerH - top).toFixed(1)}"
      rx="3" fill="var(--accent)" opacity="${i === months.length - 1 ? 1 : 0.55}"/>
      <text x="${cx.toFixed(1)}" y="${(top - 5).toFixed(1)}" text-anchor="middle"
        font-size="10" fill="var(--text)">${v.toFixed(2)}</text>
      <text x="${cx.toFixed(1)}" y="${H - 9}" text-anchor="middle"
        font-size="10" fill="var(--muted)">${m.slice(2)}</text>`;
  });
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
    role="img" aria-label="${ticker} monthly allocation history">
    <line x1="${padX}" y1="${padT + innerH}" x2="${W - 8}" y2="${padT + innerH}"
      stroke="var(--line)"/>${bars}</svg>`;
}

/* ---------- filtering / sorting ---------- */
function visibleHoldings() {
  const q = state.search.trim().toLowerCase();
  let rows = state.holdings.holdings.filter((h) => {
    if (state.sector && h.sector !== state.sector) return false;
    if (!q) return true;
    return h.ticker.toLowerCase().includes(q) || h.name.toLowerCase().includes(q);
  });
  const { key, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;
  rows = rows.slice().sort((a, b) => {
    let av, bv;
    if (key === 'mom') { av = momDelta(a.ticker); bv = momDelta(b.ticker); }
    else if (key === 'rank') { av = a.rank; bv = b.rank; }
    else { av = a[key]; bv = b[key]; }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * mul;
    return (av - bv) * mul;
  });
  return rows;
}

/* ---------- rendering ---------- */
function renderStatus() {
  const d = state.holdings;
  const badge = $('#sourceBadge');
  const map = {
    invesco: ['LIVE · INVESCO', ''],
    fmp: ['LIVE · FMP', ''],
    'sec-nport': ['LIVE · SEC', ''],
    'invesco-cached': ['CACHED', 'cached'],
    'fmp-cached': ['CACHED', 'cached'],
    seed: ['SAMPLE DATA', 'seed'],
  };
  const [label, cls] = map[d.source] || ['DATA', 'cached'];
  badge.textContent = label;
  badge.className = 'src-badge ' + cls;

  const fresh = freshnessOf(d.asOf);
  $('#staleBadge').hidden = !fresh.stale;

  const live = state.liveQuotes === true
    ? ` <span class="live-tag">&middot; delayed quotes &middot; updated ${relTime(state.livePricesAt)}</span>`
    : '';
  $('#asOf').innerHTML = `<span class="dot"></span>as of ${relTime(d.asOf)} ` +
    `(${new Date(d.asOf).toLocaleString()})${live}`;
  $('#fundName').textContent = `${d.name} · ${d.count} holdings`;
  const auto = state.auto ? ` · next in ${state.countdown}s` : ' · paused';
  $('#autoLabel').textContent = 'Auto-refresh' + auto;
  $('#footerStatus').textContent = state.auto
    ? `auto-refreshing every ${REFRESH_SECONDS}s in this view.`
    : 'auto-refresh paused.';
  $('#dataHealth').innerHTML =
    `Data source: <strong>${escapeHtml(label)}</strong> &middot; ${d.count} holdings ` +
    `&middot; snapshot ${relTime(d.asOf)}` +
    (fresh.stale
      ? ' &middot; <span class="down">may be stale &mdash; the refresh job has not '
        + 'updated it recently</span>'
      : '') +
    refreshHealthLine();
}

function refreshHealthLine() {
  const rs = state.refreshStatus;
  if (!rs) return '';
  const pct = Number.isFinite(rs.quoteSuccessRate)
    ? Math.round(rs.quoteSuccessRate * 100) : null;
  const quote = rs.quoteSource ? escapeHtml(rs.quoteSource) : '—';
  const attempts = Array.isArray(rs.attempts)
    ? rs.attempts.map((a) => `${a.source}:${a.ok ? 'ok' : 'fail'}`).join(', ')
    : '';
  return ` &middot; last refresh ${relTime(rs.runAt)} via <strong>${quote}</strong>` +
    (pct != null ? ` (${pct}% quotes)` : '') +
    (attempts ? ` &middot; pipeline: ${escapeHtml(attempts)}` : '');
}

function renderCards() {
  const h = state.holdings.holdings;
  const top10 = h.slice(0, 10).reduce((s, x) => s + x.weight, 0);
  const priced = h.filter((x) => Number.isFinite(x.changePct));
  const advancers = priced.filter((x) => x.changePct > 0).length;
  const wAvg = priced.length
    ? priced.reduce((s, x) => s + x.changePct * x.weight, 0) /
      priced.reduce((s, x) => s + x.weight, 0)
    : null;
  // Herfindahl-Hirschman index of the weight distribution: the sum of squared
  // percentage weights. Its inverse (10000 / HHI) is the "effective" number
  // of equally-weighted holdings the fund behaves like.
  const hhi = h.reduce((s, x) => s + x.weight * x.weight, 0);
  const effectiveN = hhi > 0 ? Math.round(10000 / hhi) : 0;
  const cards = [
    { label: 'Holdings', value: state.holdings.count, sub: `${state.holdings.totalWeight}% total weight` },
    { label: 'Top-10 concentration', value: top10.toFixed(1) + '%', sub: 'of fund weight' },
    { label: 'Largest position', value: h[0].ticker, sub: `${h[0].weight.toFixed(2)}% · ${h[0].name}` },
    {
      label: 'Weighted day move',
      value: wAvg == null ? '—' : fmtSigned(wAvg),
      sub: priced.length ? `${advancers}/${priced.length} advancing` : 'prices pending',
      cls: classOf(wAvg),
    },
    {
      label: 'Herfindahl index',
      value: hhi.toFixed(0),
      sub: `concentration · like ≈${effectiveN} equal holdings`,
    },
  ];
  $('#cards').innerHTML = cards.map((c) => `
    <div class="card">
      <div class="label">${c.label}</div>
      <div class="value ${c.cls || ''}">${c.value}</div>
      <div class="sub">${escapeHtml(c.sub)}</div>
    </div>`).join('');
}

function renderTable() {
  const rows = visibleHoldings();
  const maxW = state.holdings.holdings[0].weight || 1;
  const body = $('#holdingsBody');

  if (!rows.length) {
    body.innerHTML = `<tr><td class="empty" colspan="${COLS}">No holdings match your filter.</td></tr>`;
  } else {
    body.innerHTML = rows.map((h) => {
      const mom = momDelta(h.ticker);
      const open = state.open.has(h.ticker);
      const main = `
        <tr class="row ${open ? 'open' : ''}" data-tk="${h.ticker}"
          tabindex="0" role="button" aria-expanded="${open}"
          aria-label="${h.ticker}, ${escapeHtml(h.name)}, weight ${h.weight.toFixed(2)} percent">
          <td class="num" data-label="Rank">${h.rank}</td>
          <td class="tk" data-label="Ticker"><span class="caret">▸</span>${h.ticker}</td>
          <td class="co-name" data-label="Company" title="${escapeHtml(h.name)}">${escapeHtml(h.name)}</td>
          <td class="sector-tag" data-label="Sector">${escapeHtml(h.sector)}</td>
          <td class="num weight-cell" data-label="Weight %">
            <div class="weight-bar" style="width:${(h.weight / maxW) * 100}%"></div>
            <span>${h.weight.toFixed(2)}</span>
          </td>
          <td class="num" data-label="Price">${fmtPrice(h.price)}</td>
          <td class="num ${classOf(h.changePct)}" data-label="Day %">${fmtSigned(h.changePct)}</td>
          <td class="num ${classOf(mom)}" data-label="MoM Δ">${fmtSigned(mom, 2, ' pp')}</td>
          <td data-label="6-month allocation">${sparkline(monthSeries(h.ticker))}</td>
        </tr>`;
      return main + (open ? detailRow(h) : '');
    }).join('');
  }

  document.querySelectorAll('#holdingsTable thead th').forEach((th) => {
    th.classList.remove('sorted', 'desc');
    const active = th.dataset.sort === state.sort.key;
    if (active) {
      th.classList.add('sorted');
      if (state.sort.dir === 'desc') th.classList.add('desc');
    }
    th.setAttribute('aria-sort', active
      ? (state.sort.dir === 'asc' ? 'ascending' : 'descending')
      : 'none');
  });
  $('#tableFoot').textContent =
    `Showing ${rows.length} of ${state.holdings.count} holdings · ` +
    `monthly allocation history: ${state.monthly.months.length} months ` +
    `(${state.monthly.months[0]} → ${state.monthly.months[state.monthly.months.length - 1]}).`;
}

function detailRow(h) {
  const months = state.monthly.months;
  const series = monthSeries(h.ticker);
  const present = series.filter((v) => v != null);
  const first = present[0], last = present[present.length - 1];
  const cells = months.map((m, i) => {
    const v = series[i];
    const prev = i > 0 ? series[i - 1] : null;
    const dlt = v != null && prev != null ? v - prev : null;
    return `<div class="month-cell">
      <div class="m">${m}</div>
      <div class="w">${v != null ? v.toFixed(2) + '%' : '—'}</div>
      <div class="d ${classOf(dlt)}">${dlt == null ? '&nbsp;' : fmtSigned(dlt, 2, ' pp')}</div>
    </div>`;
  }).join('');
  const sixMo = first != null && last != null ? last - first : null;
  const range = Number.isFinite(h.yearLow) && Number.isFinite(h.yearHigh)
    ? `${fmtPrice(h.yearLow)} – ${fmtPrice(h.yearHigh)}`
    : '—';
  const fundStats = [
    ['Market cap', fmtMarketCap(h.marketCap)],
    ['P/E ratio', Number.isFinite(h.pe) ? h.pe.toFixed(1) : '—'],
    ['52-week range', range],
  ].map(([k, v]) => `<div class="fund-stat">
      <div class="fk">${k}</div><div class="fv">${v}</div>
    </div>`).join('');
  return `<tr class="detail"><td colspan="${COLS}">
    <div class="detail-inner">
      <div class="detail-chart">
        <h4>${h.ticker} — monthly allocation in QQQQ</h4>
        ${barChart(h.ticker)}
      </div>
      <div class="detail-stats">
        <h4>${escapeHtml(h.name)} · ${escapeHtml(h.sector)}</h4>
        <p style="color:var(--muted);font-size:12px;margin-bottom:10px">
          Rank #${h.rank} · current weight <strong style="color:var(--text)">${h.weight.toFixed(3)}%</strong>
          · 6-month change <span class="${classOf(sixMo)}">${fmtSigned(sixMo, 2, ' pp')}</span>
          · price ${fmtPrice(h.price)} (<span class="${classOf(h.changePct)}">${fmtSigned(h.changePct)}</span>)
        </p>
        <div class="fund-stats">${fundStats}</div>
        <div class="month-grid">${cells}</div>
      </div>
    </div></td></tr>`;
}

function renderSectors() {
  const totals = {};
  for (const h of state.holdings.holdings) {
    totals[h.sector] = (totals[h.sector] || 0) + h.weight;
  }
  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 1;
  $('#sectors').innerHTML = rows.map(([name, w]) => `
    <div class="sector-row">
      <div class="nm">${escapeHtml(name)}</div>
      <div class="track"><div class="fill" style="width:${(w / max) * 100}%"></div></div>
      <div class="pct">${w.toFixed(1)}%</div>
    </div>`).join('');
}

function renderChanges() {
  const el = $('#changesBanner');
  const ev = state.changes && state.changes.events && state.changes.events[0];
  if (!ev || (!ev.added.length && !ev.removed.length)) {
    el.hidden = true;
    return;
  }
  const when = new Date(ev.date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const parts = [`<strong>Latest index change &middot; ${when}</strong>`];
  if (ev.added.length) {
    parts.push(`<span class="chg-add">&#9650; Added: ${
      ev.added.map((x) => escapeHtml(x.ticker)).join(', ')}</span>`);
  }
  if (ev.removed.length) {
    parts.push(`<span class="chg-rem">&#9660; Removed: ${
      ev.removed.map((x) => escapeHtml(x.ticker)).join(', ')}</span>`);
  }
  el.innerHTML = parts.join('');
  el.hidden = false;
}

// Biggest daily gainers and losers among priced holdings. Hidden entirely
// until prices are available (e.g. before the first cron run on static hosting).
function renderMovers() {
  const panel = $('#moversPanel');
  const priced = state.holdings.holdings.filter((h) => Number.isFinite(h.changePct));
  if (!priced.length) {
    panel.hidden = true;
    return;
  }
  const ranked = priced.slice().sort((a, b) => b.changePct - a.changePct);
  const gainers = ranked.filter((h) => h.changePct > 0).slice(0, MOVERS_PER_SIDE);
  const losers = ranked.filter((h) => h.changePct < 0).slice(-MOVERS_PER_SIDE).reverse();

  const chip = (h) => `
    <button class="mover" type="button" data-tk="${h.ticker}"
      aria-label="${h.ticker}, ${escapeHtml(h.name)}, ${fmtSigned(h.changePct)} today">
      <span class="mv-tk">${h.ticker}</span>
      <span class="mv-price">${fmtPrice(h.price)}</span>
      <span class="mv-chg ${classOf(h.changePct)}">${fmtSigned(h.changePct)}</span>
    </button>`;
  const col = (title, list) => `
    <div class="mv-col">
      <div class="mv-head">${title}</div>
      <div class="mv-list">${
        list.length ? list.map(chip).join('') : '<span class="mv-none">No movers</span>'
      }</div>
    </div>`;

  $('#movers').innerHTML =
    col('&#9650; Top gainers', gainers) + col('&#9660; Top losers', losers);
  panel.hidden = false;
}

/* ---------- fund concentration ---------- */
// Per-month top-5 / top-10 weight concentration, derived from the same
// monthly allocation history that drives each row's sparkline.
function concentrationSeries() {
  const months = state.monthly ? state.monthly.months : [];
  const allocations = (state.monthly && state.monthly.allocations) || {};
  return months.map((m) => {
    const weights = [];
    for (const rec of Object.values(allocations)) {
      if (Number.isFinite(rec[m])) weights.push(rec[m]);
    }
    weights.sort((a, b) => b - a);
    const sum = (n) => weights.slice(0, n).reduce((s, w) => s + w, 0);
    return { month: m, count: weights.length, top5: sum(5), top10: sum(10) };
  });
}

function concentrationChart(series) {
  const W = 720, H = 230, padL = 40, padR = 16, padT = 16, padB = 34;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const lines = [
    { key: 'top10', label: 'Top 10 holdings', color: 'var(--accent)' },
    { key: 'top5', label: 'Top 5 holdings', color: 'var(--blue)' },
  ];
  const vals = series.flatMap((p) => [p.top5, p.top10]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.25 || 1;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const n = series.length;
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padT + innerH - ((v - lo) / (hi - lo || 1)) * innerH;

  let grid = '';
  const TICKS = 4;
  for (let t = 0; t <= TICKS; t++) {
    const v = lo + (t / TICKS) * (hi - lo);
    const gy = y(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="var(--line)"/>
      <text x="${padL - 6}" y="${(+gy + 3).toFixed(1)}" text-anchor="end"
        font-size="9.5" fill="var(--muted)">${v.toFixed(0)}%</text>`;
  }
  let xlab = '';
  series.forEach((p, i) => {
    if (n > 12 && i % 2 !== 0 && i !== n - 1) return;
    xlab += `<text x="${x(i).toFixed(1)}" y="${H - 12}" text-anchor="middle"
      font-size="9.5" fill="var(--muted)">${p.month.slice(2)}</text>`;
  });
  let paths = '';
  for (const ln of lines) {
    const d = series
      .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[ln.key]).toFixed(1)}`)
      .join(' ');
    paths += `<path d="${d}" fill="none" stroke="${ln.color}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>`;
    paths += series
      .map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p[ln.key]).toFixed(1)}"
        r="2.6" fill="${ln.color}"/>`)
      .join('');
  }
  const legend = lines
    .map((ln) => `<span class="lg">
      <span class="swatch" style="background:${ln.color}"></span>${ln.label}</span>`)
    .join('');
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
    role="img" aria-label="Top 5 and top 10 holding concentration by month">
    ${grid}${paths}${xlab}</svg>
    <div class="line-legend">${legend}</div>`;
}

function renderConcentration() {
  const series = concentrationSeries();
  const note = $('#concentrationNote');
  const chart = $('#concentrationChart');
  if (series.length < 2) {
    note.textContent = '';
    chart.innerHTML = '<p class="empty">Not enough monthly history yet.</p>';
    return;
  }
  chart.innerHTML = concentrationChart(series);
  const first = series[0];
  const last = series[series.length - 1];
  const d10 = last.top10 - first.top10;
  note.innerHTML =
    `Top 10 hold <strong>${last.top10.toFixed(1)}%</strong> of the fund ` +
    `(<span class="${classOf(d10)}">${fmtSigned(d10, 1, ' pp')}</span> since ${first.month})`;
}

/* ---------- compare holdings ---------- */
// Overlay the monthly allocation history of several holdings on one chart,
// reusing the same hand-drawn multi-line SVG style as the concentration trend.
function compareChart(tickers) {
  const months = state.monthly ? state.monthly.months : [];
  if (months.length < 2) return '<p class="empty">Not enough monthly history yet.</p>';
  const series = tickers.map((tk) => ({ tk, vals: monthSeries(tk) }));
  const present = series.flatMap((s) => s.vals).filter((v) => v != null);
  if (!present.length) {
    return '<p class="empty">No allocation history for the selected holdings.</p>';
  }
  const W = 720, H = 250, padL = 42, padR = 16, padT = 16, padB = 34;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  let lo = Math.min(...present), hi = Math.max(...present);
  const pad = (hi - lo) * 0.25 || hi * 0.1 || 1;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const n = months.length;
  const x = (i) => padL + (i / (n - 1)) * innerW;
  const y = (v) => padT + innerH - ((v - lo) / (hi - lo || 1)) * innerH;

  let grid = '';
  const TICKS = 4;
  for (let t = 0; t <= TICKS; t++) {
    const v = lo + (t / TICKS) * (hi - lo);
    const gy = y(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="var(--line)"/>
      <text x="${padL - 6}" y="${(+gy + 3).toFixed(1)}" text-anchor="end"
        font-size="9.5" fill="var(--muted)">${v.toFixed(1)}%</text>`;
  }
  let xlab = '';
  months.forEach((m, i) => {
    if (n > 12 && i % 2 !== 0 && i !== n - 1) return;
    xlab += `<text x="${x(i).toFixed(1)}" y="${H - 12}" text-anchor="middle"
      font-size="9.5" fill="var(--muted)">${m.slice(2)}</text>`;
  });
  let paths = '';
  series.forEach((s, idx) => {
    const color = COMPARE_COLORS[idx % COMPARE_COLORS.length];
    const pts = s.vals.map((v, i) => ({ v, i })).filter((p) => p.v != null);
    if (!pts.length) return;
    const d = pts
      .map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join(' ');
    paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>`;
    paths += pts
      .map((p) => `<circle cx="${x(p.i).toFixed(1)}" cy="${y(p.v).toFixed(1)}"
        r="2.6" fill="${color}"/>`)
      .join('');
  });
  const legend = series
    .map((s, idx) => `<span class="lg">
      <span class="swatch" style="background:${COMPARE_COLORS[idx % COMPARE_COLORS.length]}"></span>
      ${escapeHtml(s.tk)}</span>`)
    .join('');
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
    role="img" aria-label="Monthly allocation comparison for the selected holdings">
    ${grid}${paths}${xlab}</svg>
    <div class="line-legend">${legend}</div>`;
}

function renderCompare() {
  $('#compareChips').innerHTML = state.compare
    .map((tk, i) => `<button class="cmp-chip" type="button" data-tk="${tk}"
        aria-label="Remove ${tk} from comparison">
        <span class="cmp-dot" style="background:${COMPARE_COLORS[i % COMPARE_COLORS.length]}"></span>
        ${escapeHtml(tk)}<span class="cmp-x" aria-hidden="true">&times;</span>
      </button>`)
    .join('');
  $('#compareChart').innerHTML = state.compare.length
    ? compareChart(state.compare)
    : '<p class="empty">Pick holdings above to overlay their monthly allocation history.</p>';
}

/* ---------- index change history ---------- */
// A browsable timeline of every constituent addition / removal recorded in
// data/changes.json — the full history behind the latest-change banner.
function renderChangeHistory() {
  const el = $('#changeHistory');
  const events = (state.changes && Array.isArray(state.changes.events)
    ? state.changes.events
    : []
  ).filter((ev) => ev && ((ev.added && ev.added.length) || (ev.removed && ev.removed.length)));
  if (!events.length) {
    el.innerHTML = '<p class="empty">No index additions or removals recorded yet. They ' +
      'appear here once the refresh job detects a constituent change.</p>';
    return;
  }
  const tag = (x, cls, sign) =>
    `<span class="chg-tag ${cls}" title="${escapeHtml(x.name || x.ticker)}">` +
    `${sign} ${escapeHtml(x.ticker)}</span>`;
  el.innerHTML = events
    .map((ev) => {
      const when = new Date(ev.date).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
      const added = (ev.added || []).map((x) => tag(x, 'add', '▲')).join('');
      const removed = (ev.removed || []).map((x) => tag(x, 'rem', '▼')).join('');
      return `<div class="chg-event">
        <div class="chg-when">${escapeHtml(when)}</div>
        <div class="chg-tags">${added}${removed}</div>
      </div>`;
    })
    .join('');
}

/* ---------- fund performance ---------- */
// A single-line chart of the QQQ closing price across the tracked window,
// drawn from data/price-history.json (one close recorded per refresh day).
function perfChart(history) {
  const W = 720, H = 240, padL = 46, padR = 16, padT = 16, padB = 30;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const closes = history.map((p) => p.close);
  let lo = Math.min(...closes), hi = Math.max(...closes);
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad;
  hi += pad;
  const n = history.length;
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padT + innerH - ((v - lo) / (hi - lo || 1)) * innerH;

  let grid = '';
  const TICKS = 4;
  for (let t = 0; t <= TICKS; t++) {
    const v = lo + (t / TICKS) * (hi - lo);
    const gy = y(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="var(--line)"/>
      <text x="${padL - 6}" y="${(+gy + 3).toFixed(1)}" text-anchor="end"
        font-size="9.5" fill="var(--muted)">$${v.toFixed(0)}</text>`;
  }
  let xlab = '';
  const step = Math.max(1, Math.round(n / 6));
  history.forEach((p, i) => {
    const isLast = i === n - 1;
    // Label every `step`-th day plus the last, dropping a step label that
    // would collide with the last one.
    if (!isLast && (i % step !== 0 || n - 1 - i < step * 0.6)) return;
    xlab += `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle"
      font-size="9.5" fill="var(--muted)">${p.date.slice(5)}</text>`;
  });
  const up = history[n - 1].close >= history[0].close;
  const color = up ? 'var(--up)' : 'var(--down)';
  const line = history
    .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.close).toFixed(1)}`)
    .join(' ');
  const area = `M${x(0).toFixed(1)},${y(lo).toFixed(1)} ` +
    history.map((p, i) => `L${x(i).toFixed(1)},${y(p.close).toFixed(1)}`).join(' ') +
    ` L${x(n - 1).toFixed(1)},${y(lo).toFixed(1)} Z`;
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
    role="img" aria-label="QQQ closing price over the tracked window">
    ${grid}<path d="${area}" fill="${color}" opacity="0.12"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>${xlab}</svg>`;
}

function renderPerformance() {
  const hist = state.prices && Array.isArray(state.prices.history)
    ? state.prices.history : [];
  const note = $('#perfNote');
  const chart = $('#perfChart');
  if (hist.length < 2) {
    note.textContent = '';
    chart.innerHTML = '<p class="empty">Fund price history will appear here as ' +
      'the refresh job records daily closes.</p>';
    return;
  }
  chart.innerHTML = perfChart(hist);
  const first = hist[0].close;
  const last = hist[hist.length - 1].close;
  const ret = first ? ((last - first) / first) * 100 : null;
  note.innerHTML =
    `QQQ <strong>${fmtPrice(last)}</strong> &middot; ` +
    `<span class="${classOf(ret)}">${fmtSigned(ret, 1)}</span> ` +
    `over ${hist.length} trading days (since ${hist[0].date})`;
}

/* ---------- sector trends ---------- */
function sectorTrendSeries() {
  const months = state.monthly ? state.monthly.months : [];
  const sectorOf = Object.fromEntries(
    state.holdings.holdings.map((h) => [h.ticker, h.sector || 'Unclassified'])
  );
  return months.map((m) => {
    const totals = {};
    for (const [tk, rec] of Object.entries(state.monthly?.allocations || {})) {
      if (!Number.isFinite(rec[m])) continue;
      const sec = sectorOf[tk] || 'Unclassified';
      totals[sec] = (totals[sec] || 0) + rec[m];
    }
    return { month: m, totals };
  });
}

function sectorTrendChart(series, sectors) {
  const W = 720, H = 250, padL = 42, padR = 16, padT = 16, padB = 34;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const vals = series.flatMap((p) => sectors.map((s) => p.totals[s] || 0));
  let lo = 0;
  let hi = Math.max(...vals, 1);
  const pad = hi * 0.08 || 1;
  hi += pad;
  const n = series.length;
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padT + innerH - ((v - lo) / (hi - lo || 1)) * innerH;

  let grid = '';
  const TICKS = 4;
  for (let t = 0; t <= TICKS; t++) {
    const v = lo + (t / TICKS) * (hi - lo);
    const gy = y(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="var(--line)"/>
      <text x="${padL - 6}" y="${(+gy + 3).toFixed(1)}" text-anchor="end"
        font-size="9.5" fill="var(--muted)">${v.toFixed(0)}%</text>`;
  }
  let xlab = '';
  series.forEach((p, i) => {
    if (n > 12 && i % 2 !== 0 && i !== n - 1) return;
    xlab += `<text x="${x(i).toFixed(1)}" y="${H - 12}" text-anchor="middle"
      font-size="9.5" fill="var(--muted)">${p.month.slice(2)}</text>`;
  });
  let paths = '';
  sectors.forEach((sec, idx) => {
    const color = COMPARE_COLORS[idx % COMPARE_COLORS.length];
    const pts = series
      .map((p, i) => ({ v: p.totals[sec] || 0, i }))
      .filter((p) => Number.isFinite(p.v));
    if (pts.length < 2) return;
    const d = pts
      .map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join(' ');
    paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  const legend = sectors
    .map((sec, idx) => `<span class="lg">
      <span class="swatch" style="background:${COMPARE_COLORS[idx % COMPARE_COLORS.length]}"></span>
      ${escapeHtml(sec)}</span>`)
    .join('');
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
    role="img" aria-label="Sector allocation trend over monthly history">
    ${grid}${paths}${xlab}</svg>
    <div class="line-legend">${legend}</div>`;
}

function renderSectorTrends() {
  const series = sectorTrendSeries();
  const note = $('#sectorTrendNote');
  const chart = $('#sectorTrendChart');
  if (series.length < 2) {
    note.textContent = '';
    chart.innerHTML = '<p class="empty">Not enough monthly history yet.</p>';
    return;
  }
  const lastTotals = series[series.length - 1].totals;
  const sectors = Object.entries(lastTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([s]) => s);
  chart.innerHTML = sectorTrendChart(series, sectors);
  const first = series[0];
  const last = series[series.length - 1];
  const top = sectors[0];
  const d = top ? (last.totals[top] || 0) - (first.totals[top] || 0) : null;
  note.innerHTML = top
    ? `<strong>${escapeHtml(top)}</strong> leads at ${(last.totals[top] || 0).toFixed(1)}%` +
      (d != null ? ` (<span class="${classOf(d)}">${fmtSigned(d, 1, ' pp')}</span> since ${first.month})` : '')
    : '';
}

/* ---------- weight history ---------- */
function weightHistorySeries(ticker, maxMonths) {
  const months = state.monthly ? state.monthly.months : [];
  const kept = months.slice(-maxMonths);
  const rec = state.monthly?.allocations?.[ticker] || {};
  return kept.map((m) => ({ month: m, weight: Number.isFinite(rec[m]) ? rec[m] : null }));
}

function weightHistoryChart(series, ticker) {
  const pts = series.filter((p) => p.weight != null);
  if (pts.length < 2) return '<p class="empty">Not enough history for this holding.</p>';
  const W = 720, H = 250, padL = 42, padR = 16, padT = 16, padB = 34;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const vals = pts.map((p) => p.weight);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = (hi - lo) * 0.25 || hi * 0.1 || 1;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const n = series.length;
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padT + innerH - ((v - lo) / (hi - lo || 1)) * innerH;

  let grid = '';
  const TICKS = 4;
  for (let t = 0; t <= TICKS; t++) {
    const v = lo + (t / TICKS) * (hi - lo);
    const gy = y(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="var(--line)"/>
      <text x="${padL - 6}" y="${(+gy + 3).toFixed(1)}" text-anchor="end"
        font-size="9.5" fill="var(--muted)">${v.toFixed(1)}%</text>`;
  }
  let xlab = '';
  series.forEach((p, i) => {
    if (n > 12 && i % 2 !== 0 && i !== n - 1) return;
    xlab += `<text x="${x(i).toFixed(1)}" y="${H - 12}" text-anchor="middle"
      font-size="9.5" fill="var(--muted)">${p.month.slice(2)}</text>`;
  });
  const present = series.map((p, i) => ({ ...p, i })).filter((p) => p.weight != null);
  const d = present
    .map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.weight).toFixed(1)}`)
    .join(' ');
  const trend = present[present.length - 1].weight - present[0].weight;
  const color = trend >= 0 ? 'var(--up)' : 'var(--down)';
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
    role="img" aria-label="${ticker} index weight over the selected window">
    ${grid}<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2"
      stroke-linejoin="round" stroke-linecap="round"/>${xlab}</svg>`;
}

function renderWeightHistory() {
  const sel = $('#weightTicker');
  const win = $('#weightWindow');
  if (!state.weightChart.ticker && state.holdings?.holdings?.length) {
    state.weightChart.ticker = state.holdings.holdings[0].ticker;
  }
  if (sel && sel.value !== state.weightChart.ticker) sel.value = state.weightChart.ticker;
  if (win) win.value = String(state.weightChart.months);
  const tk = state.weightChart.ticker;
  const months = Number(state.weightChart.months) || 12;
  const series = weightHistorySeries(tk, months);
  const note = $('#weightHistoryNote');
  const chart = $('#weightHistoryChart');
  if (!tk) {
    note.textContent = '';
    chart.innerHTML = '<p class="empty">Select a holding.</p>';
    return;
  }
  chart.innerHTML = weightHistoryChart(series, tk);
  const present = series.filter((p) => p.weight != null);
  if (present.length < 2) {
    note.textContent = '';
    return;
  }
  const first = present[0];
  const last = present[present.length - 1];
  const d = last.weight - first.weight;
  note.innerHTML =
    `<strong>${escapeHtml(tk)}</strong> weight ` +
    `<strong>${last.weight.toFixed(2)}%</strong> &middot; ` +
    `<span class="${classOf(d)}">${fmtSigned(d, 2, ' pp')}</span> over ${present.length} months`;
}

function render() {
  renderStatus();
  renderCards();
  renderChanges();
  renderMovers();
  renderTable();
  renderPerformance();
  renderConcentration();
  renderCompare();
  renderWeightHistory();
  renderSectorTrends();
  renderSectors();
  renderChangeHistory();
}

/* ---------- data loading ---------- */
async function loadData() {
  const bust = '?t=' + Date.now();
  const [h, m, c, p, rs] = await Promise.all([
    fetch('data/holdings.json' + bust).then((r) => r.json()),
    fetch('data/monthly-allocations.json' + bust).then((r) => r.json()),
    fetch('data/changes.json' + bust).then((r) => r.json()).catch(() => ({ events: [] })),
    fetch('data/price-history.json' + bust).then((r) => r.json()).catch(() => null),
    fetch('data/refresh-status.json' + bust).then((r) => r.json()).catch(() => null),
  ]);
  if (Number.isFinite(h.schemaVersion) && h.schemaVersion > KNOWN_SCHEMA) {
    console.warn(
      `data schemaVersion ${h.schemaVersion} is newer than this build supports ` +
      `(${KNOWN_SCHEMA}); some fields may not render.`
    );
  }
  h.holdings.forEach((row, i) => { row.rank = i + 1; });
  // populate the sector filter and compare picker once
  if (!state.holdings) {
    const sectors = [...new Set(h.holdings.map((x) => x.sector))].sort();
    const sel = $('#sectorFilter');
    sectors.forEach((s) => {
      const o = document.createElement('option');
      o.value = o.textContent = s;
      sel.appendChild(o);
    });
    const cmpSel = $('#compareAdd');
    h.holdings.map((x) => x.ticker).sort().forEach((tk) => {
      const o = document.createElement('option');
      o.value = o.textContent = tk;
      cmpSel.appendChild(o);
    });
    const weightSel = $('#weightTicker');
    h.holdings.forEach((x) => {
      const o = document.createElement('option');
      o.value = o.textContent = x.ticker;
      weightSel.appendChild(o);
    });
    state.weightChart.ticker = h.holdings[0]?.ticker || '';
  }
  state.holdings = h;
  state.monthly = m;
  state.changes = c;
  state.prices = p;
  state.refreshStatus = rs;
  render();
}

// Near-real-time price polling. Works when self-hosted via `server.js`
// (POST/GET /api/quotes); on static hosting the first call fails and
// polling quietly stops, leaving cron-refreshed prices in place.
let quoteTimer = null;
async function pollQuotes() {
  if (!state.holdings) return;
  try {
    const res = await fetch('/api/quotes', { cache: 'no-store' });
    if (!res.ok) throw new Error('no live quotes endpoint');
    const data = await res.json();
    let n = 0;
    for (const row of state.holdings.holdings) {
      const q = data.quotes[row.ticker];
      if (q) {
        row.price = q.price;
        row.changePct = q.changePct;
        for (const f of ['marketCap', 'pe', 'yearHigh', 'yearLow']) {
          if (Number.isFinite(q[f])) row[f] = q[f];
        }
        n++;
      }
    }
    if (!n) throw new Error('empty quote set');
    state.liveQuotes = true;
    state.livePricesAt = Date.now();
    render();
  } catch {
    state.liveQuotes = false;
    if (quoteTimer) { clearInterval(quoteTimer); quoteTimer = null; }
  }
}

async function manualRefresh() {
  if (state.busy) return;
  state.busy = true;
  const btn = $('#refreshBtn');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    // Triggers a server-side fetch when self-hosted; harmless on static hosting.
    await fetch('/api/refresh', { method: 'POST' }).catch(() => {});
    await loadData();
    // Announce the outcome for screen-reader users (visual cue is the badge).
    $('#srStatus').textContent = 'Holdings refreshed. ' +
      (freshnessOf(state.holdings.asOf).stale ? 'Data may be stale.' : 'Data is current.');
  } catch (err) {
    console.error('refresh failed', err);
    $('#srStatus').textContent = 'Refresh failed.';
  } finally {
    state.busy = false;
    state.countdown = REFRESH_SECONDS;
    btn.disabled = false;
    btn.textContent = 'Refresh now';
  }
}

/* ---------- shareable view state ---------- */
// The current filter/sort/expanded-row selection is mirrored into the URL
// query string so a particular view can be bookmarked or shared. Only
// non-default values are written, keeping a pristine view at a clean URL.
function syncUrl() {
  const p = new URLSearchParams();
  if (state.sort.key !== 'weight' || state.sort.dir !== 'desc') {
    p.set('sort', `${state.sort.key}:${state.sort.dir}`);
  }
  if (state.search.trim()) p.set('q', state.search.trim());
  if (state.sector) p.set('sector', state.sector);
  if (state.open.size) p.set('open', [...state.open].join(','));
  if (state.compare.length) p.set('cmp', state.compare.join(','));
  const qs = p.toString();
  history.replaceState(null, '', qs ? '?' + qs : location.pathname);
}

function restoreFromUrl() {
  const p = new URLSearchParams(location.search);
  const sort = p.get('sort');
  if (sort) {
    const [key, dir] = sort.split(':');
    if (SORT_KEYS.has(key)) {
      state.sort.key = key;
      state.sort.dir = dir === 'asc' ? 'asc' : 'desc';
    }
  }
  state.search = p.get('q') || '';
  state.sector = p.get('sector') || '';
  const open = p.get('open');
  if (open) open.split(',').forEach((t) => t && state.open.add(t));
  const cmp = p.get('cmp');
  if (cmp) state.compare = cmp.split(',').filter(Boolean).slice(0, MAX_COMPARE);
}

// Reflect restored state into the controls once the data (and so the sector
// list) is loaded; drops a `sector` value that isn't a real option.
function syncControlsFromState() {
  $('#search').value = state.search;
  const sel = $('#sectorFilter');
  sel.value = state.sector;
  state.sector = sel.value;
  // Drop any compared tickers from the URL that aren't real holdings.
  const valid = new Set(state.holdings.holdings.map((h) => h.ticker));
  state.compare = state.compare.filter((t) => valid.has(t));
  renderTable();
  renderCompare();
  syncUrl();
}

// Open a holding's row and bring it into view — used by the movers chips.
function focusHolding(tk) {
  if (!tk) return;
  state.open.add(tk);
  if (!visibleHoldings().some((h) => h.ticker === tk)) {
    state.search = '';
    state.sector = '';
    $('#search').value = '';
    $('#sectorFilter').value = '';
  }
  renderTable();
  syncUrl();
  const row = document.querySelector(`tr.row[data-tk="${CSS.escape(tk)}"]`);
  if (row) {
    row.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center',
    });
    row.focus({ preventScroll: true });
  }
}

async function copyShareLink() {
  const btn = $('#shareBtn');
  const done = (msg) => {
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = 'Copy link'; }, 1600);
  };
  try {
    await navigator.clipboard.writeText(location.href);
    done('Copied!');
  } catch {
    done('Copy failed');
  }
}

/* ---------- theme ---------- */
// The theme is applied before first paint by an inline script in index.html;
// these helpers only keep the toggle button and stored preference in sync.
function syncThemeButton() {
  const light = document.documentElement.dataset.theme === 'light';
  const btn = $('#themeBtn');
  btn.textContent = light ? 'Dark mode' : 'Light mode';
  btn.setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} mode`);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('qqqq-theme', next);
  } catch { /* preference just won't persist */ }
  syncThemeButton();
}

/* ---------- events ---------- */
function sortBy(key) {
  if (!key) return;
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sort.key = key;
    state.sort.dir = ['ticker', 'name', 'sector'].includes(key) ? 'asc' : 'desc';
  }
  renderTable();
  syncUrl();
}

function toggleRow(tk) {
  if (!tk) return;
  if (state.open.has(tk)) state.open.delete(tk);
  else state.open.add(tk);
  renderTable();
  syncUrl();
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Export the currently filtered/sorted holdings, including monthly allocations.
function exportCsv() {
  const rows = visibleHoldings();
  const months = state.monthly.months;
  const header = ['Rank', 'Ticker', 'Company', 'Sector', 'Weight %', 'Price',
    'Day Change %', 'MoM Delta (pp)', 'Market Cap', 'P/E', '52W High', '52W Low',
    ...months.map((m) => 'Alloc ' + m)];
  const lines = [header];
  for (const h of rows) {
    const series = monthSeries(h.ticker);
    lines.push([h.rank, h.ticker, h.name, h.sector, h.weight, h.price,
      h.changePct, momDelta(h.ticker),
      h.marketCap ?? '', h.pe ?? '', h.yearHigh ?? '', h.yearLow ?? '',
      ...series]);
  }
  const csv = lines.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `qqqq-holdings-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function wireEvents() {
  document.querySelectorAll('#holdingsTable thead th').forEach((th) => {
    th.tabIndex = 0;
    th.setAttribute('aria-sort', 'none');
    th.addEventListener('click', () => sortBy(th.dataset.sort));
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(th.dataset.sort); }
    });
  });

  const body = $('#holdingsBody');
  body.addEventListener('click', (e) => {
    const row = e.target.closest('tr.row');
    if (row) toggleRow(row.dataset.tk);
  });
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('tr.row');
    if (row) { e.preventDefault(); toggleRow(row.dataset.tk); }
  });

  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderTable();
    syncUrl();
  });
  $('#sectorFilter').addEventListener('change', (e) => {
    state.sector = e.target.value;
    renderTable();
    syncUrl();
  });
  $('#autoRefresh').addEventListener('change', (e) => {
    state.auto = e.target.checked;
    state.countdown = REFRESH_SECONDS;
    renderStatus();
  });
  $('#refreshBtn').addEventListener('click', manualRefresh);
  $('#exportBtn').addEventListener('click', exportCsv);
  $('#shareBtn').addEventListener('click', copyShareLink);
  $('#themeBtn').addEventListener('click', toggleTheme);

  $('#movers').addEventListener('click', (e) => {
    const chip = e.target.closest('.mover');
    if (chip) focusHolding(chip.dataset.tk);
  });

  $('#compareAdd').addEventListener('change', (e) => {
    const tk = e.target.value;
    e.target.value = '';
    if (tk && !state.compare.includes(tk) && state.compare.length < MAX_COMPARE) {
      state.compare.push(tk);
      renderCompare();
      syncUrl();
    }
  });
  $('#compareChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.cmp-chip');
    if (!chip) return;
    state.compare = state.compare.filter((t) => t !== chip.dataset.tk);
    renderCompare();
    syncUrl();
  });

  $('#weightTicker').addEventListener('change', (e) => {
    state.weightChart.ticker = e.target.value;
    renderWeightHistory();
  });
  $('#weightWindow').addEventListener('change', (e) => {
    state.weightChart.months = Number(e.target.value) || 12;
    renderWeightHistory();
  });

  // Press "/" anywhere outside a field to jump to the holdings filter.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
    e.preventDefault();
    $('#search').focus();
  });
}

function startClock() {
  setInterval(() => {
    if (!state.auto || state.busy) return;
    state.countdown -= 1;
    if (state.countdown <= 0) {
      state.countdown = REFRESH_SECONDS;
      loadData().catch((err) => console.error(err));
    } else {
      renderStatus();
    }
  }, 1000);
}

/* ---------- boot ---------- */
(async function init() {
  wireEvents();
  syncThemeButton();
  restoreFromUrl();
  try {
    await loadData();
  } catch (err) {
    document.querySelector('.app').insertAdjacentHTML(
      'afterbegin',
      `<p class="empty">Could not load holdings data. Run <code>npm run refresh</code> ` +
      `or check that <code>data/holdings.json</code> exists.</p>`
    );
    console.error(err);
    return;
  }
  syncControlsFromState();
  startClock();
  pollQuotes();
  quoteTimer = setInterval(pollQuotes, QUOTE_POLL_SECONDS * 1000);
})();
