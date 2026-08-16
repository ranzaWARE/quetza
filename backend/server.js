const express  = require('express');
const rateLimit = require('express-rate-limit');
const session  = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const multer   = require('multer');
const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const crypto   = require('crypto');
const db       = require('./db');
const auth     = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
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

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DB_DIR }),
  secret: SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: {
    // Il cookie va marcato Secure solo se il browser parla davvero HTTPS,
    // altrimenti in HTTP puro non verrebbe mai inviato indietro.
    secure: HAS_CERTS || process.env.FORCE_SECURE_COOKIE === 'true',
    httpOnly: true, sameSite: 'lax', maxAge: 14*24*60*60*1000
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting ─────────────────────────────────────────────
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Troppi tentativi, riprova tra 15 minuti' } });
const apiLimiter   = rateLimit({ windowMs: 60*1000,    max: 300 });
const uploadLimiter= rateLimit({ windowMs: 60*1000,    max: 30 });
app.use('/api/login', loginLimiter);
app.use('/api/', apiLimiter);
app.use('/api/notes/:id/audio', uploadLimiter);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200*1024*1024 } });

// I browser mandano Accept: text/html,…,*/* — quindi req.accepts('json') è
// vero anche per una normale navigazione e restituiva JSON grezzo al posto di
// un redirect. Discrimina invece sul path.
const isApi = (req) => req.path.startsWith('/api/');

function requireAuth(req, res, next) {
  if (!req.session?.user) {
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
  if (req.session?.user) return next();
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
  const kc = auth.getKeycloakConfig();
  if (kc.enabled && username === '__oidc__') {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oidcState = state;
    const url = `${kc.issuer}/protocol/openid-connect/auth?client_id=${encodeURIComponent(kc.clientId)}&redirect_uri=${encodeURIComponent(kc.redirectUri)}&response_type=code&scope=openid+profile+email&state=${state}`;
    return res.json({ redirect: url });
  }

  try {
    const user = await auth.authenticate(username, password, req.body.method);
    user.must_change_password = db.mustChangePassword(user.username) ? 1 : 0;
    req.session.user = user;
    res.json({ ok: true, user, must_change_password: user.must_change_password });
  } catch(err) {
    res.status(401).json({ error: 'Credenziali non valide' });
  }
});

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
  const kc = auth.getKeycloakConfig();
  const { code, state } = req.query;
  if (!kc.enabled || state !== req.session.oidcState) return res.redirect('/login.html?error=invalid_state');

  try {
    const tokenRes = await fetch(`${kc.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type:'authorization_code', code, redirect_uri: kc.redirectUri, client_id: kc.clientId, client_secret: kc.clientSecret })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No token');
    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
    const username = payload.preferred_username || payload.sub;
    // Sincronizza nel DB
    let dbUser = db.getUserByUsername(username);
    if (!dbUser) { try { db.createUser(username, null, payload.name||username, 0, 'oidc'); } catch {} dbUser = db.getUserByUsername(username); }
    db.touchLogin(username);
    req.session.user = { username, displayName: payload.name||username, source:'oidc', is_admin: dbUser?.is_admin||0 };
    res.redirect('/');
  } catch(e) {
    res.redirect('/login.html?error=oidc_failed');
  }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

// Config pubblica per la pagina login (solo ciò che serve, senza segreti)
app.get('/api/login-config', (req, res) => {
  res.json({
    oidc_enabled: db.getSetting('oidc_enabled') === 'true',
    ldap_enabled: db.getSetting('ldap_enabled') === 'true' || process.env.LDAP_ENABLED === 'true',
  });
});
app.get('/api/me', requireSession, (req, res) => {
  res.json({ user: req.session.user, must_change_password: req.session.user.must_change_password ? 1 : 0 });
});

// ── Notes API ─────────────────────────────────────────────────
app.get('/api/notes', requireAuth, (req, res) => res.json(db.getNotesByUser(req.session.user.username)));
app.get('/api/notes/:id', requireAuth, (req, res) => {
  const n = db.getNoteById(req.params.id, req.session.user.username);
  if (!n) return res.status(404).json({ error: 'Nota non trovata' });
  res.json(n);
});
app.post('/api/notes', requireAuth, (req, res) => {
  const n = db.createNote(uuidv4(), req.session.user.username, req.body.title||'Nuova nota', !!req.body.voiceFirst);
  res.status(201).json(n);
});
app.patch('/api/notes/:id', requireAuth, (req, res) => {
  if (!db.updateNoteMeta(req.params.id, req.session.user.username, req.body)) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true });
});
app.put('/api/notes/:id/content', requireAuth, (req, res) => {
  try {
    const { strokes, images, thumbnail, grid, canvasText, textItems, pagesData } = req.body;
    if (!db.saveContent(req.params.id, req.session.user.username, strokes, images, thumbnail, grid, canvasText, textItems, pagesData)) return res.status(404).json({ error: 'Nota non trovata' });
    res.json({ ok: true });
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
  res.json({ ok: true });
});

// ── Audio ─────────────────────────────────────────────────────
app.post('/api/notes/:id/audio', requireAuth, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file audio' });
  if (!db.saveAudio(req.params.id, req.session.user.username, req.file.buffer, req.file.mimetype)) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true });
});
app.post('/api/notes/:id/audio/append', requireAuth, upload.single('chunk'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun chunk' });
  if (!db.appendAudioChunk(req.params.id, req.session.user.username, req.file.buffer, req.file.mimetype)) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true });
});
app.get('/api/notes/:id/audio', requireAuth, (req, res) => {
  const sessions = db.getAudio(req.params.id, req.session.user.username);
  if (!sessions?.length) return res.status(404).json({ error: 'Audio non trovato' });
  if (sessions.length === 1) { const a=sessions[0]; res.set('Content-Type',a.mime||'audio/webm').set('Content-Length',a.data.length).set('X-Audio-Sessions','1'); return res.send(a.data); }
  res.json({ sessions: sessions.map((s,i)=>({index:i,mime:s.mime,size:s.data.length})) });
});
app.get('/api/notes/:id/audio/:session', requireAuth, (req, res) => {
  const sessions = db.getAudio(req.params.id, req.session.user.username);
  const idx = parseInt(req.params.session);
  if (!sessions||idx>=sessions.length) return res.status(404).json({ error: 'Sessione non trovata' });
  const a=sessions[idx]; res.set('Content-Type',a.mime||'audio/webm').set('Content-Length',a.data.length); res.send(a.data);
});
app.delete('/api/notes/:id/audio', requireAuth, (req, res) => { db.deleteAudio(req.params.id, req.session.user.username); res.json({ ok: true }); });

// GET trascrizione salvata
app.get('/api/notes/:id/transcript', requireAuth, (req, res) => {
  const note = db.getNoteById(req.params.id, req.session.user.username);
  if (!note) return res.status(404).json({ error: 'Nota non trovata' });
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
    method: 'POST', body: form, signal: AbortSignal.timeout(300000)
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
  const note = db.getNoteById(req.params.id, req.session.user.username);
  if (!note) return res.status(404).json({ error: 'Nota non trovata' });

  try {
    const result = await transcribeNote(req.params.id, req.session.user.username);
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
  };
}

app.get('/api/export', requireAuth, async (req, res) => {
  const username = req.session.user.username;
  const notes = db.getAllNotesForExport(username);
  res.set('Content-Type','application/zip').set('Content-Disposition',`attachment; filename="quetza-${username}-${new Date().toISOString().slice(0,10)}.zip"`);
  const arc = archiver('zip',{zlib:{level:6}}); arc.pipe(res);
  arc.append(JSON.stringify(notes.map(noteForManifest),null,2),{name:'manifest.json'});
  for (const note of notes) {
    if (!note.has_audio) continue;
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
function restoreAudioFromZip(zip, noteId, username) {
  const found = [];
  for (let i = 0; ; i++) {
    const entry = ['webm','mp4','wav']
      .map(ext => ({ ext, e: zip.getEntry(`audio/${noteId}_${i}.${ext}`) }))
      .find(x => x.e);
    if (!entry) break;
    found.push(entry);
  }
  // Formato storico senza indice di sessione
  if (!found.length) {
    const legacy = ['webm','mp4','wav']
      .map(ext => ({ ext, e: zip.getEntry(`audio/${noteId}.${ext}`) }))
      .find(x => x.e);
    if (legacy) found.push(legacy);
  }
  if (!found.length) return 0;

  db.deleteAudio(noteId, username);
  found.forEach(({ ext, e }) => db.saveAudio(noteId, username, e.getData(), `audio/${ext}`));
  return found.length;
}

app.post('/api/import', requireAuth,
  multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024*1024}}).single('archive'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nessun file' });
    try {
      const zip = new AdmZip(req.file.buffer);
      const manifest = JSON.parse(zip.getEntry('manifest.json')?.getData().toString('utf8') || 'null');
      if (!manifest) return res.status(400).json({ error: 'ZIP non valido' });
      const notes = Array.isArray(manifest) ? manifest : (manifest.notes || []);
      let imported=0, skipped=0;
      for (const note of notes) {
        if (!note.id||!note.title){skipped++;continue;}
        db.upsertNoteFromImport(note.id, req.session.user.username, note);
        restoreAudioFromZip(zip, note.id, req.session.user.username);
        imported++;
      }
      res.json({ ok: true, imported, skipped });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
);

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
app.get('/api/notes/:id/shares', requireAuth, (req, res) => res.json(db.getSharesForNote(req.params.id, req.session.user.username)));
app.delete('/api/shares/:token', requireAuth, (req, res) => { db.deleteShare(req.params.token, req.session.user.username); res.json({ ok: true }); });
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
  if (!req.params.id) return res.status(400).json({ error: 'ID mancante' });
  const noteId   = req.params.id;
  const username = req.session.user.username;

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
app.get('/api/admin/settings', requireAuth, requireAdmin, (req, res) => res.json(db.getAllSettings()));
app.post('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const settings = req.body;
  Object.entries(settings).forEach(([k,v]) => db.setSetting(k, v));
  res.json({ ok: true });
});

// Export globale (tutti gli utenti)
app.get('/api/admin/export', requireAuth, requireAdmin, async (req, res) => {
  const notes = db.getAllNotesForExport(); // tutti
  const users = db.getUsers();
  res.set('Content-Type','application/zip').set('Content-Disposition',`attachment; filename="quetza-full-${new Date().toISOString().slice(0,10)}.zip"`);
  const arc = archiver('zip',{zlib:{level:6}}); arc.pipe(res);
  arc.append(JSON.stringify({ users, notes: notes.map(noteForManifest) },null,2),{name:'manifest.json'});
  for (const note of notes) {
    if (!note.has_audio) continue;
    const audio = db.getAudio(note.id, null);
    if (!audio?.length) continue;
    audio.forEach((a,i)=>arc.append(a.data,{name:`audio/${note.id}_${i}.${a.mime?.includes('mp4')?'mp4':'webm'}`}));
  }
  arc.finalize();
});

// Import globale
app.post('/api/admin/import', requireAuth, requireAdmin,
  multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024*1024}}).single('archive'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nessun file' });
    try {
      const zip = new AdmZip(req.file.buffer);
      const data = JSON.parse(zip.getEntry('manifest.json')?.getData().toString('utf8')||'null');
      if (!data) return res.status(400).json({ error: 'ZIP non valido' });
      let imported=0, skipped=0, usersImported=0;
      // Importa utenti se presenti
      if (data.users) {
        for (const u of data.users) {
          if (!u.username) continue;
          const ex = db.getUserByUsername(u.username);
          if (!ex) {
            try {
              db.createUser(u.username, 'changeme123', u.display_name||u.username, 0, u.source||'local');
              // Password provvisoria: va cambiata al primo accesso
              db.resetPassword(u.username, 'changeme123', true);
              usersImported++;
            } catch {}
          }
        }
      }
      const notes = data.notes || data; // supporta entrambi i formati
      for (const note of notes) {
        if (!note.id||!note.title){skipped++;continue;}
        const owner = note.username || 'admin';
        db.upsertNoteFromImport(note.id, owner, note);
        restoreAudioFromZip(zip, note.id, owner);
        imported++;
      }
      res.json({ ok:true, imported, skipped, usersImported });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
);

// ── Pagina admin ──────────────────────────────────────────────
app.get('/admin', requireAuth, requireAdmin, (req, res) => res.sendFile(path.join(__dirname,'public','admin.html')));

// ── Catch-all ─────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

// ── Server ────────────────────────────────────────────────────
// Con i certificati: HTTPS su HTTPS_PORT + redirect da PORT.
// Senza certificati: solo HTTP su PORT. Prima il redirect veniva avviato
// comunque su PORT e poi app.listen(PORT) falliva con EADDRINUSE, quindi
// senza certificati l'app non partiva affatto.
if (HAS_CERTS) {
  https.createServer({ cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) }, app)
    .listen(HTTPS_PORT, () => console.log(`Quetza HTTPS :${HTTPS_PORT}`));

  http.createServer((req, res) => {
    const host = (req.headers.host || 'localhost').replace(String(PORT), String(HTTPS_PORT));
    res.writeHead(301, { Location: `https://${host}${req.url}` });
    res.end();
  }).listen(PORT, () => console.log(`Quetza redirect HTTP :${PORT} → :${HTTPS_PORT}`));
} else {
  console.warn(`[quetza] Certificati non trovati (${CERT_PATH}) — avvio in HTTP puro. La registrazione audio richiede HTTPS o localhost.`);
  app.listen(PORT, () => console.log(`Quetza HTTP :${PORT}`));
}