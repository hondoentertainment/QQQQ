'use strict';

const REFRESH_SECONDS = 60;
const COLS = 9;

const QUOTE_POLL_SECONDS = 20;
const MOVERS_PER_SIDE = 5;

// Sort keys accepted from the table headers and the shareable URL.
const SORT_KEYS = new Set(
  ['rank', 'ticker', 'name', 'sector', 'weight', 'price', 'changePct', 'mom']
);

const state = {
  holdings: null,
  monthly: null,
  changes: null,
  sort: { key: 'weight', dir: 'desc' },
  search: '',
  sector: '',
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
  if (pts.length < 2) return `<svg class="spark" width="${W}" height="${H}"></svg>`;
  const vals = pts.map((p) => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => P + (i / (values.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const trend = vals[vals.length - 1] - vals[0];
  const color = trend > 0 ? 'var(--up)' : trend < 0 ? 'var(--down)' : 'var(--muted)';
  const last = pts[pts.length - 1];
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
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
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
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
    'invesco-cached': ['CACHED', 'cached'],
    'fmp-cached': ['CACHED', 'cached'],
    seed: ['SAMPLE DATA', 'seed'],
  };
  const [label, cls] = map[d.source] || ['DATA', 'cached'];
  badge.textContent = label;
  badge.className = 'src-badge ' + cls;
  const live = state.liveQuotes === true
    ? ` <span class="live-tag">&middot; live prices ${relTime(state.livePricesAt)}</span>`
    : '';
  $('#asOf').innerHTML = `<span class="dot"></span>as of ${relTime(d.asOf)} ` +
    `(${new Date(d.asOf).toLocaleString()})${live}`;
  $('#fundName').textContent = `${d.name} · ${d.count} holdings`;
  const auto = state.auto ? ` · next in ${state.countdown}s` : ' · paused';
  $('#autoLabel').textContent = 'Auto-refresh' + auto;
  $('#footerStatus').textContent = state.auto
    ? `auto-refreshing every ${REFRESH_SECONDS}s in this view.`
    : 'auto-refresh paused.';
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
          <td class="num">${h.rank}</td>
          <td class="tk"><span class="caret">▸</span>${h.ticker}</td>
          <td class="co-name" title="${escapeHtml(h.name)}">${escapeHtml(h.name)}</td>
          <td class="sector-tag">${escapeHtml(h.sector)}</td>
          <td class="num weight-cell">
            <div class="weight-bar" style="width:${(h.weight / maxW) * 100}%"></div>
            <span>${h.weight.toFixed(2)}</span>
          </td>
          <td class="num">${fmtPrice(h.price)}</td>
          <td class="num ${classOf(h.changePct)}">${fmtSigned(h.changePct)}</td>
          <td class="num ${classOf(mom)}">${fmtSigned(mom, 2, ' pp')}</td>
          <td>${sparkline(monthSeries(h.ticker))}</td>
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

function render() {
  renderStatus();
  renderCards();
  renderChanges();
  renderMovers();
  renderTable();
  renderSectors();
}

/* ---------- data loading ---------- */
async function loadData() {
  const bust = '?t=' + Date.now();
  const [h, m, c] = await Promise.all([
    fetch('data/holdings.json' + bust).then((r) => r.json()),
    fetch('data/monthly-allocations.json' + bust).then((r) => r.json()),
    fetch('data/changes.json' + bust).then((r) => r.json()).catch(() => ({ events: [] })),
  ]);
  h.holdings.forEach((row, i) => { row.rank = i + 1; });
  // populate sector filter once
  if (!state.holdings) {
    const sectors = [...new Set(h.holdings.map((x) => x.sector))].sort();
    const sel = $('#sectorFilter');
    sectors.forEach((s) => {
      const o = document.createElement('option');
      o.value = o.textContent = s;
      sel.appendChild(o);
    });
  }
  state.holdings = h;
  state.monthly = m;
  state.changes = c;
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
      if (q) { row.price = q.price; row.changePct = q.changePct; n++; }
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
  } catch (err) {
    console.error('refresh failed', err);
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
}

// Reflect restored state into the controls once the data (and so the sector
// list) is loaded; drops a `sector` value that isn't a real option.
function syncControlsFromState() {
  $('#search').value = state.search;
  const sel = $('#sectorFilter');
  sel.value = state.sector;
  state.sector = sel.value;
  renderTable();
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
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    'Day Change %', 'MoM Delta (pp)', ...months.map((m) => 'Alloc ' + m)];
  const lines = [header];
  for (const h of rows) {
    const series = monthSeries(h.ticker);
    lines.push([h.rank, h.ticker, h.name, h.sector, h.weight, h.price,
      h.changePct, momDelta(h.ticker), ...series]);
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

  $('#movers').addEventListener('click', (e) => {
    const chip = e.target.closest('.mover');
    if (chip) focusHolding(chip.dataset.tk);
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
