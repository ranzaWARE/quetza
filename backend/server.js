const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const db = require('./db');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_DIR = path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'quetza.db'));

// ── Middleware ───────────────────────────────────────────────
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DB_DIR }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // set true if behind HTTPS
    httpOnly: true,
    maxAge: 14 * 24 * 60 * 60 * 1000 // 14 days
  }
}));

// ── Static files ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Audio upload (multer, stored in memory) ──────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB max
});

// ── Auth middleware ───────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.accepts('json')) return res.status(401).json({ error: 'Non autenticato' });
  res.redirect('/login.html');
}

// ── Auth routes ───────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username e password richiesti' });
  try {
    const user = await auth.authenticate(username, password);
    req.session.user = user;
    res.json({ ok: true, user: { username: user.username, displayName: user.displayName } });
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(401).json({ error: 'Credenziali non valide' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// ── Notes API ─────────────────────────────────────────────────
app.get('/api/notes', requireAuth, (req, res) => {
  const notes = db.getNotesByUser(req.session.user.username);
  res.json(notes);
});

app.get('/api/notes/:id', requireAuth, (req, res) => {
  const note = db.getNoteById(req.params.id, req.session.user.username);
  if (!note) return res.status(404).json({ error: 'Nota non trovata' });
  res.json(note);
});

app.post('/api/notes', requireAuth, (req, res) => {
  const id = uuidv4();
  const note = db.createNote(id, req.session.user.username, req.body.title || 'Nuova nota');
  res.status(201).json(note);
});

app.patch('/api/notes/:id', requireAuth, (req, res) => {
  const ok = db.updateNoteMeta(req.params.id, req.session.user.username, req.body);
  if (!ok) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true });
});

app.put('/api/notes/:id/content', requireAuth, (req, res) => {
  const { strokes, images, thumbnail, grid } = req.body;
  const ok = db.saveContent(req.params.id, req.session.user.username, strokes, images, thumbnail, grid);
  if (!ok) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true });
});

app.delete('/api/notes/:id', requireAuth, (req, res) => {
  const ok = db.deleteNote(req.params.id, req.session.user.username);
  if (!ok) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true });
});

// ── Audio API ─────────────────────────────────────────────────
app.post('/api/notes/:id/audio', requireAuth, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file audio' });
  const ok = db.saveAudio(req.params.id, req.session.user.username, req.file.buffer, req.file.mimetype);
  if (!ok) return res.status(404).json({ error: 'Nota non trovata' });
  res.json({ ok: true });
});

app.get('/api/notes/:id/audio', requireAuth, (req, res) => {
  const audio = db.getAudio(req.params.id, req.session.user.username);
  if (!audio) return res.status(404).json({ error: 'Audio non trovato' });
  res.set('Content-Type', audio.mime || 'audio/webm');
  res.set('Content-Length', audio.data.length);
  res.set('Accept-Ranges', 'bytes');
  res.send(audio.data);
});

app.delete('/api/notes/:id/audio', requireAuth, (req, res) => {
  db.deleteAudio(req.params.id, req.session.user.username);
  res.json({ ok: true });
});

// ── Export / Import ──────────────────────────────────────────
const archiver = require('archiver');
const AdmZip   = require('adm-zip');

// GET /api/export → ZIP con tutte le note dell'utente
app.get('/api/export', requireAuth, async (req, res) => {
  const username = req.session.user.username;
  const notes = db.getAllNotesForExport(username);

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition',
    `attachment; filename="quetza-${username}-${new Date().toISOString().slice(0,10)}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  const manifest = notes.map(n => ({
    id: n.id, title: n.title, grid: n.grid,
    created_at: n.created_at, updated_at: n.updated_at,
    has_audio: !!n.has_audio,
    strokes:   n.strokes   ? JSON.parse(n.strokes)   : [],
    images:    n.images    ? JSON.parse(n.images)     : [],
    thumbnail: n.thumbnail || null,
  }));
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  for (const note of notes) {
    if (!note.has_audio) continue;
    const audio = db.getAudio(note.id, username);
    if (!audio || !audio.data) continue;
    const ext = (audio.mime || '').includes('mp4') ? 'mp4' : 'webm';
    archive.append(audio.data, { name: `audio/${note.id}.${ext}` });
  }

  archive.finalize();
});

// POST /api/import → carica ZIP esportato
app.post('/api/import', requireAuth,
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } }).single('archive'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nessun file' });
    const username = req.session.user.username;
    try {
      const zip = new AdmZip(req.file.buffer);
      const manifestEntry = zip.getEntry('manifest.json');
      if (!manifestEntry) return res.status(400).json({ error: 'ZIP non valido' });

      const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
      let imported = 0, skipped = 0;

      for (const note of manifest) {
        if (!note.id || !note.title) { skipped++; continue; }
        db.upsertNoteFromImport(note.id, username, note);
        const aw = zip.getEntry(`audio/${note.id}.webm`);
        const am = zip.getEntry(`audio/${note.id}.mp4`);
        const ae = aw || am;
        if (ae) db.saveAudio(note.id, username, ae.getData(), am ? 'audio/mp4' : 'audio/webm');
        imported++;
      }
      res.json({ ok: true, imported, skipped });
    } catch(e) {
      console.error('Import error:', e);
      res.status(500).json({ error: e.message });
    }
  }
);

// ── Catch-all → index ─────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Quetza running on http://localhost:${PORT}`);
  console.log(`LDAP: ${process.env.LDAP_ENABLED === 'true' ? 'enabled → ' + process.env.LDAP_URL : 'disabled (local users only)'}`);
});