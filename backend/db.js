const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'quetza.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username     TEXT PRIMARY KEY,
    password_hash TEXT,
    display_name TEXT NOT NULL DEFAULT '',
    is_admin     INTEGER NOT NULL DEFAULT 0,
    is_active    INTEGER NOT NULL DEFAULT 1,
    source       TEXT NOT NULL DEFAULT 'local',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_login   TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id              TEXT PRIMARY KEY,
    username        TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT 'Nuova nota',
    strokes         TEXT,
    images          TEXT,
    thumbnail       TEXT,
    grid            TEXT DEFAULT 'lines',
    has_audio       INTEGER DEFAULT 0,
    canvas_text     TEXT,
    whisper_text     TEXT,
    whisper_segments TEXT,
    text_items       TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audio (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id  TEXT NOT NULL,
    username TEXT NOT NULL,
    session  INTEGER NOT NULL DEFAULT 0,
    data     BLOB NOT NULL,
    mime     TEXT DEFAULT 'audio/webm',
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(username);
  CREATE INDEX IF NOT EXISTS idx_audio_note ON audio(note_id);

  CREATE TABLE IF NOT EXISTS shares (
    token      TEXT PRIMARY KEY,
    note_id    TEXT NOT NULL,
    username   TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
  );
`);

// ── Migrazioni ────────────────────────────────────────────────
// audio: aggiunge session/id se mancanti
try { db.exec(`ALTER TABLE audio ADD COLUMN session INTEGER NOT NULL DEFAULT 0`); } catch {}
try {
  const cols = db.prepare(`PRAGMA table_info(audio)`).all().map(c => c.name);
  if (!cols.includes('id')) {
    db.exec(`
      ALTER TABLE audio RENAME TO audio_old;
      CREATE TABLE audio (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id  TEXT NOT NULL,
        username TEXT NOT NULL,
        session  INTEGER NOT NULL DEFAULT 0,
        data     BLOB NOT NULL,
        mime     TEXT DEFAULT 'audio/webm',
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
      );
      INSERT INTO audio (note_id, username, session, data, mime)
        SELECT note_id, username, 0, data, mime FROM audio_old;
      DROP TABLE audio_old;
    `);
  }
} catch(e) {}

// Migra colonne nuove se mancanti
try { db.exec(`ALTER TABLE notes ADD COLUMN canvas_text TEXT`); } catch {}
try { db.exec(`ALTER TABLE notes ADD COLUMN whisper_text TEXT`); } catch {}
try { db.exec(`ALTER TABLE notes ADD COLUMN text_items TEXT`); } catch {}
try { db.exec(`ALTER TABLE notes ADD COLUMN whisper_segments TEXT`); } catch {}

// Indice FTS — ricrea se schema cambiato (rimuove vecchia versione con content table)
try {
  // Controlla se la vecchia tabella usa content table (causa "no such column: T.note_id")
  db.prepare(`INSERT INTO notes_fts(note_id,username,title,canvas_text,whisper_text) VALUES('_test','_test','','','') `).run();
  db.prepare(`DELETE FROM notes_fts WHERE note_id='_test'`).run();
} catch(e) {
  // Schema vecchio/incompatibile — droppa e ricrea
  console.log('FTS: recreating table (schema migration)');
  try { db.exec(`DROP TABLE IF EXISTS notes_fts`); } catch {}
}
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    note_id UNINDEXED,
    username UNINDEXED,
    title,
    canvas_text,
    whisper_text
  );
`);

// ── Seed: crea admin/admin se non esiste ancora nessun utente ─
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'quetza_salt').digest('hex');
}

const adminExists = db.prepare(`SELECT 1 FROM users WHERE username = 'admin'`).get();
if (!adminExists) {
  db.prepare(`
    INSERT INTO users (username, password_hash, display_name, is_admin, source)
    VALUES ('admin', ?, 'Administrator', 1, 'local')
  `).run(hashPassword('admin'));
}

// ── Users ─────────────────────────────────────────────────────
function getUsers() {
  return db.prepare(`SELECT username, display_name, is_admin, is_active, source, created_at, last_login FROM users ORDER BY is_admin DESC, username ASC`).all();
}

function getUserByUsername(username) {
  return db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
}

function createUser(username, password, displayName, isAdmin = 0) {
  const existing = db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(username);
  if (existing) throw new Error('Utente già esistente');
  db.prepare(`
    INSERT INTO users (username, password_hash, display_name, is_admin, source)
    VALUES (?, ?, ?, ?, 'local')
  `).run(username, hashPassword(password), displayName || username, isAdmin ? 1 : 0);
}

function updateUser(username, { displayName, isAdmin, isActive }) {
  const sets = [], vals = [];
  if (displayName !== undefined) { sets.push('display_name = ?'); vals.push(displayName); }
  if (isAdmin    !== undefined) { sets.push('is_admin = ?');     vals.push(isAdmin ? 1 : 0); }
  if (isActive   !== undefined) { sets.push('is_active = ?');    vals.push(isActive ? 1 : 0); }
  if (!sets.length) return;
  vals.push(username);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE username = ?`).run(...vals);
}

function resetPassword(username, newPassword) {
  db.prepare(`UPDATE users SET password_hash = ? WHERE username = ?`).run(hashPassword(newPassword), username);
}

function deleteUser(username) {
  db.prepare(`DELETE FROM users WHERE username = ?`).run(username);
}

function countAdmins() {
  return db.prepare(`SELECT COUNT(*) as n FROM users WHERE is_admin = 1 AND is_active = 1`).get().n;
}

function verifyPassword(username, password) {
  const user = db.prepare(`SELECT password_hash, is_active FROM users WHERE username = ? AND source = 'local'`).get(username);
  if (!user || !user.is_active) return false;
  return user.password_hash === hashPassword(password);
}

function touchLogin(username) {
  db.prepare(`UPDATE users SET last_login = datetime('now') WHERE username = ?`).run(username);
}

// ── Settings ──────────────────────────────────────────────────
function getSetting(key) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function getAllSettings() {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ── Notes ─────────────────────────────────────────────────────
function getNotesByUser(username) {
  return db.prepare(`SELECT id, title, thumbnail, grid, has_audio, created_at, updated_at FROM notes WHERE username = ? ORDER BY updated_at DESC`).all(username);
}

function getNoteById(id, username) {
  const note = username
    ? db.prepare(`SELECT * FROM notes WHERE id = ? AND username = ?`).get(id, username)
    : db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id);
  if (!note) return null;
  return {
    ...note,
    strokes:          note.strokes          ? JSON.parse(note.strokes)          : [],
    images:           note.images           ? JSON.parse(note.images)           : [],
    text_items:       note.text_items       ? JSON.parse(note.text_items)       : [],
    whisper_segments: note.whisper_segments ? JSON.parse(note.whisper_segments) : null,
  };
}

function createNote(id, username, title) {
  db.prepare(`INSERT INTO notes (id, username, title, strokes, images) VALUES (?, ?, ?, '[]', '[]')`).run(id, username, title);
  return getNoteById(id, username);
}

function updateNoteMeta(id, username, { title, grid }) {
  const sets = [], vals = [];
  if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
  if (grid  !== undefined) { sets.push('grid = ?');  vals.push(grid); }
  if (!sets.length) return true;
  sets.push("updated_at = datetime('now')");
  vals.push(id, username);
  return db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? AND username = ?`).run(...vals).changes > 0;
}

function saveContent(id, username, strokes, images, thumbnail, grid, canvasText, textItems) {
  const r = db.prepare(`UPDATE notes SET strokes=?, images=?, thumbnail=?, grid=?, canvas_text=?, text_items=?, updated_at=datetime('now') WHERE id=? AND username=?`)
    .run(JSON.stringify(strokes||[]), JSON.stringify(images||[]), thumbnail||null, grid||'lines', canvasText||null, JSON.stringify(textItems||[]), id, username);
  if (r.changes > 0) { try { rebuildFts(id); } catch(e) { console.warn('FTS rebuild:', e.message); } }
  return r.changes > 0;
}

function saveWhisperText(noteId, text, segments) {
  db.prepare(`UPDATE notes SET whisper_text=?, whisper_segments=?, updated_at=datetime('now') WHERE id=?`)
    .run(text||'', segments ? JSON.stringify(segments) : null, noteId);
  try { rebuildFts(noteId); } catch(e) { console.warn('FTS rebuild whisper:', e.message); }
}

function rebuildFts(noteId) {
  const n = db.prepare(`SELECT id, username, title, canvas_text, whisper_text FROM notes WHERE id=?`).get(noteId);
  if (!n) return;
  // Cancella record esistente e reinserisci
  db.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).run(n.id);
  db.prepare(`INSERT INTO notes_fts(note_id, username, title, canvas_text, whisper_text) VALUES(?,?,?,?,?)`)
    .run(n.id, n.username||'', n.title||'', n.canvas_text||'', n.whisper_text||'');
}

function searchNotes(username, query) {
  if (!query?.trim()) return [];
  try {
    return db.prepare(`
      SELECT n.id, n.title, n.thumbnail, n.has_audio, n.updated_at,
             snippet(notes_fts, 2, '<mark>', '</mark>', '…', 20) as snippet
      FROM notes_fts f
      JOIN notes n ON n.id = f.note_id
      WHERE notes_fts MATCH ? AND f.username = ?
      ORDER BY rank LIMIT 50
    `).all(query.trim() + '*', username);
  } catch { return []; }
}

function deleteNote(id, username) {
  return db.prepare(`DELETE FROM notes WHERE id = ? AND username = ?`).run(id, username).changes > 0;
}

// ── Audio ─────────────────────────────────────────────────────
function saveAudio(noteId, username, buffer, mime) {
  const note = db.prepare(`SELECT id FROM notes WHERE id = ? AND username = ?`).get(noteId, username);
  if (!note) return false;
  const row = db.prepare(`SELECT MAX(session) as m FROM audio WHERE note_id = ?`).get(noteId);
  const session = row && row.m !== null ? row.m + 1 : 0;
  db.prepare(`INSERT INTO audio (note_id, username, session, data, mime) VALUES (?, ?, ?, ?, ?)`).run(noteId, username, session, buffer, mime);
  db.prepare(`UPDATE notes SET has_audio = 1, updated_at = datetime('now') WHERE id = ?`).run(noteId);
  return true;
}

function getAudio(noteId, username) {
  return username
    ? db.prepare(`SELECT data, mime, session FROM audio WHERE note_id = ? AND username = ? ORDER BY session ASC`).all(noteId, username)
    : db.prepare(`SELECT data, mime, session FROM audio WHERE note_id = ? ORDER BY session ASC`).all(noteId);
}

function deleteAudio(noteId, username) {
  db.prepare(`DELETE FROM audio WHERE note_id = ? AND username = ?`).run(noteId, username);
  db.prepare(`UPDATE notes SET has_audio = 0 WHERE id = ?`).run(noteId);
}

function appendAudioChunk(noteId, username, chunk, mime) {
  const note = db.prepare(`SELECT id FROM notes WHERE id = ? AND username = ?`).get(noteId, username);
  if (!note) return false;
  const existing = db.prepare(`SELECT id, data, mime FROM audio WHERE note_id = ? ORDER BY session DESC LIMIT 1`).get(noteId);
  if (existing) {
    db.prepare(`UPDATE audio SET data = ?, mime = ? WHERE id = ?`).run(Buffer.concat([existing.data, chunk]), mime || existing.mime, existing.id);
  } else {
    db.prepare(`INSERT INTO audio (note_id, username, session, data, mime) VALUES (?, ?, 0, ?, ?)`).run(noteId, username, chunk, mime||'audio/webm');
    db.prepare(`UPDATE notes SET has_audio = 1, updated_at = datetime('now') WHERE id = ?`).run(noteId);
  }
  return true;
}

// ── Shares ────────────────────────────────────────────────────
function createShare(token, noteId, username, expiresAt) {
  db.prepare(`INSERT INTO shares (token, note_id, username, expires_at) VALUES (?, ?, ?, ?)`).run(token, noteId, username, expiresAt||null);
}

function getShare(token) {
  const s = db.prepare(`SELECT * FROM shares WHERE token = ?`).get(token);
  if (!s) return null;
  if (s.expires_at && new Date(s.expires_at) < new Date()) return null;
  return s;
}

function deleteShare(token, username) {
  db.prepare(`DELETE FROM shares WHERE token = ? AND username = ?`).run(token, username);
}

function getSharesForNote(noteId, username) {
  return db.prepare(`SELECT token, expires_at, created_at FROM shares WHERE note_id = ? AND username = ? ORDER BY created_at DESC`).all(noteId, username);
}

// ── Export / Import globale (admin) ───────────────────────────
function getAllNotesForExport(username) {
  return username
    ? db.prepare(`SELECT id, title, grid, strokes, images, thumbnail, has_audio, created_at, updated_at, username FROM notes WHERE username = ? ORDER BY updated_at DESC`).all(username)
    : db.prepare(`SELECT id, title, grid, strokes, images, thumbnail, has_audio, created_at, updated_at, username FROM notes ORDER BY username, updated_at DESC`).all();
}

function upsertNoteFromImport(id, username, note) {
  db.prepare(`
    INSERT INTO notes (id, username, title, strokes, images, thumbnail, grid, has_audio, canvas_text, text_items, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, strokes=excluded.strokes, images=excluded.images,
      thumbnail=excluded.thumbnail, grid=excluded.grid, has_audio=excluded.has_audio,
      canvas_text=excluded.canvas_text, text_items=excluded.text_items, updated_at=excluded.updated_at
  `).run(id, username, note.title||'Senza titolo', JSON.stringify(note.strokes||[]), JSON.stringify(note.images||[]),
    note.thumbnail||null, note.grid||'lines', note.has_audio?1:0,
    note.canvas_text||null, JSON.stringify(note.text_items||[]),
    note.created_at||new Date().toISOString(), note.updated_at||new Date().toISOString());
  rebuildFts(id);
}

// Statistiche per admin
function getStats() {
  const users  = db.prepare(`SELECT COUNT(*) as n FROM users`).get().n;
  const notes  = db.prepare(`SELECT COUNT(*) as n FROM notes`).get().n;
  const audio  = db.prepare(`SELECT COALESCE(SUM(length(data)),0) as n FROM audio`).get().n;
  const perUser = db.prepare(`
    SELECT u.username, u.display_name, u.is_admin, u.last_login,
           COUNT(n.id) as note_count,
           COALESCE(SUM(length(a.data)),0) as audio_bytes
    FROM users u
    LEFT JOIN notes n ON n.username = u.username
    LEFT JOIN audio a ON a.username = u.username
    GROUP BY u.username ORDER BY u.username
  `).all();
  return { users, notes, audio_bytes: audio, per_user: perUser };
}

module.exports = {
  // users
  getUsers, getUserByUsername, createUser, updateUser, resetPassword, deleteUser,
  countAdmins, verifyPassword, touchLogin, hashPassword,
  // settings
  getSetting, setSetting, getAllSettings,
  // notes
  getNotesByUser, getNoteById, createNote, updateNoteMeta, saveContent, deleteNote,
  saveWhisperText, searchNotes, rebuildFts,
  // audio
  saveAudio, getAudio, deleteAudio, appendAudioChunk,
  // shares
  createShare, getShare, deleteShare, getSharesForNote,
  // export/import
  getAllNotesForExport, upsertNoteFromImport,
  // stats
  getStats,
};