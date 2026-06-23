const state = { rows: [], grouped: [], filtered: [], selected: null, category: 'All', query: '' };

const CORE_GOODS = [
  'Atta / Wheat Flour', 'Petrol', 'Diesel', 'Milk', 'Chicken Meat', 'Eggs',
  'Sugar', 'Cooking Oil', 'Ghee', 'Basmati Rice', 'Potatoes', 'Onions',
  'Tomatoes', 'Mango Sindhri', 'Bananas', 'Cement'
];
const CATEGORY_ORDER = ['All', 'Staples', 'Fuel', 'Meat & Dairy', 'Vegetables', 'Fruits', 'Household', 'Misc'];
const CATEGORY_ALIAS = { 'Flour, Rice & Pulses': 'Staples', 'Oil, Sugar & Staples': 'Staples', 'Fuel & Energy': 'Fuel', 'Meat, Dairy & Eggs': 'Meat & Dairy', 'Essential Commodities': 'Staples', 'Poultry': 'Meat & Dairy', 'Utilities': 'Misc' };
const PRIORITY = new Map(CORE_GOODS.map((g, i) => [g, i + 1]));

const fmtRs = (n) => `Rs. ${Number(n).toLocaleString('en-PK', { maximumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2 })}`;
const niceDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const cssChange = (v) => v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
const pctText = (v) => {
  if (!Number.isFinite(v)) return '—';
  const decimals = Math.abs(v) < 1 && v !== 0 ? 2 : 1;
  return `${v > 0 ? '+' : ''}${v.toFixed(decimals)}%`;
};
const unitLabel = (unit) => ({ kg: 'Per kg', litre: 'Per litre', piece: 'Per piece', dozen: 'Per dozen', crate: 'Per crate', '50kg bag': 'Per 50 kg bag', '11.67 kg cylinder': 'Per cylinder', unit: 'Per unit', '200g packet': 'Per 200g', '390g pack': 'Per 390g', '800g packet': 'Per 800g', '250g cake': 'Per 250g', '115g cake': 'Per 115g', '40kg bundle': 'Per 40kg bundle', MMBTU: 'Per MMBTU' }[unit] || unit);

function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function extractUrdu(note='') { const match = String(note).match(/Urdu item:\s*([^\.]+)/i); return match ? match[1].trim() : ''; }
function categoryOf(cat) { return CATEGORY_ALIAS[cat] || cat || 'Misc'; }
function normaliseRow(r) {
  const good = r.good || r.item || 'Unknown';
  return {
    id: r.id || `${r.date}-${slugify(good)}-${Math.random().toString(16).slice(2)}`,
    good,
    urdu: r.urdu || extractUrdu(r.note),
    category: categoryOf(r.category),
    unit: r.unit || 'unit',
    price: Number(r.price),
    date: r.date,
    sourceType: r.sourceType || 'verified',
    sourceName: r.sourceName || 'Verified source',
    sourceUrl: r.sourceUrl || '',
    priority: Number(r.priority || PRIORITY.get(good) || 500)
  };
}

async function loadData() {
  const [official, manual] = await Promise.all([
    fetch('/data/price-history.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
    fetch('/data/manual-prices.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : []).catch(() => [])
  ]);
  state.rows = [...official, ...manual]
    .map(normaliseRow)
    .filter(r => r.good && r.date && Number.isFinite(r.price));
  buildGroups();
  renderAll();
}

function buildGroups() {
  const map = new Map();
  for (const row of state.rows) {
    const key = `${row.good}__${row.unit}`;
    if (!map.has(key)) map.set(key, { key, good: row.good, urdu: row.urdu, unit: row.unit, category: row.category, priority: row.priority, history: [] });
    const group = map.get(key);
    if (!group.urdu && row.urdu) group.urdu = row.urdu;
    group.category = row.category || group.category;
    group.priority = Math.min(group.priority || 500, row.priority || 500);
    group.history.push(row);
  }
  state.grouped = [...map.values()].map(g => {
    g.history.sort((a,b) => a.date.localeCompare(b.date));
    g.latest = g.history[g.history.length - 1];
    g.previous = g.history.length > 1 ? g.history[g.history.length - 2] : null;
    g.change = g.previous ? g.latest.price - g.previous.price : 0;
    g.changePct = g.previous && g.previous.price ? (g.change / g.previous.price) * 100 : 0;
    return g;
  }).sort(compareGoods);
  state.selected = state.grouped.find(g => PRIORITY.has(g.good)) || state.grouped[0] || null;
}

function compareGoods(a, b) {
  const pa = a.priority || PRIORITY.get(a.good) || 500;
  const pb = b.priority || PRIORITY.get(b.good) || 500;
  if (pa !== pb) return pa - pb;
  const ca = CATEGORY_ORDER.indexOf(a.category), cb = CATEGORY_ORDER.indexOf(b.category);
  if (ca !== cb) return (ca < 0 ? 99 : ca) - (cb < 0 ? 99 : cb);
  if (a.latest.date !== b.latest.date) return b.latest.date.localeCompare(a.latest.date);
  return a.good.localeCompare(b.good);
}

function applyFilters() {
  const q = state.query.trim().toLowerCase();
  state.filtered = state.grouped.filter(g => {
    const catOk = state.category === 'All' || g.category === state.category;
    const qOk = !q || `${g.good} ${g.urdu || ''} ${g.category}`.toLowerCase().includes(q);
    return catOk && qOk;
  }).sort(compareGoods);
}

function renderAll() { applyFilters(); renderCategories(); renderCards(); renderCoreBasket(); renderTable(); renderDetail(state.selected); }

function renderCategories() {
  const available = new Set(state.grouped.map(g => g.category));
  const cats = ['All', ...CATEGORY_ORDER.slice(1).filter(c => available.has(c)), ...[...available].filter(c => !CATEGORY_ORDER.includes(c)).sort()];
  document.getElementById('categoryFilters').innerHTML = cats.map(cat => `<button class="chip ${cat === state.category ? 'active' : ''}" data-cat="${cat}">${cat}</button>`).join('');
  document.querySelectorAll('.chip').forEach(btn => btn.addEventListener('click', () => { state.category = btn.dataset.cat; renderAll(); }));
}

function renderCards() {
  const changed = state.grouped.filter(g => g.previous);
  const latestDate = state.rows.reduce((m,r) => r.date > m ? r.date : m, '');
  const core = state.grouped.filter(g => CORE_GOODS.includes(g.good) && g.previous);
  const latestTotal = core.reduce((s,g) => s + Number(g.latest.price || 0), 0);
  const previousTotal = core.reduce((s,g) => s + Number(g.previous.price || 0), 0);
  const basketDelta = latestTotal - previousTotal;
  const basketChange = previousTotal ? (basketDelta / previousTotal) * 100 : 0;
  const basketSub = previousTotal
    ? `${fmtRs(Math.abs(basketDelta))} ${basketDelta > 0 ? 'higher' : basketDelta < 0 ? 'lower' : 'no net change'} across ${core.length} key goods`
    : 'Not enough history yet';
  const upCount = changed.filter(g => g.change > 0).length;
  const downCount = changed.filter(g => g.change < 0).length;
  const biggestMover = [...changed].sort((a,b) => Math.abs(b.changePct) - Math.abs(a.changePct))[0];
  const cards = [
    { label: 'Core basket change', value: pctText(basketChange), cls: cssChange(basketChange), sub: basketSub },
    { label: 'Most moved item', value: biggestMover ? pctText(biggestMover.changePct) : '—', cls: biggestMover ? cssChange(biggestMover.changePct) : '', sub: biggestMover ? biggestMover.good : 'No movement yet' },
    { label: 'Prices rising', value: upCount, cls: 'up', sub: `${downCount} lower than previous entry` },
    { label: 'Latest update', value: latestDate ? niceDate(latestDate) : '—', sub: 'Most recent price date' }
  ];
  document.getElementById('cards').innerHTML = cards.map(c => `<article class="card"><p>${c.label}</p><strong class="${c.cls || ''}">${c.value}</strong><small>${c.sub}</small></article>`).join('');
  const heroDate = document.getElementById('heroDate');
  if (heroDate) heroDate.textContent = latestDate ? niceDate(latestDate) : '—';
}

function renderCoreBasket() {
  const groups = CORE_GOODS.map(name => state.grouped.find(g => g.good === name)).filter(Boolean);
  document.getElementById('coreBasket').innerHTML = groups.map(g => `
    <button class="core-item" data-key="${g.key}">
      <span>${g.good}</span>
      <strong>${fmtRs(g.latest.price)}</strong>
      <small>${unitLabel(g.unit)} · <em class="${cssChange(g.change)}">${g.previous ? pctText(g.changePct) : 'New'}</em></small>
    </button>`).join('');
  document.querySelectorAll('.core-item').forEach(btn => btn.addEventListener('click', () => {
    state.selected = state.grouped.find(g => g.key === btn.dataset.key);
    renderDetail(state.selected);
    document.querySelector('.detail-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));
}

function renderTable() {
  document.getElementById('resultCount').textContent = `${state.filtered.length} goods shown`;
  const tbody = document.getElementById('priceRows');
  if (!state.filtered.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty">No matching prices.</td></tr>`; return; }
  tbody.innerHTML = state.filtered.map(g => `
    <tr data-key="${g.key}">
      <td><span class="good">${g.good}</span>${g.urdu ? `<span class="urdu" dir="rtl">${g.urdu}</span>` : ''}</td>
      <td><span class="badge">${g.category}</span></td>
      <td>${unitLabel(g.unit)}</td>
      <td class="price">${fmtRs(g.latest.price)}</td>
      <td class="${cssChange(g.change)}">${g.previous ? `${g.change > 0 ? '+' : ''}${fmtRs(g.change)} (${pctText(g.changePct)})` : 'New'}</td>
      <td>${sparkline(g.history, 112, 36)}</td>
    </tr>`).join('');
  tbody.querySelectorAll('tr[data-key]').forEach(tr => tr.addEventListener('click', () => {
    state.selected = state.grouped.find(g => g.key === tr.dataset.key);
    renderDetail(state.selected);
  }));
}

function pointsFor(history, w, h, pad=4) {
  const vals = history.map(r => Number(r.price));
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  return vals.map((v,i) => {
    const x = pad + (history.length === 1 ? (w - pad*2) / 2 : i * (w - pad*2) / (history.length - 1));
    const y = h - pad - ((v - min) / span) * (h - pad*2);
    return [x,y];
  });
}
function sparkline(history, w=112, h=36) {
  const pts = pointsFor(history, w, h);
  const d = pts.map((p,i) => `${i?'L':'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const stroke = history.length > 1 && history.at(-1).price > history[0].price ? 'var(--red)' : 'var(--green-2)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Price trend"><path d="${d}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${pts.at(-1)[0]}" cy="${pts.at(-1)[1]}" r="3.5" fill="${stroke}"/></svg>`;
}
function bigChart(history) {
  const w = 620, h = 260, pad = 34;
  const pts = pointsFor(history, w, h, pad);
  const vals = history.map(r => r.price);
  const min = Math.min(...vals), max = Math.max(...vals);
  const d = pts.map((p,i) => `${i?'L':'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const circles = pts.map((p,i) => `<circle cx="${p[0]}" cy="${p[1]}" r="5"><title>${niceDate(history[i].date)} — ${fmtRs(history[i].price)}</title></circle>`).join('');
  const labels = history.map((r,i) => `<text x="${pts[i][0]}" y="248" text-anchor="middle">${r.date.slice(5).replace('-', '/')}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Historical price chart">
    <line x1="${pad}" x2="${w-pad}" y1="${h-pad}" y2="${h-pad}" />
    <line x1="${pad}" x2="${pad}" y1="${pad}" y2="${h-pad}" />
    <text x="${pad}" y="24">${fmtRs(max)}</text><text x="${pad}" y="226">${fmtRs(min)}</text>
    <path d="${d}"/><g>${circles}</g><g class="xlabels">${labels}</g>
  </svg>`;
}

function renderDetail(g) {
  if (!g) { document.getElementById('detail').innerHTML = '<p class="empty">Select a good to view its trend.</p>'; return; }
  document.getElementById('detail').innerHTML = `
    <div class="detail-title"><div><h2>${g.good}</h2>${g.urdu ? `<p class="urdu" dir="rtl">${g.urdu}</p>` : ''}</div><span class="badge">${g.category}</span></div>
    <div class="big-price">${fmtRs(g.latest.price)}</div>
    <div class="muted-line">${unitLabel(g.unit)}</div>
    <div class="change-line ${cssChange(g.change)}">${g.previous ? `${g.change > 0 ? '+' : ''}${fmtRs(g.change)} (${pctText(g.changePct)}) versus previous entry` : 'First entry in current data'}</div>
    ${bigChart(g.history)}
    <div class="meta-list">
      <div class="meta-row"><span>Latest date</span><strong>${niceDate(g.latest.date)}</strong></div>
      <div class="meta-row"><span>Previous price</span><strong>${g.previous ? `${fmtRs(g.previous.price)} on ${niceDate(g.previous.date)}` : '—'}</strong></div>
      <div class="meta-row"><span>Data points</span><strong>${g.history.length}</strong></div>
    </div>`;
}

document.getElementById('searchInput').addEventListener('input', (e) => { state.query = e.target.value; renderAll(); });
loadData().catch(err => {
  console.error(err);
  document.getElementById('priceRows').innerHTML = `<tr><td colspan="6" class="empty">Could not load price data.</td></tr>`;
});
