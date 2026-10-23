'use strict';
/* ═══════════════════════════════════════════════════
   Quetza sul dispositivo — le note vivono qui, il server è facoltativo.

   Nelle app client (Android e quelle che verranno) l'interfaccia web è
   dentro l'app e ogni chiamata /api/... dell'app la serve questo file, da
   IndexedDB: si scrive, si registra, si cerca, si esporta senza rete e
   senza nessun server. Se si collega un server Quetza, local-sync.js
   sincronizza tutto nei due sensi; condivisione e trascrizione passano dal
   server.

   Si attiva quando l'app nativa imposta window.__quetzaClient, oppure in un
   browser con ?locale=1 (per provarlo; ?locale=0 per uscire). Sul sito
   servito dal server non fa nulla.

   IndexedDB "quetza-local":
     notes { id, title, …contenuto come sul server…, version,
             sync: { srv, dirty, audioCleared, transcribing } }
           srv = com'era la nota sul server all'ultima sincronizzazione
           (null = mai inviata); dirty = contenuto cambiato da allora
     audio { key: "nota|000001", noteId, seq, blob, mime, srv }
           srv = indice della sessione sul server (null = non ancora inviata)
     kv    { k, v }: link (server collegato), lastLink, tombs (note
           eliminate per sempre qui, da eliminare anche sul server),
           shared (ultime note condivise dai colleghi)
═══════════════════════════════════════════════════ */
(function () {
  // Sull'app Android l'interfaccia arriva da appassets.androidplatform.net
  // (WebViewAssetLoader): anche se lo script dell'app non fosse partito prima.
  const CLIENT = window.__quetzaClient || (location.hostname === 'appassets.androidplatform.net' ? { platform: 'android' } : null);
  let active = !!CLIENT;
  try {
    const p = new URLSearchParams(location.search).get('locale');
    if (p === '1') localStorage.setItem('quetza-local', '1');
    if (p === '0') localStorage.removeItem('quetza-local');
    active = active || localStorage.getItem('quetza-local') === '1';
  } catch {}
  if (!active) return;

  const ME = 'dispositivo';
  const TRASH_DAYS = 30;

  // Ritorno dalla pagina /collega.html del server: il token arriva nell'hash
  // e va tolto subito dall'indirizzo (e dalla cronologia).
  let incomingLink = null;
  {
    const m = location.hash.match(/^#quetza-link=(.*)$/);
    if (m) {
      history.replaceState(null, '', location.pathname + location.search);
      try { incomingLink = decodeURIComponent(m[1]) === 'annullato' ? 'annullato' : JSON.parse(decodeURIComponent(m[1])); } catch {}
    }
  }

  // ── IndexedDB ──────────────────────────────────────────
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB non disponibile'));
      const r = indexedDB.open('quetza-local', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('IndexedDB bloccato'));
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  const range = (prefix) => IDBKeyRange.bound(prefix, prefix + '\uffff');
  const result = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const done = (t) => new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error || new Error('transazione annullata'));
  });

  const db = {
    async get(store, key) { return result((await open()).transaction(store).objectStore(store).get(key)); },
    async all(store, prefix) {
      const s = (await open()).transaction(store).objectStore(store);
      return result(prefix == null ? s.getAll() : s.getAll(range(prefix)));
    },
    async put(store, value) {
      const t = (await open()).transaction(store, 'readwrite');
      t.objectStore(store).put(value);
      return done(t);
    },
    async del(store, key) {
      const t = (await open()).transaction(store, 'readwrite');
      t.objectStore(store).delete(key);
      return done(t);
    },
    async delPrefix(store, prefix) {
      const t = (await open()).transaction(store, 'readwrite');
      t.objectStore(store).delete(range(prefix));
      return done(t);
    },
    // Legge e riscrive nella stessa transazione: nessuna modifica fatta nel
    // frattempo va persa. fn riceve il record (o undefined) e restituisce
    // quello da salvare; undefined = non scrivere nulla.
    async update(store, key, fn) {
      const t = (await open()).transaction(store, 'readwrite');
      const s = t.objectStore(store);
      let out, err;
      s.get(key).onsuccess = (e) => {
        try { out = fn(e.target.result); if (out !== undefined) s.put(out); }
        catch (x) { err = x; t.abort(); }
      };
      try { await done(t); } catch (x) { throw err || x; }
      return out;
    },
  };

  // ── Note ───────────────────────────────────────────────
  // Date nel formato del server (SQLite, UTC): il client le legge già così.
  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const when = (s) => new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s || '') ? s.replace(' ', 'T') + 'Z' : s).getTime() || 0;
  const akey = (id, seq) => `${id}|${String(seq).padStart(6, '0')}`;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

  // Come sul server: testo libero, senza doppioni, al massimo 20 da 30 caratteri
  function normTags(v) {
    const out = [], seen = new Set();
    for (const t of Array.isArray(v) ? v : []) {
      if (typeof t !== 'string') continue;
      const tag = t.replace(/\s+/g, ' ').trim().slice(0, 30);
      if (!tag || seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase()); out.push(tag);
      if (out.length === 20) break;
    }
    return out;
  }

  function newNote(fields = {}) {
    const t = now();
    return {
      id: uuid(), title: 'Nuova nota', grid: 'lines', strokes: [], images: [], thumbnail: null,
      canvas_text: null, text_items: [], pages_data: null, whisper_text: null, whisper_segments: null,
      voice_first: 0, tags: [], has_audio: 0, created_at: t, updated_at: t, deleted_at: null,
      version: 1, sync: { srv: null, dirty: true }, ...fields,
    };
  }
  const summary = (n) => ({ id: n.id, title: n.title, thumbnail: n.thumbnail, grid: n.grid, has_audio: n.has_audio,
                            tags: n.tags || [], created_at: n.created_at, updated_at: n.updated_at });
  function publicNote(n) {
    const { sync, ...rest } = n;
    return { ...rest, username: ME, role: 'owner' };
  }
  // Sessioni audio nell'ordine del server, poi quelle non ancora inviate
  async function audioOf(id) {
    const list = await db.all('audio', id + '|');
    return list.sort((a, b) => (a.srv ?? 1e9) - (b.srv ?? 1e9) || a.seq - b.seq);
  }

  async function getTombs() { return (await db.get('kv', 'tombs'))?.v || {}; }
  async function dropTomb(id) {
    await db.update('kv', 'tombs', (r) => { if (!r || !(id in r.v)) return; delete r.v[id]; return r; });
  }
  // Via dal dispositivo. Se la nota era sul server, la sincronizzazione la
  // elimina per sempre anche lì (tombstone).
  async function purgeNote(n, tomb = true) {
    if (tomb && n.sync?.srv) {
      await db.update('kv', 'tombs', (r) => {
        r = r || { k: 'tombs', v: {} };
        r.v[n.id] = n.sync.srv.version;
        return r;
      });
    }
    await db.delPrefix('audio', n.id + '|');
    await db.del('notes', n.id);
  }
  const trashDays = () => LINK?.trashDays || TRASH_DAYS;
  async function purgeOldTrash() {
    const limit = Date.now() - trashDays() * 86400000;
    for (const n of await db.all('notes')) if (n.deleted_at && when(n.deleted_at) < limit) await purgeNote(n);
  }

  // Il server ha dato un altro id alla nota (quello proposto era già di un
  // altro utente): tutto passa sotto il nuovo id.
  async function rekey(oldId, newId) {
    const n = await db.get('notes', oldId);
    if (!n) return;
    await db.put('notes', { ...n, id: newId });
    for (const a of await db.all('audio', oldId + '|')) {
      await db.put('audio', { ...a, key: akey(newId, a.seq), noteId: newId });
      await db.del('audio', a.key);
    }
    await db.del('notes', oldId);
  }

  // Collegato a un server diverso (o a un altro account): per quel server
  // ogni nota del dispositivo è nuova.
  async function resetSync() {
    for (const n of await db.all('notes')) await db.put('notes', { ...n, sync: { srv: null, dirty: true } });
    for (const a of await db.all('audio')) if (a.srv != null) await db.put('audio', { ...a, srv: null });
    await db.del('kv', 'tombs');
    await db.del('kv', 'shared');
  }

  // ── Server collegato ───────────────────────────────────
  let LINK = null;   // { server, token, user, name, trashDays, state, lastSync, lastError }
  async function setLink(v) {
    LINK = v;
    if (v) await db.put('kv', { k: 'link', v }); else await db.del('kv', 'link');
    window.dispatchEvent(new Event('quetza:link'));
  }
  async function updateLink(patch) {
    if (!LINK) return;
    LINK = { ...LINK, ...patch };
    await db.put('kv', { k: 'link', v: LINK });
    window.dispatchEvent(new Event('quetza:link'));
  }

  const realFetch = window.fetch.bind(window);
  // Errore di rete verso il server: chi chiama lo vede come un fetch fallito
  const offline = (e) => Object.assign(new TypeError('Failed to fetch'), { offline: true, cause: e });
  async function serverFetch(path, init = {}, timeoutMs = 30000) {
    if (!LINK) throw offline(new Error('nessun server collegato'));
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', 'Bearer ' + LINK.token);
    const signal = timeoutMs && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    let r;
    try { r = await realFetch(LINK.server + path, { ...init, headers, mode: 'cors', credentials: 'omit', cache: 'no-store', signal }); }
    catch (e) { throw offline(e); }
    if (r.status === 401 && LINK.state !== 'expired') await updateLink({ state: 'expired' });
    return r;
  }

  const ready = (async () => {
    try {
      LINK = (await db.get('kv', 'link'))?.v || null;
      if (incomingLink && incomingLink !== 'annullato' && incomingLink.token && incomingLink.server) {
        const d = incomingLink;
        const prev = (await db.get('kv', 'lastLink'))?.v;
        if (!prev || prev.server !== d.server || prev.user !== d.user) await resetSync();
        await setLink({ server: d.server, token: d.token, user: d.user, name: d.name || d.user, state: 'ok', at: Date.now() });
        await db.put('kv', { k: 'lastLink', v: { server: d.server, user: d.user } });
      }
      await purgeOldTrash();
    } catch (e) { console.warn('[quetza] archivio locale:', e); }
    // Le note sono solo qui: si chiede di non liberare mai questo spazio
    try { await navigator.storage?.persist?.(); } catch {}
  })();

  // ── Risposte ───────────────────────────────────────────
  const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const notFound = () => json({ error: 'Nota non trovata' }, 404);
  const changed = () => window.dispatchEvent(new Event('quetza:local-change'));

  // Note che non sono sul dispositivo (di un collega) e tutto quello che solo
  // il server sa fare: si gira la richiesta al server collegato.
  async function forward(req, url) {
    if (!LINK) return notFound();
    const init = { method: req.method, headers: {} };
    const ct = req.headers.get('Content-Type');
    if (ct) init.headers['Content-Type'] = ct;
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
    const r = await serverFetch(url.pathname + url.search, init, 0);
    // 401 qui non è la sessione dell'app che scade: è il collegamento
    if (r.status === 401) return json({ error: 'Collegamento al server scaduto: ricollega il dispositivo dal pulsante del server' }, 503);
    return r;
  }
  // Condivisione e trascrizione: la nota deve prima essere sul server
  async function viaServer(req, url, m) {
    if (!LINK) return json({ error: 'Serve un server Quetza: collegalo dal pulsante in alto a destra' }, 503);
    const n = m[1] && await db.get('notes', m[1]);
    if (n) {
      try { await QL.pushNote(n.id); }
      catch { return json({ error: 'Server non raggiungibile: la nota non è ancora sul server' }, 503); }
    }
    return forward(req, url);
  }
  // La nota del dispositivo, oppure null se va chiesta al server
  async function local(id) { return db.get('notes', id); }

  // ── API ────────────────────────────────────────────────
  async function me() {
    return json({
      user: { username: ME, displayName: LINK ? LINK.name || LINK.user : 'Questo dispositivo', source: 'device', is_admin: 0 },
      must_change_password: 0, storage: { used: 0, quota: 0 },
    });
  }

  async function listNotes() {
    const all = (await db.all('notes')).filter(n => !n.deleted_at);
    return json(all.sort((a, b) => when(b.updated_at) - when(a.updated_at)).map(summary));
  }

  // Le note dei colleghi stanno sul server: senza rete restano le ultime viste
  async function sharedNotes() {
    if (!LINK || LINK.state === 'expired') return json([]);
    const cached = async () => json((await db.get('kv', 'shared'))?.v || []);
    try {
      const r = await serverFetch('/api/notes/shared', {}, 3000);
      if (!r.ok) return cached();
      const list = await r.json();
      await db.put('kv', { k: 'shared', v: list });
      return json(list);
    } catch { return cached(); }
  }

  async function createNote(req) {
    const b = await req.json().catch(() => ({}));
    const n = newNote({ title: String(b.title || 'Nuova nota'), voice_first: b.voiceFirst ? 1 : 0 });
    await db.put('notes', n);
    changed();
    return json(publicNote(n), 201);
  }

  async function getNote(req, url, [, id]) {
    const n = await local(id);
    if (!n) return forward(req, url);
    return n.deleted_at ? notFound() : json(publicNote(n));
  }

  async function patchNote(req, url, [, id]) {
    const n0 = await local(id);
    if (!n0) return forward(req, url);
    const b = await req.json().catch(() => ({}));
    const n = await db.update('notes', id, (n) => {
      if (!n || n.deleted_at) return;
      if (b.title !== undefined) n.title = String(b.title);
      if (b.grid !== undefined) n.grid = b.grid;
      if (b.tags !== undefined) n.tags = normTags(b.tags);
      n.updated_at = now();
      return n;
    });
    if (!n) return notFound();
    changed();
    return json({ ok: true });
  }

  async function putContent(req, url, [, id]) {
    const n0 = await local(id);
    if (!n0) return forward(req, url);
    const b = await req.json();
    let res = notFound();
    await db.update('notes', id, (n) => {
      if (!n || n.deleted_at) return;
      if (b.baseVersion != null && Number(b.baseVersion) !== n.version) {
        res = json({ error: 'La nota è stata modificata nel frattempo', version: n.version }, 409);
        return;
      }
      Object.assign(n, {
        strokes: b.strokes || [], images: b.images || [], thumbnail: b.thumbnail ?? n.thumbnail,
        grid: b.grid || 'lines', canvas_text: b.canvasText || null, text_items: b.textItems || [],
        pages_data: b.pagesData || null, version: n.version + 1, updated_at: now(),
      });
      n.sync = { ...n.sync, dirty: true };
      res = json({ ok: true, version: n.version });
      return n;
    });
    changed();
    return res;
  }

  async function trashNote(req, url, [, id]) {
    const n0 = await local(id);
    if (!n0) return forward(req, url);
    const n = await db.update('notes', id, (n) => {
      if (!n || n.deleted_at) return;
      n.deleted_at = now();
      return n;
    });
    if (!n) return notFound();
    changed();
    return json({ ok: true, trash: true, days: trashDays() });
  }

  async function listTrash() {
    await purgeOldTrash();
    const notes = (await db.all('notes')).filter(n => n.deleted_at)
      .sort((a, b) => when(b.deleted_at) - when(a.deleted_at))
      .map(n => ({ id: n.id, title: n.title, thumbnail: n.thumbnail, has_audio: n.has_audio, updated_at: n.updated_at, deleted_at: n.deleted_at }));
    return json({ days: trashDays(), notes });
  }
  async function restoreNote(req, url, [, id]) {
    const n = await db.update('notes', id, (n) => {
      if (!n || !n.deleted_at) return;
      n.deleted_at = null;
      return n;
    });
    if (!n) return json({ error: 'Nota non trovata nel cestino' }, 404);
    changed();
    return json({ ok: true });
  }
  async function purgeOne(req, url, [, id]) {
    const n = await local(id);
    if (!n || !n.deleted_at) return json({ error: 'Nota non trovata nel cestino' }, 404);
    await purgeNote(n);
    changed();
    return json({ ok: true });
  }
  async function emptyTrash() {
    let deleted = 0;
    for (const n of await db.all('notes')) if (n.deleted_at) { await purgeNote(n); deleted++; }
    changed();
    return json({ ok: true, deleted });
  }

  // Ricerca nel titolo, nelle etichette, nel testo scritto e nella
  // trascrizione, con l'estratto evidenziato come quello del server.
  async function search(req, url) {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (!q) return json([]);
    const out = [];
    for (const n of await db.all('notes')) {
      if (n.deleted_at) continue;
      for (const f of [[n.title, ...(n.tags || [])].join(' '), n.canvas_text || '', n.whisper_text || '']) {
        const i = f.toLowerCase().indexOf(q);
        if (i < 0) continue;
        const a = Math.max(0, i - 50), z = Math.min(f.length, i + q.length + 50);
        const snippet = (a ? '…' : '') + f.slice(a, i) + '\u0001' + f.slice(i, i + q.length) + '\u0002' + f.slice(i + q.length, z) + (z < f.length ? '…' : '');
        out.push({ id: n.id, title: n.title, thumbnail: n.thumbnail, has_audio: n.has_audio, updated_at: n.updated_at, snippet });
        break;
      }
      if (out.length === 50) break;
    }
    return json(out);
  }

  // ── Audio ──────────────────────────────────────────────
  async function addAudio(req, url, [, id]) {
    const n0 = await local(id);
    if (!n0) return forward(req, url);
    if (n0.deleted_at) return notFound();
    const f = (await req.formData()).get('audio');
    if (!f || typeof f === 'string') return json({ error: 'Nessun file audio' }, 400);
    const mime = f.type || 'audio/webm';
    const seq = (await db.all('audio', id + '|')).reduce((m, a) => Math.max(m, a.seq + 1), 0);
    await db.put('audio', { key: akey(id, seq), noteId: id, seq, blob: f.slice(0, f.size, mime), mime, srv: null });
    await db.update('notes', id, (n) => { if (!n) return; n.has_audio = 1; n.updated_at = now(); return n; });
    changed();
    return json({ ok: true });
  }
  async function getAudio(req, url, [, id]) {
    const n = await local(id);
    if (!n) return forward(req, url);
    if (n.deleted_at) return notFound();
    const list = await audioOf(id);
    if (!list.length) return json({ error: 'Audio non trovato' }, 404);
    if (list.length === 1) return new Response(list[0].blob, { headers: { 'Content-Type': list[0].mime || 'audio/webm', 'X-Audio-Sessions': '1' } });
    return json({ sessions: list.map((a, index) => ({ index, mime: a.mime, size: a.blob.size })) });
  }
  async function getAudioSession(req, url, [, id, i]) {
    const n = await local(id);
    if (!n) return forward(req, url);
    if (n.deleted_at) return notFound();
    const a = (await audioOf(id))[Number(i)];
    if (!a) return json({ error: 'Sessione non trovata' }, 404);
    return new Response(a.blob, { headers: { 'Content-Type': a.mime || 'audio/webm' } });
  }
  async function deleteAudio(req, url, [, id]) {
    const n0 = await local(id);
    if (!n0) return forward(req, url);
    if (n0.deleted_at) return notFound();
    const list = await db.all('audio', id + '|');
    await db.delPrefix('audio', id + '|');
    await db.update('notes', id, (n) => {
      if (!n) return;
      Object.assign(n, { has_audio: 0, whisper_text: null, whisper_segments: null });
      if (list.some(a => a.srv != null) || n.sync?.srv?.audio_count) n.sync = { ...n.sync, audioCleared: true };
      return n;
    });
    changed();
    return json({ ok: true });
  }

  // La trascrizione la fa il server: finché non è pronta la si chiede a lui
  async function transcript(req, url, [, id]) {
    const n = await local(id);
    if (!n) return forward(req, url);
    if (n.deleted_at) return notFound();
    if (!n.whisper_text && n.sync?.transcribing && LINK) {
      try {
        const r = await serverFetch(`/api/notes/${id}/transcript`, {}, 10000);
        const d = r.ok ? await r.json() : null;
        if (d?.has_transcript) {
          await db.update('notes', id, (x) => {
            if (!x) return;
            Object.assign(x, { whisper_text: d.text, whisper_segments: d.segments || null });
            x.sync = { ...x.sync, transcribing: false };
            return x;
          });
          return json({ text: d.text, segments: d.segments || null, has_transcript: true });
        }
      } catch {}
    }
    return json({ text: n.whisper_text || null, segments: n.whisper_segments || null, has_transcript: !!n.whisper_text });
  }
  async function transcribe(req, url, m) {
    const n = await local(m[1]);
    if (!n) return forward(req, url);
    const r = await viaServer(req, url, m);
    if (r.ok) await db.update('notes', n.id, (x) => { if (!x) return; x.sync = { ...x.sync, transcribing: true }; return x; });
    return r;
  }

  // ── Export / import ────────────────────────────────────
  // Stesso formato dell'export del server: l'archivio si importa anche lì.
  async function exportZip() {
    const notes = (await db.all('notes')).filter(n => !n.deleted_at).sort((a, b) => when(b.updated_at) - when(a.updated_at));
    const manifest = notes.map(({ sync, version, ...n }) => ({ ...n, username: ME }));
    const files = [{ name: 'manifest.json', data: new Blob([JSON.stringify(manifest, null, 2)]) }];
    for (const n of notes) {
      (await audioOf(n.id)).forEach((a, i) =>
        files.push({ name: `audio/${n.id}_${i}.${(a.mime || '').includes('mp4') ? 'mp4' : 'webm'}`, data: a.blob }));
    }
    const blob = await Zip.write(files);
    return new Response(blob, { headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="quetza-dispositivo-${new Date().toISOString().slice(0, 10)}.zip"`,
    } });
  }

  // Come l'import del server: una nota già presente si sostituisce solo con
  // una più recente; reimportare quella che è nel cestino la ripristina.
  async function importZip(req) {
    const f = (await req.formData()).get('archive');
    if (!f || typeof f === 'string') return json({ error: 'Nessun file' }, 400);
    let zip, manifest;
    try {
      zip = await Zip.read(f);
      manifest = JSON.parse(await (await zip.blob(zip.get('manifest.json'))).text());
    } catch { return json({ error: 'ZIP non valido' }, 400); }
    const notes = Array.isArray(manifest) ? manifest : (manifest?.notes || []);
    const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
    let imported = 0, skipped = 0, unchanged = 0;
    for (const x of notes) {
      if (!x || typeof x.id !== 'string' || !x.id || !x.title) { skipped++; continue; }
      const cur = await local(x.id);
      if (cur && when(cur.updated_at) >= when(x.updated_at)) {
        if (cur.deleted_at) { await db.update('notes', x.id, (n) => { if (!n) return; n.deleted_at = null; return n; }); imported++; }
        else unchanged++;
        continue;
      }
      const n = newNote({
        id: x.id, title: String(x.title), grid: x.grid || 'lines',
        strokes: parse(x.strokes, []), images: parse(x.images, []), thumbnail: x.thumbnail || null,
        canvas_text: x.canvas_text || null, text_items: parse(x.text_items, []), pages_data: parse(x.pages_data, null),
        whisper_text: x.whisper_text || null, whisper_segments: parse(x.whisper_segments, null),
        voice_first: x.voice_first ? 1 : 0, tags: normTags(parse(x.tags, [])),
        created_at: x.created_at || now(), updated_at: x.updated_at || now(), deleted_at: x.deleted_at || null,
        version: (cur?.version || 0) + 1, sync: { ...(cur?.sync || { srv: null }), dirty: true },
      });
      // Tutte le sessioni audio dell'archivio (audio/<id>_0, _1, …), al
      // posto di quelle sul dispositivo; senza audio nell'archivio si tiene
      // quello che c'è.
      const found = [];
      for (let i = 0; ; i++) {
        const e = ['webm', 'mp4', 'wav'].map(ext => zip.get(`audio/${x.id}_${i}.${ext}`)).find(Boolean);
        if (!e) break;
        found.push(e);
      }
      if (!found.length) {
        const legacy = ['webm', 'mp4', 'wav'].map(ext => zip.get(`audio/${x.id}.${ext}`)).find(Boolean);
        if (legacy) found.push(legacy);
      }
      const old = await db.all('audio', x.id + '|');
      if (found.length) {
        await db.delPrefix('audio', x.id + '|');
        if (old.some(a => a.srv != null)) n.sync.audioCleared = true;
        for (let i = 0; i < found.length; i++) {
          const mime = 'audio/' + found[i].name.split('.').pop();
          await db.put('audio', { key: akey(x.id, i), noteId: x.id, seq: i, blob: await zip.blob(found[i], mime), mime, srv: null });
        }
      }
      n.has_audio = found.length || old.length ? 1 : 0;
      await db.put('notes', n);
      imported++;
    }
    changed();
    return json({ ok: true, imported, skipped, copies: 0, unchanged });
  }

  // ── ZIP ────────────────────────────────────────────────
  // Scrittura senza compressione (l'audio è già compresso), lettura anche
  // degli archivi compressi del server (deflate).
  const Zip = (() => {
    const TABLE = new Uint32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    function crc32(bytes, crc = 0) {
      let c = crc ^ 0xFFFFFFFF;
      for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    }
    const enc = new TextEncoder(), dec = new TextDecoder();

    async function write(files) {
      const d = new Date();
      const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const parts = [], central = [];
      let offset = 0, cdSize = 0;
      for (const f of files) {
        const name = enc.encode(f.name), blob = f.data;
        let crc = 0;
        for (let p = 0; p < blob.size; p += 1 << 22) crc = crc32(new Uint8Array(await blob.slice(p, p + (1 << 22)).arrayBuffer()), crc);
        if (blob.size >= 0xFFFFFFFF || offset >= 0xFFFFFFFF) throw new Error('Archivio troppo grande (oltre 4 GB)');
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
        lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
        lh.setUint32(18, blob.size, true); lh.setUint32(22, blob.size, true); lh.setUint16(26, name.length, true);
        parts.push(lh.buffer, name, blob);
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
        ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
        ch.setUint32(20, blob.size, true); ch.setUint32(24, blob.size, true); ch.setUint16(28, name.length, true);
        ch.setUint32(42, offset, true);
        central.push(ch.buffer, name);
        offset += 30 + name.length + blob.size;
        cdSize += 46 + name.length;
      }
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
      end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
      return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
    }

    async function read(file) {
      const tailLen = Math.min(file.size, 22 + 65535);
      const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
      let eocd = -1;
      for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      if (eocd < 0) throw new Error('ZIP non valido');
      const count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
      if (count === 0xFFFF || cdOff === 0xFFFFFFFF) throw new Error('ZIP64 non supportato');
      const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
      const entries = new Map();
      for (let p = 0, i = 0; i < count; i++) {
        if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP non valido');
        const nlen = cd.getUint16(p + 28, true);
        const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nlen));
        entries.set(name, { name, method: cd.getUint16(p + 10, true), csize: cd.getUint32(p + 20, true), off: cd.getUint32(p + 42, true) });
        p += 46 + nlen + cd.getUint16(p + 30, true) + cd.getUint16(p + 32, true);
      }
      return {
        get: (name) => entries.get(name),
        async blob(e, type = '') {
          if (!e) throw new Error('voce mancante');
          const lh = new DataView(await file.slice(e.off, e.off + 30).arrayBuffer());
          const start = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
          const raw = file.slice(start, start + e.csize);
          if (e.method === 0) return raw.slice(0, raw.size, type);
          if (e.method !== 8) throw new Error('compressione non supportata');
          const b = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
          return b.slice(0, b.size, type);
        },
      };
    }
    return { write, read, crc32 };
  })();

  // ── Instradamento ──────────────────────────────────────
  const N = '/api/notes/([^/]+)';
  const ROUTES = [
    ['GET', /^\/api\/me$/, me],
    ['POST', /^\/api\/logout$/, async () => json({ ok: true })],
    ['GET', /^\/api\/notes$/, listNotes],
    ['POST', /^\/api\/notes$/, createNote],
    ['GET', /^\/api\/notes\/shared$/, sharedNotes],
    ['GET', new RegExp(`^${N}$`), getNote],
    ['PATCH', new RegExp(`^${N}$`), patchNote],
    ['DELETE', new RegExp(`^${N}$`), trashNote],
    ['PUT', new RegExp(`^${N}/content$`), putContent],
    ['POST', new RegExp(`^${N}/audio$`), addAudio],
    ['GET', new RegExp(`^${N}/audio$`), getAudio],
    ['GET', new RegExp(`^${N}/audio/(\\d+)$`), getAudioSession],
    ['DELETE', new RegExp(`^${N}/audio$`), deleteAudio],
    ['GET', new RegExp(`^${N}/transcript$`), transcript],
    ['POST', new RegExp(`^${N}/transcribe-async$`), transcribe],
    ['*', new RegExp(`^${N}/(?:access(?:/[^/]+)?|shares?)$`), viaServer],
    ['*', /^\/api\/(?:users|shares\/[^/]+)$/, viaServer],
    ['GET', /^\/api\/trash$/, listTrash],
    ['DELETE', /^\/api\/trash$/, emptyTrash],
    ['POST', /^\/api\/trash\/([^/]+)\/restore$/, restoreNote],
    ['DELETE', /^\/api\/trash\/([^/]+)$/, purgeOne],
    ['GET', /^\/api\/search$/, search],
    ['GET', /^\/api\/export$/, exportZip],
    ['POST', /^\/api\/import$/, importZip],
  ];

  async function handle(req, url) {
    await ready;
    for (const [method, re, fn] of ROUTES) {
      if (method !== '*' && method !== req.method) continue;
      const m = url.pathname.match(re);
      if (!m) continue;
      try { return await fn(req, url, m); }
      catch (e) {
        if (e && e.offline) throw e;
        if (e && e.name === 'QuotaExceededError')
          return json({ error: 'Spazio esaurito sul dispositivo: svuota il cestino o elimina audio e note che non servono' }, 507);
        console.error('[quetza] locale', req.method, url.pathname, e);
        return json({ error: (e && e.message) || 'Errore' }, 500);
      }
    }
    if (LINK) return forward(req, url);
    return json({ error: 'Non disponibile senza un server collegato' }, 404);
  }

  window.fetch = function (input, init) {
    let url;
    try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
    catch { return realFetch(input, init); }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    return handle(new Request(input, init), url);
  };

  const QL = window.QuetzaLocal = {
    client: CLIENT, ready, db, ME, Zip,
    get link() { return LINK; },
    linked: () => !!LINK,
    incomingLink: () => incomingLink,
    setLink, updateLink, serverFetch, trashDays,
    newNote, audioOf, akey, now, when, normTags, rekey, resetSync, getTombs, dropTomb, purgeNote,
    pushNote: async () => { throw new Error('sincronizzazione non disponibile'); },   // da local-sync.js
  };
})();
