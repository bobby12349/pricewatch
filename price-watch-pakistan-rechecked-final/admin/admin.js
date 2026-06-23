const form = document.getElementById('adminForm');
const statusEl = document.getElementById('status');
function setStatus(msg, bad=false){ statusEl.className = `notice ${bad ? 'danger' : ''}`; statusEl.textContent = msg; }
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  data.price = Number(data.price);
  setStatus('Saving...');
  try {
    const res = await fetch('/api/admin/prices', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(data) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    setStatus('Saved to GitHub. Vercel should redeploy automatically from the commit.');
    form.reset();
  } catch (err) { setStatus(err.message || 'Could not save.', true); }
});
