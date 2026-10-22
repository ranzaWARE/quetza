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

    async function ssoLogin(claims, tamper) {
      cookie = '';
      const start = await (await req('POST', '/api/login', { username: '__oidc__', password: 'x' })).json();
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
