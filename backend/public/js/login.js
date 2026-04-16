'use strict';
document.getElementById('form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('btn');
  const err = document.getElementById('err');
  btn.disabled = true; err.classList.remove('on');
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('u').value.trim(), password: document.getElementById('p').value })
    });
    const d = await r.json();
    if (r.ok) { window.location.href = '/'; }
    else { err.textContent = d.error || 'Errore'; err.classList.add('on'); }
  } catch { err.textContent = 'Errore di rete'; err.classList.add('on'); }
  finally { btn.disabled = false; }
});
