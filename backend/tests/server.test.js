// Test di integrazione HTTP contro il vero server.js
// (better-sqlite3 e connect-sqlite3 sono sostituiti da shim: vedi ./shim)
const { check, section, done } = require('./_env');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DBF = path.join(os.tmpdir(), `quetza-srv-test-${process.pid}.db`);
for (const f of [DBF, DBF+'-wal', DBF+'-shm']) { try { fs.unlinkSync(f); } catch {} }

process.env.DB_PATH = DBF;
process.env.PORT = String(3900 + (process.pid % 90));
process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.CERT_PATH = '/non/esiste.crt';   // forza il ramo HTTP puro
process.env.KEY_PATH  = '/non/esiste.key';
process.env.TRUST_PROXY = '0';
const BKD = fs.mkdtempSync(path.join(os.tmpdir(), 'quetza-bk-'));
process.env.BACKUP_DIR = path.join(BKD, 'locali');
process.env.BACKUP_COPY_DIR = path.join(BKD, 'nas');

(async () => {
  require('../server.js');
  await new Promise(r => setTimeout(r, 600));

  const BASE = `http://127.0.0.1:${process.env.PORT}`;
  let cookie = '';
  async function req(method, url, body, opts = {}) {
    const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) };
    let payload = body;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return r;
  }

  section('Avvio senza certificati');
  // Prima il server apriva il redirect HTTP su PORT e poi app.listen(PORT)
  // falliva con EADDRINUSE: il processo moriva invece di partire.
  const alive = await fetch(BASE + '/api/login-config').then(r => r.ok).catch(() => false);
  check('il server parte in HTTP puro senza EADDRINUSE', alive);

  section('Login e password provvisoria');
  let r = await req('POST', '/api/login', { username: 'admin', password: 'sbagliata' });
  check('password errata → 401', r.status === 401, r.status);

  r = await req('POST', '/api/login', { username: 'admin', password: 'admin', method: 'local' });
  const login = await r.json();
  check('login admin riuscito', r.ok);
  check('segnala password da cambiare', login.must_change_password === 1, JSON.stringify(login.must_change_password));

  r = await req('GET', '/api/notes');
  check('API bloccate finché la password è provvisoria', r.status === 403, r.status);
  const blocked = await r.json();
  check('il 403 spiega il motivo', blocked.must_change_password === true);

  r = await req('GET', '/admin');
  check('pagina admin reindirizza invece di dare JSON', r.status === 302 && r.headers.get('location') === '/',
        `${r.status} → ${r.headers.get('location')}`);

  r = await req('GET', '/api/me');
  check('/api/me resta accessibile (serve al modale)', r.ok);

  r = await req('POST', '/api/change-password', { currentPassword: 'admin', newPassword: 'corta' });
  check('password troppo corta rifiutata', r.status === 400, r.status);

  r = await req('POST', '/api/change-password', { currentPassword: 'sbagliata', newPassword: 'nuovaPassword1' });
  check('password attuale errata rifiutata', r.status === 401, r.status);

  r = await req('POST', '/api/change-password', { currentPassword: 'admin', newPassword: 'nuovaPassword1' });
  check('cambio password riuscito', r.ok, r.status);

  r = await req('GET', '/api/notes');
  check('API sbloccate dopo il cambio', r.ok, r.status);

  section('Login con la nuova password');
  await req('POST', '/api/logout');
  r = await req('POST', '/api/login', { username: 'admin', password: 'admin' });
  check('vecchia password non funziona più', r.status === 401, r.status);
  r = await req('POST', '/api/login', { username: 'admin', password: 'nuovaPassword1' });
  check('nuova password funziona', r.ok);
  check('flag azzerato', (await r.json()).must_change_password === 0);

  section('Note, pagine e condivisione');
  r = await req('POST', '/api/notes', { title: 'Riunione' });
  const note = await r.json();
  check('nota creata', !!note.id);

  const pages = [
    { strokes: [{ t:'pen', c:'#111', sz:3, pts:[{x:1,y:1},{x:5,y:5}] }], textItems: [{ text:'prima pagina', x:10, y:20, size:18 }], images: [] },
    { strokes: [{ t:'rect', c:'#c0392b', sz:2, pts:[{x:2,y:2},{x:9,y:9}] }], textItems: [{ text:'seconda pagina', x:11, y:21, size:18 }], images: [] },
  ];
  r = await req('PUT', `/api/notes/${note.id}/content`, {
    strokes: pages[0].strokes, images: [], thumbnail: 'data:,', grid: 'lines',
    canvasText: 'prima pagina seconda pagina', textItems: pages[0].textItems, pagesData: pages,
  });
  check('contenuto multipagina salvato', r.ok);

  r = await req('POST', `/api/notes/${note.id}/share`, { expires: null });
  const share = await r.json();
  check('link di condivisione creato', !!share.token);

  const shared = await fetch(`${BASE}/api/shared/${share.token}`).then(r => r.json());
  check('vista condivisa espone pages_data', Array.isArray(shared.pages_data) && shared.pages_data.length === 2,
        `pagine: ${shared.pages_data?.length}`);
  check('vista condivisa espone text_items', Array.isArray(shared.text_items) && shared.text_items.length === 1);
  check('seconda pagina visibile a chi riceve il link',
        shared.pages_data?.[1]?.textItems?.[0]?.text === 'seconda pagina');

  section('Ricerca full-text');
  r = await req('GET', '/api/search?q=seconda');
  const res = await r.json();
  check('trova la nota dal testo digitato', res.some(x => x.id === note.id), `${res.length} risultati`);

  section('Export → import (round trip)');
  r = await req('GET', '/api/export');
  check('export risponde ZIP', r.ok && /zip/.test(r.headers.get('content-type')||''), r.headers.get('content-type'));
  const zipBuf = Buffer.from(await r.arrayBuffer());
  check('archivio non vuoto', zipBuf.length > 100, `${zipBuf.length} byte`);

  const AdmZip = require('adm-zip');
  const manifest = JSON.parse(new AdmZip(zipBuf).getEntry('manifest.json').getData().toString('utf8'));
  const mn = manifest.find(n => n.id === note.id);
  check('manifest contiene pages_data', Array.isArray(mn.pages_data) && mn.pages_data.length === 2);
  check('manifest contiene text_items', Array.isArray(mn.text_items) && mn.text_items.length === 1);

  // cancella e reimporta
  await req('DELETE', `/api/notes/${note.id}`);
  check('nota eliminata', (await req('GET', `/api/notes/${note.id}`)).status === 404);

  const fd = new FormData();
  fd.append('archive', new Blob([zipBuf], { type: 'application/zip' }), 'export.zip');
  r = await req('POST', '/api/import', fd);
  const imp = await r.json();
  check('import riuscito', r.ok && imp.imported === 1, JSON.stringify(imp));

  const back = await (await req('GET', `/api/notes/${note.id}`)).json();
  check('reimport conserva 2 pagine', back.pages_data?.length === 2, `pagine: ${back.pages_data?.length}`);
  check('reimport conserva il testo della pagina 2',
        back.pages_data?.[1]?.textItems?.[0]?.text === 'seconda pagina');
  check('reimport conserva i tratti della pagina 2', back.pages_data?.[1]?.strokes?.[0]?.t === 'rect');
  check('reimport conserva text_items', back.text_items?.[0]?.text === 'prima pagina');

  section('Statistiche admin');
  const stats = await (await req('GET', '/api/admin/stats')).json();
  const arow = stats.per_user.find(u => u.username === 'admin');
  check('conteggio note corretto', arow.note_count === 1, `${arow.note_count}`);
  check('nessun audio → 0 byte', Number(arow.audio_bytes) === 0, `${arow.audio_bytes}`);

  section('Versioni, audio e trascrizioni nel ripristino');
  const asForm = (buf) => { const f = new FormData(); f.append('archive', new Blob([buf], { type: 'application/zip' }), 'a.zip'); return f; };
  const v0 = (await (await req('GET', `/api/notes/${note.id}`)).json()).version;
  r = await req('PUT', `/api/notes/${note.id}/content`, { strokes: [], pagesData: pages, textItems: [], baseVersion: v0 });
  const v1 = (await r.json()).version;
  check('salvataggio dalla versione giusta → versione nuova', r.ok && v1 === v0 + 1, `${v0} → ${v1}`);
  r = await req('PUT', `/api/notes/${note.id}/content`, { strokes: [], pagesData: [], baseVersion: v0 });
  const kept = await (await req('GET', `/api/notes/${note.id}`)).json();
  check('salvataggio da una versione vecchia → 409 e nulla sovrascritto', r.status === 409 && kept.pages_data?.length === 2, r.status);

  const afd = new FormData();
  afd.append('audio', new Blob([Buffer.from('audio-di-prova')], { type: 'audio/webm' }), 'a.webm');
  check('audio caricato', (await req('POST', `/api/notes/${note.id}/audio`, afd)).ok);
  require('../db').saveWhisperText(note.id, 'trascrizione di prova', [{ start: 0, end: 1, text: 'trascrizione di prova' }]);
  const zip2 = Buffer.from(await (await req('GET', '/api/export')).arrayBuffer());
  r = await req('POST', '/api/import', asForm(zip2));
  check('reimport dello stesso archivio: nota lasciata com\'è', (await r.json()).unchanged === 1);
  await req('DELETE', `/api/notes/${note.id}`);
  r = await req('POST', '/api/import', asForm(zip2));
  const tr = await (await req('GET', `/api/notes/${note.id}/transcript`)).json();
  check('il ripristino conserva la trascrizione', tr.text === 'trascrizione di prova', tr.text);
  const au = await req('GET', `/api/notes/${note.id}/audio`);
  check('il ripristino conserva l\'audio', au.ok && Buffer.from(await au.arrayBuffer()).toString() === 'audio-di-prova');
  await req('PATCH', `/api/notes/${note.id}`, { title: 'Verbale cantiere' });
  check('rinominata: la ricerca la trova col titolo nuovo', (await (await req('GET', '/api/search?q=cantiere')).json()).some(x => x.id === note.id));
  await req('PATCH', `/api/notes/${note.id}`, { title: 'Riunione' });

  section('Cestino');
  const tn = await (await req('POST', '/api/notes', { title: 'Da cestinare' })).json();
  await req('PUT', `/api/notes/${tn.id}/content`, { strokes: [], canvasText: 'ornitorinco', pagesData: [{ strokes: [], textItems: [{ text: 'ornitorinco', x: 1, y: 1 }], images: [] }] });
  const tfd = new FormData();
  tfd.append('audio', new Blob([Buffer.from('audio-cestino')], { type: 'audio/webm' }), 'a.webm');
  await req('POST', `/api/notes/${tn.id}/audio`, tfd);
  const tsh = await (await req('POST', `/api/notes/${tn.id}/share`, {})).json();
  r = await req('DELETE', `/api/notes/${tn.id}`);
  check('eliminare sposta nel cestino', r.ok && (await r.json()).trash === true);
  check('nel cestino: sparisce da elenco e API', !(await (await req('GET', '/api/notes')).json()).some(n => n.id === tn.id)
        && (await req('GET', `/api/notes/${tn.id}`)).status === 404);
  check('nel cestino: non si salva sopra', (await req('PUT', `/api/notes/${tn.id}/content`, { strokes: [], pagesData: [] })).status === 404);
  check('nel cestino: la ricerca non la trova', !(await (await req('GET', '/api/search?q=ornitorinco')).json()).some(x => x.id === tn.id));
  check('nel cestino: il link condiviso è revocato', (await fetch(`${BASE}/api/shared/${tsh.token}`)).status === 404);
  const trash = await (await req('GET', '/api/trash')).json();
  check('il cestino la elenca, con i giorni di permanenza', trash.days === 30 && trash.notes.some(n => n.id === tn.id && n.deleted_at));
  r = await req('POST', `/api/trash/${tn.id}/restore`);
  const rest = await (await req('GET', `/api/notes/${tn.id}`)).json();
  check('ripristinata con contenuto e audio', r.ok && rest.pages_data?.[0]?.textItems?.[0]?.text === 'ornitorinco' && rest.has_audio === 1);
  check('ripristinata: la ricerca la ritrova', (await (await req('GET', '/api/search?q=ornitorinco')).json()).some(x => x.id === tn.id));
  check('una nota fuori dal cestino non si elimina per sempre', (await req('DELETE', `/api/trash/${tn.id}`)).status === 404);
  await req('DELETE', `/api/notes/${tn.id}`);
  r = await req('DELETE', `/api/trash/${tn.id}`);
  check('eliminata per sempre dal cestino', r.ok && !(await (await req('GET', '/api/trash')).json()).notes.some(n => n.id === tn.id));
  const tdb = require('../db');
  const old = await (await req('POST', '/api/notes', { title: 'vecchia' })).json();
  await req('DELETE', `/api/notes/${old.id}`);
  check('pulizia: una nota appena eliminata resta', tdb.purgeTrash(30) === 0 && tdb.getTrash('admin').some(n => n.id === old.id));
  const activeBefore = (await (await req('GET', '/api/notes')).json()).length;
  check('pulizia: oltre i giorni previsti sparisce, le note attive no', tdb.purgeTrash(-1) >= 1
        && !tdb.getTrash('admin').length && (await (await req('GET', '/api/notes')).json()).length === activeBefore);

  section('Condivisione dopo il reimport');
  // Eliminando la nota, la FK ON DELETE CASCADE revoca anche i suoi link:
  // il token vecchio non deve più funzionare, e serve rigenerarlo.
  check('il link della nota eliminata è revocato',
        (await fetch(`${BASE}/api/shared/${share.token}`)).status === 404);
  const share2 = await (await req('POST', `/api/notes/${note.id}/share`, { expires: null })).json();

  section('Sicurezza: sessione, import, impostazioni, utenti');
  check('/healthz risponde senza login', (await fetch(`${BASE}/healthz`)).ok);
  r = await fetch(`${BASE}/login.html`);
  check('intestazioni di sicurezza presenti',
        r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('x-frame-options') === 'SAMEORIGIN');

  // Login con una sessione già aperta: l'id deve cambiare e il vecchio non vale più
  const oldCookie = cookie;
  r = await req('POST', '/api/login', { username: 'admin', password: 'nuovaPassword1', method: 'local' });
  check('il login rigenera l\'id di sessione', r.ok && cookie && cookie !== oldCookie);
  const adminCookie = cookie;
  cookie = oldCookie;
  check('la sessione precedente al login non è più valida', (await req('GET', '/api/notes')).status === 401);
  cookie = adminCookie;

  r = await req('POST', '/api/admin/settings', { session_secret: 'x' });
  check('impostazioni: chiave sconosciuta rifiutata', r.status === 400, r.status);
  r = await req('POST', '/api/admin/settings', { whisper_model: { a: 1 } });
  check('impostazioni: valore non semplice rifiutato', r.status === 400, r.status);
  r = await req('POST', '/api/admin/settings', { whisper_model: 'tiny' });
  check('impostazioni: chiave valida salvata', r.ok, r.status);

  r = await req('POST', '/api/admin/users', { username: 'mario', password: 'passwordMario1', displayName: 'Mario' });
  check('utente mario creato', r.ok, r.status);
  cookie = '';
  await req('POST', '/api/login', { username: 'mario', password: 'passwordMario1', method: 'local' });
  const marioCookie = cookie;

  // mario importa un archivio che contiene l'id di una nota di admin
  const evil = new AdmZip();
  evil.addFile('manifest.json', Buffer.from(JSON.stringify([{ id: note.id, title: 'sovrascritta', strokes: [], pages_data: [] }])));
  const efd = new FormData();
  efd.append('archive', new Blob([evil.toBuffer()], { type: 'application/zip' }), 'x.zip');
  r = await req('POST', '/api/import', efd);
  const eimp = await r.json();
  check('import con id altrui → importata come copia', r.ok && eimp.copies === 1, JSON.stringify(eimp));
  const mine = await (await req('GET', '/api/notes')).json();
  check('la copia è di mario, con un id nuovo', mine.length === 1 && mine[0].id !== note.id && mine[0].title === 'sovrascritta');
  cookie = adminCookie;
  const orig = await (await req('GET', `/api/notes/${note.id}`)).json();
  check('la nota di admin non è stata toccata', orig.title === 'Riunione', orig.title);
  cookie = marioCookie;
  check('mario non cancella audio e trascrizione di admin', (await req('DELETE', `/api/notes/${note.id}/audio`)).status === 404);
  check('mario non vede i link di admin', (await req('GET', `/api/notes/${note.id}/shares`)).status === 404);
  check('mario non revoca i link di admin', (await req('DELETE', `/api/shares/${share2.token}`)).status === 404);
  cookie = adminCookie;
  const tr2 = await (await req('GET', `/api/notes/${note.id}/transcript`)).json();
  check('trascrizione di admin intatta', tr2.text === 'trascrizione di prova', tr2.text);

  r = await req('PATCH', '/api/admin/users/mario', { isActive: false });
  check('mario disattivato', r.ok);
  cookie = marioCookie;
  check('la sessione di un utente disattivato perde l\'accesso', (await req('GET', '/api/notes')).status === 401);
  cookie = adminCookie;

  const auth = require('../auth');
  check('escape del filtro LDAP (RFC 4515)', auth.escapeLdapFilter('a*(b)\\') === 'a\\2a\\28b\\29\\5c');
  let blocked2 = false;
  try { auth.syncExternalUser('admin', 'Finto admin', 'ldap'); } catch { blocked2 = true; }
  check('un utente LDAP/SSO non eredita l\'account locale con lo stesso nome', blocked2);
  let noEmpty = false;
  try { await auth.ldapAuthenticate('admin', ''); } catch { noEmpty = true; }
  check('LDAP: password vuota rifiutata senza contattare il server', noEmpty);

  async function loginAs(username, password) {
    cookie = '';
    await req('POST', '/api/login', { username, password, method: 'local' });
    return cookie;
  }
  // il testo finisce due volte nel contenuto: canvasText e pagina
  const content = (text, extra = {}) => ({
    strokes: [], images: [], thumbnail: 'data:,', grid: 'lines', canvasText: text,
    textItems: [], pagesData: [{ strokes: [], textItems: [{ text, x: 1, y: 1, size: 18 }], images: [] }], ...extra,
  });

  section('Etichette');
  cookie = adminCookie;
  const tagged = await (await req('POST', '/api/notes', { title: 'Preventivo Rossi' })).json();
  r = await req('PATCH', `/api/notes/${tagged.id}`, { tags: [' Clienti ', 'clienti', 'Urgente', '', 42] });
  check('etichette salvate', r.ok, r.status);
  let listed = (await (await req('GET', '/api/notes')).json()).find(n => n.id === tagged.id);
  check('etichette ripulite e senza doppioni', JSON.stringify(listed?.tags) === '["Clienti","Urgente"]', JSON.stringify(listed?.tags));
  let found = await (await req('GET', '/api/search?q=urgente')).json();
  check('la ricerca trova le note per etichetta', found.some(n => n.id === tagged.id), JSON.stringify(found.map(n => n.title)));
  await req('PATCH', `/api/notes/${tagged.id}`, { title: 'Preventivo Rossi bis' });
  listed = (await (await req('GET', '/api/notes')).json()).find(n => n.id === tagged.id);
  check('cambiare il titolo non toglie le etichette', listed?.tags?.length === 2);
  found = await (await req('GET', '/api/search?q=clienti')).json();
  check('dopo il cambio titolo la ricerca per etichetta funziona ancora', found.some(n => n.id === tagged.id));
  r = await req('GET', '/api/export');
  const tman = JSON.parse(new AdmZip(Buffer.from(await r.arrayBuffer())).getEntry('manifest.json').getData().toString('utf8'));
  check('le etichette finiscono nell\'export', JSON.stringify(tman.find(n => n.id === tagged.id)?.tags) === '["Clienti","Urgente"]');
  await req('PATCH', `/api/notes/${tagged.id}`, { tags: Array.from({ length: 40 }, (_, i) => i + 'x'.repeat(50)) });
  listed = (await (await req('GET', '/api/notes')).json()).find(n => n.id === tagged.id);
  check('etichette limitate in numero e lunghezza', listed.tags.length === 20 && listed.tags.every(t => t.length <= 30));

  section('Condivisione con i colleghi');
  await req('POST', '/api/admin/users', { username: 'luca', password: 'passwordLuca1', displayName: 'Luca' });
  await req('POST', '/api/admin/users', { username: 'sara', password: 'passwordSara1', displayName: 'Sara' });
  const lucaCookie = await loginAs('luca', 'passwordLuca1');
  const saraCookie = await loginAs('sara', 'passwordSara1');
  cookie = adminCookie;
  const sn = await (await req('POST', '/api/notes', { title: 'Verbale' })).json();
  r = await req('PUT', `/api/notes/${sn.id}/content`, content('testo del verbale'));
  let ver = (await r.json()).version;
  await req('PATCH', `/api/notes/${sn.id}`, { tags: ['Privata'] });
  const dir = await (await req('GET', '/api/users')).json();
  check('rubrica: colleghi attivi, senza se stessi', dir.some(u => u.username === 'luca') && !dir.some(u => u.username === 'admin') && !dir.some(u => u.username === 'mario'));

  cookie = lucaCookie;
  check('senza condivisione: la nota non si vede', (await req('GET', `/api/notes/${sn.id}`)).status === 404);
  check('senza condivisione: non si scrive', (await req('PUT', `/api/notes/${sn.id}/content`, content('x'))).status === 404);

  cookie = adminCookie;
  check('condivisione con se stessi rifiutata', (await req('PUT', `/api/notes/${sn.id}/access/admin`, { perm: 'read' })).status === 400);
  check('condivisione con utente inesistente rifiutata', (await req('PUT', `/api/notes/${sn.id}/access/nessuno`, { perm: 'read' })).status === 400);
  check('condivisione con utente disattivato rifiutata', (await req('PUT', `/api/notes/${sn.id}/access/mario`, { perm: 'read' })).status === 400);
  check('"tutti" solo in lettura', (await req('PUT', `/api/notes/${sn.id}/access/*`, { perm: 'write' })).status === 400);
  check('permesso sconosciuto rifiutato', (await req('PUT', `/api/notes/${sn.id}/access/luca`, { perm: 'admin' })).status === 400);
  r = await req('PUT', `/api/notes/${sn.id}/access/luca`, { perm: 'read' });
  check('condivisa con luca in lettura', r.ok, r.status);

  cookie = lucaCookie;
  let sh = await (await req('GET', '/api/notes/shared')).json();
  check('luca la trova tra le condivise', sh.length === 1 && sh[0].id === sn.id && sh[0].perm === 'read' && sh[0].owner === 'admin', JSON.stringify(sh));
  check('ma non tra le sue note', !(await (await req('GET', '/api/notes')).json()).some(n => n.id === sn.id));
  let got = await (await req('GET', `/api/notes/${sn.id}`)).json();
  check('luca la apre in sola lettura', got.role === 'read' && got.canvas_text === 'testo del verbale' && got.owner === 'admin');
  check('le etichette del proprietario restano private', Array.isArray(got.tags) && !got.tags.length);
  check('in lettura non si salva il contenuto', (await req('PUT', `/api/notes/${sn.id}/content`, content('vandalo', { baseVersion: ver }))).status === 404);
  check('in lettura non si rinomina', (await req('PATCH', `/api/notes/${sn.id}`, { title: 'vandalo' })).status === 404);
  check('in lettura non si registra audio', (await req('POST', `/api/notes/${sn.id}/audio/append`, (() => { const f = new FormData(); f.append('chunk', new Blob([Buffer.alloc(10)], { type: 'audio/webm' }), 'c.webm'); return f; })())).status === 404);
  check('il destinatario non vede chi altro ha accesso', (await req('GET', `/api/notes/${sn.id}/access`)).status === 404);
  check('il destinatario non condivide a sua volta', (await req('PUT', `/api/notes/${sn.id}/access/sara`, { perm: 'read' })).status === 404);
  check('il destinatario non crea link pubblici', (await req('POST', `/api/notes/${sn.id}/share`, {})).status === 404);
  check('il destinatario non la elimina', (await req('DELETE', `/api/notes/${sn.id}`)).status === 404);
  check('la trascrizione si legge', (await req('GET', `/api/notes/${sn.id}/transcript`)).ok);

  cookie = adminCookie;
  await req('PUT', `/api/notes/${sn.id}/access/luca`, { perm: 'write' });
  cookie = lucaCookie;
  r = await req('PUT', `/api/notes/${sn.id}/content`, content('aggiunta di luca', { baseVersion: ver }));
  check('con "può modificare" luca salva', r.ok, r.status);
  const ver2 = (await r.json()).version;
  r = await req('PUT', `/api/notes/${sn.id}/content`, content('versione vecchia', { baseVersion: ver }));
  check('anche tra colleghi una versione superata dà conflitto', r.status === 409, r.status);
  check('luca rinomina', (await req('PATCH', `/api/notes/${sn.id}`, { title: 'Verbale (rivisto)', tags: ['Rubata'] })).ok);
  cookie = adminCookie;
  got = await (await req('GET', `/api/notes/${sn.id}`)).json();
  check('il proprietario vede le modifiche del collega', got.canvas_text === 'aggiunta di luca' && got.version === ver2 && got.title === 'Verbale (rivisto)');
  check('un collega non cambia le etichette del proprietario', JSON.stringify(got.tags) === '["Privata"]', JSON.stringify(got.tags));
  check('la nota resta del proprietario', (await (await req('GET', '/api/notes')).json()).some(n => n.id === sn.id));
  found = await (await req('GET', '/api/search?q=aggiunta')).json();
  check('la ricerca del proprietario trova il testo scritto dal collega', found.some(n => n.id === sn.id));

  cookie = saraCookie;
  check('sara non la vede', (await req('GET', `/api/notes/${sn.id}`)).status === 404 && !(await (await req('GET', '/api/notes/shared')).json()).length);
  cookie = adminCookie;
  check('visibile a tutti i colleghi', (await req('PUT', `/api/notes/${sn.id}/access/*`, { perm: 'read' })).ok);
  cookie = saraCookie;
  sh = await (await req('GET', '/api/notes/shared')).json();
  check('ora sara la trova, in sola lettura', sh.length === 1 && sh[0].perm === 'read');
  check('"tutti" non dà la scrittura', (await req('PUT', `/api/notes/${sn.id}/content`, content('x'))).status === 404);
  cookie = lucaCookie;
  check('"tutti" non toglie la scrittura a chi ce l\'ha', (await (await req('GET', `/api/notes/${sn.id}`)).json()).role === 'write');

  cookie = saraCookie;
  r = await req('DELETE', `/api/notes/${sn.id}/access`);
  check('sara la toglie dalle sue condivise', r.ok && !(await (await req('GET', '/api/notes/shared')).json()).length);
  check('e non la apre più', (await req('GET', `/api/notes/${sn.id}`)).status === 404);
  cookie = adminCookie;
  check('il proprietario non "lascia" la propria nota', (await req('DELETE', `/api/notes/${sn.id}/access`)).status === 400);
  let acc = await (await req('GET', `/api/notes/${sn.id}/access`)).json();
  check('elenco accessi: tutti + luca, senza chi l\'ha tolta', acc.map(a => a.username).join() === '*,luca', JSON.stringify(acc));
  await req('PUT', `/api/notes/${sn.id}/access/sara`, { perm: 'read' });
  cookie = saraCookie;
  check('ricondivisa esplicitamente, sara la rivede', (await (await req('GET', '/api/notes/shared')).json()).length === 1);

  cookie = adminCookie;
  await req('DELETE', `/api/notes/${sn.id}`);
  cookie = lucaCookie;
  check('nota nel cestino: sparisce ai colleghi', (await req('GET', `/api/notes/${sn.id}`)).status === 404
        && !(await (await req('GET', '/api/notes/shared')).json()).length);
  check('nota nel cestino: il collega non ci scrive', (await req('PUT', `/api/notes/${sn.id}/content`, content('x'))).status === 404);
  cookie = adminCookie;
  await req('POST', `/api/trash/${sn.id}/restore`);
  cookie = lucaCookie;
  check('ripristinata: torna visibile con gli stessi permessi', (await (await req('GET', `/api/notes/${sn.id}`)).json()).role === 'write');

  cookie = adminCookie;
  check('accesso tolto a luca', (await req('DELETE', `/api/notes/${sn.id}/access/luca`)).ok);
  cookie = lucaCookie;
  check('luca resta in lettura grazie a "tutti"', (await (await req('GET', `/api/notes/${sn.id}`)).json()).role === 'read');
  cookie = adminCookie;
  await req('DELETE', `/api/notes/${sn.id}/access/*`);
  cookie = lucaCookie;
  check('tolto anche "tutti": luca non la vede più', (await req('GET', `/api/notes/${sn.id}`)).status === 404);

  section('Migrazione: condivisioni nell\'export completo');
  cookie = adminCookie;
  await req('PUT', `/api/notes/${sn.id}/access/luca`, { perm: 'write' });
  r = await req('GET', '/api/admin/export');
  const fz = Buffer.from(await r.arrayBuffer());
  const fman = JSON.parse(new AdmZip(fz).getEntry('manifest.json').getData().toString('utf8'));
  check('l\'export completo contiene le condivisioni', fman.access?.some(a => a.note_id === sn.id && a.username === 'luca' && a.perm === 'write'));
  await req('DELETE', `/api/notes/${sn.id}/access/luca`);
  const ffd = new FormData();
  ffd.append('archive', new Blob([fz], { type: 'application/zip' }), 'completo.zip');
  r = await req('POST', '/api/admin/import', ffd);
  const fimp = await r.json();
  check('l\'import completo le ripristina', r.ok && fimp.shares >= 1, JSON.stringify(fimp));
  cookie = lucaCookie;
  check('luca ritrova la nota, ancora in modifica', (await (await req('GET', `/api/notes/${sn.id}`)).json()).role === 'write');
  cookie = adminCookie;
  await req('DELETE', `/api/notes/${sn.id}/access/luca`);

  section('Spazio per utente');
  cookie = adminCookie;
  check('quota non valida rifiutata', (await req('PUT', '/api/admin/users/luca/quota', { quotaMb: -3 })).status === 400);
  check('quota di 1 MB a luca', (await req('PUT', '/api/admin/users/luca/quota', { quotaMb: 1 })).ok);
  cookie = lucaCookie;
  let me2 = await (await req('GET', '/api/me')).json();
  check('/api/me riporta spazio usato e limite', me2.storage?.quota === 1048576 && me2.storage.used >= 0, JSON.stringify(me2.storage));
  const q1 = await (await req('POST', '/api/notes', { title: 'grande' })).json();
  r = await req('PUT', `/api/notes/${q1.id}/content`, content('a'.repeat(300 * 1024)));
  check('salvataggio entro il limite', r.ok, r.status);
  const q2 = await (await req('POST', '/api/notes', { title: 'troppo' })).json();
  r = await req('PUT', `/api/notes/${q2.id}/content`, content('b'.repeat(300 * 1024)));
  const qerr = await r.json();
  check('oltre il limite → 507 con un messaggio chiaro', r.status === 507 && /spazio/i.test(qerr.error), `${r.status} ${qerr.error}`);
  check('il contenuto rifiutato non è stato scritto', !(await (await req('GET', `/api/notes/${q2.id}`)).json()).canvas_text);
  r = await req('PUT', `/api/notes/${q1.id}/content`, content('a'.repeat(600 * 1024)));
  check('anche ingrandire una nota oltre il limite → 507', r.status === 507, r.status);
  r = await req('PUT', `/api/notes/${q1.id}/content`, content('a'.repeat(100 * 1024)));
  check('ridurre una nota è sempre permesso', r.ok, r.status);
  {
    const z = new AdmZip();
    z.addFile('manifest.json', Buffer.from(JSON.stringify([{ id: 'imp-' + Date.now(), title: 'importata', canvas_text: 'q'.repeat(2 * 1048576) }])));
    const zfd = new FormData(); zfd.append('archive', new Blob([z.toBuffer()], { type: 'application/zip' }), 'q.zip');
    r = await req('POST', '/api/import', zfd);
    check('import oltre il limite → 507, niente importato', r.status === 507 && !(await (await req('GET', '/api/notes')).json()).some(n => n.title === 'importata'), r.status);
  }
  const big = new FormData(); big.append('audio', new Blob([Buffer.alloc(2 * 1048576)], { type: 'audio/webm' }), 'a.webm');
  check('audio oltre il limite → 507', (await req('POST', `/api/notes/${q1.id}/audio`, big)).status === 507);
  // Il collega che scrive consuma lo spazio del proprietario, non il suo
  cookie = adminCookie;
  const an = await (await req('POST', '/api/notes', { title: 'di admin' })).json();
  await req('PUT', `/api/notes/${an.id}/access/luca`, { perm: 'write' });
  cookie = lucaCookie;
  r = await req('PUT', `/api/notes/${an.id}/content`, content('c'.repeat(1200 * 1024)));
  check('scrivendo nella nota di un altro conta lo spazio del proprietario', r.ok, r.status);
  cookie = adminCookie;
  await req('POST', '/api/admin/settings', { storage_quota_mb: '5' });
  cookie = saraCookie;
  check('limite generale applicato a chi non ne ha uno suo', (await (await req('GET', '/api/me')).json()).storage.quota === 5 * 1048576);
  cookie = adminCookie;
  await req('PUT', '/api/admin/users/sara/quota', { quotaMb: 0 });
  cookie = saraCookie;
  check('0 sul singolo utente = nessun limite, anche col limite generale', (await (await req('GET', '/api/me')).json()).storage.quota === 0);
  cookie = adminCookie;
  const st = await (await req('GET', '/api/admin/stats')).json();
  const lu = st.per_user.find(u => u.username === 'luca');
  check('statistiche admin: spazio usato e limite per utente', lu?.quota_mb === 1 && lu.used_bytes > 100 * 1024 && st.default_quota_mb === 5, JSON.stringify(lu));
  await req('POST', '/api/admin/settings', { storage_quota_mb: '0' });
  await req('PUT', '/api/admin/users/luca/quota', { quotaMb: null });
  cookie = lucaCookie;
  check('tolto il limite si torna a salvare', (await req('PUT', `/api/notes/${q2.id}/content`, content('b'.repeat(300 * 1024)))).ok);

  section('Backup dal pannello admin');
  cookie = lucaCookie;
  check('solo l\'admin vede i backup', (await req('GET', '/api/admin/backup')).status === 403);
  cookie = adminCookie;
  let bk = await (await req('GET', '/api/admin/backup')).json();
  check('nessun backup ancora', bk.count === 0 && !bk.status && bk.copyDir === process.env.BACKUP_COPY_DIR, JSON.stringify(bk));
  r = await req('POST', '/api/admin/backup');
  bk = await r.json();
  check('backup manuale riuscito', r.ok && bk.status?.ok && bk.count === 1, JSON.stringify(bk));
  check('copia esterna fatta e segnalata', bk.status?.copy?.ok && fs.readdirSync(process.env.BACKUP_COPY_DIR).filter(f => /^quetza_.*\.db$/.test(f)).length === 1);
  check('nessun file a metà nella copia esterna', !fs.readdirSync(process.env.BACKUP_COPY_DIR).some(f => f.endsWith('.parziale')));
  const bkFile = path.join(process.env.BACKUP_DIR, bk.status.file);
  {
    const Database = require('better-sqlite3');
    const b = new Database(bkFile, { readonly: true });
    check('il backup contiene le note', b.prepare('SELECT COUNT(*) n FROM notes WHERE id = ?').get(sn.id).n === 1);
    b.close();
  }

  section('SSO / OIDC con un provider finto (PKCE, nonce, aud)');
  {
    const http = require('http');
    const crypto = require('crypto');
    let lastTokenReq = null, idClaims = {};
    const prov = http.createServer((q, s2) => {
      const iss = `http://127.0.0.1:${prov.address().port}/realms/test`;
      if (q.url.endsWith('/.well-known/openid-configuration')) {
        s2.setHeader('Content-Type', 'application/json');
        return s2.end(JSON.stringify({ issuer: iss, authorization_endpoint: `${iss}/auth`, token_endpoint: `${iss}/token` }));
      }
      if (q.url.endsWith('/token')) {
        let b = ''; q.on('data', c => b += c); q.on('end', () => {
          lastTokenReq = new URLSearchParams(b);
          const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
          s2.setHeader('Content-Type', 'application/json');
          s2.end(JSON.stringify({ id_token: `${enc({ alg: 'RS256' })}.${enc({ iss, aud: 'quetza', exp: Date.now() / 1000 + 300, ...idClaims })}.firma` }));
        });
        return;
      }
      s2.statusCode = 404; s2.end();
    });
    await new Promise(r => prov.listen(0, '127.0.0.1', r));
    const iss = `http://127.0.0.1:${prov.address().port}/realms/test`;
    cookie = adminCookie;
    await req('POST', '/api/admin/settings', { oidc_enabled: 'true', oidc_issuer: iss, oidc_client_id: 'quetza', oidc_client_secret: 's', oidc_redirect_uri: `${BASE}/auth/callback` });

    async function ssoLogin(claims, tamper, next) {
      cookie = '';
      const start = await (await req('POST', '/api/login', { username: '__oidc__', password: 'x', next })).json();
      const u = new URL(start.redirect);
      idClaims = { preferred_username: 'giulia', name: 'Giulia', nonce: u.searchParams.get('nonce'), ...claims };
      const state = tamper === 'state' ? 'sbagliato' : u.searchParams.get('state');
      const cb = await req('GET', `/auth/callback?code=abc&state=${state}`);
      return { u, cb };
    }

    let { u, cb } = await ssoLogin({});
    check('redirect verso l\'endpoint della discovery', u.origin + u.pathname === `${iss}/auth`);
    check('PKCE S256 e nonce nella richiesta', u.searchParams.get('code_challenge_method') === 'S256' && !!u.searchParams.get('nonce'));
    check('login SSO riuscito', cb.status === 302 && cb.headers.get('location') === '/', cb.headers.get('location'));
    const verifier = lastTokenReq.get('code_verifier');
    check('code_verifier inviato e coerente con il challenge',
          crypto.createHash('sha256').update(verifier || '').digest('base64url') === u.searchParams.get('code_challenge'));
    const me = await (await req('GET', '/api/me')).json();
    check('utente SSO creato e collegato', me.user?.username === 'giulia' && me.user?.source === 'oidc');
    ({ cb } = await ssoLogin({}, null, '/collega.html?app=x'));
    check('dopo il login SSO torna alla pagina richiesta', cb.headers.get('location') === '/collega.html?app=x', cb.headers.get('location'));
    ({ cb } = await ssoLogin({}, null, '//evil.example/'));
    check('ritorno verso un altro sito ignorato', cb.headers.get('location') === '/', cb.headers.get('location'));

    ({ cb } = await ssoLogin({ nonce: 'altro' }));
    check('nonce diverso → rifiutato', cb.headers.get('location') === '/login.html?error=oidc_failed');
    ({ cb } = await ssoLogin({ aud: 'altro-client' }));
    check('id_token per un altro client → rifiutato', cb.headers.get('location') === '/login.html?error=oidc_failed');
    ({ cb } = await ssoLogin({}, 'state'));
    check('state sbagliato → rifiutato', cb.headers.get('location') === '/login.html?error=invalid_state');
    ({ cb } = await ssoLogin({ preferred_username: 'admin' }));
    check('SSO con lo username dell\'admin locale → rifiutato', cb.headers.get('location') === '/login.html?error=oidc_failed');

    prov.close();
    cookie = adminCookie;
    await req('POST', '/api/admin/settings', { oidc_enabled: 'false' });
  }

  section('Dispositivi collegati');
  const APP = 'https://appassets.androidplatform.net';
  cookie = '';
  r = await fetch(BASE + '/api/notes', { method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  check('CORS: preflight dall\'app Android accettato', r.status === 204 && r.headers.get('access-control-allow-origin') === APP
        && /authorization/i.test(r.headers.get('access-control-allow-headers') || ''), r.status);
  r = await fetch(BASE + '/api/notes', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
  check('CORS: nessun permesso per altri siti', !r.headers.get('access-control-allow-origin'));

  cookie = lucaCookie;
  r = await req('POST', '/api/devices', { name: 'Tablet', app: 'https://evil.example/index.html' });
  check('il token va solo a un\'app client riconosciuta', r.status === 400, r.status);
  r = await req('POST', '/api/devices', { app: APP + '/index.html', cancel: true });
  check('annulla: solo l\'indirizzo per tornare all\'app', r.ok && (await r.json()).app === APP + '/index.html' && !(await (await req('GET', '/api/devices')).json()).length);
  r = await req('POST', '/api/devices', { name: 'Tablet di Luca', app: APP + '/index.html' });
  const dev = await r.json();
  check('dispositivo collegato: token e indirizzo di ritorno', r.status === 201 && dev.token?.startsWith('qd_') && dev.app === APP + '/index.html', r.status);
  const lucaNote = await (await req('POST', '/api/notes', { title: 'Nota di Luca' })).json();

  cookie = '';
  const bearer = (t = dev.token) => ({ headers: { Authorization: `Bearer ${t}`, Origin: APP } });
  r = await req('GET', '/api/notes', null, bearer());
  let dn = r.ok ? await r.json() : [];
  check('con il token si leggono le proprie note', r.ok && dn.some(n => n.id === lucaNote.id), r.status);
  check('risposta leggibile dall\'app (CORS)', r.headers.get('access-control-allow-origin') === APP);
  check('nessun cookie di sessione creato per il dispositivo', !r.headers.get('set-cookie'));
  check('token sbagliato → 401', (await req('GET', '/api/notes', null, bearer('qd_sbagliato'))).status === 401);
  r = await fetch(BASE + '/api/notes', { headers: { Cookie: lucaCookie, Origin: APP } });
  check('dall\'app il cookie non vale: serve il token', r.status === 401, r.status);
  r = await req('POST', '/api/devices', { name: 'x', app: APP + '/' }, bearer());
  check('un dispositivo non ne collega altri', r.status === 403, r.status);

  const cid = require('crypto').randomUUID();
  r = await req('POST', '/api/notes', { id: cid, title: 'Creata offline' }, bearer());
  check('la nota creata sul dispositivo tiene il suo id', r.status === 201 && (await r.json()).id === cid, r.status);
  r = await req('POST', '/api/notes', { id: cid, title: 'Creata offline' }, bearer());
  check('stesso id una seconda volta → 409', r.status === 409, r.status);
  r = await req('POST', '/api/notes', { id: sn.id, title: 'Id di un altro utente' }, bearer());
  const other = await r.json();
  check('id di una nota altrui → nota nuova con un altro id', r.status === 201 && other.id !== sn.id, r.status);
  cookie = adminCookie;
  check('la nota dell\'altro utente resta sua', (await (await req('GET', '/api/sync')).json()).notes.some(n => n.id === sn.id));
  cookie = '';
  r = await req('PUT', `/api/notes/${cid}/content`, content('scritto in treno', { baseVersion: 1 }), bearer());
  check('contenuto dal dispositivo salvato', r.ok && (await r.json()).version === 2, r.status);
  for (const i of [0, 1]) {
    const fd = new FormData();
    fd.append('audio', new Blob([Buffer.alloc(100 + i)], { type: 'audio/webm' }), 's.webm');
    r = await req('POST', `/api/notes/${cid}/audio`, fd, bearer());
    check(`l'invio audio dice quale sessione è (${i})`, r.ok && (await r.json()).session === i);
  }
  await req('PATCH', `/api/notes/${cid}`, { tags: ['Treno'] }, bearer());
  await req('DELETE', `/api/notes/${other.id}`, null, bearer());
  r = await req('GET', '/api/sync', null, bearer());
  const sl = r.ok ? await r.json() : { notes: [] };
  const sc = sl.notes.find(n => n.id === cid), sTrash = sl.notes.find(n => n.id === other.id);
  check('sync: stato delle note senza contenuto', sc && sc.version === 2 && sc.audio_count === 2 && sc.whisper_len === 0
        && JSON.stringify(sc.tags) === '["Treno"]' && !('strokes' in sc), JSON.stringify(sc));
  check('sync: anche le note nel cestino, con la data', sTrash && !!sTrash.deleted_at);
  check('sync: solo le note dell\'utente', !sl.notes.some(n => n.id === sn.id) && sl.trash_days > 0);

  r = await req('GET', '/api/devices', null, bearer());
  const devs = await r.json();
  check('elenco dispositivi con quello corrente', devs.length === 1 && devs[0].current && devs[0].name === 'Tablet di Luca');
  cookie = adminCookie;
  let ul = await (await req('GET', '/api/admin/users')).json();
  check('l\'admin vede quanti dispositivi ha un utente', ul.find(u => u.username === 'luca')?.devices === 1);
  cookie = '';
  r = await req('DELETE', '/api/devices/current', null, bearer());
  check('il dispositivo si scollega da solo', r.ok, r.status);
  check('dopo lo scollegamento il token non vale più', (await req('GET', '/api/notes', null, bearer())).status === 401);

  cookie = lucaCookie;
  const dev2 = await (await req('POST', '/api/devices', { name: 'Telefono', app: APP + '/index.html' })).json();
  cookie = adminCookie;
  r = await req('DELETE', '/api/admin/users/luca/devices');
  check('l\'admin scollega i dispositivi di un utente', r.ok && (await r.json()).deleted === 1);
  cookie = '';
  check('token revocato dall\'admin → 401', (await req('GET', '/api/notes', null, bearer(dev2.token))).status === 401);
  cookie = lucaCookie;
  const dev3 = await (await req('POST', '/api/devices', { name: 'Telefono', app: APP + '/index.html' })).json();
  cookie = adminCookie;
  await req('PATCH', '/api/admin/users/luca', { isActive: false });
  cookie = '';
  check('utente disattivato: il dispositivo non sincronizza', (await req('GET', '/api/sync', null, bearer(dev3.token))).status === 401);
  cookie = adminCookie;
  await req('PATCH', '/api/admin/users/luca', { isActive: true });

  section('Accesso non autenticato');
  cookie = '';
  check('API protette → 401', (await req('GET', '/api/notes')).status === 401);
  r = await req('GET', '/admin');
  check('pagina admin → redirect al login', r.status === 302 && r.headers.get('location') === '/login.html',
        `${r.status} → ${r.headers.get('location')}`);
  r = await fetch(`${BASE}/api/shared/${share2.token}`);
  check('il link condiviso resta pubblico senza login', r.ok, r.status);

  done();
})();
