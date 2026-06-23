function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1_000_000) reject(new Error('Body too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
function makeId() { return Math.random().toString(16).slice(2) + Date.now().toString(16); }
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  try {
    const payload = JSON.parse(await readBody(req));
    if (!process.env.ADMIN_PASSWORD || payload.password !== process.env.ADMIN_PASSWORD) return json(res, 401, { error: 'Invalid admin password' });
    const repo = process.env.GITHUB_REPO;
    const token = process.env.GITHUB_TOKEN;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const path = process.env.GITHUB_DATA_PATH || 'price-watch-pakistan/price-watch-pakistan/data/manual-prices.json';
    if (!repo || !token) return json(res, 500, { error: 'Missing GITHUB_REPO or GITHUB_TOKEN environment variable' });
    const row = {
      id: makeId(),
      good: String(payload.good || '').trim(),
      urdu: String(payload.urdu || '').trim(),
      category: String(payload.category || '').trim(),
      unit: String(payload.unit || 'kg').trim(),
      price: Number(payload.price),
      date: String(payload.date || '').trim(),
      sourceType: 'government',
      sourceName: 'Government of Punjab Official Rate List',
      sourceUrl: 'https://lahore.punjab.gov.pk/market_rates',
      sourceDocument: 'Admin-entered official rate list',
      note: String(payload.note || 'Admin-entered official Government rate-list value').trim()
    };
    if (!row.good || !row.category || !row.date || !Number.isFinite(row.price)) return json(res, 400, { error: 'Missing required fields' });
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'price-watch-pakistan-admin' };
    const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(branch)}`;
    const current = await fetch(url, { headers });
    let sha = null, arr = [];
    if (current.ok) {
      const file = await current.json();
      sha = file.sha;
      arr = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8') || '[]');
      if (!Array.isArray(arr)) arr = [];
    } else if (current.status !== 404) {
      return json(res, 500, { error: 'Could not read GitHub data file' });
    }
    arr.push(row);
    const content = Buffer.from(JSON.stringify(arr, null, 2) + '\n').toString('base64');
    const save = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ message: `Add official price: ${row.good} ${row.date}`, content, sha, branch })
    });
    if (!save.ok) return json(res, 500, { error: 'Could not save to GitHub' });
    return json(res, 200, { ok: true, row });
  } catch (err) { return json(res, 500, { error: err.message || 'Server error' }); }
}
