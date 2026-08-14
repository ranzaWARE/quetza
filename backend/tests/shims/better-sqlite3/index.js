// Fallback usato solo se better-sqlite3 (modulo nativo) non è compilabile
// sull'ambiente corrente: espone la stessa API sopra node:sqlite (Node 22+).
const { DatabaseSync } = require('node:sqlite');
module.exports = class Database {
  constructor(path) { this._db = new DatabaseSync(path); }
  pragma(s) { try { this._db.exec(`PRAGMA ${s}`); } catch {} }
  exec(sql) { return this._db.exec(sql); }
  prepare(sql) {
    const st = this._db.prepare(sql);
    return {
      get: (...a) => st.get(...a),
      all: (...a) => st.all(...a),
      run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }; },
    };
  }
};
