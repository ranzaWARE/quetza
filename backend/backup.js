#!/usr/bin/env node
// Backup del DB Quetza, eseguito ogni notte da cron (vedi entrypoint.sh).
// Usa l'API di backup di SQLite: la copia è coerente anche mentre l'app
// scrive. Il vecchio `cp` copiava il solo file principale, senza il WAL,
// e poteva produrre un backup incompleto o corrotto.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, 'data', 'quetza.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const KEEP       = Number(process.env.BACKUP_KEEP) || 30;

(async () => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const dest  = path.join(BACKUP_DIR, `quetza_${stamp}.db`);

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  await db.backup(dest);
  db.close();

  const old = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^quetza_.*\.db$/.test(f))
    .sort().reverse().slice(KEEP);
  old.forEach(f => fs.rmSync(path.join(BACKUP_DIR, f)));

  console.log(`[backup] ${stamp} - OK ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB, rimossi ${old.length})`);
})().catch(e => { console.error('[backup] ERRORE', e.message); process.exit(1); });
