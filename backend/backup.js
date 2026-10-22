#!/usr/bin/env node
// Backup del DB Quetza, eseguito ogni notte da cron (vedi entrypoint.sh) o
// dal pannello admin. Usa l'API di backup di SQLite: la copia è coerente
// anche mentre l'app scrive. Il vecchio `cp` copiava il solo file principale,
// senza il WAL, e poteva produrre un backup incompleto o corrotto.
//
// Con BACKUP_COPY_DIR (una cartella del NAS montata sul server) ogni backup
// verificato viene copiato anche lì: un backup sullo stesso disco non
// protegge da un guasto del disco. L'esito finisce in status.json, che il
// pannello admin mostra.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, 'data', 'quetza.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const COPY_DIR   = process.env.BACKUP_COPY_DIR || '';
const KEEP       = Number(process.env.BACKUP_KEEP) || 30;
const NAME       = /^quetza_.*\.db$/;

function rotate(dir) {
  const old = fs.readdirSync(dir).filter(f => NAME.test(f)).sort().reverse().slice(KEEP);
  old.forEach(f => fs.rmSync(path.join(dir, f)));
  return old.length;
}

function writeStatus(st) {
  try { fs.writeFileSync(path.join(BACKUP_DIR, 'status.json'), JSON.stringify(st, null, 2)); } catch {}
}

// Copia nella cartella esterna: prima con un nome temporaneo, poi rinominata,
// così una copia interrotta (NAS che cade a metà) non sembra mai completa.
function copyOut(src) {
  fs.mkdirSync(COPY_DIR, { recursive: true });
  const dest = path.join(COPY_DIR, path.basename(src));
  const tmp = dest + '.parziale';
  fs.copyFileSync(src, tmp);
  if (fs.statSync(tmp).size !== fs.statSync(src).size) throw new Error('copia incompleta');
  fs.renameSync(tmp, dest);
  return rotate(COPY_DIR);
}

(async () => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const dest  = path.join(BACKUP_DIR, `quetza_${stamp}.db`);
  const st = { at: new Date().toISOString(), ok: false, file: path.basename(dest) };

  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try { await db.backup(dest); } finally { db.close(); }

    // Si verifica la copia prima di ruotare: un backup illeggibile non deve
    // far cancellare quelli buoni più vecchi.
    const chk = new Database(dest, { readonly: true });
    let ok;
    try { ok = chk.pragma('quick_check', { simple: true }); } finally { chk.close(); }
    if (ok !== 'ok') {
      fs.rmSync(dest, { force: true });
      throw new Error(`copia non integra (${ok}), backup precedenti lasciati intatti`);
    }
  } catch (e) {
    st.error = e.message;
    writeStatus(st);
    console.error('[backup] ERRORE', e.message);
    process.exit(1);
  }

  st.ok = true;
  st.size = fs.statSync(dest).size;
  const removed = rotate(BACKUP_DIR);
  st.kept = fs.readdirSync(BACKUP_DIR).filter(f => NAME.test(f)).length;
  console.log(`[backup] ${stamp} - OK ${dest} (${(st.size / 1048576).toFixed(1)} MB, rimossi ${removed})`);

  if (COPY_DIR) {
    try {
      copyOut(dest);
      st.copy = { ok: true };
      console.log(`[backup] copia esterna OK in ${COPY_DIR}`);
    } catch (e) {
      // Il backup locale resta valido: si segnala, senza fallire tutto
      st.copy = { ok: false, error: e.message };
      console.error(`[backup] ERRORE copia esterna in ${COPY_DIR}: ${e.message}`);
    }
  }
  writeStatus(st);
})();
