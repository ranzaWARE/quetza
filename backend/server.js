const express  = require('express');
const rateLimit = require('express-rate-limit');
const session  = require('express-session');
const SQLiteStore = require('./session-store')(session);
const path     = require('path');
const multer   = require('multer');
const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const os       = require('os');
const crypto   = require('crypto');
const db       = require('./db');
const auth     = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
// Indirizzo con cui gli utenti aprono Quetza (es. https://quetza.azienda.local:8443).
// Serve per il redirect da HTTP a HTTPS: dentro il container non si conosce
// la porta pubblicata da Docker.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
// true = la porta HTTP serve l'app intera (password in chiaro sulla rete).
// Default: la porta HTTP fa solo il redirect verso HTTPS.
const ALLOW_HTTP = process.env.ALLOW_HTTP === 'true';
const DB_DIR = path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'quetza.db'));

const CERT_PATH = process.env.CERT_PATH || '/app/certs/server.crt';
const KEY_PATH  = process.env.KEY_PATH  || '/app/certs/server.key';
const HAS_CERTS = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);

// Dietro nginx/reverse proxy il rate limiter deve leggere X-Forwarded-For,
// altrimenti tutti gli utenti condividono il contatore dell'IP del proxy.
// Numero di hop fidati; 0 = nessun proxy (default sicuro: 1 hop, il nostro nginx).
const TRUST_PROXY = Number(process.env.TRUST_PROXY ?? 1);
if (TRUST_PROXY > 0) app.set('trust proxy', TRUST_PROXY);

// Senza SESSION_SECRET si genera un segreto casuale a ogni avvio: le sessioni
// non sopravvivono al riavvio, ma non si usa mai un segreto noto e pubblico.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  SESSION_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[quetza] SESSION_SECRET assente o troppo corto — generato segreto casuale temporaneo. Le sessioni verranno invalidate a ogni riavvio.');
}

// Intestazioni di sicurezza di base. Niente CSP restrittiva: le pagine usano
// script e stili inline. frame-ancestors impedisce di incorniciare l'app in
// siti terzi (clickjacking).
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// Stato del container (healthcheck di Docker): senza autenticazione e
// raggiungibile anche sulla porta HTTP.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Porta HTTP: solo redirect verso HTTPS, salvo ALLOW_HTTP=true.
// Le richieste già passate da un proxy TLS (X-Forwarded-Proto: https) hanno
// req.secure vero e non vengono toccate.
app.use((req, res, next) => {
  if (req.secure || ALLOW_HTTP || !HAS_CERTS) return next();
  const host = (req.headers.host || 'localhost').replace(/:\d+$/, '');
  const base = PUBLIC_URL || `https://${host}:${process.env.PUBLIC_HTTPS_PORT || HTTPS_PORT}`;
  res.redirect(308, base + req.originalUrl);
});

// ── App client sul dispositivo ────────────────────────────────
// Le app client (Android e le future) hanno l'interfaccia dentro l'app e le
// note sul dispositivo; se collegate a questo server sincronizzano con un
// token del dispositivo. Le loro richieste arrivano da un'altra origine:
// CORS solo per le origini delle app, e da lì mai cookie, solo il token.
const CLIENT_ORIGINS = new Set(['https://appassets.androidplatform.net',
  ...(process.env.CLIENT_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)]);
app.use('/api/', (req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || !CLIENT_ORIGINS.has(origin)) return next();
  delete req.headers.cookie;
  res.set({ 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
            'Access-Control-Expose-Headers': 'Content-Disposition, X-Audio-Sessions' });
  if (req.method !== 'OPTIONS') return next();
  res.set({ 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
  res.sendStatus(204);
});
// Authorization: Bearer <token del dispositivo> → sessione di quell'utente
// solo per questa richiesta (express-session non tocca una req.session già
// presente, e nessun cookie viene creato).
app.use('/api/', (req, res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return next();
  const d = db.deviceByToken(h.slice(7).trim());
  const u = d && db.getUserByUsername(d.username);
  if (!u || !u.is_active) return res.status(401).json({ error: 'Dispositivo non collegato o collegamento revocato' });
  req.device = d;
  req.session = {
    user: { username: u.username, displayName: u.display_name || u.username, source: u.source, is_admin: u.is_admin, must_change_password: 0 },
    regenerate(cb) { cb(); }, destroy(cb) { if (cb) cb(); }, save(cb) { if (cb) cb(); },
  };
  next();
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DB_DIR }),
  secret: SESSION_SECRET,
  resave: false, saveUninitialized: false,
  // La scadenza riparte a ogni richiesta: chi usa l'app non viene buttato
  // fuori a metà riunione 14 giorni dopo il login.
  rolling: true,
  cookie: {
    // 'auto' = express-session decide per ogni richiesta guardando req.secure
    // (che considera anche X-Forwarded-Proto grazie a trust proxy). Un
    // booleano statico legato a HAS_CERTS romperebbe una delle due porte:
    // se true, il browser scarta il cookie sulle richieste HTTP; se false,
    // niente Secure nemmeno su HTTPS. Ora l'app risponde su entrambe le
    // porte con lo stesso server — serve che il cookie si adatti di volta
    // in volta, non una scelta fissa all'avvio.
    secure: 'auto',
    httpOnly: true, sameSite: 'lax', maxAge: 14*24*60*60*1000
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting ─────────────────────────────────────────────
// Il contatore delle API è per utente quando c'è una sessione: in azienda più
// persone escono spesso dallo stesso IP (NAT, proxy) e con un contatore per IP
// si toglievano i salvataggi a vicenda.
const byUser = (req) => req.session?.user?.username ? `u:${req.session.user.username}` : req.ip;
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Troppi tentativi, riprova tra 15 minuti' } });
const apiLimiter   = rateLimit({ windowMs: 60*1000,    max: 600, keyGenerator: byUser });
const uploadLimiter= rateLimit({ windowMs: 60*1000,    max: 30,  keyGenerator: byUser });
app.use('/api/login', loginLimiter);
app.use('/api/', apiLimiter);
// Solo gli invii: il limite valeva anche per la lettura, e aprire qualche nota
// con più registrazioni faceva sparire la barra audio (429).
app.post('/api/notes/:id/audio', uploadLimiter);
app.post('/api/notes/:id/audio/append', uploadLimiter);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200*1024*1024 } });

// I browser mandano Accept: text/html,…,*/* — quindi req.accepts('json') è
// vero anche per una normale navigazione e restituiva JSON grezzo al posto di
// un redirect. Discrimina invece sul path.
const isApi = (req) => req.path.startsWith('/api/');

// Ricontrolla l'utente sul DB a ogni richiesta: un account disattivato o
// eliminato perde subito l'accesso, e togliere i permessi admin ha effetto
// senza aspettare la scadenza della sessione (14 giorni).
function refreshSessionUser(req) {
  const u = req.session?.user && db.getUserByUsername(req.session.user.username);
  if (!u || !u.is_active) return false;
  req.session.user.is_admin = u.is_admin;
  return true;
}

function requireAuth(req, res, next) {
  if (!req.session?.user || !refreshSessionUser(req)) {
    if (req.session?.user) req.session.user = null;
    if (isApi(req)) return res.status(401).json({ error: 'Non autenticato' });
    return res.redirect('/login.html');
  }
  // Password da cambiare: nessuna API utilizzabile finché non è stata cambiata.
  // /api/me e /api/change-password restano accessibili per pilotare il modale.
  if (req.session.user.must_change_password) {
    if (isApi(req)) return res.status(403).json({ error: 'Password da cambiare', must_change_password: true });
    return res.redirect('/');   // l'app mostra il modale di cambio password
  }
  next();
}

// Autenticato ma senza il blocco "cambia password" — solo per /api/me e logout
function requireSession(req, res, next) {
  if (req.session?.user && refreshSessionUser(req)) return next();
  if (isApi(req)) return res.status(401).json({ error: 'Non autenticato' });
  res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.is_admin) return next();
  res.status(403).json({ error: 'Accesso non autorizzato' });
}

// ── Auth ──────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username e password richiesti' });

  // Redirect OIDC se abilitato
  const oc = auth.getOidcConfig();
  if (oc.enabled && username === '__oidc__') {
    let disc;
    try { disc = await auth.oidcDiscover(oc); }
    catch (e) {
      console.error('[oidc] discovery fallita:', e.message, e.cause || '');
      return res.status(502).json({ error: 'Provider SSO non raggiungibile' });
    }
    // state contro il CSRF, nonce contro il replay dell'id_token, PKCE (S256)
    // contro l'intercettazione del code: tutti legati a questa sessione.
    const state    = crypto.randomBytes(16).toString('hex');
    const nonce    = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    req.session.oidc = { state, nonce, verifier, next: localPath(req.body.next) };
    const url = new URL(disc.authorizationEndpoint);
    url.search = new URLSearchParams({
      ...Object.fromEntries(url.searchParams),
      client_id: oc.clientId, redirect_uri: oc.redirectUri, response_type: 'code',
      scope: 'openid profile email', state, nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    return res.json({ redirect: url.toString() });
  }

  try {
    const user = await auth.authenticate(username, password, req.body.method);
    user.must_change_password = db.mustChangePassword(user.username) ? 1 : 0;
    // Nuovo id di sessione al login (session fixation)
    await regenerateSession(req);
    req.session.user = user;
    res.json({ ok: true, user, must_change_password: user.must_change_password });
  } catch(err) {
    res.status(401).json({ error: 'Credenziali non valide' });
  }
});

// Dove tornare dopo il login: solo un percorso di questo server
function localPath(p) {
  return typeof p === 'string' && /^\/(?![\/\\])/.test(p) ? p : null;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
}

// Cambio password dell'utente autenticato (anche con must_change_password attivo)
app.post('/api/change-password', requireSession, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const u = req.session.user;
  if (u.source !== 'local') return res.status(400).json({ error: 'Password gestita dal provider esterno (LDAP/SSO)' });
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'La nuova password deve avere almeno 8 caratteri' });
  if (!db.verifyPassword(u.username, currentPassword||'')) return res.status(401).json({ error: 'Password attuale non corretta' });
  if (currentPassword === newPassword) return res.status(400).json({ error: 'La nuova password deve essere diversa da quella attuale' });

  db.resetPassword(u.username, newPassword, false);
  req.session.user.must_change_password = 0;
  res.json({ ok: true });
});

// OIDC callback
app.get('/auth/callback', async (req, res) => {
  const kc = auth.getOidcConfig();
  const { code, state, error: providerError, error_description } = req.query;
  if (providerError) {
    console.error(`[oidc] il provider ha rifiutato la richiesta: ${providerError} — ${error_description||''}`);
    return res.redirect('/login.html?error=oidc_failed');
  }
  const pending = req.session.oidc;
  // Monouso: un secondo callback con lo stesso state viene rifiutato
  delete req.session.oidc;
  if (!kc.enabled || !pending || !state || state !== pending.state) {
    console.error('[oidc] state non valido (sessione scaduta, cookie non ricevuto, o richiesta rigiocata)');
    return res.redirect('/login.html?error=invalid_state');
  }

  // Il token endpoint (da discovery) si chiama sull'URL interno se impostato:
  // dal container l'hostname pubblico del provider può non risolversi.
  let tokenUrl = '(discovery)';
  try {
    tokenUrl = (await auth.oidcDiscover(kc)).tokenEndpoint;
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type:'authorization_code', code, redirect_uri: kc.redirectUri, client_id: kc.clientId, client_secret: kc.clientSecret, code_verifier: pending.verifier }),
      ...auth.oidcFetchOptions(kc),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(`token endpoint HTTP ${tokenRes.status}: ${tokens.error||''} ${tokens.error_description||''}`);
    // L'id_token è lo standard OIDC per i claim di profilo (preferred_username,
    // name, email): l'access_token non è garantito essere nemmeno un JWT, e
    // quando lo è non è detto contenga quei claim — dipende dal provider.
    // Decodificare l'access_token "funzionava" solo con IdP (tipicamente
    // Keycloak di default) che ci mettono quei claim per abitudine; con un
    // provider diverso o configurato diversamente il login falliva o creava
    // utenti con uno username illeggibile (il solo "sub").
    // L'id_token arriva direttamente dal token endpoint su TLS, autenticandosi
    // con il client secret: per OIDC Core (3.1.3.7) questo basta a fidarsi
    // della firma. Restano da controllare issuer, destinatario, scadenza e nonce.
    const jwt = tokens.id_token;
    if (!jwt) throw new Error('risposta del token endpoint priva di id_token (scope "openid" mancante?)');
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    if (!auth.isAcceptedIssuer(kc, payload.iss)) throw new Error(`issuer del token inatteso: "${payload.iss}" (atteso "${kc.issuer}")`);
    const aud = [].concat(payload.aud || []);
    if (!aud.includes(kc.clientId)) throw new Error(`id_token non destinato a questo client (aud: ${aud.join(', ')})`);
    if (payload.exp && payload.exp * 1000 < Date.now() - 60000) throw new Error('id_token scaduto');
    if (payload.nonce !== pending.nonce) throw new Error('nonce dell\'id_token non corrispondente');
    const username = payload.preferred_username || payload.email || payload.sub;
    if (!username) throw new Error('nessun claim utilizzabile come username nel token (preferred_username/email/sub)');
    const dbUser = auth.syncExternalUser(username, payload.name || username, 'oidc');
    await regenerateSession(req);
    req.session.user = { username, displayName: payload.name||username, source:'oidc', is_admin: dbUser.is_admin||0 };
    res.redirect(pending.next || '/');
  } catch(e) {
    // e.message da solo per un fetch fallito è quasi sempre il generico
    // "fetch failed" di Node — la causa vera (DNS non risolto, connessione
    // rifiutata, certificato TLS non fidato, timeout...) sta in e.cause e
    // prima andava persa, rendendo impossibile capire perché falliva.
    console.error(`[oidc] callback fallito verso ${tokenUrl}:`, e.message, e.cause || '');
    res.redirect('/login.html?error=oidc_failed' + (pending.next ? '&next=' + encodeURIComponent(pending.next) : ''));
  }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

// Config pubblica per la pagina login (solo ciò che serve, senza segreti)
app.get('/api/login-config', (req, res) => {
  res.json({
    oidc_enabled: db.getSetting('oidc_enabled') === 'true',
    ldap_enabled: db.getSetting('ldap_enabled') === 'true' || process.env.LDAP_ENABLED === 'true',
    org_name: process.env.ORG_NAME || '',
  });
});
app.get('/api/me', requireSession, (req, res) => {
  const u = req.session.user.username;
  res.json({ user: req.session.user, must_change_password: req.session.user.must_change_password ? 1 : 0,
             storage: { used: db.storageUsed(u), quota: db.quotaFor(u) } });
});

// ── Spazio per utente ─────────────────────────────────────────
// 507 se dopo l'operazione l'utente supererebbe il suo spazio. Si lascia
// sempre passare chi riduce lo spazio (togliere immagini, svuotare note).
function overQuota(username, addBytes, freedBytes = 0) {
  const quota = db.quotaFor(username);
  if (!quota || addBytes <= freedBytes) return null;
  const used = db.storageUsed(username);
  return used - freedBytes + addBytes > quota ? { used, quota } : null;
}
const QUOTA_MSG = 'Spazio esaurito: svuota il cestino o elimina note e audio che non servono, oppure chiedi all\'IT più spazio';

// ── Notes API ─────────────────────────────────────────────────
app.get('/api/notes', requireAuth, (req, res) => res.json(db.getNotesByUser(req.session.user.username)));
// Note che i colleghi hanno condiviso con me (prima di /:id)
app.get('/api/notes/shared', requireAuth, (req, res) => res.json(db.getSharedWithMe(req.session.user.username)));

// Chi può fare cosa su una nota: il proprietario tutto, chi ha "modifica"
// contenuto, titolo e audio, chi ha "lettura" solo guardare e ascoltare.
// Per chi non ha accesso la nota non esiste (404, mai 403: il client
// leggerebbe 403 come sessione scaduta).
const CAN = { read: ['owner', 'write', 'read'], write: ['owner', 'write'], own: ['owner'] };
function noteFor(req, res, need) {
  const a = db.noteAccess(req.params.id, req.session.user.username);
  if (!a || !CAN[need].includes(a.role)) { res.status(404).json({ error: 'Nota non trovata' }); return null; }
  return a;
}

app.get('/api/notes/:id', requireAuth, (req, res) => {
  const a = noteFor(req, res, 'read'); if (!a) return;
  const n = db.getNoteById(req.params.id, a.owner);
  if (a.role !== 'owner') {
    n.tags = [];                                   // le etichette sono del proprietario
    n.owner = a.owner;
    n.owner_name = db.getUserByUsername(a.owner)?.display_name || a.owner;
  }
  res.json({ ...n, role: a.role });
});
// Un dispositivo può proporre l'id della nota che ha creato offline: resta
// lo stesso ovunque. Se è già di questo utente la nota c'è già (409); se è di
// un altro, la nota nasce con un id nuovo, che il dispositivo adotta.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.post('/api/notes', requireAuth, (req, res) => {
  const me = req.session.user.username;
  let id = typeof req.body.id === 'string' && UUID_RE.test(req.body.id) ? req.body.id.toLowerCase() : null;
  const owner = id && db.getNoteOwner(id);
  if (owner === me) return res.status(409).json({ error: 'Nota già presente', id });
  if (owner) id = null;
  const n = db.createNote(id || crypto.randomUUID(), me, req.body.title||'Nuova nota', !!req.body.voiceFirst);
  res.status(201).json(n);
});
app.patch('/api/notes/:id', requireAuth, (req, res) => {
  const a = noteFor(req, res, 'write'); if (!a) return;
  const { title, grid, tags } = req.body || {};
  const meta = a.role === 'owner' ? { title, grid, tags } : { title, grid };
  if (!db.updateNoteMeta(req.params.id, a.owner, meta)) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true });
});
app.put('/api/notes/:id/content', requireAuth, (req, res) => {
  try {
    const { strokes, images, thumbnail, grid, canvasText, textItems, pagesData, baseVersion } = req.body;
    const size = [strokes, images, textItems, pagesData].reduce((a, v) => a + (v ? JSON.stringify(v).length : 0), 0)
               + (thumbnail || '').length + (canvasText || '').length;
    const a = noteFor(req, res, 'write'); if (!a) return;
    // Lo spazio è del proprietario, anche quando scrive un collega
    const q = overQuota(a.owner, size, db.noteBytes(req.params.id));
    if (q) return res.status(507).json({ error: QUOTA_MSG, ...q });
    const r = db.saveContent(req.params.id, a.owner, strokes, images, thumbnail, grid, canvasText, textItems, pagesData, baseVersion);
    if (!r) return res.status(404).json({ error: 'Nota non trovata' });
    if (r.conflict) return res.status(409).json({ error: 'La nota è stata modificata da un altro dispositivo', version: r.version });
    res.json({ ok: true, version: r.version });
  } catch(e) {
    console.error('saveContent error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Ricerca full-text
app.get('/api/search', requireAuth, (req, res) => {
  const results = db.searchNotes(req.session.user.username, req.query.q);
  res.json(results);
});
app.delete('/api/notes/:id', requireAuth, (req, res) => {
  if (!db.deleteNote(req.params.id, req.session.user.username)) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true, trash: true, days: TRASH_DAYS });
});

// ── Dispositivi collegati ─────────────────────────────────────
// Stato di tutte le note (cestino compreso) per la sincronizzazione
app.get('/api/sync', requireAuth, (req, res) =>
  res.json({ notes: db.getSyncList(req.session.user.username), trash_days: TRASH_DAYS }));
// Collegamento di un dispositivo, dalla pagina /collega.html dopo il login:
// il token torna all'app solo se il suo indirizzo è quello di un'app client.
app.post('/api/devices', requireAuth, (req, res) => {
  if (req.device) return res.status(403).json({ error: 'Un dispositivo non può collegarne altri' });
  let back;
  try { back = new URL(String(req.body.app || '')); } catch {}
  if (!back || !CLIENT_ORIGINS.has(back.origin)) return res.status(400).json({ error: 'App non riconosciuta' });
  // Annulla: solo l'indirizzo per tornare all'app, nessun token
  if (req.body.cancel) return res.json({ app: back.origin + back.pathname });
  const name = String(req.body.name || '').trim() || 'Dispositivo';
  const d = db.createDevice(req.session.user.username, name);
  res.status(201).json({ ...d, app: back.origin + back.pathname });
});
app.get('/api/devices', requireAuth, (req, res) =>
  res.json(db.getDevices(req.session.user.username).map(d => ({ ...d, current: d.id === req.device?.id }))));
// 'current' = il dispositivo che fa la richiesta (si scollega da solo)
app.delete('/api/devices/:id', requireAuth, (req, res) => {
  const id = req.params.id === 'current' ? req.device?.id : req.params.id;
  if (!id || !db.deleteDevice(id, req.session.user.username)) return res.status(404).json({ error: 'Dispositivo non trovato' });
  res.json({ ok: true });
});

// ── Cestino ───────────────────────────────────────────────────
// Le note eliminate restano qui TRASH_DAYS giorni, poi vengono cancellate.
const TRASH_DAYS = Math.max(1, Number(process.env.TRASH_DAYS) || 30);
app.get('/api/trash', requireAuth, (req, res) => res.json({ days: TRASH_DAYS, notes: db.getTrash(req.session.user.username) }));
app.post('/api/trash/:id/restore', requireAuth, (req, res) => {
  if (!db.restoreNote(req.params.id, req.session.user.username)) return res.status(404).json({ error: 'Nota non trovata nel cestino' });
  res.json({ ok: true });
});
app.delete('/api/trash/:id', requireAuth, (req, res) => {
  if (!db.purgeNote(req.params.id, req.session.user.username)) return res.status(404).json({ error: 'Nota non trovata nel cestino' });
  res.json({ ok: true });
});
app.delete('/api/trash', requireAuth, (req, res) => res.json({ ok: true, deleted: db.purgeNote(null, req.session.user.username) }));
function purgeTrash() {
  try {
    const n = db.purgeTrash(TRASH_DAYS);
    if (n) console.log(`[cestino] eliminate definitivamente ${n} note più vecchie di ${TRASH_DAYS} giorni`);
  } catch (e) { console.warn('[cestino] pulizia non riuscita:', e.message); }
}
purgeTrash();
setInterval(purgeTrash, 6 * 3600 * 1000).unref();

// ── Audio ─────────────────────────────────────────────────────
app.post('/api/notes/:id/audio', requireAuth, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file audio' });
  const a = noteFor(req, res, 'write'); if (!a) return;
  const q = overQuota(a.owner, req.file.size);
  if (q) return res.status(507).json({ error: QUOTA_MSG, ...q });
  const saved = db.saveAudio(req.params.id, a.owner, req.file.buffer, req.file.mimetype);
  if (!saved) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true, session: saved.session });
});
app.post('/api/notes/:id/audio/append', requireAuth, upload.single('chunk'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun chunk' });
  const a = noteFor(req, res, 'write'); if (!a) return;
  const q = overQuota(a.owner, req.file.size);
  if (q) return res.status(507).json({ error: QUOTA_MSG, ...q });
  if (!db.appendAudioChunk(req.params.id, a.owner, req.file.buffer, req.file.mimetype)) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true });
});
app.get('/api/notes/:id/audio', requireAuth, (req, res) => {
  const a = noteFor(req, res, 'read'); if (!a) return;
  const sessions = db.getAudio(req.params.id, a.owner);
  if (!sessions?.length) return res.status(404).json({ error: 'Audio non trovato' });
  if (sessions.length === 1) { const au = sessions[0]; res.set('Content-Type',au.mime||'audio/webm').set('Content-Length',au.data.length).set('X-Audio-Sessions','1'); return res.send(au.data); }
  res.json({ sessions: sessions.map((s,i)=>({index:i,mime:s.mime,size:s.data.length})) });
});
app.get('/api/notes/:id/audio/:session', requireAuth, (req, res) => {
  const a = noteFor(req, res, 'read'); if (!a) return;
  const sessions = db.getAudio(req.params.id, a.owner);
  const idx = parseInt(req.params.session);
  if (!sessions || !(idx >= 0) || idx >= sessions.length) return res.status(404).json({ error: 'Sessione non trovata' });
  const au = sessions[idx]; res.set('Content-Type',au.mime||'audio/webm').set('Content-Length',au.data.length); res.send(au.data);
});
app.delete('/api/notes/:id/audio', requireAuth, (req, res) => {
  if (!db.deleteAudio(req.params.id, req.session.user.username)) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true });
});

// GET trascrizione salvata
app.get('/api/notes/:id/transcript', requireAuth, (req, res) => {
  const a = noteFor(req, res, 'read'); if (!a) return;
  const note = db.getNoteById(req.params.id, a.owner);
  res.json({
    text:     note.whisper_text     || null,
    segments: note.whisper_segments || null,
    has_transcript: !!note.whisper_text
  });
});

// ── Whisper ───────────────────────────────────────────────────
// Le impostazioni salvate dal pannello admin hanno la precedenza sulle env,
// altrimenti WHISPER_URL da docker-compose le renderebbe sempre inefficaci.
function whisperConfig() {
  return {
    url:     db.getSetting('whisper_url')      || process.env.WHISPER_URL || 'http://quetza-whisper:9876',
    model:   db.getSetting('whisper_model')    || process.env.WHISPER_MODEL || '',
    hfToken: db.getSetting('whisper_hf_token') || process.env.HF_TOKEN || '',
  };
}

// Registrazioni lunghe con modelli grandi su CPU richiedono anche decine di
// minuti, e il servizio ne elabora una alla volta (le altre aspettano in coda):
// i 5 minuti di prima facevano fallire le trascrizioni di riunioni lunghe.
const WHISPER_TIMEOUT_MS = (Number(process.env.WHISPER_TIMEOUT_MIN) || 60) * 60 * 1000;

async function whisperReachable(url) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

// Invia l'audio di una nota al microservizio e salva il risultato.
// Ogni sessione di registrazione viene inviata come file separato: concatenare
// i buffer WebM produceva un flusso con più header di container, di cui ffmpeg
// decodificava solo il primo (registrazioni in più riprese troncate).
async function transcribeNote(noteId, username) {
  const cfg = whisperConfig();
  if (!(await whisperReachable(cfg.url))) {
    const err = new Error('Servizio Whisper non disponibile. Controlla che il container quetza-whisper sia avviato.');
    err.status = 503;
    throw err;
  }

  const sessions = db.getAudio(noteId, username);
  if (!sessions?.length) {
    const err = new Error('Nessun audio da trascrivere');
    err.status = 404;
    throw err;
  }

  const form = new FormData();
  sessions.forEach((s, i) => {
    const mime = s.mime || 'audio/webm';
    const ext  = mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : 'webm';
    // Stesso nome campo per tutte: il servizio le legge con getlist('audio')
    form.append('audio', new Blob([s.data], { type: mime }), `session_${i}.${ext}`);
  });
  form.append('diarize', 'true');
  if (cfg.model)   form.append('model', cfg.model);
  if (cfg.hfToken) form.append('hf_token', cfg.hfToken);

  const r = await fetch(`${cfg.url}/transcribe`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS)
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: 'Errore sconosciuto' }));
    const err = new Error(body.error || 'Errore trascrizione');
    err.status = 500;
    throw err;
  }

  const result = await r.json();
  // Salva la trascrizione nel DB e ricostruisce l'indice FTS
  db.saveWhisperText(noteId, result.text || '', result.segments || null);
  return result;
}

// Whisper trascrizione con diarizzazione (via microservizio Python)
app.post('/api/notes/:id/transcribe', requireAuth, async (req, res) => {
  const a = noteFor(req, res, 'write'); if (!a) return;

  try {
    const result = await transcribeNote(req.params.id, a.owner);
    res.json({
      ok:       true,
      text:     result.text,
      diarized: result.diarized,
      speakers: result.speakers,
      segments: result.segments,
      language: result.language
    });
  } catch(e) {
    console.error('Transcribe error:', e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Errore durante la trascrizione: ' + e.message });
  }
});

// ── Export / Import (personale) ───────────────────────────────
const archiver = require('archiver');
const AdmZip   = require('adm-zip');

// Deserializza le colonne JSON per un manifest leggibile.
// Deve coprire TUTTI i campi di contenuto: escluderne uno significa perderlo
// al reimport (era il caso di text_items, pages_data e whisper_*).
function noteForManifest(n) {
  const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
  return {
    ...n,
    strokes:          parse(n.strokes, []),
    images:           parse(n.images, []),
    text_items:       parse(n.text_items, []),
    pages_data:       parse(n.pages_data, null),
    whisper_segments: parse(n.whisper_segments, null),
    tags:             parse(n.tags, []),
  };
}

app.get('/api/export', requireAuth, async (req, res) => {
  const username = req.session.user.username;
  const notes = db.getAllNotesForExport(username);
  res.set('Content-Type','application/zip').set('Content-Disposition',`attachment; filename="quetza-${username}-${new Date().toISOString().slice(0,10)}.zip"`);
  const arc = archiver('zip',{zlib:{level:6}}); arc.pipe(res);
  arc.append(JSON.stringify(notes.map(noteForManifest),null,2),{name:'manifest.json'});
  for (const note of notes) {
    const audio = db.getAudio(note.id, username);
    if (!audio?.length) continue;
    audio.forEach((a,i)=>arc.append(a.data,{name:`audio/${note.id}_${i}.${a.mime?.includes('mp4')?'mp4':'webm'}`}));
  }
  arc.finalize();
});

// Ripristina TUTTE le sessioni audio di una nota (audio/<id>_0, _1, _2 …).
// La versione precedente cercava solo _0, perdendo le registrazioni successive.
// L'audio esistente viene rimosso prima, altrimenti un reimport duplicherebbe
// le sessioni accodandole a quelle già presenti.
// srcId = id della nota nell'archivio (nomi dei file audio), noteId = id
// con cui viene salvata, diverso se la nota è stata importata come copia.
function restoreAudioFromZip(zip, noteId, username, srcId = noteId) {
  const found = [];
  for (let i = 0; ; i++) {
    const entry = ['webm','mp4','wav']
      .map(ext => ({ ext, e: zip.getEntry(`audio/${srcId}_${i}.${ext}`) }))
      .find(x => x.e);
    if (!entry) break;
    found.push(entry);
  }
  // Formato storico senza indice di sessione
  if (!found.length) {
    const legacy = ['webm','mp4','wav']
      .map(ext => ({ ext, e: zip.getEntry(`audio/${srcId}.${ext}`) }))
      .find(x => x.e);
    if (legacy) found.push(legacy);
  }
  if (!found.length) return 0;

  db.replaceAudio(noteId, username, found.map(({ ext, e }) => ({ data: e.getData(), mime: `audio/${ext}` })));
  return found.length;
}

// Archivi di import: su disco (non in RAM durante l'upload) e con un limite
// configurabile. adm-zip legge comunque l'archivio intero in memoria, quindi
// il limite va tenuto sotto la RAM libera del server.
const IMPORT_MAX_BYTES = (Number(process.env.IMPORT_MAX_MB) || 1024) * 1024 * 1024;
const importUpload = (maxBytes) => multer({ dest: path.join(os.tmpdir(), 'quetza-import'), limits: { fileSize: maxBytes } }).single('archive');
const removeUpload = (req) => { if (req.file?.path) fs.rm(req.file.path, { force: true }, () => {}); };

app.post('/api/import', requireAuth, importUpload(IMPORT_MAX_BYTES),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nessun file' });
    const username = req.session.user.username;
    try {
      const zip = new AdmZip(req.file.path);
      const manifest = JSON.parse(zip.getEntry('manifest.json')?.getData().toString('utf8') || 'null');
      if (!manifest) return res.status(400).json({ error: 'ZIP non valido' });
      const notes = Array.isArray(manifest) ? manifest : (manifest.notes || []);
      // Lo spazio vale anche per l'import: si conta l'archivio scompattato
      const q = overQuota(username, zip.getEntries().reduce((a, e) => a + e.header.size, 0));
      if (q) return res.status(507).json({ error: QUOTA_MSG, ...q });
      let imported=0, skipped=0, copies=0, unchanged=0;
      for (const note of notes) {
        if (!note.id||!note.title){skipped++;continue;}
        // Un id che appartiene a un altro utente non va mai sovrascritto:
        // prima l'import personale aggiornava il contenuto della nota altrui.
        // La nota entra come copia con un id nuovo.
        const owner = db.getNoteOwner(note.id);
        // Già presente e uguale o più recente: non si tocca. Se però è nel
        // cestino, reimportarla significa volerla indietro: torna fuori così
        // com'è (la versione nel cestino non è più vecchia dell'archivio).
        if (owner === username && db.importWouldOverwriteNewer(note.id, note.updated_at)) {
          if (db.restoreNote(note.id, username)) imported++; else unchanged++;
          continue;
        }
        const id = owner && owner !== username ? crypto.randomUUID() : note.id;
        if (id !== note.id) copies++;
        db.upsertNoteFromImport(id, username, note);
        restoreAudioFromZip(zip, id, username, note.id);
        imported++;
      }
      res.json({ ok: true, imported, skipped, copies, unchanged });
    } catch(e) { res.status(500).json({ error: e.message }); }
    finally { removeUpload(req); }
  }
);

// ── Condivisione con i colleghi ───────────────────────────────
app.get('/api/users', requireAuth, (req, res) =>
  res.json(db.getDirectory().filter(u => u.username !== req.session.user.username)));
app.get('/api/notes/:id/access', requireAuth, (req, res) => {
  const a = noteFor(req, res, 'own'); if (!a) return;
  res.json(db.getAccessList(req.params.id));
});
// username '*' = tutti gli utenti, solo in lettura
app.put('/api/notes/:id/access/:username', requireAuth, (req, res) => {
  const a = noteFor(req, res, 'own'); if (!a) return;
  const who = req.params.username, perm = req.body?.perm;
  if (!['read', 'write'].includes(perm) || (who === '*' && perm !== 'read'))
    return res.status(400).json({ error: 'Permesso non valido' });
  if (who !== '*') {
    const u = db.getUserByUsername(who);
    if (!u || !u.is_active) return res.status(400).json({ error: 'Utente non trovato o disattivato' });
    if (who === a.owner) return res.status(400).json({ error: 'La nota è già tua' });
  }
  db.setAccess(req.params.id, who, perm, a.owner);
  res.json({ ok: true });
});
// Un destinatario toglie la nota dalle sue condivise
app.delete('/api/notes/:id/access', requireAuth, (req, res) => {
  const a = noteFor(req, res, 'read'); if (!a) return;
  if (a.role === 'owner') return res.status(400).json({ error: 'La nota è tua' });
  db.setAccess(req.params.id, req.session.user.username, 'hidden', req.session.user.username);
  res.json({ ok: true });
});
// Il proprietario toglie l'accesso a qualcuno
app.delete('/api/notes/:id/access/:username', requireAuth, (req, res) => {
  const a = noteFor(req, res, 'own'); if (!a) return;
  if (!db.removeAccess(req.params.id, req.params.username)) return res.status(404).json({ error: 'Accesso non trovato' });
  res.json({ ok: true });
});

// ── Shares ────────────────────────────────────────────────────
app.post('/api/notes/:id/share', requireAuth, (req, res) => {
  const note = db.getNoteById(req.params.id, req.session.user.username);
  if (!note) return res.status(404).json({ error: 'Nota non trovata' });
  const token = crypto.randomBytes(20).toString('hex');
  let expiresAt = null;
  if (req.body.expires) { const d=new Date(); d.setDate(d.getDate()+parseInt(req.body.expires)); expiresAt=d.toISOString(); }
  db.createShare(token, req.params.id, req.session.user.username, expiresAt);
  res.json({ token, expiresAt });
});
app.get('/api/notes/:id/shares', requireAuth, (req, res) => {
  if (db.getNoteOwner(req.params.id) !== req.session.user.username) return res.status(404).json({ error: 'Nota non trovata' });
  res.json(db.getSharesForNote(req.params.id, req.session.user.username));
});
app.delete('/api/shares/:token', requireAuth, (req, res) => {
  if (!db.deleteShare(req.params.token, req.session.user.username)) return res.status(404).json({ error: 'Link non trovato' });
  res.json({ ok: true });
});
app.get('/api/shared/:token', (req, res) => {
  const share = db.getShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Link non valido o scaduto' });
  const note = db.getNoteById(share.note_id, share.username);
  if (!note) return res.status(404).json({ error: 'Nota non trovata' });
  // pages_data e text_items servono alla vista condivisa per mostrare tutte le
  // pagine e il testo digitato: con i soli strokes si vedeva una pagina sola.
  res.json({
    title: note.title, strokes: note.strokes, images: note.images,
    text_items: note.text_items, pages_data: note.pages_data,
    grid: note.grid, has_audio: note.has_audio,
    shared_by: share.username, expires_at: share.expires_at
  });
});
// Due rotte esplicite invece del parametro opzionale ':session?', che Express 5
// non supporta più: all'aggiornamento il server non sarebbe nemmeno partito.
function sharedAudio(req, res) {
  const share = db.getShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Link non valido' });
  const sessions = db.getAudio(share.note_id, share.username);
  if (!sessions?.length) return res.status(404).json({ error: 'Audio non trovato' });

  if (req.params.session !== undefined) {
    const idx = parseInt(req.params.session);
    if (!(idx >= 0) || idx >= sessions.length) return res.status(404).json({ error: 'Sessione non trovata' });
    const a = sessions[idx];
    res.set('Content-Type', a.mime || 'audio/webm');
    return res.send(a.data);
  }
  if (sessions.length === 1) {
    res.set('Content-Type', sessions[0].mime || 'audio/webm');
    return res.send(sessions[0].data);
  }
  res.json({ sessions: sessions.map((s, i) => ({ index: i, mime: s.mime })) });
}
app.get('/api/shared/:token/audio', sharedAudio);
app.get('/api/shared/:token/audio/:session', sharedAudio);
app.get('/share/:token', (req, res) => res.sendFile(path.join(__dirname,'public','share.html')));

// ── Admin API ─────────────────────────────────────────────────

// Statistiche
app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => res.json(db.getStats()));

// Auto-trascrizione in background (chiamata dopo stop registrazione)
// Non aspetta il risultato — risponde subito 202 e processa in background
app.post('/api/notes/:id/transcribe-async', requireAuth, async (req, res) => {
  const a = noteFor(req, res, 'write'); if (!a) return;
  const noteId   = req.params.id;
  const username = a.owner;

  // Risponde subito
  res.status(202).json({ ok: true, message: 'Trascrizione avviata in background' });

  // Processa in background senza await
  (async () => {
    try {
      const result = await transcribeNote(noteId, username);
      console.log(`[whisper] Auto-transcribed note ${noteId} (${result.language}, diarized:${result.diarized})`);
    } catch(e) {
      console.warn('[whisper] Auto-transcription failed:', e.message);
    }
  })();
});

// Health check Whisper (proxy verso il container Python)
app.get('/api/admin/whisper-health', requireAuth, requireAdmin, async (req, res) => {
  const cfg = whisperConfig();
  try {
    const r = await fetch(`${cfg.url}/health`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    // Il modello/token effettivi sono quelli che Quetza invierà al servizio,
    // non solo quelli con cui il container è partito.
    res.json({
      ...d,
      configured_model: cfg.model || d.whisper_model,
      diarization: d.diarization || !!cfg.hfToken,
    });
  } catch(e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// Utenti
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => res.json(db.getUsers()));

app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, displayName, isAdmin } = req.body;
  if (!username||!password) return res.status(400).json({ error: 'Username e password richiesti' });
  try {
    db.createUser(username, password, displayName, isAdmin);
    res.status(201).json({ ok: true });
  } catch(e) { res.status(409).json({ error: e.message }); }
});

app.patch('/api/admin/users/:username', requireAuth, requireAdmin, (req, res) => {
  const { username } = req.params;
  const { isAdmin, isActive, displayName } = req.body;

  // Impedisci di rimuovere l'ultimo admin
  if (isAdmin === false || isAdmin === 0) {
    if (db.countAdmins() <= 1) {
      const target = db.getUserByUsername(username);
      if (target?.is_admin) return res.status(400).json({ error: 'Impossibile rimuovere l\'ultimo amministratore' });
    }
  }
  // Impedisci di disattivare l'ultimo admin
  if (isActive === false || isActive === 0) {
    if (db.countAdmins() <= 1) {
      const target = db.getUserByUsername(username);
      if (target?.is_admin) return res.status(400).json({ error: 'Impossibile disattivare l\'ultimo amministratore' });
    }
  }

  db.updateUser(username, { displayName, isAdmin, isActive });
  res.json({ ok: true });
});

app.put('/api/admin/users/:username/quota', requireAuth, requireAdmin, (req, res) => {
  const mb = req.body?.quotaMb;
  if (mb != null && mb !== '' && !(Number(mb) >= 0)) return res.status(400).json({ error: 'Quota non valida' });
  if (!db.setUserQuota(req.params.username, mb)) return res.status(404).json({ error: 'Utente non trovato' });
  res.json({ ok: true });
});

// Tablet perso o cambio di mano: l'app non sincronizza più (le note già
// sul dispositivo restano lì)
app.delete('/api/admin/users/:username/devices', requireAuth, requireAdmin, (req, res) =>
  res.json({ ok: true, deleted: db.deleteDevices(req.params.username) }));

app.post('/api/admin/users/:username/reset-password', requireAuth, requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password richiesta' });
  db.resetPassword(req.params.username, password);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:username', requireAuth, requireAdmin, (req, res) => {
  const target = db.getUserByUsername(req.params.username);
  if (target?.is_admin && db.countAdmins() <= 1) return res.status(400).json({ error: 'Impossibile eliminare l\'ultimo amministratore' });
  db.deleteUser(req.params.username);
  res.json({ ok: true });
});

// Impostazioni
// Diagnostica OIDC: discovery (.well-known) dall'URL che usa il server.
// Risponde con lo stato HTTP o con la causa reale dell'errore di rete/TLS.
app.get('/api/admin/oidc/test', requireAuth, requireAdmin, async (req, res) => {
  const oc = auth.getOidcConfig();
  if (!oc.issuer) return res.status(400).json({ ok: false, error: 'Issuer non configurato' });
  try {
    const d = await auth.oidcDiscover(oc, { fresh: true });
    const issuerOk = auth.isAcceptedIssuer(oc, d.issuer);
    res.json({ ok: issuerOk, url: d.url, status: d.status, issuer: d.issuer, issuerOk, tokenEndpoint: d.tokenEndpoint });
  } catch (e) {
    res.json({ ok: false, url: e.url, status: e.status, error: e.message, cause: e.cause ? `${e.cause.code||''} ${e.cause.message||e.cause}`.trim() : undefined });
  }
});

app.get('/api/admin/settings', requireAuth, requireAdmin, (req, res) => res.json(db.getAllSettings()));
// Solo le chiavi che il pannello admin gestisce davvero, e solo valori
// semplici: prima si poteva scrivere qualsiasi chiave con qualsiasi valore.
const SETTING_KEY = /^(ldap|oidc|whisper|storage)_[a-z_]+$/;
app.post('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const settings = req.body || {};
  const bad = Object.keys(settings).filter(k => !SETTING_KEY.test(k) || !['string','number','boolean'].includes(typeof settings[k]));
  if (bad.length) return res.status(400).json({ error: `Impostazioni non valide: ${bad.join(', ')}` });
  Object.entries(settings).forEach(([k,v]) => db.setSetting(k, String(v)));
  res.json({ ok: true });
});

// ── Backup (stato e backup al volo) ───────────────────────────
// Stessi valori che entrypoint.sh passa al cron di backup.js.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'quetza.db')), 'backups');
function backupInfo() {
  let status = null;
  try { status = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, 'status.json'), 'utf8')); } catch {}
  let files = [];
  try { files = fs.readdirSync(BACKUP_DIR).filter(f => /^quetza_.*\.db$/.test(f)).sort(); } catch {}
  return {
    status, count: files.length, latest: files[files.length - 1] || null,
    dir: BACKUP_DIR, copyDir: process.env.BACKUP_COPY_DIR || null,
    keep: Number(process.env.BACKUP_KEEP) || 30, cron: process.env.BACKUP_CRON || null,
  };
}
let backupRunning = false;
app.get('/api/admin/backup', requireAuth, requireAdmin, (req, res) => res.json(backupInfo()));
app.post('/api/admin/backup', requireAuth, requireAdmin, (req, res) => {
  if (backupRunning) return res.status(409).json({ error: 'Backup già in corso' });
  backupRunning = true;
  require('child_process').execFile(process.execPath, [path.join(__dirname, 'backup.js')],
    { env: { ...process.env, BACKUP_DIR }, timeout: 30 * 60 * 1000 }, (err, stdout, stderr) => {
      backupRunning = false;
      const info = backupInfo();
      if (err) return res.status(500).json({ ...info, error: (stderr || err.message).trim() });
      res.json(info);
    });
});

// Export globale (tutti gli utenti)
app.get('/api/admin/export', requireAuth, requireAdmin, async (req, res) => {
  const notes = db.getAllNotesForExport(); // tutti
  const users = db.getUsers();
  res.set('Content-Type','application/zip').set('Content-Disposition',`attachment; filename="quetza-full-${new Date().toISOString().slice(0,10)}.zip"`);
  const arc = archiver('zip',{zlib:{level:6}}); arc.pipe(res);
  arc.append(JSON.stringify({ users, notes: notes.map(noteForManifest), access: db.getAllAccess() },null,2),{name:'manifest.json'});
  for (const note of notes) {
    const audio = db.getAudio(note.id, null);
    if (!audio?.length) continue;
    audio.forEach((a,i)=>arc.append(a.data,{name:`audio/${note.id}_${i}.${a.mime?.includes('mp4')?'mp4':'webm'}`}));
  }
  arc.finalize();
});

// Import globale
app.post('/api/admin/import', requireAuth, requireAdmin, importUpload(IMPORT_MAX_BYTES * 4),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nessun file' });
    try {
      const zip = new AdmZip(req.file.path);
      const data = JSON.parse(zip.getEntry('manifest.json')?.getData().toString('utf8')||'null');
      if (!data) return res.status(400).json({ error: 'ZIP non valido' });
      let imported=0, skipped=0, usersImported=0, usersWithoutPassword=0;
      // Importa utenti se presenti. L'archivio non contiene le password:
      // gli account locali nascono senza password (non possono entrare) finché
      // l'admin non ne imposta una provvisoria dal tab Utenti. Prima ricevevano
      // tutti "changeme123", nota a chiunque abbia letto il codice.
      if (data.users) {
        for (const u of data.users) {
          if (!u.username) continue;
          const ex = db.getUserByUsername(u.username);
          if (!ex) {
            try {
              const source = ['ldap', 'oidc'].includes(u.source) ? u.source : 'local';
              db.createUser(u.username, null, u.display_name||u.username, 0, source);
              if (u.quota_mb != null) db.setUserQuota(u.username, u.quota_mb);
              usersImported++;
              if (source === 'local') usersWithoutPassword++;
            } catch {}
          }
        }
      }
      const notes = data.notes || data; // supporta entrambi i formati
      let unchanged = 0;
      for (const note of notes) {
        if (!note.id||!note.title){skipped++;continue;}
        const owner = note.username || 'admin';
        // Nota di un altro utente con lo stesso id, o già presente e più recente:
        // non si tocca (l'upsert non la aggiornerebbe, ma l'audio sì).
        const current = db.getNoteOwner(note.id);
        if (current && (current !== owner || db.importWouldOverwriteNewer(note.id, note.updated_at))) { unchanged++; continue; }
        db.upsertNoteFromImport(note.id, owner, note);
        restoreAudioFromZip(zip, note.id, owner);
        imported++;
      }
      // Condivisioni tra colleghi, dopo note e utenti
      let shares = 0;
      for (const a of Array.isArray(data.access) ? data.access : []) if (db.importAccess(a)) shares++;
      res.json({ ok:true, imported, skipped, unchanged, usersImported, usersWithoutPassword, shares });
    } catch(e) { res.status(500).json({ error: e.message }); }
    finally { removeUpload(req); }
  }
);

// ── Pagina admin ──────────────────────────────────────────────
app.get('/admin', requireAuth, requireAdmin, (req, res) => res.sendFile(path.join(__dirname,'public','admin.html')));

// ── Catch-all ─────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

// ── Server ────────────────────────────────────────────────────
// Con i certificati: HTTPS su HTTPS_PORT e, su PORT, il redirect verso HTTPS
// (middleware sopra). Con ALLOW_HTTP=true PORT serve l'app intera in chiaro:
// il cookie di sessione si adatta da solo (cookie.secure:'auto'), ma la
// registrazione audio (getUserMedia) resta bloccata dal browser fuori da
// HTTPS o localhost.
// Senza certificati: solo HTTP su PORT.
const servers = [];
if (HAS_CERTS) {
  servers.push(https.createServer({ cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) }, app)
    .listen(HTTPS_PORT, () => console.log(`Quetza HTTPS :${HTTPS_PORT}`)));

  servers.push(http.createServer(app)
    .listen(PORT, () => console.log(ALLOW_HTTP
      ? `Quetza HTTP :${PORT} (ALLOW_HTTP: app completa in chiaro, registrazione audio non disponibile)`
      : `Quetza HTTP :${PORT} (solo redirect verso HTTPS)`)));
} else {
  console.warn(`[quetza] Certificati non trovati (${CERT_PATH}) — avvio in HTTP puro. La registrazione audio richiede HTTPS o localhost.`);
  servers.push(app.listen(PORT, () => console.log(`Quetza HTTP :${PORT}`)));
}

// docker stop manda SIGTERM: si smette di accettare richieste, si lasciano
// finire quelle in corso (un salvataggio, un upload audio) e si chiude il DB.
// Senza questo Node, che nel container è il processo 1, ignorava il segnale e
// veniva ucciso dopo 10 secondi a metà di quello che stava facendo.
let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`[quetza] ${sig}: chiusura in corso`);
  let open = servers.length;
  const done = () => { db.close(); console.log('[quetza] database chiuso, uscita'); process.exit(0); };
  servers.forEach(s => { s.close(() => { if (--open === 0) done(); }); s.closeIdleConnections?.(); });
  setTimeout(done, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));