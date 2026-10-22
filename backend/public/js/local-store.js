// Copia locale (IndexedDB) di tutto quello che non è ancora arrivato al server:
// modifiche di una nota e registrazioni audio. Se la rete cade, la sessione
// scade, la scheda si chiude o il browser si blocca, il lavoro resta sul
// dispositivo e l'app lo invia al prossimo giro.
//   drafts    { key: "utente|nota", payload, title, rev, baseVersion, at }
//   recs      { key: "utente|registrazione", noteId, mime, state, at }
//   recParts  { key: "utente|registrazione|000001", blob }
// Se IndexedDB non è disponibile (alcune modalità private) le funzioni
// rifiutano la promessa: l'app continua a funzionare, senza rete di sicurezza.
const LocalStore = (() => {
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB non disponibile'));
      const r = indexedDB.open('quetza', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const s of ['drafts', 'recs', 'recParts'])
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('IndexedDB bloccato'));
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }

  const range = (prefix) => IDBKeyRange.bound(prefix, prefix + '￿');

  function done(t) {
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error || new Error('transazione annullata'));
    });
  }
  function result(r) {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  }

  return {
    async put(store, value) {
      const t = (await open()).transaction(store, 'readwrite');
      t.objectStore(store).put(value);
      return done(t);
    },
    async get(store, key) {
      return result((await open()).transaction(store).objectStore(store).get(key));
    },
    async del(store, key) {
      const t = (await open()).transaction(store, 'readwrite');
      t.objectStore(store).delete(key);
      return done(t);
    },
    async list(store, prefix) {
      return result((await open()).transaction(store).objectStore(store).getAll(range(prefix)));
    },
    async delPrefix(store, prefix) {
      const t = (await open()).transaction(store, 'readwrite');
      t.objectStore(store).delete(range(prefix));
      return done(t);
    },
  };
})();
