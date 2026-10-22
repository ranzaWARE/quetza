// Schermate della guida: guida l'app vera (server locale con DB vuoto e
// Whisper finto) con Playwright e salva i PNG in $WORK/out. Lanciato da make.sh.
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:3300';
const WORK = process.env.WORK;
const J = f => JSON.parse(fs.readFileSync(path.join(WORK, f)));
const RI = J('strokes-riunione.json'), CO = J('strokes-collaudo.json'), ST = J('strokes-stand.json');
const shot = (p, name, clip) => p.screenshot({ path: path.join(WORK, 'out', `${name}.png`), ...(clip ? { clip, fullPage: true } : {}) });

async function cmap(p) {
  const c = await p.evaluate(() => { const r = document.getElementById('C').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; });
  return { ...c, k: c.w / 794 };
}
async function pen(p, m, strokes, dx = 0, dy = 0, delay = 0) {
  for (const s of strokes) {
    const pt = q => [m.x + (q.x + dx) * m.k, m.y + (q.y + dy) * m.k];
    await p.mouse.move(...pt(s[0])); await p.mouse.down();
    for (const q of s.slice(1)) await p.mouse.move(...pt(q));
    await p.mouse.up();
    if (delay) await p.waitForTimeout(delay);
  }
}
async function drag(p, m, a, b) {
  await p.mouse.move(m.x + a[0] * m.k, m.y + a[1] * m.k); await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(m.x + (a[0] + (b[0] - a[0]) * i / 8) * m.k, m.y + (a[1] + (b[1] - a[1]) * i / 8) * m.k);
  await p.mouse.up();
}
const tool = (p, t) => p.click(`[data-t="${t}"]`);
const color = (p, sel) => p.click(sel);
async function newNote(p, title) {
  await p.click('#newB'); await p.waitForTimeout(1000);
  await p.click('#NTT'); await p.keyboard.press('Control+A'); await p.keyboard.type(title); await p.keyboard.press('Tab');
  return cmap(p);
}
async function saveBack(p) {
  await p.click('#SVB'); await p.waitForTimeout(800);
  await p.click('#BACKB'); await p.waitForTimeout(1000);
}

(async () => {
  fs.mkdirSync(path.join(WORK, 'out'), { recursive: true });
  const b = await chromium.launch({ args: ['--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') console.log('console:', m.text()); });
  p.on('dialog', d => d.accept());

  await p.goto(BASE + '/login.html'); await p.waitForTimeout(400);
  await shot(p, 'login');
  await p.fill('#u', 'admin'); await p.fill('#p', 'admin'); await p.click('#btn');
  await p.waitForTimeout(1200);
  await shot(p, 'cambio-password');
  await p.fill('#_cpw_old', 'admin'); await p.fill('#_cpw_new', 'Password123!'); await p.fill('#_cpw_new2', 'Password123!'); await p.click('#_cpw_ok');
  await p.waitForTimeout(800);

  // Nota 1: collaudo (checklist)
  let m = await newNote(p, 'Collaudo linea 3');
  await pen(p, m, CO[0]);
  for (let i = 0; i < 4; i++) { await tool(p, 'rect'); await drag(p, m, [80, 160 + i * 70], [110, 190 + i * 70]); }
  await tool(p, 'pen'); await color(p, '#SW_BK');
  // spunte sulle prime tre
  for (let i = 0; i < 3; i++) await pen(p, m, [[{ x: 84, y: 175 + i * 70 }, { x: 93, y: 186 + i * 70 }, { x: 116, y: 152 + i * 70 }]]);
  await pen(p, m, CO[1]);
  await saveBack(p);

  // Nota 2: schema stand (forme, frecce, testo)
  m = await newNote(p, 'Schema stand fiera');
  await pen(p, m, ST[0]);
  await tool(p, 'rect'); await drag(p, m, [90, 180], [700, 640]);
  await tool(p, 'rect'); await drag(p, m, [380, 300], [620, 450]);
  await tool(p, 'ellipse'); await drag(p, m, [130, 470], [260, 590]);
  await tool(p, 'pen');
  await pen(p, m, ST[2], 395, 255); await pen(p, m, ST[3], 165, 520); await pen(p, m, ST[1], 330, 690);
  await p.click('.sw[data-c]:nth-of-type(2)').catch(() => {});
  await tool(p, 'arrow'); await drag(p, m, [400, 700], [400, 650]);
  await tool(p, 'pen');
  await shot(p, 'forme');
  await saveBack(p);

  // Nota 3: riunione con registrazione
  m = await newNote(p, 'Riunione progetto');
  await p.click('#AUDIOTOGGLE'); await p.waitForTimeout(300);
  await p.click('#RCB'); await p.waitForTimeout(700);
  await tool(p, 'pen');
  await pen(p, m, RI[0], 0, 0, 20);
  await p.waitForTimeout(500);
  await pen(p, m, RI[1], 0, 0, 15);
  await shot(p, 'registrazione');
  await p.click('#RCB'); await p.waitForTimeout(3500);
  await p.click('#SVB'); await p.waitForTimeout(1000);

  // riascolto: salto a metà della forma d'onda
  const wv = await p.locator('#PW').boundingBox();
  await p.mouse.click(wv.x + wv.width * 0.5, wv.y + wv.height / 2); await p.waitForTimeout(800);
  await shot(p, 'riascolto');

  await p.click('#TRANSCB'); await p.waitForTimeout(1500);
  await shot(p, 'trascrizione');
  await p.click('#TRANSCB').catch(() => {}); await p.waitForTimeout(300);

  // colleghi con cui condividere
  const api = (url, method, body) => p.evaluate(([u, m, b]) => fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.ok), [url, method, body]);
  await api('/api/admin/users', 'POST', { username: 'giulia', password: 'Password123!', displayName: 'Giulia Verdi' });
  await api('/api/admin/users', 'POST', { username: 'marco', password: 'Password123!', displayName: 'Marco Neri' });

  await p.click('#SHAREB'); await p.waitForTimeout(600);
  await p.fill('#COLLIN', 'giulia'); await p.selectOption('#COLLPERM', 'write'); await p.click('#COLLADD'); await p.waitForTimeout(500);
  await p.fill('#COLLIN', 'marco'); await p.selectOption('#COLLPERM', 'read'); await p.click('#COLLADD'); await p.waitForTimeout(500);
  await p.click('#SHARECREB'); await p.waitForTimeout(800);
  await shot(p, 'condividi', await p.locator('#SHAREM .MD').boundingBox());
  await p.click('#SHARECANCB').catch(() => {}); await p.waitForTimeout(300);
  await p.click('#BACKB'); await p.waitForTimeout(1200);

  // una nota che Giulia condivide con l'admin, per «Condivise con me»
  const g = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await g.goto(BASE + '/login.html'); await g.fill('#u', 'giulia'); await g.fill('#p', 'Password123!'); await g.click('#btn');
  await g.waitForSelector('#newB');
  m = await newNote(g, 'Ordini fornitori'); await pen(g, m, CO[1]); await g.click('#SVB'); await g.waitForTimeout(800);
  await g.evaluate(() => fetch(`/api/notes/${S.curId}/access/admin`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ perm: 'read' }) }));
  await g.context().close();

  // etichette
  const ids = await p.evaluate(() => Object.fromEntries(S.notes.map(n => [n.title, n.id])));
  for (const [t, tags] of [['Collaudo linea 3', ['Produzione']], ['Schema stand fiera', ['Fiere']], ['Riunione progetto', ['Clienti', 'Progetti']]])
    await api(`/api/notes/${ids[t]}`, 'PATCH', { tags });
  await p.evaluate(() => loadNotes()); await p.waitForTimeout(800);

  await shot(p, 'libreria');
  await p.fill('#SRCH', 'preventivi'); await p.waitForTimeout(1200);
  await shot(p, 'ricerca');
  await p.fill('#SRCH', ''); await p.waitForTimeout(500);

  // tema scuro
  await p.click('.dkToggle'); await p.waitForTimeout(400);
  await shot(p, 'libreria-scuro');
  await p.click('.noteGrid >> text=Riunione progetto'); await p.waitForTimeout(1500);
  await shot(p, 'editor-scuro');
  await p.click('#BACKB'); await p.waitForTimeout(800);
  await p.click('.dkToggle'); await p.click('.dkToggle'); await p.waitForTimeout(300); // eink -> chiaro

  // amministrazione: un limite di spazio per far vedere la colonna
  await api('/api/admin/settings', 'POST', { storage_quota_mb: 500 });
  await api('/api/admin/users/giulia/quota', 'PUT', { quotaMb: 2000 });
  await p.goto(BASE + '/admin'); await p.waitForTimeout(1200);
  await shot(p, 'admin');
  await shot(p, 'admin-spazio', await p.locator('.card', { has: p.locator('#perUserTbody') }).boundingBox());
  for (const [t, n] of [['SSO / OIDC', 'admin-sso'], ['LDAP / AD', 'admin-ldap'], ['Whisper', 'admin-whisper'], ['Backup & Migrazione', 'admin-backup']]) {
    const loc = p.locator('button').filter({ hasText: t }).first();
    if (!(await loc.count())) { console.log('tab mancante', t); continue; }
    await loc.click(); await p.waitForTimeout(600);
    if (n === 'admin-backup') {
      // backup vero, con la copia esterna; nel testo i percorsi del container
      await p.click('#backupNowB'); await p.waitForTimeout(3000);
      await p.evaluate(w => { const e = document.getElementById('backupStatus'); e.innerHTML = e.innerHTML.split(w).join(''); }, WORK);
    }
    await shot(p, n);
  }
  await b.close();
})();
