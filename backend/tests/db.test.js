// Test di db.js: hashing password, migrazione hash legacy, statistiche,
// round-trip export/import, ricerca full-text.
const { check, section, done } = require('./_env');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const DBF = path.join(os.tmpdir(), `quetza-db-test-${process.pid}.db`);
for (const f of [DBF, DBF+'-wal', DBF+'-shm']) { try { fs.unlinkSync(f); } catch {} }
process.env.DB_PATH = DBF;

const db = require('../db.js');

section('Password');
db.createUser('mario', 'segreta123', 'Mario Rossi', 0);
const u = db.getUserByUsername('mario');
check('hash in formato scrypt con salt per utente', u.password_hash.startsWith('scrypt$'), u.password_hash.slice(0, 24) + '…');
check('login corretto', db.verifyPassword('mario', 'segreta123') === true);
check('login sbagliato rifiutato', db.verifyPassword('mario', 'sbagliata') === false);

// due utenti con la STESSA password devono avere hash diversi (salt per utente)
db.createUser('luigi', 'segreta123', 'Luigi', 0);
check('stessa password → hash diversi', db.getUserByUsername('luigi').password_hash !== u.password_hash);

// utente esterno: nessun hash, niente login locale
db.createUser('ldapuser', null, 'Utente LDAP', 0, 'ldap');
const ext = db.getUserByUsername('ldapuser');
check('utente LDAP senza password_hash', ext.password_hash === null);
check('utente LDAP non fa login locale', db.verifyPassword('ldapuser', 'qualsiasi') === false);

section('Migrazione hash legacy');
const crypto = require('crypto');
const legacy = crypto.createHash('sha256').update('vecchia123' + 'quetza_salt').digest('hex');
db.createUser('anna', 'placeholder', 'Anna', 0);
// simula un utente rimasto col vecchio hash SHA-256
const raw = new (require('better-sqlite3'))(DBF);
raw.prepare(`UPDATE users SET password_hash = ? WHERE username = 'anna'`).run(legacy);
check('hash legacy presente', db.getUserByUsername('anna').password_hash === legacy);
check('login con password legacy accettato', db.verifyPassword('anna', 'vecchia123') === true);
check('hash riscritto in scrypt dopo il login', db.getUserByUsername('anna').password_hash.startsWith('scrypt$'));
check('login legacy ancora valido dopo migrazione', db.verifyPassword('anna', 'vecchia123') === true);
check('password errata rifiutata dopo migrazione', db.verifyPassword('anna', 'vecchia124') === false);

section('must_change_password');
check('admin di seed deve cambiare password', db.mustChangePassword('admin') === true);
check('utente creato normalmente non deve', db.mustChangePassword('mario') === false);
db.resetPassword('mario', 'nuova12345');           // reset admin → forza cambio
check('reset admin forza il cambio', db.mustChangePassword('mario') === true);
db.resetPassword('mario', 'scelta12345', false);   // cambio volontario → azzera
check('cambio volontario azzera il flag', db.mustChangePassword('mario') === false);
check('nuova password funziona', db.verifyPassword('mario', 'scelta12345') === true);

section('Statistiche (prodotto cartesiano)');
db.createNote('n1', 'mario', 'Nota 1');
db.createNote('n2', 'mario', 'Nota 2');
db.createNote('n3', 'mario', 'Nota 3');
db.saveAudio('n1', 'mario', Buffer.alloc(1000), 'audio/webm');
db.saveAudio('n2', 'mario', Buffer.alloc(500),  'audio/webm');
const stats = db.getStats();
const mrow = stats.per_user.find(r => r.username === 'mario');
check('note_count corretto', mrow.note_count === 3, `atteso 3, ottenuto ${mrow.note_count}`);
check('audio_bytes NON gonfiato', Number(mrow.audio_bytes) === 1500, `atteso 1500, ottenuto ${mrow.audio_bytes}`);
check('audio totale corretto', Number(stats.audio_bytes) === 1500, `${stats.audio_bytes}`);

section('Export / import completo');
const pages = [
  { strokes: [{ t:'pen', c:'#111', sz:3, pts:[{x:1,y:2,p:.5},{x:3,y:4,p:.6}] }], textItems: [{ text:'pagina uno', x:10, y:20, size:18 }], images: [] },
  { strokes: [{ t:'rect', c:'#c0392b', sz:2, pts:[{x:5,y:5},{x:50,y:50}] }],     textItems: [{ text:'pagina due', x:30, y:40, size:22 }], images: [] },
];
db.saveContent('n1', 'mario', pages[0].strokes, [], 'thumb', 'grid', 'pagina uno pagina due', pages[0].textItems, pages);
db.saveWhisperText('n1', 'testo trascritto della riunione', [{ start:0, end:2, text:'ciao', speaker_label:'Persona 1' }]);

const exported = db.getAllNotesForExport('mario');
const en1 = exported.find(n => n.id === 'n1');
check('export include pages_data',       en1.pages_data != null);
check('export include text_items',       en1.text_items != null);
check('export include canvas_text',      en1.canvas_text === 'pagina uno pagina due');
check('export include whisper_text',     en1.whisper_text === 'testo trascritto della riunione');
check('export include whisper_segments', en1.whisper_segments != null);

// simula il round-trip via manifest JSON (come fa server.js)
const parse = (v, f) => { try { return v ? JSON.parse(v) : f; } catch { return f; } };
const manifest = JSON.parse(JSON.stringify({
  ...en1,
  strokes: parse(en1.strokes, []), images: parse(en1.images, []),
  text_items: parse(en1.text_items, []), pages_data: parse(en1.pages_data, null),
  whisper_segments: parse(en1.whisper_segments, null),
}));

db.upsertNoteFromImport('n1imported', 'luigi', manifest);
const back = db.getNoteById('n1imported', 'luigi');
check('reimport conserva 2 pagine',        back.pages_data?.length === 2, `pagine: ${back.pages_data?.length}`);
check('reimport conserva testo pagina 2',  back.pages_data?.[1]?.textItems?.[0]?.text === 'pagina due');
check('reimport conserva strokes pagina 2', back.pages_data?.[1]?.strokes?.[0]?.t === 'rect');
check('reimport conserva text_items',      back.text_items?.[0]?.text === 'pagina uno');
check('reimport conserva trascrizione',    back.whisper_text === 'testo trascritto della riunione');
check('reimport conserva segmenti',        back.whisper_segments?.[0]?.speaker_label === 'Persona 1');
check('reimport conserva canvas_text',     back.canvas_text === 'pagina uno pagina due');

section('Ricerca full-text');
const found = db.searchNotes('mario', 'trascritto');
check('FTS trova per testo trascrizione', found.some(r => r.id === 'n1'), `${found.length} risultati`);
const found2 = db.searchNotes('mario', 'pagina');
check('FTS trova per testo digitato', found2.some(r => r.id === 'n1'));



section('Migrazione credenziali fasulle');
// Il vecchio codice creava gli utenti LDAP con hash della stringa "null":
// chiunque poteva entrare come loro usando la password letterale "null".
{
  const legacyNull = require('crypto').createHash('sha256').update('null' + 'quetza_salt').digest('hex');
  const raw2 = new (require('better-sqlite3'))(DBF);
  raw2.prepare(`INSERT INTO users (username, password_hash, display_name, is_admin, is_active, source)
                VALUES ('vecchio_ldap', ?, 'Utente LDAP storico', 0, 1, 'local')`).run(legacyNull);
  check('hash fasullo presente prima della migrazione',
        db.getUserByUsername('vecchio_ldap').password_hash === legacyNull);
  check('con quell\'hash la password "null" funzionerebbe',
        db.verifyPassword('vecchio_ldap', 'null') === true);
  // verifyPassword riscrive in scrypt gli hash legacy quando il login riesce:
  // rimetto l'hash originale per testare la migrazione sul dato di partenza.
  raw2.prepare(`UPDATE users SET password_hash = ? WHERE username = 'vecchio_ldap'`).run(legacyNull);

  // Ricarica db.js: la migrazione gira all'avvio del modulo
  delete require.cache[require.resolve('../db.js')];
  const db2 = require('../db.js');
  check('migrazione azzera l\'hash fasullo', db2.getUserByUsername('vecchio_ldap').password_hash === null);
  check('password "null" non funziona più', db2.verifyPassword('vecchio_ldap', 'null') === false);
  check('nessuna password funziona su quell\'account', db2.verifyPassword('vecchio_ldap', '') === false);
}

done();
