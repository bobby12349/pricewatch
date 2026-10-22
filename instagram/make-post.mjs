// Builds the weekly Instagram carousel (3 slides, 1080x1350) + caption from the
// latest PBS week in the site's price data. Output: instagram/latest/
//   node make-post.mjs            (needs Chrome: set CHROME_PATH, or /usr/bin/google-chrome)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '../price-watch-pakistan-rechecked-final/data/price-history.json');
const OUT = path.join(here, 'latest');

// Display names + Urdu for the PBS goods
const NAMES = {
  'Atta / Wheat Flour': ['Atta', 'آٹا'], 'Petrol': ['Petrol', 'پیٹرول'], 'Diesel': ['Diesel', 'ڈیزل'],
  'Milk': ['Milk', 'دودھ'], 'Chicken Broiler Live': ['Chicken (live)', 'برائلر مرغی'], 'Eggs': ['Eggs', 'انڈے'],
  'Sugar': ['Sugar', 'چینی'], 'Cooking Oil': ['Cooking oil', 'کوکنگ آئل'], 'Ghee': ['Ghee', 'گھی'],
  'Ghee Tin': ['Ghee (tin)', 'گھی ٹن'], 'Basmati Rice Broken': ['Basmati rice', 'باسمتی چاول'],
  'Rice IRRI': ['IRRI rice', 'اری چاول'], 'Potatoes': ['Potatoes', 'آلو'], 'Onions': ['Onions', 'پیاز'],
  'Tomatoes': ['Tomatoes', 'ٹماٹر'], 'Garlic': ['Garlic', 'لہسن'], 'Pulse Gram': ['Pulse Gram', 'دال چنا'],
  'Pulse Masoor': ['Pulse Masoor', 'دال مسور'], 'Pulse Moong': ['Pulse Moong', 'دال مونگ'],
  'Pulse Mash': ['Pulse Mash', 'دال ماش'], 'Mutton': ['Mutton', 'بکرے کا گوشت'],
  'Beef with Bone': ['Beef', 'گائے کا گوشت'], 'Bread': ['Bread', 'ڈبل روٹی'], 'Tea': ['Tea (190g)', 'چائے'],
  'Toilet Soap': ['Bath soap', 'نہانے کا صابن'], 'Washing Soap': ['Washing soap', 'کپڑے دھونے کا صابن'],
  'LPG Cylinder': ['LPG cylinder', 'ایل پی جی'], 'Firewood': ['Firewood', 'لکڑی'],
  'Match Box': ['Matchbox', 'ماچس'], 'Curd / Dahi': ['Dahi', 'دہی'], 'Powdered Milk NIDO': ['Powdered milk', 'خشک دودھ'],
  'Electricity Charges Q1': ['Electricity', 'بجلی'], 'Gas Charges Q1': ['Gas', 'گیس'],
  'Chilies Powder': ['Chilli powder', 'لال مرچ'], 'Gur': ['Gur', 'گڑ'], 'Mustard Oil': ['Mustard oil', 'سرسوں کا تیل'],
  'Salt Powdered': ['Salt', 'نمک'],
  'Bananas': ['Bananas', 'کیلا'],
};

const rows = JSON.parse(fs.readFileSync(DATA, 'utf8')).filter(r => r.sourceName === 'Pakistan Bureau of Statistics');
const dates = [...new Set(rows.map(r => r.date))].sort();
const cur = dates.at(-1), prev = dates.at(-2);
const price = new Map(rows.map(r => [`${r.good}|${r.date}`, r.price]));
const moves = [];
for (const g of new Set(rows.map(r => r.good))) {
  const a = price.get(`${g}|${cur}`), b = price.get(`${g}|${prev}`);
  if (a && b) moves.push({ g, pct: (a / b - 1) * 100, name: (NAMES[g] || [g, ''])[0], ur: (NAMES[g] || [g, ''])[1] });
}
const ups = moves.filter(m => m.pct >= 0.05).sort((x, y) => y.pct - x.pct).slice(0, 5);
const downs = moves.filter(m => m.pct <= -0.05).sort((x, y) => x.pct - y.pct).slice(0, 5);

const fmtPct = p => (p > 0 ? '+' : '−') + Math.abs(p).toFixed(1) + '%';
const d = new Date(cur + 'T00:00:00Z');
const dateUp = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
const day = d.getUTCDate(), sfx = [, 'st', 'nd', 'rd'][day % 10 > 3 || Math.floor(day / 10) === 1 ? 0 : day % 10] || 'th';
const monthLong = d.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });

const hero = ups[0] || downs[0];
const heroUp = hero && hero.pct > 0;
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const rowHtml = list => list.map((m, i) =>
  `<div class="row"><div class="n">${i + 1}</div><div class="nm"><div class="e">${esc(m.name)}</div><div class="ur">${esc(m.ur)}</div></div><div class="p">${fmtPct(m.pct)}</div></div>`).join('\n');
const listSlide = (id, kind, list, n) => `
<section class="slide list ${kind}" id="${id}">
  <div class="top"><div class="d">PRICES UPDATED · ${dateUp}</div><svg width="64" height="64"><use href="#logo"/></svg></div>
  <h2>Top ${list.length} price<br><span class="${kind}">${kind === 'up' ? 'increases' : 'decreases'}</span></h2>
  <div class="sub">Change vs. previous week</div>
  <div class="card">${list.length ? rowHtml(list) : '<div class="row"><div class="nm"><div class="e">No price ' + (kind === 'up' ? 'increases' : 'decreases') + ' this week</div></div></div>'}</div>
  <div class="foot"><span>PriceWatch Pakistan</span><span>${n} / 3</span></div>
</section>`;

const head = fs.readFileSync(path.join(here, 'head.html'), 'utf8');
const logo = fs.readFileSync(path.join(here, 'logo.svg.html'), 'utf8');
const html = `${head}<body>${logo}
<section class="slide cover" id="s1">
  <div class="blob"></div>
  <div class="brand"><svg width="78" height="78"><use href="#logo"/></svg>
    <div><div class="name">PriceWatch Pakistan</div><div class="tag">DAILY PRICE TRACKER</div></div></div>
  <div class="pill"><i></i>PRICES UPDATED · ${dateUp}</div>
  <div class="hero">This week's<br>prices<br><span class="dim">are in.</span></div>
  ${hero ? `<div class="big">
    <div><div class="lab">BIGGEST ${heroUp ? 'INCREASE' : 'DROP'} THIS WEEK</div><div class="nmw"><div class="item">${esc(hero.name)}</div><div class="ur">${esc(hero.ur)}</div></div></div>
    <div class="pct" style="${heroUp ? '' : 'color:#a7f0c4'}">${fmtPct(hero.pct)}</div>
  </div>` : ''}
  <div class="swipe">Swipe for the top movers →</div>
  <div class="dots"><b class="on"></b><b></b><b></b></div>
</section>
${listSlide('s2', 'up', ups, 2)}
${listSlide('s3', 'down', downs, 3)}
</body></html>`;

fs.mkdirSync(OUT, { recursive: true });
const htmlPath = path.join(here, '.post.html');
fs.writeFileSync(htmlPath, html);

const list = (l) => l.slice(0, 3).map(m => `${m.name.replace(/\s*\(.*\)/, '').toLowerCase()} (${fmtPct(m.pct)})`).join(', ');
const caption = `Prices updated as per ${day}${sfx} of ${monthLong} 🧾 ` +
  (ups.length ? `${list(ups)} rose the most this week` : 'No major increases this week') +
  (downs.length ? `, while ${list(downs)} fell.` : '.') +
  ` Full list at pricewatchpk.vercel.app — source: PBS weekly SPI.\n\n#Pakistan #Inflation #Prices #Lahore #Karachi #Islamabad #PriceWatchPK\n`;
fs.writeFileSync(path.join(OUT, 'caption.txt'), caption);

const exe = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 1350 });
await page.goto('file://' + htmlPath, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
for (const i of [1, 2, 3]) await (await page.$('#s' + i)).screenshot({ path: path.join(OUT, `slide${i}.png`) });
await browser.close();
fs.rmSync(htmlPath);
console.log(`Post for ${cur} (vs ${prev}): ${ups.length} up, ${downs.length} down -> ${OUT}`);
