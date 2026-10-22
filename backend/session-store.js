// Store delle sessioni su better-sqlite3 (già usato per il DB principale).
// Sostituisce connect-sqlite3, che si portava dietro il modulo nativo sqlite3
// e, tramite node-gyp, versioni vulnerabili di tar. Stesso file e stesso
// schema di connect-sqlite3 (sessions: sid, expired, sess), quindi le
// sessioni già aperte sopravvivono all'aggiornamento.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

module.exports = function (session) {
  const Store = session.Store;

  return class SqliteSessionStore extends Store {
    constructor({ dir, db = 'sessions.db', cleanupMs = 15 * 60 * 1000 } = {}) {
      super();
      fs.mkdirSync(dir, { recursive: true });
      this.db = new Database(path.join(dir, db));
      this.db.pragma('journal_mode = WAL');
      this.db.exec('CREATE TABLE IF NOT EXISTS sessions (sid PRIMARY KEY, expired, sess)');
      this.q = {
        get:   this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND ? <= expired'),
        set:   this.db.prepare('INSERT OR REPLACE INTO sessions (sid, expired, sess) VALUES (?, ?, ?)'),
        del:   this.db.prepare('DELETE FROM sessions WHERE sid = ?'),
        touch: this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ? AND ? <= expired'),
        clean: this.db.prepare('DELETE FROM sessions WHERE ? > expired'),
      };
      this.timer = setInterval(() => { try { this.q.clean.run(Date.now()); } catch {} }, cleanupMs);
      this.timer.unref();
    }

    expiry(sess) {
      const max = sess?.cookie?.maxAge;
      return Date.now() + (typeof max === 'number' ? max : 24 * 60 * 60 * 1000);
    }

    get(sid, cb) {
      try {
        const row = this.q.get.get(sid, Date.now());
        cb(null, row ? JSON.parse(row.sess) : null);
      } catch (e) { cb(e); }
    }

    set(sid, sess, cb = () => {}) {
      try { this.q.set.run(sid, this.expiry(sess), JSON.stringify(sess)); cb(null); }
      catch (e) { cb(e); }
    }

    destroy(sid, cb = () => {}) {
      try { this.q.del.run(sid); cb(null); } catch (e) { cb(e); }
    }

    touch(sid, sess, cb = () => {}) {
      try { this.q.touch.run(this.expiry(sess), sid, Date.now()); cb(null); }
      catch (e) { cb(e); }
    }
  };
};
