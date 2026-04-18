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
const DB_DIR = path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'quetza.db'));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DB_DIR }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false, saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 14*24*60*60*1000 }
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

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.accepts('json')) return res.status(401).json({ error: 'Non autenticato' });
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
    const user = await auth.authenticate(username, password);
    req.session.user = user;
    res.json({ ok: true, user });
  } catch(err) {
    res.status(401).json({ error: 'Credenziali non valide' });
  }
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
    if (!dbUser) { try { db.createUser(username, null, payload.name||username, 0); } catch {} dbUser = db.getUserByUsername(username); }
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
app.get('/api/me', requireAuth, (req, res) => { res.json({ user: req.session.user }); });

// ── Notes API ─────────────────────────────────────────────────
app.get('/api/notes', requireAuth, (req, res) => res.json(db.getNotesByUser(req.session.user.username)));
app.get('/api/notes/:id', requireAuth, (req, res) => {
  const n = db.getNoteById(req.params.id, req.session.user.username);
  if (!n) return res.status(404).json({ error: 'Nota non trovata' });
  res.json(n);
});
app.post('/api/notes', requireAuth, (req, res) => {
  const n = db.createNote(uuidv4(), req.session.user.username, req.body.title||'Nuova nota');
  res.status(201).json(n);
});
app.patch('/api/notes/:id', requireAuth, (req, res) => {
  if (!db.updateNoteMeta(req.params.id, req.session.user.username, req.body)) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true });
});
app.put('/api/notes/:id/content', requireAuth, (req, res) => {
  try {
    const { strokes, images, thumbnail, grid, canvasText, textItems } = req.body;
    if (!db.saveContent(req.params.id, req.session.user.username, strokes, images, thumbnail, grid, canvasText, textItems)) return res.status(404).json({ error: 'Nota non trovata' });
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

// Whisper trascrizione con diarizzazione (via microservizio Python)
app.post('/api/notes/:id/transcribe', requireAuth, async (req, res) => {
  const note = db.getNoteById(req.params.id, req.session.user.username);
  if (!note) return res.status(404).json({ error: 'Nota non trovata' });
  const sessions = db.getAudio(req.params.id, req.session.user.username);
  if (!sessions?.length) return res.status(404).json({ error: 'Nessun audio da trascrivere' });

  const whisperUrl = process.env.WHISPER_URL || db.getSetting('whisper_url') || 'http://localhost:9876';

  // Verifica che il servizio sia disponibile
  try {
    const health = await fetch(`${whisperUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error('not ok');
  } catch {
    return res.status(503).json({ error: 'Servizio Whisper non disponibile. Controlla che il container quetza-whisper sia avviato.' });
  }

  // Manda l'audio al microservizio Python
  try {
    const audioBuffer = Buffer.concat(sessions.map(s => s.data));
    const mime = sessions[0]?.mime || 'audio/webm';
    const ext  = mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : 'webm';

    const { FormData, Blob } = await import('node:buffer').then(() => ({
      FormData: globalThis.FormData || require('form-data'),
      Blob: globalThis.Blob
    })).catch(() => ({ FormData: require('form-data'), Blob: null }));

    // Usa form-data per compatibilità Node.js < 18
    // Usa FormData nativo (Node.js 18+)
    const { FormData: FD, Blob: BL } = globalThis;
    let r;
    if (FD && BL) {
      const form = new FD();
      form.append('audio', new BL([audioBuffer], { type: mime }), `audio.${ext}`);
      form.append('diarize', 'true');
      r = await fetch(`${whisperUrl}/transcribe`, { method:'POST', body:form, signal:AbortSignal.timeout(300000) });
    } else {
      // Fallback form-data per Node < 18
      const FormDataLib = require('form-data');
      const form = new FormDataLib();
      form.append('audio', audioBuffer, { filename:`audio.${ext}`, contentType:mime });
      form.append('diarize', 'true');
      r = await fetch(`${whisperUrl}/transcribe`, { method:'POST', body:form, headers:form.getHeaders(), signal:AbortSignal.timeout(300000) });
    }

    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: 'Errore sconosciuto' }));
      return res.status(500).json({ error: err.error || 'Errore trascrizione' });
    }

    const result = await r.json();

    // Salva la trascrizione nel DB e ricostruisce l'indice FTS
    db.saveWhisperText(req.params.id, result.text || '', result.segments || null);

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
    res.status(500).json({ error: 'Errore durante la trascrizione: ' + e.message });
  }
});

// ── Export / Import (personale) ───────────────────────────────
const archiver = require('archiver');
const AdmZip   = require('adm-zip');

app.get('/api/export', requireAuth, async (req, res) => {
  const username = req.session.user.username;
  const notes = db.getAllNotesForExport(username);
  res.set('Content-Type','application/zip').set('Content-Disposition',`attachment; filename="quetza-${username}-${new Date().toISOString().slice(0,10)}.zip"`);
  const arc = archiver('zip',{zlib:{level:6}}); arc.pipe(res);
  arc.append(JSON.stringify(notes.map(n=>({...n,strokes:n.strokes?JSON.parse(n.strokes):[],images:n.images?JSON.parse(n.images):[]})),null,2),{name:'manifest.json'});
  for (const note of notes) {
    if (!note.has_audio) continue;
    const audio = db.getAudio(note.id, username);
    if (!audio?.length) continue;
    audio.forEach((a,i)=>arc.append(a.data,{name:`audio/${note.id}_${i}.${a.mime?.includes('mp4')?'mp4':'webm'}`}));
  }
  arc.finalize();
});

app.post('/api/import', requireAuth,
  multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024*1024}}).single('archive'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nessun file' });
    try {
      const zip = new AdmZip(req.file.buffer);
      const manifest = JSON.parse(zip.getEntry('manifest.json')?.getData().toString('utf8') || 'null');
      if (!manifest) return res.status(400).json({ error: 'ZIP non valido' });
      let imported=0, skipped=0;
      for (const note of manifest) {
        if (!note.id||!note.title){skipped++;continue;}
        db.upsertNoteFromImport(note.id, req.session.user.username, note);
        ['webm','mp4'].forEach((ext,i)=>{
          const e=zip.getEntry(`audio/${note.id}_0.${ext}`)||zip.getEntry(`audio/${note.id}.${ext}`);
          if(e) db.saveAudio(note.id,req.session.user.username,e.getData(),`audio/${ext}`);
        });
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
  res.json({ title:note.title, strokes:note.strokes, images:note.images, grid:note.grid, has_audio:note.has_audio, shared_by:share.username, expires_at:share.expires_at });
});
app.get('/api/shared/:token/audio/:session?', (req, res) => {
  const share = db.getShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Link non valido' });
  const sessions = db.getAudio(share.note_id, share.username);
  if (!sessions?.length) return res.status(404).json({ error: 'Audio non trovato' });
  if (req.params.session!==undefined) {
    const idx=parseInt(req.params.session);
    if(idx>=sessions.length) return res.status(404).json({error:'Sessione non trovata'});
    const a=sessions[idx]; res.set('Content-Type',a.mime||'audio/webm'); return res.send(a.data);
  }
  if (sessions.length===1){res.set('Content-Type',sessions[0].mime||'audio/webm');return res.send(sessions[0].data);}
  res.json({sessions:sessions.map((s,i)=>({index:i,mime:s.mime}))});
});
app.get('/share/:token', (req, res) => res.sendFile(path.join(__dirname,'public','share.html')));

// ── Admin API ─────────────────────────────────────────────────

// Statistiche
app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => res.json(db.getStats()));

// Auto-trascrizione in background (chiamata dopo stop registrazione)
// Non aspetta il risultato — risponde subito 202 e processa in background
app.post('/api/notes/:id/transcribe-async', requireAuth, async (req, res) => {
  if (!req.params.id) return res.status(400).json({ error: 'ID mancante' });
  // Risponde subito
  res.status(202).json({ ok: true, message: 'Trascrizione avviata in background' });

  // Processa in background senza await
  (async () => {
    try {
      const whisperUrl = process.env.WHISPER_URL || db.getSetting('whisper_url') || 'http://quetza-whisper:9876';
      const health = await fetch(`${whisperUrl}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!health?.ok) return;

      const sessions = db.getAudio(req.params.id, req.session.user.username);
      if (!sessions?.length) return;

      const audioBuffer = Buffer.concat(sessions.map(s => s.data));
      const mime = sessions[0]?.mime || 'audio/webm';
      const ext  = mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : 'webm';

      const { FormData: FD, Blob: BL } = globalThis;
      let r;
      if (FD && BL) {
        const form = new FD();
        form.append('audio', new BL([audioBuffer], { type: mime }), `audio.${ext}`);
        form.append('diarize', 'true');
        r = await fetch(`${whisperUrl}/transcribe`, { method:'POST', body:form, signal:AbortSignal.timeout(300000) });
      } else {
        const FormDataLib = require('form-data');
        const form = new FormDataLib();
        form.append('audio', audioBuffer, { filename:`audio.${ext}`, contentType:mime });
        form.append('diarize', 'true');
        r = await fetch(`${whisperUrl}/transcribe`, { method:'POST', body:form, headers:form.getHeaders(), signal:AbortSignal.timeout(300000) });
      }

      if (!r.ok) return;
      const result = await r.json();
      db.saveWhisperText(req.params.id, result.text || '', result.segments || null);
      console.log(`[whisper] Auto-transcribed note ${req.params.id} (${result.language}, diarized:${result.diarized})`);
    } catch(e) {
      console.warn('[whisper] Auto-transcription failed:', e.message);
    }
  })();
});

// Health check Whisper (proxy verso il container Python)
app.get('/api/admin/whisper-health', requireAuth, requireAdmin, async (req, res) => {
  const whisperUrl = process.env.WHISPER_URL || db.getSetting('whisper_url') || 'http://quetza-whisper:9876';
  try {
    const r = await fetch(`${whisperUrl}/health`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    res.json(d);
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
  arc.append(JSON.stringify({ users, notes: notes.map(n=>({...n,strokes:n.strokes?JSON.parse(n.strokes):[],images:n.images?JSON.parse(n.images):[]})) },null,2),{name:'manifest.json'});
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
          if (!ex) { try { db.createUser(u.username, 'changeme123', u.display_name||u.username, 0); usersImported++; } catch {} }
        }
      }
      const notes = data.notes || data; // supporta entrambi i formati
      for (const note of notes) {
        if (!note.id||!note.title){skipped++;continue;}
        db.upsertNoteFromImport(note.id, note.username||'admin', note);
        ['webm','mp4'].forEach(ext=>{
          const e=zip.getEntry(`audio/${note.id}_0.${ext}`)||zip.getEntry(`audio/${note.id}.${ext}`);
          if(e) db.saveAudio(note.id, note.username||'admin', e.getData(), `audio/${ext}`);
        });
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
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
http.createServer((req,res)=>{
  const host=(req.headers.host||'localhost').replace(String(PORT),String(HTTPS_PORT));
  res.writeHead(301,{Location:`https://${host}${req.url}`}); res.end();
}).listen(PORT);

const certPath='/app/certs/server.crt', keyPath='/app/certs/server.key';
if (fs.existsSync(certPath)&&fs.existsSync(keyPath)) {
  https.createServer({cert:fs.readFileSync(certPath),key:fs.readFileSync(keyPath)},app)
    .listen(HTTPS_PORT,()=>console.log(`Quetza HTTPS :${HTTPS_PORT}`));
} else {
  app.listen(PORT,()=>console.log(`Quetza HTTP :${PORT}`));
}