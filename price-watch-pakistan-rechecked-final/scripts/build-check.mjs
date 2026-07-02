import fs from 'node:fs';
import path from 'node:path';
const required = ['index.html', 'app.js', 'styles.css', 'data/price-history.json', 'data/manual-prices.json', 'admin/index.html'];
for (const file of required) {
  if (!fs.existsSync(file)) throw new Error(`Missing required file: ${file}`);
}
const rows = JSON.parse(fs.readFileSync('data/price-history.json', 'utf8'));
if (!Array.isArray(rows) || rows.length < 1) throw new Error('price-history.json has no rows');
const goods = new Set(rows.map(r => `${r.good}|${r.unit}`));
for (const name of ['Atta / Wheat Flour','Petrol','Diesel','Milk','Chicken Meat','Eggs','Mango']) {
  if (!rows.some(r => r.good === name)) throw new Error(`Missing key good: ${name}`);
}
// Create a public copy as a fallback in case Vercel Output Directory is set to public.
const publicDir = 'public';
fs.rmSync(publicDir, { recursive: true, force: true });
fs.mkdirSync(publicDir, { recursive: true });
function copy(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src)) copy(path.join(src,item), path.join(dest,item));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}
for (const item of ['index.html','app.js','styles.css','data','admin']) copy(item, path.join(publicDir,item));
console.log(`Static build check passed: ${rows.length} price rows, ${goods.size} goods. Public fallback created.`);
