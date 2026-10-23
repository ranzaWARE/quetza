'use strict';
/* ═══════════════════════════════════════════════════
   Quetza sul dispositivo — sincronizzazione con il server (facoltativa).

   Con un server collegato porta tutto nei due sensi: note, etichette,
   cestino, audio e trascrizioni. Per capire chi ha cambiato cosa confronta
   tre stati: la nota sul dispositivo, quella sul server e com'era sul server
   all'ultima sincronizzazione (sync.srv).
   - Contenuto cambiato da una parte sola: vince quella parte.
   - Cambiato da entrambe: nessuno dei due lavori va perso, quello del
     dispositivo diventa una nota a parte "(conflitto hh:mm)".
   - Titolo, griglia, etichette: campo per campo, vince chi l'ha cambiato.
   - Nota eliminata altrove con modifiche qui: le modifiche tornano come
     nota "(recuperata)".
   - Nota sparita dal server (eliminata per sempre altrove): sul dispositivo
     finisce nel cestino, non sparisce.
   Gira all'avvio, ogni minuto, al ritorno della rete e poco dopo ogni
   modifica. Qui c'è anche il pannello "Server" e l'avviso "nessun backup".
═══════════════════════════════════════════════════ */
(function () {
  const QL = window.QuetzaLocal;
  if (!QL) return;
  const { db } = QL;
  const JSONH = { 'Content-Type': 'application/json' };
  const hhmm = (t = Date.now()) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const host = (u) => { try { return new URL(u).host; } catch { return u; } };
  const say = (msg, ms) => window.toast ? window.toast(msg, ms) : console.log(msg);

  // ── Chiamate al server ─────────────────────────────────
  // Stop = si interrompe il giro (collegamento scaduto, troppe richieste);
  // gli errori di una sola nota invece non fermano le altre.
  const stop = (message, state) => Object.assign(new Error(message), { stop: true, state });
  async function api(path, init = {}, timeout = 30000) {
    const r = await QL.serverFetch(path, init, timeout);
    if (r.status === 401) throw stop('Collegamento scaduto o revocato', 'expired');
    if (r.status === 429) throw stop('Troppe richieste: riprovo tra poco', 'offline');
    return r;
  }
  async function ok(r, allowed = []) {
    if (r.ok || allowed.includes(r.status)) return r;
    const d = await r.json().catch(() => ({}));
    throw Object.assign(new Error(r.status === 507 ? 'Spazio esaurito sul server' : (d.error || `HTTP ${r.status}`)), { status: r.status });
  }

  // Com'è la nota sul server, quanto basta per i confronti
  const snap = (x) => ({
    version: x.version, title: x.title, grid: x.grid, tags: JSON.stringify(x.tags || []),
    deleted: !!x.deleted_at, whisper_len: x.whisper_len || 0, audio_count: x.audio_count || 0,
  });
  const contentOf = (n) => ({
    strokes: n.strokes, images: n.images, thumbnail: n.thumbnail, grid: n.grid, canvasText: n.canvas_text,
    textItems: n.text_items, pagesData: n.pages_data,
  });
  async function setSync(id, patch) {
    return db.update('notes', id, (n) => { if (!n) return; n.sync = { ...n.sync, ...patch }; return n; });
  }
  async function setSrv(id, patch) {
    const n = await db.update('notes', id, (n) => { if (!n) return; n.sync = { ...n.sync, srv: { ...n.sync.srv, ...patch } }; return n; });
    return n?.sync.srv;
  }

  // Nuova nota sul dispositivo con il lavoro che altrimenti andrebbe perso
  async function copyOf(L, label, rep) {
    const c = QL.newNote({
      title: `${L.title} (${label})`, grid: L.grid, strokes: L.strokes, images: L.images, thumbnail: L.thumbnail,
      canvas_text: L.canvas_text, text_items: L.text_items, pages_data: L.pages_data, tags: L.tags, voice_first: L.voice_first,
    });
    await db.put('notes', c);
    rep.copies.push(c.title);
    rep.again = true;
  }

  // Contenuto del server al posto di quello del dispositivo. La versione
  // locale sale: un editor aperto sulla nota vecchia se ne accorge al
  // salvataggio (e mette il suo lavoro in una copia).
  async function pullContent(id, rep, expectVersion) {
    const r = await api(`/api/notes/${id}`);
    if (r.status === 404) return false;
    await ok(r);
    const s = await r.json();
    const n = await db.update('notes', id, (n) => {
      if (!n || (expectVersion != null && n.version !== expectVersion)) return;
      Object.assign(n, {
        strokes: s.strokes || [], images: s.images || [], thumbnail: s.thumbnail || null,
        canvas_text: s.canvas_text || null, text_items: s.text_items || [], pages_data: s.pages_data || null,
        updated_at: s.updated_at || n.updated_at, version: n.version + 1,
      });
      n.sync = { ...n.sync, dirty: false, srv: { ...n.sync.srv, version: s.version } };
      return n;
    });
    if (n) rep.changed.add(id);
    return !!n;
  }

  // ── Una nota ───────────────────────────────────────────
  async function syncNote(id, x, rep) {
    let L = await db.get('notes', id);
    if (!L) return;
    let S = L.sync?.srv || null;

    if (!S) {
      if (L.deleted_at) return;                       // mai stata sul server: il cestino resta qui
      if (x) return adopt(L, x, rep);                 // stesso id già sul server
      return pushNew(L, rep);
    }
    if (!x) {
      // Sparita dal server (eliminata per sempre altrove)
      if (L.deleted_at) { await QL.purgeNote(L, false); return; }
      if (L.sync.dirty) { await setSync(id, { srv: null }); return pushNew(await db.get('notes', id), rep); }
      await db.update('notes', id, (n) => { if (!n) return; n.deleted_at = QL.now(); n.sync = { ...n.sync, srv: null }; return n; });
      rep.trashed++; rep.changed.add(id);
      return;
    }

    // Cestino
    const Ld = !!L.deleted_at;
    let Rd = !!x.deleted_at;
    if (Ld !== S.deleted) {
      if (Rd !== Ld) {
        await ok(Ld ? await api(`/api/notes/${id}`, { method: 'DELETE' })
                    : await api(`/api/trash/${id}/restore`, { method: 'POST' }), [404]);
        Rd = Ld;
      }
      S = await setSrv(id, { deleted: Ld });
    } else if (Rd !== S.deleted) {
      if (Rd && L.sync.dirty) await copyOf(L, 'recuperata', rep);
      await db.update('notes', id, (n) => {
        if (!n) return;
        n.deleted_at = Rd ? x.deleted_at : null;
        n.sync = { ...n.sync, dirty: Rd ? false : n.sync.dirty, srv: { ...n.sync.srv, deleted: Rd } };
        return n;
      });
      rep.changed.add(id);
    }
    if (Rd) return;                                   // nel cestino: il resto quando torna fuori
    L = await db.get('notes', id);
    if (!L || L.deleted_at) return;
    S = L.sync.srv;

    // Contenuto
    if (L.sync.dirty && x.version === S.version) {
      const v = L.version;
      const r = await api(`/api/notes/${id}/content`, { method: 'PUT', headers: JSONH, body: JSON.stringify({ ...contentOf(L), baseVersion: S.version }) }, 0);
      if (r.status === 409) {
        await copyOf(L, `conflitto ${hhmm()}`, rep);
        await pullContent(id, rep, v);
      } else if (r.status !== 404) {
        await ok(r);
        const { version } = await r.json();
        await db.update('notes', id, (n) => {
          if (!n) return;
          n.sync = { ...n.sync, srv: { ...n.sync.srv, version }, dirty: n.version === v ? false : n.sync.dirty };
          return n;
        });
        rep.pushed++;
      }
    } else if (L.sync.dirty) {
      // Cambiata sia qui sia altrove
      await copyOf(L, `conflitto ${hhmm()}`, rep);
      await pullContent(id, rep, L.version);
    } else if (x.version !== S.version) {
      await pullContent(id, rep, L.version);
    }

    // Titolo, griglia, etichette: campo per campo
    L = await db.get('notes', id);
    if (!L) return;
    S = L.sync.srv;
    const patch = {}, take = {}, agreed = {};
    for (const f of ['title', 'grid', 'tags']) {
      const enc = (v) => f === 'tags' ? JSON.stringify(v || []) : v;
      const lv = enc(L[f]), sv = S[f], rv = enc(x[f]);
      if (lv !== sv && lv !== rv) { patch[f] = L[f]; agreed[f] = lv; }
      else if (lv === sv && rv !== sv) { take[f] = x[f]; agreed[f] = rv; }
      else agreed[f] = lv;
    }
    if (Object.keys(patch).length) {
      await ok(await api(`/api/notes/${id}`, { method: 'PATCH', headers: JSONH, body: JSON.stringify(patch) }));
      rep.pushed++;
    }
    await db.update('notes', id, (n) => {
      if (!n) return;
      Object.assign(n, take);
      n.sync = { ...n.sync, srv: { ...n.sync.srv, ...agreed } };
      return n;
    });
    if (Object.keys(take).length) rep.changed.add(id);

    // Trascrizione fatta dal server
    if ((x.whisper_len || 0) !== (S.whisper_len || 0)) {
      const r = await api(`/api/notes/${id}/transcript`);
      if (r.ok) {
        const d = await r.json();
        await db.update('notes', id, (n) => {
          if (!n) return;
          Object.assign(n, { whisper_text: d.text || null, whisper_segments: d.segments || null });
          n.sync = { ...n.sync, transcribing: false, srv: { ...n.sync.srv, whisper_len: x.whisper_len || 0 } };
          return n;
        });
        rep.changed.add(id);
      }
    }

    await syncAudio(id, x.audio_count || 0, rep);
  }

  // Registrazioni: quelle nuove del dispositivo vanno sul server, quelle
  // fatte altrove arrivano qui; l'audio tolto da una parte sparisce anche
  // dall'altra.
  async function syncAudio(id, count, rep) {
    const L = await db.get('notes', id);
    if (!L) return;
    if (L.sync.audioCleared) {
      if (count > 0) await ok(await api(`/api/notes/${id}/audio`, { method: 'DELETE' }), [404]);
      count = 0;
      await setSync(id, { audioCleared: false });
    }
    let list = await QL.audioOf(id);
    const known = list.filter(a => a.srv != null);
    if (known.some(a => a.srv >= count)) {
      for (const a of known) await db.del('audio', a.key);
      list = list.filter(a => a.srv == null);
      rep.changed.add(id);
    }
    for (const a of list.filter(a => a.srv == null)) {
      const fd = new FormData();
      fd.append('audio', a.blob, `session.${(a.mime || '').includes('mp4') ? 'mp4' : 'webm'}`);
      const r = await ok(await api(`/api/notes/${id}/audio`, { method: 'POST', body: fd }, 0));
      const { session } = await r.json();
      await db.update('audio', a.key, (y) => { if (!y) return; y.srv = session; return y; });
      count = Math.max(count, session + 1);
      rep.pushed++;
    }
    const all = await QL.audioOf(id);
    const have = new Set(all.map(a => a.srv));
    let seq = all.reduce((m, a) => Math.max(m, a.seq + 1), 0);
    for (let i = 0; i < count; i++) {
      if (have.has(i)) continue;
      const r = await api(`/api/notes/${id}/audio/${i}`, {}, 0);
      if (r.status === 404) break;
      await ok(r);
      const blob = await r.blob();
      await db.put('audio', { key: QL.akey(id, seq), noteId: id, seq: seq++, blob, mime: blob.type || 'audio/webm', srv: i });
      rep.changed.add(id);
    }
    const n = (await QL.audioOf(id)).length;
    await db.update('notes', id, (y) => {
      if (!y) return;
      y.has_audio = n ? 1 : 0;
      y.sync = { ...y.sync, srv: { ...y.sync.srv, audio_count: count } };
      return y;
    });
  }

  // Nota nata sul dispositivo: la si crea sul server con lo stesso id
  async function pushNew(L, rep) {
    const r = await api('/api/notes', { method: 'POST', headers: JSONH, body: JSON.stringify({ id: L.id, title: L.title, voiceFirst: !!L.voice_first }) });
    if (r.status === 409) return;                     // c'è già (risposta persa): si allinea al prossimo giro
    await ok(r);
    const s = await r.json();
    let id = L.id;
    if (s.id !== L.id) { await QL.rekey(L.id, s.id); id = s.id; }
    const x = { id, version: s.version, title: s.title, grid: s.grid, tags: [], deleted_at: null, whisper_len: 0, audio_count: 0 };
    await setSync(id, { srv: snap(x), dirty: true });
    rep.pushed++;
    return syncNote(id, x, rep);
  }

  // Lo stesso id c'è sul server ma il dispositivo non l'ha mai sincronizzato
  // (archivio del server importato qui, collegamento rifatto da capo).
  async function adopt(L, x, rep) {
    if (x.version === 1 && !x.audio_count) {
      // creata da qui e mai riempita (invio interrotto): è questa
      await setSync(L.id, { srv: snap(x), dirty: true });
      return syncNote(L.id, x, rep);
    }
    let same = false;
    const r = await api(`/api/notes/${L.id}`);
    if (r.ok) {
      const s = await r.json();
      same = JSON.stringify(s.pages_data ?? null) === JSON.stringify(L.pages_data ?? null);
    }
    if (!same) await copyOf(L, 'dal dispositivo', rep);
    // Audio uguale per numero di sessioni: è lo stesso, non si rimanda
    const local = await QL.audioOf(L.id);
    if (local.length && local.length === x.audio_count) {
      for (let i = 0; i < local.length; i++) await db.update('audio', local[i].key, (a) => { if (!a) return; a.srv = i; return a; });
    }
    // Il server vince: contenuto e campi si riprendono da lì
    await setSync(L.id, {
      dirty: false,
      srv: { ...snap(x), version: -1, title: L.title, grid: L.grid, tags: JSON.stringify(L.tags || []), deleted: !!L.deleted_at, whisper_len: -1 },
    });
    return syncNote(L.id, x, rep);
  }

  // Nota che il dispositivo non ha ancora
  async function pullNew(x, rep) {
    const r = await api(`/api/notes/${x.id}`);
    if (r.status === 404) return;
    await ok(r);
    const s = await r.json();
    await db.put('notes', QL.newNote({
      id: s.id, title: s.title, grid: s.grid || 'lines', strokes: s.strokes || [], images: s.images || [],
      thumbnail: s.thumbnail || null, canvas_text: s.canvas_text || null, text_items: s.text_items || [],
      pages_data: s.pages_data || null, whisper_text: s.whisper_text || null, whisper_segments: s.whisper_segments || null,
      voice_first: s.voice_first ? 1 : 0, tags: s.tags || [], created_at: s.created_at, updated_at: s.updated_at,
      sync: { dirty: false, srv: { ...snap(x), version: s.version, title: s.title, grid: s.grid, tags: JSON.stringify(s.tags || []), audio_count: 0 } },
    }));
    await syncAudio(s.id, x.audio_count || 0, rep);
    rep.pulled++; rep.changed.add(s.id);
  }

  // ── Un giro completo ───────────────────────────────────
  async function syncAll(rep) {
    const r = await ok(await api('/api/sync', {}, 20000));
    const { notes, trash_days } = await r.json();
    if (trash_days && trash_days !== QL.link.trashDays) await QL.updateLink({ trashDays: trash_days });
    const R = new Map(notes.map(x => [x.id, x]));

    // Eliminate per sempre sul dispositivo: anche sul server, se nel
    // frattempo nessuno ci ha scritto
    const tombs = await QL.getTombs();
    for (const [id, version] of Object.entries(tombs)) {
      const x = R.get(id);
      // (se invece è cambiata altrove resta in R e torna sul dispositivo)
      if (x && x.version === version) {
        if (!x.deleted_at) await ok(await api(`/api/notes/${id}`, { method: 'DELETE' }), [404]);
        await ok(await api(`/api/trash/${id}`, { method: 'DELETE' }), [404]);
        R.delete(id);
      }
      await QL.dropTomb(id);
    }

    const each = async (fn) => {
      try { await fn(); }
      catch (e) {
        if (e.stop || e.offline) throw e;
        console.warn('[quetza] sincronizzazione:', e);
        rep.errors.push(e.message);
      }
    };
    for (const L of await db.all('notes')) {
      await each(() => syncNote(L.id, R.get(L.id), rep));
      R.delete(L.id);
    }
    // Nuove sul server (quelle già nel cestino del server restano lì)
    for (const x of R.values()) if (!x.deleted_at) await each(() => pullNew(x, rep));
  }

  const st = { running: null, again: false };
  async function run() {
    const link = QL.link;
    if (!link || link.state === 'expired') return;
    if (st.running) { st.again = true; return st.running; }
    st.running = (async () => {
      const rep = { pulled: 0, pushed: 0, trashed: 0, copies: [], errors: [], changed: new Set(), again: false };
      await QL.updateLink({ state: 'running' });
      try {
        let rounds = 0;
        do { st.again = false; rep.again = false; await syncAll(rep); }
        while ((st.again || rep.again) && ++rounds < 3);
        await QL.updateLink({ state: rep.errors.length ? 'error' : 'ok', lastSync: Date.now(), lastError: rep.errors[0] || null });
      } catch (e) {
        await QL.updateLink({ state: e.state || (e.offline ? 'offline' : 'error'), lastError: e.offline ? null : e.message });
      } finally {
        st.running = null;
        report(rep);
      }
    })();
    return st.running;
  }

  function report(rep) {
    if (rep.changed.size || rep.copies.length || rep.trashed)
      window.dispatchEvent(new CustomEvent('quetza:synced', { detail: { changed: [...rep.changed] } }));
    if (rep.copies.length) say(`⚠ Note cambiate sia qui sia altrove: il lavoro di questo dispositivo è in ${rep.copies.map(t => `"${t}"`).join(', ')}`, 10000);
    if (rep.trashed) say(`${rep.trashed === 1 ? 'Una nota eliminata' : rep.trashed + ' note eliminate'} sul server: ${rep.trashed === 1 ? 'è' : 'sono'} nel cestino di questo dispositivo`, 7000);
    if (QL.link?.state === 'expired') say('⚠ Collegamento al server scaduto o revocato: le note restano qui. Ricollega dal pulsante del server.', 9000);
    refreshUI();
  }

  // Prima della condivisione o della trascrizione: la nota (con l'audio)
  // deve essere già tutta sul server.
  QL.pushNote = async (id) => {
    await run();
    const n = await db.get('notes', id);
    const audio = await QL.audioOf(id);
    if (!n?.sync?.srv || n.sync.dirty || audio.some(a => a.srv == null)) throw new Error('nota non ancora sul server');
  };
  QL.syncNow = run;

  // Note ancora da mandare al server
  async function pending() {
    let n = 0;
    for (const x of await db.all('notes')) if (!x.deleted_at && (!x.sync?.srv || x.sync.dirty || x.sync.audioCleared)) n++;
    return n;
  }

  // ── Collegamento ───────────────────────────────────────
  function normalize(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      // Da una pagina https il browser blocca le richieste http
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && location.protocol === 'http:')) return null;
      return u.origin;
    } catch { return null; }
  }
  const deviceName = () => QL.client?.device || (/Android/i.test(navigator.userAgent) ? 'Dispositivo Android' : 'Browser');

  async function startLink(server, force) {
    if (!force) {
      try {
        const r = await fetch(server + '/api/login-config', { mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout?.(8000) });
        if (!r.ok) throw new Error();
      } catch { return false; }
    }
    if (typeof flushSave === 'function') await flushSave();
    const back = location.origin + location.pathname;
    location.href = `${server}/collega.html?app=${encodeURIComponent(back)}&nome=${encodeURIComponent(deviceName())}`;
    return true;
  }

  async function unlink(wipe) {
    try { await QL.serverFetch('/api/devices/current', { method: 'DELETE' }, 8000); } catch {}
    await QL.setLink(null);
    if (wipe) {
      for (const n of await db.all('notes')) await QL.purgeNote(n, false);
      await db.del('kv', 'tombs');
      await db.del('kv', 'shared');
    }
    window.dispatchEvent(new CustomEvent('quetza:synced', { detail: { changed: [] } }));
  }

  // ── Interfaccia ────────────────────────────────────────
  const ICON_CLOUD = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
  const ICON_DEVICE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';

  function statusText(link) {
    const last = link.lastSync ? `ultima sincronizzazione alle ${hhmm(link.lastSync)}` : 'mai sincronizzato';
    switch (link.state) {
      case 'running': return 'Sincronizzazione in corso…';
      case 'offline': return `Server non raggiungibile: riprovo da solo (${last})`;
      case 'expired': return 'Collegamento scaduto o revocato: ricollega per riprendere a sincronizzare';
      case 'error': return `Sincronizzato in parte (${last}): ${link.lastError || 'errore'}`;
      default: return link.lastSync ? `Sincronizzato alle ${hhmm(link.lastSync)}` : 'In attesa della prima sincronizzazione';
    }
  }

  async function refreshUI() {
    const link = QL.link;
    document.body.classList.toggle('qlocal', true);
    document.body.classList.toggle('qlunlinked', !link);
    const btn = document.getElementById('logoutB');
    if (btn) {
      btn.innerHTML = link ? ICON_CLOUD : ICON_DEVICE;
      btn.title = link ? `Server e sincronizzazione — ${statusText(link)}` : 'Note solo su questo dispositivo — collega un server';
      btn.classList.toggle('qlWarn', !link || ['expired', 'error'].includes(link.state));
    }
    const ban = document.getElementById('LOCALBAN');
    if (ban) {
      let hidden = false;
      try { hidden = Number(localStorage.getItem('quetza-noban') || 0) > Date.now(); } catch {}
      if (!link && !hidden) {
        ban.innerHTML = `<span>📱 Le note sono solo su questo dispositivo, senza backup. Collega un server Quetza oppure esportale ogni tanto.</span>
          <button class="aurorBtn xs" data-a="panel">Collega un server</button><button class="lbX" data-a="hide" title="Nascondi per una settimana">✕</button>`;
        ban.hidden = false;
      } else if (link?.state === 'expired') {
        ban.innerHTML = `<span>⚠ Collegamento a ${h(host(link.server))} scaduto o revocato: le modifiche restano su questo dispositivo.</span>
          <button class="aurorBtn xs" data-a="relink">Ricollega</button>`;
        ban.hidden = false;
      } else ban.hidden = true;
    }
    const stEl = document.getElementById('_srv_st');
    if (stEl && link) {
      const n = await pending();
      stEl.textContent = statusText(link) + (n ? ` · ${n === 1 ? 'una nota' : n + ' note'} da inviare` : '');
    }
  }

  function setupUI() {
    const lib = document.getElementById('LIBRARY');
    const bar = lib?.querySelector('.libToolbar');
    if (bar && !document.getElementById('LOCALBAN')) {
      const ban = document.createElement('div');
      ban.id = 'LOCALBAN';
      ban.className = 'localBan';
      ban.hidden = true;
      bar.after(ban);
      ban.onclick = (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'panel') openPanel();
        if (a === 'relink') startLink(QL.link.server, true);
        if (a === 'hide') { try { localStorage.setItem('quetza-noban', String(Date.now() + 7 * 86400000)); } catch {} refreshUI(); }
      };
    }
    // L'admin e il cambio password sono del sito: qui non servono
    document.getElementById('adminLink')?.remove();
    refreshUI();
  }

  function openPanel() {
    document.getElementById('_srv')?.remove();
    const link = QL.link, C = QL.client || {};
    const m = document.createElement('div');
    m.id = '_srv';
    m.className = 'MW';
    if (!link) {
      m.innerHTML = `
        <div class="MD" style="width:420px;max-width:calc(100vw - 32px)">
          <h3>Server Quetza</h3>
          <p class="ms">Ora le note sono solo su questo dispositivo: se si perde o si rompe, si perdono anche loro. Collegandolo al server Quetza della tua organizzazione le note si sincronizzano in entrambi i sensi e restano anche lì; si potranno condividere con i colleghi e trascrivere.</p>
          <input type="url" id="_srv_url" placeholder="https://quetza.azienda.local:8443" value="${h(C.server || '')}" ${C.managed ? 'disabled' : ''}
                 style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r);font-size:.9rem;font-family:inherit;margin-bottom:6px">
          ${C.managed ? '<p class="ms" style="margin-bottom:6px">Indirizzo impostato dall\'amministratore.</p>' : ''}
          <div id="_srv_err" style="color:var(--danger,#c0392b);font-size:.74rem;min-height:16px;margin-bottom:6px"></div>
          <div class="ma">
            <button class="mc" data-a="close">Non ora</button>
            <button class="mk" data-a="link">Collega</button>
          </div>
        </div>`;
    } else {
      m.innerHTML = `
        <div class="MD" style="width:420px;max-width:calc(100vw - 32px)">
          <h3>Server Quetza</h3>
          <p class="ms">Collegato a <b>${h(host(link.server))}</b> come <b>${h(link.name || link.user)}</b>. Le note di questo dispositivo e quelle dell'account si sincronizzano da sole.</p>
          <p class="ms" id="_srv_st">…</p>
          <div class="ma">
            <button class="mc danger" data-a="unlink">Scollega</button>
            ${link.state === 'expired' ? '<button class="mk" data-a="relink">Ricollega</button>' : '<button class="mk" data-a="sync">Sincronizza ora</button>'}
            <button class="mc" data-a="close">Chiudi</button>
          </div>
        </div>`;
    }
    document.body.appendChild(m);
    refreshUI();
    let force = false;
    m.onclick = async (e) => {
      if (e.target === m) return m.remove();
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'close') return m.remove();
      if (a === 'sync') { run(); setTimeout(refreshUI, 50); return; }
      if (a === 'relink') return startLink(link.server, true);
      if (a === 'unlink') return m.remove(), confirmUnlink();
      if (a === 'link') {
        const err = m.querySelector('#_srv_err');
        const server = normalize(m.querySelector('#_srv_url').value);
        if (!server) { err.textContent = 'Indirizzo non valido: serve quello https del server, es. https://quetza.azienda.local:8443'; return; }
        err.textContent = 'Verifica del server…';
        if (!(await startLink(server, force))) {
          err.textContent = 'Server non raggiungibile da qui (rete, certificato o server non abilitato per l\'app). Controlla l\'indirizzo, oppure premi di nuovo per aprirlo comunque.';
          force = true;
          e.target.textContent = 'Apri comunque';
        }
      }
    };
    const inp = m.querySelector('#_srv_url');
    if (inp && !inp.disabled) { inp.onkeydown = (e) => { if (e.key === 'Enter') m.querySelector('[data-a="link"]').click(); }; setTimeout(() => inp.focus(), 50); }
  }

  async function confirmUnlink() {
    const n = await pending();
    const m = document.createElement('div');
    m.id = '_srvx';
    m.className = 'MW';
    m.innerHTML = `
      <div class="MD" style="width:420px;max-width:calc(100vw - 32px)">
        <h3>Scollegare il server?</h3>
        <p class="ms">Le note smettono di sincronizzarsi. Quelle sul server restano dove sono.</p>
        ${n ? `<p class="ms"><b>${n === 1 ? 'Una nota non è ancora' : n + ' note non sono ancora'} sul server</b>: scollegando ora resta${n === 1 ? '' : 'no'} solo su questo dispositivo.</p>` : ''}
        <div class="ma" style="flex-wrap:wrap">
          <button class="mc" data-a="close">Annulla</button>
          ${n ? '' : '<button class="mc danger" data-a="wipe" title="Per passare il dispositivo a un\'altra persona">Scollega e togli le note da qui</button>'}
          <button class="mk" data-a="keep">Scollega e tieni le note</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    m.onclick = async (e) => {
      if (e.target === m) return m.remove();
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      m.remove();
      if (a === 'keep') { await unlink(false); say('Server scollegato: le note restano su questo dispositivo'); }
      if (a === 'wipe') { await unlink(true); say('Server scollegato e note tolte da questo dispositivo'); }
    };
  }
  QL.openPanel = openPanel;

  // ── Avvio e ritmo ──────────────────────────────────────
  const loaded = new Promise(r => (document.readyState === 'complete' ? r() : window.addEventListener('load', r)));
  Promise.all([QL.ready, loaded]).then(async () => {
    setupUI();
    const inc = QL.incomingLink();
    if (inc === 'annullato') say('Collegamento annullato: le note restano solo su questo dispositivo');
    else if (inc && QL.link) say(`✓ Collegato a ${host(QL.link.server)}: sincronizzazione in corso`, 6000);
    if (QL.link) return run();
    // App installata con un server già impostato (MDM o versione
    // precedente dell'app): si propone di collegarlo, se raggiungibile.
    const server = normalize(QL.client?.server);
    if (!server) return;
    let later = 0;
    try { later = Number(localStorage.getItem('quetza-link-later') || 0); } catch {}
    if (!QL.client.managed && later > Date.now()) return;
    try {
      const r = await fetch(server + '/api/login-config', { mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout?.(6000) });
      if (!r.ok) return;
    } catch { return; }
    if (QL.link || document.getElementById('_srv')) return;
    openPanel();
    const later7 = () => { try { localStorage.setItem('quetza-link-later', String(Date.now() + 7 * 86400000)); } catch {} };
    document.querySelector('#_srv [data-a="close"]')?.addEventListener('click', later7);
  });

  let soonT = null;
  window.addEventListener('quetza:local-change', () => {
    if (!QL.link) return;
    clearTimeout(soonT);
    soonT = setTimeout(run, 4000);
  });
  window.addEventListener('quetza:link', () => { refreshUI(); });
  window.addEventListener('online', () => run());
  setInterval(() => { if (navigator.onLine !== false && document.visibilityState === 'visible') run(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
})();
