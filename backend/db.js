const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'quetza.db');
// Senza Docker la cartella data/ non esiste al primo avvio
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
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
    must_change_password INTEGER NOT NULL DEFAULT 0,
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
try { db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE notes ADD COLUMN canvas_text TEXT`); } catch {}
try { db.exec(`ALTER TABLE notes ADD COLUMN whisper_text TEXT`); } catch {}
try { db.exec(`ALTER TABLE notes ADD COLUMN text_items TEXT`); } catch {}
try { db.exec(`ALTER TABLE notes ADD COLUMN whisper_segments TEXT`); } catch {}
try { db.exec(`ALTER TABLE notes ADD COLUMN pages_data TEXT`); } catch {}
// Nota creata dal flusso "Nota vocale": il client nasconde il foglio finché
// non ha davvero contenuto — un controllo su strokes vuoti da solo non
// basta, altrimenti anche una nota normale appena creata (vuota anch'essa)
// mostrerebbe il suggerimento invece del foglio bianco atteso.
try { db.exec(`ALTER TABLE notes ADD COLUMN voice_first INTEGER NOT NULL DEFAULT 0`); } catch {}
// Versione del contenuto, +1 a ogni salvataggio: il client manda quella da cui
// è partito e, se nel frattempo un altro dispositivo ha salvato, il server
// rifiuta (409) invece di sovrascrivere in silenzio il lavoro dell'altro.
try { db.exec(`ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1`); } catch {}
// Cestino: una nota eliminata ha deleted_at valorizzato e resta recuperabile
// per TRASH_DAYS giorni, poi viene cancellata davvero (purgeTrash).
try { db.exec(`ALTER TABLE notes ADD COLUMN deleted_at TEXT`); } catch {}

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

// ── Password hashing ──────────────────────────────────────────
// Formato corrente: scrypt$<salt hex>$<hash hex>, salt casuale per utente.
// Formato legacy (pre-migrazione): SHA-256 con salt globale statico.
// Gli hash legacy restano verificabili e vengono riscritti in scrypt
// al primo login riuscito (vedi verifyPassword).
const SCRYPT_KEYLEN = 64;
const LEGACY_SALT   = 'quetza_salt';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function legacyHash(pw) {
  return crypto.createHash('sha256').update(pw + LEGACY_SALT).digest('hex');
}

// Confronto a tempo costante — evita timing attack sul confronto stringhe
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Verifica una password contro un hash in uno dei due formati.
// Ritorna { ok, legacy } — legacy=true segnala che va riscritto in scrypt.
function checkPassword(pw, stored) {
  if (!stored) return { ok: false, legacy: false };
  if (stored.startsWith('scrypt$')) {
    const [, salt, hash] = stored.split('$');
    if (!salt || !hash) return { ok: false, legacy: false };
    let derived;
    try { derived = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN).toString('hex'); }
    catch { return { ok: false, legacy: false }; }
    return { ok: safeEqual(derived, hash), legacy: false };
  }
  return { ok: safeEqual(legacyHash(pw), stored), legacy: true };
}

// ── Migrazione di sicurezza ───────────────────────────────────
// Il vecchio createUser() era chiamato con password null per gli utenti
// LDAP/OIDC, ma passava comunque il valore all'hash: il risultato era
// l'hash della stringa "null", uguale per tutti. Quegli account restavano
// quindi accessibili in locale con la password letterale "null".
// Qui gli hash fasulli vengono azzerati: l'account resta valido via LDAP/OIDC
// ma non ha più credenziali locali utilizzabili.
{
  const bogus = ['null', 'undefined', ''].map(legacyHash);
  const placeholders = bogus.map(() => '?').join(',');
  const affected = db.prepare(`SELECT username FROM users WHERE password_hash IN (${placeholders})`).all(...bogus);
  if (affected.length) {
    db.prepare(`UPDATE users SET password_hash = NULL WHERE password_hash IN (${placeholders})`).run(...bogus);
    console.warn(`[quetza] Rimosse credenziali locali fasulle per ${affected.length} utenti esterni: ${affected.map(u => u.username).join(', ')}`);
  }
}

// ── Seed: crea admin al primo avvio ───────────────────────────
// La password iniziale è 'admin' ma must_change_password=1 obbliga
// il cambio al primo accesso prima di poter usare l'app.
const adminExists = db.prepare(`SELECT 1 FROM users WHERE username = 'admin'`).get();
if (!adminExists) {
  db.prepare(`
    INSERT INTO users (username, password_hash, display_name, is_admin, source, must_change_password)
    VALUES ('admin', ?, 'Administrator', 1, 'local', 1)
  `).run(hashPassword('admin'));
  console.warn('[quetza] Utente admin creato con password iniziale "admin" — va cambiata al primo accesso.');
}

// ── Users ─────────────────────────────────────────────────────
function getUsers() {
  return db.prepare(`SELECT username, display_name, is_admin, is_active, source, must_change_password, created_at, last_login FROM users ORDER BY is_admin DESC, username ASC`).all();
}

function getUserByUsername(username) {
  return db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
}

// password null/undefined → utente esterno (LDAP/OIDC), nessun hash locale.
// source distingue l'origine: gli utenti esterni non possono fare login locale.
function createUser(username, password, displayName, isAdmin = 0, source = 'local') {
  const existing = db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(username);
  if (existing) throw new Error('Utente già esistente');
  db.prepare(`
    INSERT INTO users (username, password_hash, display_name, is_admin, source, must_change_password)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(username, password == null ? null : hashPassword(password), displayName || username, isAdmin ? 1 : 0, source);
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

// mustChange=true → l'utente dovrà cambiarla al primo accesso.
// Usato dal reset admin; il cambio volontario dell'utente azzera il flag.
function resetPassword(username, newPassword, mustChange = true) {
  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = ? WHERE username = ?`)
    .run(hashPassword(newPassword), mustChange ? 1 : 0, username);
}

function deleteUser(username) {
  db.prepare(`DELETE FROM users WHERE username = ?`).run(username);
}

function countAdmins() {
  return db.prepare(`SELECT COUNT(*) as n FROM users WHERE is_admin = 1 AND is_active = 1`).get().n;
}

function verifyPassword(username, password) {
  const user = db.prepare(`SELECT password_hash, is_active FROM users WHERE username = ? AND source = 'local'`).get(username);
  if (!user || !user.is_active || !user.password_hash) return false;
  const { ok, legacy } = checkPassword(password, user.password_hash);
  // Migrazione trasparente: il vecchio hash SHA-256 viene riscritto in scrypt
  // al primo login riuscito, senza chiedere nulla all'utente.
  if (ok && legacy) {
    db.prepare(`UPDATE users SET password_hash = ? WHERE username = ?`).run(hashPassword(password), username);
  }
  return ok;
}

// True se l'utente deve cambiare password prima di poter usare l'app
function mustChangePassword(username) {
  const u = db.prepare(`SELECT must_change_password FROM users WHERE username = ?`).get(username);
  return !!(u && u.must_change_password);
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
  return db.prepare(`SELECT id, title, thumbnail, grid, has_audio, created_at, updated_at FROM notes WHERE username = ? AND deleted_at IS NULL ORDER BY updated_at DESC`).all(username);
}

function getNoteById(id, username) {
  const note = username
    ? db.prepare(`SELECT * FROM notes WHERE id = ? AND username = ? AND deleted_at IS NULL`).get(id, username)
    : db.prepare(`SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!note) return null;
  return {
    ...note,
    strokes:          note.strokes          ? JSON.parse(note.strokes)          : [],
    images:           note.images           ? JSON.parse(note.images)           : [],
    text_items:       note.text_items       ? JSON.parse(note.text_items)       : [],
    whisper_segments: note.whisper_segments ? JSON.parse(note.whisper_segments) : null,
    pages_data:       note.pages_data       ? JSON.parse(note.pages_data)       : null,
  };
}

function createNote(id, username, title, voiceFirst) {
  db.prepare(`INSERT INTO notes (id, username, title, strokes, images, voice_first) VALUES (?, ?, ?, '[]', '[]', ?)`)
    .run(id, username, title, voiceFirst ? 1 : 0);
  return getNoteById(id, username);
}

function updateNoteMeta(id, username, { title, grid }) {
  const sets = [], vals = [];
  if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
  if (grid  !== undefined) { sets.push('grid = ?');  vals.push(grid); }
  if (!sets.length) return true;
  sets.push("updated_at = datetime('now')");
  vals.push(id, username);
  const ok = db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? AND username = ? AND deleted_at IS NULL`).run(...vals).changes > 0;
  // senza, la ricerca trovava la nota solo col titolo vecchio
  if (ok && title !== undefined) { try { rebuildFts(id); } catch(e) { console.warn('FTS rebuild title:', e.message); } }
  return ok;
}

// baseVersion = versione da cui è partito il client (facoltativa). Se la nota
// è stata salvata nel frattempo da un altro dispositivo non si scrive nulla.
// Ritorna { version } dopo il salvataggio, { conflict, version } se la nota è
// cambiata nel frattempo, null se la nota non esiste.
// thumbnail assente = resta quella di prima (il recupero delle modifiche
// salvate sul dispositivo non ha un'anteprima da mandare).
const saveContent = db.transaction((id, username, strokes, images, thumbnail, grid, canvasText, textItems, pagesData, baseVersion) => {
  const cur = db.prepare(`SELECT version FROM notes WHERE id = ? AND username = ? AND deleted_at IS NULL`).get(id, username);
  if (!cur) return null;
  if (baseVersion != null && Number(baseVersion) !== cur.version) return { conflict: true, version: cur.version };
  // pagesData = array di pagine [{strokes, textItems, images}]
  const pagesJson = pagesData ? JSON.stringify(pagesData) : null;
  db.prepare(`UPDATE notes SET strokes=?, images=?, thumbnail=COALESCE(?, thumbnail), grid=?, canvas_text=?, text_items=?, pages_data=?,
                version=version+1, updated_at=datetime('now') WHERE id=? AND username=?`)
    .run(JSON.stringify(strokes||[]), JSON.stringify(images||[]), thumbnail||null, grid||'lines', canvasText||null, JSON.stringify(textItems||[]), pagesJson, id, username);
  try { rebuildFts(id); } catch(e) { console.warn('FTS rebuild:', e.message); }
  return { version: cur.version + 1 };
});

function saveWhisperText(noteId, text, segments) {
  db.prepare(`UPDATE notes SET whisper_text=?, whisper_segments=?, updated_at=datetime('now') WHERE id=?`)
    .run(text||'', segments ? JSON.stringify(segments) : null, noteId);
  try { rebuildFts(noteId); } catch(e) { console.warn('FTS rebuild whisper:', e.message); }
}

function rebuildFts(noteId) {
  const n = db.prepare(`SELECT id, username, title, canvas_text, whisper_text FROM notes WHERE id=? AND deleted_at IS NULL`).get(noteId);
  if (!n) { db.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).run(noteId); return; }
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
             snippet(notes_fts, -1, char(1), char(2), '…', 20) as snippet
      FROM notes_fts f
      JOIN notes n ON n.id = f.note_id AND n.deleted_at IS NULL
      WHERE notes_fts MATCH ? AND f.username = ?
      ORDER BY rank LIMIT 50
    `).all(query.trim() + '*', username);
  } catch { return []; }
}

// Eliminare sposta nel cestino: contenuto e audio restano, la nota sparisce
// da elenco, ricerca e API, e i suoi link condivisi vengono revocati.
const deleteNote = db.transaction((id, username) => {
  const ok = db.prepare(`UPDATE notes SET deleted_at = datetime('now') WHERE id = ? AND username = ? AND deleted_at IS NULL`).run(id, username).changes > 0;
  if (ok) {
    db.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).run(id);
    db.prepare(`DELETE FROM shares WHERE note_id = ?`).run(id);
  }
  return ok;
});

function getTrash(username) {
  return db.prepare(`SELECT id, title, thumbnail, has_audio, updated_at, deleted_at FROM notes
                     WHERE username = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`).all(username);
}
function restoreNote(id, username) {
  const ok = db.prepare(`UPDATE notes SET deleted_at = NULL WHERE id = ? AND username = ? AND deleted_at IS NOT NULL`).run(id, username).changes > 0;
  if (ok) { try { rebuildFts(id); } catch(e) { console.warn('FTS rebuild restore:', e.message); } }
  return ok;
}
// Cancellazione definitiva, solo di note già nel cestino (audio e link vanno
// via con la FK ON DELETE CASCADE). id assente = svuota tutto il cestino.
function purgeNote(id, username) {
  return id
    ? db.prepare(`DELETE FROM notes WHERE id = ? AND username = ? AND deleted_at IS NOT NULL`).run(id, username).changes
    : db.prepare(`DELETE FROM notes WHERE username = ? AND deleted_at IS NOT NULL`).run(username).changes;
}
function purgeTrash(days) {
  return db.prepare(`DELETE FROM notes WHERE deleted_at IS NOT NULL AND julianday(deleted_at) < julianday('now') - ?`).run(days).changes;
}

// ── Audio ─────────────────────────────────────────────────────
function saveAudio(noteId, username, buffer, mime) {
  const note = db.prepare(`SELECT id FROM notes WHERE id = ? AND username = ? AND deleted_at IS NULL`).get(noteId, username);
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

// false = la nota non è di questo utente (prima l'UPDATE non guardava il
// proprietario: chiunque conoscesse l'id cancellava la trascrizione altrui).
function deleteAudio(noteId, username) {
  const note = db.prepare(`SELECT id FROM notes WHERE id = ? AND username = ? AND deleted_at IS NULL`).get(noteId, username);
  if (!note) return false;
  db.prepare(`DELETE FROM audio WHERE note_id = ? AND username = ?`).run(noteId, username);
  // Una trascrizione orfana (audio cancellato ma testo Whisper rimasto in DB)
  // riapparirebbe alla riapertura della nota, riferita a un audio inesistente.
  db.prepare(`UPDATE notes SET has_audio = 0, whisper_text = NULL, whisper_segments = NULL WHERE id = ? AND username = ?`).run(noteId, username);
  try { rebuildFts(noteId); } catch(e) { console.warn('FTS rebuild after deleteAudio:', e.message); }
  return true;
}

// Import: sostituisce l'audio di una nota con quello dell'archivio, tutto o
// niente, lasciando la trascrizione importata con la nota. Prima passava da
// deleteAudio, che la cancellava: ogni ripristino perdeva le trascrizioni.
const replaceAudio = db.transaction((noteId, username, sessions) => {
  db.prepare(`DELETE FROM audio WHERE note_id = ?`).run(noteId);
  const ins = db.prepare(`INSERT INTO audio (note_id, username, session, data, mime) VALUES (?, ?, ?, ?, ?)`);
  sessions.forEach((a, i) => ins.run(noteId, username, i, a.data, a.mime));
  db.prepare(`UPDATE notes SET has_audio = ? WHERE id = ?`).run(sessions.length ? 1 : 0, noteId);
});

function appendAudioChunk(noteId, username, chunk, mime) {
  const note = db.prepare(`SELECT id FROM notes WHERE id = ? AND username = ? AND deleted_at IS NULL`).get(noteId, username);
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
  return db.prepare(`DELETE FROM shares WHERE token = ? AND username = ?`).run(token, username).changes > 0;
}

function getSharesForNote(noteId, username) {
  return db.prepare(`SELECT token, expires_at, created_at FROM shares WHERE note_id = ? AND username = ? ORDER BY created_at DESC`).all(noteId, username);
}

// ── Export / Import globale (admin) ───────────────────────────
// Esporta TUTTE le colonne di contenuto: senza pages_data/text_items/whisper_*
// un ciclo export→import perdeva pagine, testo digitato e trascrizioni.
const EXPORT_COLS = `id, title, grid, strokes, images, thumbnail, has_audio,
                     canvas_text, text_items, pages_data, whisper_text, whisper_segments,
                     voice_first, created_at, updated_at, deleted_at, username`;

function getAllNotesForExport(username) {
  return username
    ? db.prepare(`SELECT ${EXPORT_COLS} FROM notes WHERE username = ? AND deleted_at IS NULL ORDER BY updated_at DESC`).all(username)
    : db.prepare(`SELECT ${EXPORT_COLS} FROM notes ORDER BY username, updated_at DESC`).all();
}

// Accetta sia oggetti/array già deserializzati (manifest JSON) sia stringhe
// JSON grezze come arrivano dal DB, così l'import regge entrambi i formati.
function asJsonText(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function getNoteOwner(id) {
  return db.prepare(`SELECT username FROM notes WHERE id = ?`).get(id)?.username || null;
}

// Una nota già presente viene sostituita dall'archivio solo se quella
// dell'archivio è più recente: reimportare un export vecchio non deve
// riportare indietro le note modificate dopo (né togliere le loro registrazioni).
function importWouldOverwriteNewer(id, updatedAt) {
  const r = db.prepare(`SELECT julianday(updated_at) >= COALESCE(julianday(?), 0) AS newer FROM notes WHERE id = ?`).get(updatedAt || null, id);
  return !!(r && r.newer);
}

function upsertNoteFromImport(id, username, note) {
  db.prepare(`
    INSERT INTO notes (id, username, title, strokes, images, thumbnail, grid, has_audio,
                       canvas_text, text_items, pages_data, whisper_text, whisper_segments,
                       voice_first, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, strokes=excluded.strokes, images=excluded.images,
      thumbnail=excluded.thumbnail, grid=excluded.grid, has_audio=excluded.has_audio,
      canvas_text=excluded.canvas_text, text_items=excluded.text_items,
      pages_data=excluded.pages_data, whisper_text=excluded.whisper_text,
      whisper_segments=excluded.whisper_segments, voice_first=excluded.voice_first,
      updated_at=excluded.updated_at, deleted_at=excluded.deleted_at, version=notes.version+1
    WHERE notes.username = excluded.username
  `).run(id, username, note.title||'Senza titolo',
    asJsonText(note.strokes, '[]'), asJsonText(note.images, '[]'),
    note.thumbnail||null, note.grid||'lines', note.has_audio?1:0,
    note.canvas_text||null, asJsonText(note.text_items, '[]'),
    asJsonText(note.pages_data, null), note.whisper_text||null,
    asJsonText(note.whisper_segments, null), note.voice_first?1:0,
    note.created_at||new Date().toISOString(), note.updated_at||new Date().toISOString(),
    note.deleted_at||null);
  rebuildFts(id);
}

// Statistiche per admin
function getStats() {
  const users  = db.prepare(`SELECT COUNT(*) as n FROM users`).get().n;
  const notes  = db.prepare(`SELECT COUNT(*) as n FROM notes WHERE deleted_at IS NULL`).get().n;
  const audio  = db.prepare(`SELECT COALESCE(SUM(length(data)),0) as n FROM audio`).get().n;
  // Sottoquery invece di due LEFT JOIN: unire notes e audio nella stessa
  // query produce un prodotto cartesiano che moltiplica audio_bytes per il
  // numero di note dell'utente (e note_count per il numero di audio).
  const perUser = db.prepare(`
    SELECT u.username, u.display_name, u.is_admin, u.last_login,
           (SELECT COUNT(*)                    FROM notes n WHERE n.username = u.username AND n.deleted_at IS NULL) as note_count,
           (SELECT COALESCE(SUM(length(a.data)),0) FROM audio a WHERE a.username = u.username) as audio_bytes
    FROM users u
    ORDER BY u.username
  `).all();
  return { users, notes, audio_bytes: audio, per_user: perUser };
}

function close() { try { db.close(); } catch {} }

module.exports = {
  close,
  // users
  getUsers, getUserByUsername, createUser, updateUser, resetPassword, deleteUser,
  countAdmins, verifyPassword, touchLogin, hashPassword, mustChangePassword,
  // settings
  getSetting, setSetting, getAllSettings, getNoteOwner,
  // notes
  getNotesByUser, getNoteById, createNote, updateNoteMeta, saveContent, deleteNote,
  getTrash, restoreNote, purgeNote, purgeTrash,
  saveWhisperText, searchNotes, rebuildFts,
  // audio
  saveAudio, getAudio, deleteAudio, replaceAudio, appendAudioChunk,
  // shares
  createShare, getShare, deleteShare, getSharesForNote,
  // export/import
  getAllNotesForExport, upsertNoteFromImport, importWouldOverwriteNewer,
  // stats
  getStats,
};