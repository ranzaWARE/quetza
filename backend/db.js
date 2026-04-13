const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'quetza.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrazione: aggiunge colonna 'session' se tabella audio esiste senza di essa
try {
  db.exec(`ALTER TABLE audio ADD COLUMN session INTEGER NOT NULL DEFAULT 0`);
} catch(e) { /* colonna già presente */ }
// Migrazione: aggiunge colonna 'id' autoincrement se necessario (più complessa — ricrea tabella)
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
} catch(e) { console.log('Migration note:', e.message); }

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id           TEXT PRIMARY KEY,
    username     TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT 'Nuova nota',
    strokes      TEXT,
    images       TEXT,
    thumbnail    TEXT,
    grid         TEXT DEFAULT 'lines',
    has_audio    INTEGER DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audio (
    note_id  TEXT PRIMARY KEY,
    username TEXT NOT NULL,
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

function getNotesByUser(username) {
  return db.prepare(`
    SELECT id, title, thumbnail, grid, has_audio, created_at, updated_at
    FROM notes WHERE username = ?
    ORDER BY updated_at DESC
  `).all(username);
}

function getNoteById(id, username) {
  const note = db.prepare(`
    SELECT * FROM notes WHERE id = ? AND username = ?
  `).get(id, username);
  if (!note) return null;
  return {
    ...note,
    strokes: note.strokes ? JSON.parse(note.strokes) : [],
    images:  note.images  ? JSON.parse(note.images)  : [],
  };
}

function createNote(id, username, title) {
  db.prepare(`
    INSERT INTO notes (id, username, title, strokes, images)
    VALUES (?, ?, ?, '[]', '[]')
  `).run(id, username, title);
  return getNoteById(id, username);
}

function updateNoteMeta(id, username, { title, grid }) {
  const sets = [];
  const vals = [];
  if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
  if (grid  !== undefined) { sets.push('grid = ?');  vals.push(grid);  }
  if (!sets.length) return true;
  sets.push("updated_at = datetime('now')");
  vals.push(id, username);
  const r = db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? AND username = ?`).run(...vals);
  return r.changes > 0;
}

function saveContent(id, username, strokes, images, thumbnail, grid) {
  const r = db.prepare(`
    UPDATE notes
    SET strokes = ?, images = ?, thumbnail = ?, grid = ?, updated_at = datetime('now')
    WHERE id = ? AND username = ?
  `).run(
    JSON.stringify(strokes || []),
    JSON.stringify(images  || []),
    thumbnail || null,
    grid || 'lines',
    id, username
  );
  return r.changes > 0;
}

function deleteNote(id, username) {
  const r = db.prepare(`DELETE FROM notes WHERE id = ? AND username = ?`).run(id, username);
  return r.changes > 0;
}

function saveAudio(noteId, username, buffer, mime) {
  const note = db.prepare(`SELECT id FROM notes WHERE id = ? AND username = ?`).get(noteId, username);
  if (!note) return false;
  // Calcola il numero di sessione successivo
  const row = db.prepare(`SELECT MAX(session) as m FROM audio WHERE note_id = ?`).get(noteId);
  const session = row && row.m !== null ? row.m + 1 : 0;
  db.prepare(`
    INSERT INTO audio (note_id, username, session, data, mime) VALUES (?, ?, ?, ?, ?)
  `).run(noteId, username, session, buffer, mime);
  db.prepare(`UPDATE notes SET has_audio = 1, updated_at = datetime('now') WHERE id = ?`).run(noteId);
  return true;
}

function getAudio(noteId, username) {
  // Restituisce tutte le sessioni in ordine
  return db.prepare(`
    SELECT data, mime, session FROM audio
    WHERE note_id = ? AND username = ?
    ORDER BY session ASC
  `).all(noteId, username);
}

function deleteAudio(noteId, username) {
  db.prepare(`DELETE FROM audio WHERE note_id = ? AND username = ?`).run(noteId, username);
  db.prepare(`UPDATE notes SET has_audio = 0 WHERE id = ?`).run(noteId);
}

// Appendi chunk audio al blob esistente (concatenazione binaria)
// Mantiene la compressione originale senza ricodificare
function appendAudioChunk(noteId, username, chunk, mime) {
  const note = db.prepare(`SELECT id FROM notes WHERE id = ? AND username = ?`).get(noteId, username);
  if (!note) return false;

  const existing = db.prepare(`SELECT data, mime FROM audio WHERE note_id = ?`).get(noteId);
  if (existing) {
    // Concatena i buffer binari
    const combined = Buffer.concat([existing.data, chunk]);
    db.prepare(`
      UPDATE audio SET data = ?, mime = ? WHERE note_id = ?
    `).run(combined, mime || existing.mime, noteId);
  } else {
    db.prepare(`
      INSERT INTO audio (note_id, username, data, mime) VALUES (?, ?, ?, ?)
    `).run(noteId, username, chunk, mime || 'audio/webm');
    db.prepare(`UPDATE notes SET has_audio = 1, updated_at = datetime('now') WHERE id = ?`).run(noteId);
  }
  return true;
}

function createShare(token, noteId, username, expiresAt) {
  db.prepare(`INSERT INTO shares (token, note_id, username, expires_at) VALUES (?, ?, ?, ?)`
  ).run(token, noteId, username, expiresAt || null);
}

function getShare(token) {
  const s = db.prepare(`SELECT * FROM shares WHERE token = ?`).get(token);
  if (!s) return null;
  if (s.expires_at && new Date(s.expires_at) < new Date()) return null; // scaduto
  return s;
}

function deleteShare(token, username) {
  db.prepare(`DELETE FROM shares WHERE token = ? AND username = ?`).run(token, username);
}

function getSharesForNote(noteId, username) {
  return db.prepare(`SELECT token, expires_at, created_at FROM shares WHERE note_id = ? AND username = ? ORDER BY created_at DESC`).all(noteId, username);
}

function getAllNotesForExport(username) {
  return db.prepare(`
    SELECT id, title, grid, strokes, images, thumbnail, has_audio, created_at, updated_at
    FROM notes WHERE username = ? ORDER BY updated_at DESC
  `).all(username);
}

function upsertNoteFromImport(id, username, note) {
  db.prepare(`
    INSERT INTO notes (id, username, title, strokes, images, thumbnail, grid, has_audio, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title      = excluded.title,
      strokes    = excluded.strokes,
      images     = excluded.images,
      thumbnail  = excluded.thumbnail,
      grid       = excluded.grid,
      has_audio  = excluded.has_audio,
      updated_at = excluded.updated_at
  `).run(
    id, username,
    note.title || 'Senza titolo',
    JSON.stringify(note.strokes || []),
    JSON.stringify(note.images  || []),
    note.thumbnail || null,
    note.grid || 'lines',
    note.has_audio ? 1 : 0,
    note.created_at || new Date().toISOString(),
    note.updated_at || new Date().toISOString()
  );
}

module.exports = { getNotesByUser, getNoteById, createNote, updateNoteMeta, saveContent, deleteNote, saveAudio, getAudio, deleteAudio, getAllNotesForExport, upsertNoteFromImport, appendAudioChunk, createShare, getShare, deleteShare, getSharesForNote };