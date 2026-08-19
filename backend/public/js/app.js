'use strict';
/* ═══════════════════════════════════════════════════
   Quetza — Frontend App
   Pointer Events API: pen=draw, touch=scroll, pinch=zoom
═══════════════════════════════════════════════════ */

// ── Config ────────────────────────────────────────────────
// A4 @ 96dpi — coordinate logiche fisse
// La qualità Retina è gestita via devicePixelRatio in applyZoom
const PW = 794;   // A4 width @ 96dpi
const PH = 1123;  // A4 height @ 96dpi
// PGAP rimosso — pagine separate con canvas proprio
const GSP = 19;   // grid spacing — standard 5mm @ 96dpi (96/25.4*5 ≈ 18.9), come PW/PH
const ZOOM_STEPS = [.25,.33,.5,.67,.75,.9,1,1.1,1.25,1.5,1.75,2,2.5,3];

// ── State ─────────────────────────────────────────────────
const S = {
  // Drawing
  // penSize per penna/evidenziatore/forme; eraserSize dedicata alla gomma —
  // condividerne una sola (come prima) rendeva la gomma bloccata sullo
  // stesso range fine della penna (1-24px, troppo piccolo per cancellare
  // comodamente) e cambiava lo spessore della penna ogni volta che si
  // regolava la gomma o viceversa.
  tool: 'pen', color: '#111', penSize: 3, eraserSize: 18,
  strokes: [], undo: [], redo: [], cur: null, imgs: [],
  grid: 'lines',
  // Zoom / pan
  zoom: 1, pan: false, pY: 0, pSY: 0,
  // Palm rejection
  palmActive: false,  // true se un dito è sul canvas mentre scriviamo
  activePointers: new Map(), // pointerId → type
  // Audio
  aCtx: null, aBuf: null, src: null,
  playing: false, recOn: false,
  recStart: 0, recOffset: 0, recPaused: false, playOff: 0, playSt: 0,
  raf: null, peaks: null,
  // UI
  dark: false,
  shapeRecog: false,
  // Pagine: array di {strokes, textItems, images}
  pages: [{ strokes: [], textItems: [], images: [] }],
  curPage: 0,       // pagina corrente (0-based)
  textItems: [],    // {x, y, text, size, id}
  whisperSegments: null,  // array segmenti con start/end/text
  whisperPending: false,  // trascrizione in background in corso
  textMode: false,  // attesa click per posizionare testo
  sortOrder: 'updated',
  // Selezione
  selectedIds: new Set(),   // set di indici strokes selezionati
  selDrag: false,
  selDragStart: null,
  selDragFrom: null,        // posizioni originali degli strokes
  lassoPath: null,          // path in corso per lasso
  // Autosave
  autoSaveTimer: null,
  dirty: false,
  // Notes
  notes: [], curId: null,
  // Search
  searchQ: '',
  // User
  user: null,
};

// ── DOM refs ─────────────────────────────────────────────
const CV   = document.getElementById('C');
const cx   = CV.getContext('2d');
const CO   = document.getElementById('CO');
const CA   = document.querySelector('.CA');

// Canvas offscreen: griglia pre-renderizzata (non cambia mai durante il disegno)
// e strokes statici (tutto tranne il tratto corrente)
// Questo evita di ridisegnare tutto ad ogni evento pointermove
const _gridCanvas  = document.createElement('canvas');
const _gridCtx     = _gridCanvas.getContext('2d');
const _strokeCanvas = document.createElement('canvas');
const _strokeCtx    = _strokeCanvas.getContext('2d');
let _gridDirty   = true;  // la griglia va ridisegnata
let _strokeDirty = true;  // gli strokes statici vanno ridisegnati
let _rafPending  = false; // un RAF è già in coda
const CW   = document.getElementById('CW');
const LIBRARY = document.getElementById('LIBRARY');
const EDITOR  = document.getElementById('EDITOR');
const NTT  = document.getElementById('NTT');
const APP  = document.getElementById('W');
const TSel = { classList: { add:()=>{}, remove:()=>{} }, clientHeight: 0 };
const MP   = document.getElementById('MP');
const TT   = document.getElementById('TT');
const WC   = document.getElementById('WC');
const wx   = WC.getContext('2d');
const PW2  = document.getElementById('PW');
const SC   = document.getElementById('SC');
const ATM  = document.getElementById('ATM');
const AB   = document.getElementById('AB');
const RTM  = document.getElementById('RTM');
const ZL   = document.getElementById('ZL');
const SZR  = document.getElementById('SZR');
const SZV  = document.getElementById('SZV');
const GSL  = document.getElementById('GSL');

// ── Init ──────────────────────────────────────────────────
async function init() {
  try {
    const r = await fetch('/api/me');
    if (!r.ok) { window.location.href = '/login.html'; return; }
    const d = await r.json();
    S.user = d.user;
    const label = d.user.displayName || d.user.username;
    document.getElementById('UNAME').textContent = label;
    if (d.user.is_admin) { const al=document.getElementById('adminLink'); if(al) al.style.display='flex'; }
    // Password provvisoria: nessuna API è utilizzabile finché non viene cambiata
    if (d.must_change_password) { showChangePasswordModal(true); return; }
  } catch { window.location.href = '/login.html'; return; }

  await loadNotes();
  restoreDarkMode();
  setupToolbar();
  setupLibrary();
  setupZoom();
  setupCanvas();
  setupPages();
  startNetMonitor();
  // Auto-detect logo (come Stego) — cerca assets/logo.*
  (async () => {
    const hdr = document.getElementById('APPHDR');
    const logo = document.getElementById('brandLogo');
    if (!hdr || !logo) return;
    for (const src of ['assets/logo.svg','assets/logo.png','assets/logo.webp','assets/logo.jpg']) {
      try {
        const r = await fetch(src, { method: 'HEAD' });
        // Il server ha una route catch-all che risponde 200 con index.html per
        // qualunque path inesistente: senza controllare il Content-Type, il
        // probe "trova" sempre un logo al primo tentativo e nasconde il
        // brand mark reale mostrando un'immagine rotta al suo posto.
        const ct = r.headers.get('Content-Type') || '';
        if (r.ok && ct.startsWith('image/')) { logo.src = src; logo.hidden = false; hdr.classList.add('hasCustomLogo'); break; }
      } catch {}
    }
  })();
}

// ── Cambio password ───────────────────────────────────────
// forced=true → l'utente ha una password provvisoria (seed admin o reset
// amministratore) e non può usare l'app finché non la cambia.
function showChangePasswordModal(forced) {
  document.getElementById('_cpw')?.remove();
  const m = document.createElement('div');
  m.id = '_cpw';
  m.className = 'MW';
  m.innerHTML = `
    <div class="MD" style="width:360px">
      <h3>${forced ? 'Cambia la password' : 'Cambia password'}</h3>
      <p class="ms">${forced
        ? 'Stai usando una password provvisoria. Scegline una nuova per continuare.'
        : 'Scegli una nuova password per il tuo account.'}</p>
      <input type="password" id="_cpw_old" placeholder="Password attuale" autocomplete="current-password"
             style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r);font-size:.9rem;font-family:inherit;margin-bottom:8px">
      <input type="password" id="_cpw_new" placeholder="Nuova password (min. 8 caratteri)" autocomplete="new-password"
             style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r);font-size:.9rem;font-family:inherit;margin-bottom:8px">
      <input type="password" id="_cpw_new2" placeholder="Ripeti la nuova password" autocomplete="new-password"
             style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r);font-size:.9rem;font-family:inherit;margin-bottom:8px">
      <div id="_cpw_err" style="color:var(--acc,#c0392b);font-size:.74rem;min-height:16px;margin-bottom:6px"></div>
      <div class="ma">
        ${forced ? '' : '<button class="mc" id="_cpw_canc">Annulla</button>'}
        <button class="mk" id="_cpw_ok">Cambia password</button>
      </div>
    </div>`;
  document.body.appendChild(m);

  const err = m.querySelector('#_cpw_err');
  m.querySelector('#_cpw_canc')?.addEventListener('click', () => m.remove());
  m.querySelector('#_cpw_ok').onclick = async () => {
    const oldPw = m.querySelector('#_cpw_old').value;
    const nw    = m.querySelector('#_cpw_new').value;
    const nw2   = m.querySelector('#_cpw_new2').value;
    err.textContent = '';
    if (nw.length < 8)  { err.textContent = 'La nuova password deve avere almeno 8 caratteri'; return; }
    if (nw !== nw2)     { err.textContent = 'Le due password non coincidono'; return; }
    try {
      const r = await fetch('/api/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: oldPw, newPassword: nw })
      });
      const d = await r.json();
      if (!r.ok) { err.textContent = d.error || 'Errore'; return; }
      m.remove();
      if (forced) location.reload();   // ricarica: ora le API sono sbloccate
      else toast('✓ Password aggiornata');
    } catch(e) { err.textContent = 'Errore di rete'; }
  };
  setTimeout(() => m.querySelector('#_cpw_old').focus(), 50);
}

// ── Notes API ─────────────────────────────────────────────
async function loadNotes() {
  const r = await fetch('/api/notes');
  S.notes = await r.json();
  renderNL();
}

function restoreDarkMode() {
  // L'attributo data-theme (dark/eink) è già impostato dallo script di
  // bootstrap in <head>, prima del parsing del CSS. Qui sincronizziamo solo
  // S.dark — vero solo per il tema scuro: l'e-ink ha comunque pagina bianca,
  // quindi la penna di default resta nera come in chiaro.
  try {
    if (localStorage.getItem('auror-theme') === 'dark') {
      S.dark = true;
      if (S.color === '#111') setColor('#fff');
    }
  } catch {}
}

// Carica tutte le sessioni audio di una nota e le concatena in un unico AudioBuffer
async function loadAllAudioSessions(noteId) {
  if (!S.aCtx) S.aCtx = new (window.AudioContext || window.webkitAudioContext)();
  const r = await fetch(`/api/notes/${noteId}/audio`);
  if (!r.ok) return null;

  const ct = r.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    // Sessioni multiple: scarica ognuna e concatena
    const { sessions } = await r.json();
    const buffers = [];
    for (const s of sessions) {
      const sr = await fetch(`/api/notes/${noteId}/audio/${s.index}`);
      if (!sr.ok) continue;
      const ab = await sr.arrayBuffer();
      try {
        const buf = await S.aCtx.decodeAudioData(ab);
        buffers.push(buf);
      } catch(e) { console.warn(`Session ${s.index} decode failed:`, e); }
    }
    if (!buffers.length) return null;
    // Concatena tutti i buffer in ordine
    let result = buffers[0];
    for (let i = 1; i < buffers.length; i++) {
      result = concatAudioBuffers(S.aCtx, result, buffers[i]);
    }
    return result;
  } else {
    // Sessione singola: decodifica direttamente
    const ab = await r.arrayBuffer();
    return await S.aCtx.decodeAudioData(ab);
  }
}

// ── Navigazione tra schermate ────────────────────────────
// Libreria ed editor sono due schermate a tutto schermo, mai
// visibili insieme: così, con una nota aperta, il canvas ha
// tutto lo spazio disponibile invece di condividerlo con la lista.
function showEditor() {
  LIBRARY.classList.remove('on');
  EDITOR.classList.add('on');
}
function showLibrary() {
  EDITOR.classList.remove('on');
  LIBRARY.classList.add('on');
}

async function openNote(id) {
  if (S.recOn) stopRec();
  if (S.playing) stopAudio();

  const r = await fetch(`/api/notes/${id}`);
  const n = await r.json();
  S.curId = id;
  // Carica pagine
  if (n.pages_data && Array.isArray(n.pages_data) && n.pages_data.length > 0) {
    S.pages = n.pages_data;
  } else {
    // Migrazione: note vecchie con strokes flat → pagina 1
    S.pages = [{ strokes: n.strokes || [], textItems: n.text_items || [], images: n.images || [] }];
  }
  S.curPage = 0;
  S.forceCanvasView = false;         // rivalutato per la nota che si sta aprendo
  S.voiceFirst = !!n.voice_first;    // marcatore persistente, non solo "pagine vuote"
  S.whisperSegments = Array.isArray(n.whisper_segments) ? n.whisper_segments : null;
  S.grid    = n.grid || 'lines';
  S.undo = []; S.redo = []; S.selectedIds.clear(); S.cur = null;
  GSL.value = S.grid;
  NTT.value = n.title;
  updateAudioOnlyView();

  // Reset audio UI — nascosta di default: si vede solo se la nota ha già
  // un audio, oppure quando l'utente la richiama col pulsante in toolbar.
  S.aBuf = null; S.peaks = null; S.playOff = 0;
  AB.dataset.state = 'idle';
  AB.style.display = 'none';
  wx.clearRect(0, 0, WC.width, WC.height);
  TSel.classList.remove('on');

  // Carica audio (singola sessione o multi-sessione concatenata)
  if (n.has_audio) {
    try {
      if (!S.aCtx) S.aCtx = new (window.AudioContext || window.webkitAudioContext)();
      S.aBuf = await loadAllAudioSessions(id);
      if (S.aBuf) {
        buildPeaks();
        AB.dataset.state = 'playback';
        AB.style.display = 'flex';
        drawWave(0); updAT(0); TSel.classList.add('on');
      }
    } catch (e) { console.warn('Audio load failed:', e); }
  }
  updateTranscribeBtn();

  // Sincronizza strokes/textItems/imgs con pagina 0
  const pg0 = curPg();
  S.strokes   = pg0.strokes   ? [...pg0.strokes]   : [];
  S.textItems = pg0.textItems ? [...pg0.textItems] : [];
  S.imgs      = pg0.images    ? [...pg0.images]    : [];

  showEditor();
  CV.width = PW; CV.height = PH; markDirty('all');
  renderNL();
  updatePageNav();
  updatePageNav();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fitW(); // fitW chiama applyZoom che ridimensiona CV.style.width/height
    redraw();
    drawTL(0);
  }));
}

async function newNote() {
  const r = await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: defaultNoteTitle() })
  });
  const n = await r.json();
  S.notes.unshift(n);
  renderNL();
  await openNote(n.id);
}

// Nota vocale: stessa nota di sempre — pagine e trascrizione funzionano
// identiche — solo la barra audio è già in vista invece che nascosta, così
// il primo gesto naturale è premere REC. Si può comunque scrivere in
// qualsiasi momento: il canvas resta lì, "+pagina" resta sempre accessibile
// anche a registrazione in corso.
async function newVoiceNote() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' });
  const timeStr = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const r = await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `Registrazione ${dateStr} ${timeStr}`, voiceFirst: true })
  });
  const n = await r.json();
  S.notes.unshift(n);
  renderNL();
  await openNote(n.id);
  AB.style.display = 'flex';
}

// Titolo di default con data/ora — evita "Nuova nota" generico in libreria
function defaultNoteTitle() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' });
  const timeStr = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return `Nota ${dateStr} ${timeStr}`;
}

async function deleteNote(id) {
  if (!confirm('Eliminare questa nota?')) return;
  await fetch(`/api/notes/${id}`, { method: 'DELETE' });
  S.notes = S.notes.filter(n => n.id !== id);
  if (S.curId === id) { S.curId = null; S.strokes = []; S.textItems = []; showLibrary(); }
  renderNL();
}

async function duplicateNote(id) {
  const src = S.notes.find(n => n.id === id);
  if (!src) return;
  // Carica il contenuto completo
  const full = await fetch(`/api/notes/${id}`).then(r => r.json());
  // Crea nuova nota
  const nr = await fetch('/api/notes', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title: full.title + ' (copia)', voiceFirst: !!full.voice_first})});
  const newNote = await nr.json();
  // Copia contenuto — pagine e testo inclusi, altrimenti la copia perdeva
  // tutte le pagine oltre la prima e il testo digitato
  const pagesData = (Array.isArray(full.pages_data) && full.pages_data.length)
    ? full.pages_data
    : [{ strokes: full.strokes || [], textItems: full.text_items || [], images: full.images || [] }];
  await fetch(`/api/notes/${newNote.id}/content`, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      strokes: full.strokes, images: full.images, thumbnail: full.thumbnail,
      grid: full.grid, canvasText: full.canvas_text,
      textItems: full.text_items || [], pagesData: pagesData
    })
  });
  await loadNotes();
  toast('Nota duplicata');
}

function scheduleAutoSave() {
  S.dirty = true;
  clearTimeout(S.autoSaveTimer);
  S.autoSaveTimer = setTimeout(() => saveNote(true), 4000); // 4s dopo l'ultimo tratto
}

async function saveNote(silent = false) {
  if (!S.curId) return;
  // Titolo automatico se vuoto (newNote() imposta già data/ora alla creazione,
  // ma resta una rete di sicurezza per note create diversamente)
  let title = NTT.value.trim();
  if (!title) {
    title = defaultNoteTitle();
    NTT.value = title;
  }
  const thumbnail = genThumb();

  // Estrai testo dal canvas (testo digitato)
  // Salva testo di tutte le pagine per la ricerca FTS
  syncCurrentPage();
  const canvasText = S.pages.map(p => (p.textItems||[]).map(t=>t.text).join(' ')).join(' ');

  // Il salvataggio può fallire (rete, sessione scaduta): senza controllo
  // la nota risultava "salvata" e S.dirty veniva azzerato comunque, perdendo
  // silenziosamente il lavoro.
  setNetStatus('syncing');
  try {
    const rc = await fetch(`/api/notes/${S.curId}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        strokes: S.strokes, images: S.imgs, thumbnail, grid: S.grid,
        canvasText, textItems: S.textItems,
        pagesData: S.pages
      })
    });
    if (!rc.ok) throw new Error(`salvataggio contenuto: HTTP ${rc.status}`);

    const rm = await fetch(`/api/notes/${S.curId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, grid: S.grid })
    });
    if (!rm.ok) throw new Error(`salvataggio titolo: HTTP ${rm.status}`);
  } catch (e) {
    setNetStatus('offline');
    S.dirty = true;                      // resta sporca: si ritenta al prossimo giro
    clearTimeout(S.autoSaveTimer);
    S.autoSaveTimer = setTimeout(() => saveNote(true), 15000);
    toast('⚠ Salvataggio non riuscito — riprovo tra poco');
    console.error('saveNote:', e);
    renderNL();
    return false;
  }
  setNetStatus('online');

  const idx = S.notes.findIndex(n => n.id === S.curId);
  if (idx >= 0) {
    S.notes[idx].title = title;
    S.notes[idx].thumbnail = thumbnail;
    S.notes[idx].grid = S.grid;
    S.notes[idx].updated_at = new Date().toISOString();
    const [note] = S.notes.splice(idx, 1);
    S.notes.unshift(note);
  }
  renderNL();
  S.dirty = false;
  if (!silent) toast('✓ Salvato');
  return true;
}

function genThumb() {
  const o = document.createElement('canvas');
  o.width = 280; o.height = 100;
  const oc = o.getContext('2d');
  oc.fillStyle = '#fff'; oc.fillRect(0, 0, 280, 100);
  const sc = Math.min(280 / PW, 100 / PH);
  oc.save(); oc.scale(sc, sc);
  drawSS(oc, S.strokes);
  (Array.isArray(S.textItems) ? S.textItems : []).forEach(ti => {
    oc.font = `${ti.size||18}px 'Segoe UI',system-ui,sans-serif`;
    oc.fillStyle = ti.color || '#111827';
    oc.fillText(ti.text, ti.x, ti.y);
  });
  oc.restore();
  return o.toDataURL('image/jpeg', 0.7);
}

function sortedNotes() {
  const ns = [...S.notes];
  switch (S.sortOrder) {
    case 'created': return ns.sort((a,b) => new Date(b.created_at)-new Date(a.created_at));
    case 'alpha':   return ns.sort((a,b) => a.title.localeCompare(b.title, 'it'));
    default:        return ns.sort((a,b) => new Date(b.updated_at||b.created_at)-new Date(a.updated_at||a.created_at));
  }
}

function renderNL() {
  const el = document.getElementById('NL');
  el.innerHTML = '';
  const q = (S.searchQ || '').toLowerCase().trim();
  let notes = sortedNotes();
  if (q) notes = notes.filter(n => n.title.toLowerCase().includes(q));
  if (!notes.length) {
    el.innerHTML = `<div class="empty-msg">${q ? 'Nessun risultato' : 'Nessuna nota — creane una per iniziare'}</div>`;
    return;
  }
  notes.forEach(n => el.appendChild(buildNoteCard(n)));
}

const NOTE_ICON = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

// Card nella griglia libreria — usata sia per la lista normale sia per i
// risultati di ricerca full-text (che hanno un sottoinsieme dei campi nota).
function buildNoteCard(n) {
  const isDirty = n.id === S.curId && S.dirty;
  const d = document.createElement('div');
  d.className = 'noteCard' + (n.id === S.curId ? ' on' : '');
  const date = new Date(n.updated_at||n.created_at).toLocaleDateString('it-IT',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
  d.innerHTML = `
    <div class="thumb">${n.thumbnail ? `<img src="${n.thumbnail}" alt="">` : NOTE_ICON}</div>
    <div class="meta">
      <div class="title" title="Doppio click per rinominare">${esc(n.title)}${isDirty?'<span class="dirty">●</span>':''}</div>
      <div class="date">${date}</div>
      ${n.has_audio?'<div class="audioBadge">⏺ audio</div>':''}
    </div>
    <button class="menuBtn" title="Altro">⋯</button>
  `;
  // Doppio click sul titolo → rinomina inline
  d.querySelector('.title').ondblclick = e => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.value = n.title;
    input.className = 'aurorInput';
    input.style.cssText = 'height:auto;padding:2px 4px;font-size:.8rem;font-weight:600';
    d.querySelector('.title').replaceWith(input);
    input.focus(); input.select();
    const commit = async () => {
      const newTitle = input.value.trim() || n.title;
      n.title = newTitle;
      await fetch(`/api/notes/${n.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:newTitle})});
      if (n.id===S.curId) NTT.value = newTitle;
      renderNL();
    };
    input.onblur = commit;
    input.onkeydown = e => { if(e.key==='Enter') input.blur(); if(e.key==='Escape'){input.value=n.title;input.blur();} };
  };
  // Menu contestuale (⋯)
  d.querySelector('.menuBtn').onclick = e => {
    e.stopPropagation();
    showNoteMenu(n, e.currentTarget);
  };
  d.onclick = () => openNote(n.id);
  return d;
}

function showNoteMenu(n, anchor) {
  document.getElementById('_nm')?.remove();
  const m = document.createElement('div');
  m.id = '_nm';
  m.className = 'aurorCtxMenu';
  m.style.cssText = 'position:fixed;z-index:500';
  const r = anchor.getBoundingClientRect();
  m.style.right = (window.innerWidth - r.right) + 'px';
  m.style.top   = (r.bottom + 4) + 'px';
  const items = [
    ['Duplica', () => duplicateNote(n.id)],
    ['Elimina', () => deleteNote(n.id)],
  ];
  items.forEach(([label, fn]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { m.remove(); fn(); };
    m.appendChild(b);
  });
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
}

// Spessore corrente per il tipo di tratto che si sta per creare — la gomma
// ha una dimensione propria, indipendente da penna/evidenziatore/forme.
function sizeFor(t) { return t === 'eraser' ? S.eraserSize : S.penSize; }

function setColor(c) {
  S.color = c;
  let matched = false;
  document.querySelectorAll('.sw').forEach(s => {
    const on = s.dataset.c.toLowerCase() === c.toLowerCase();
    s.classList.toggle('on', on);
    if (on) matched = true;
  });
  // Colore scelto dalla tavolozza (non una delle 3 fisse): tinge l'icona
  // "altri colori" così resta visibile quale colore è davvero attivo
  const more = document.getElementById('COLORMORE');
  if (more) more.style.color = matched ? '' : c;
}
function applyDarkColor() {
  const bk = document.getElementById('SW_BK');
  if (S.dark) {
    if (bk) { bk.dataset.c = '#fff'; bk.style.background = '#fff'; }
    if (S.color === '#111') setColor('#fff');
  } else {
    if (bk) { bk.dataset.c = '#111'; bk.style.background = '#111'; }
    if (S.color === '#fff') setColor('#111');
  }
}

// ── Color picker — pattern AUROR: quadrato SV + striscia tonalità + hex ──
const CP_PRESETS = ['#111111','#ffffff','#c0392b','#e67e22','#f5a000','#1e8449','#2471a3','#8e44ad'];
let cpHue = 0, cpSat = 0, cpVal = 0.07; // stato corrente del picker (0..360 / 0..1 / 0..1)

function hsvToHex(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r, g, b;
  if (h < 60) { r=c; g=x; b=0; } else if (h < 120) { r=x; g=c; b=0; }
  else if (h < 180) { r=0; g=c; b=x; } else if (h < 240) { r=0; g=x; b=c; }
  else if (h < 300) { r=c; g=0; b=x; } else { r=x; g=0; b=c; }
  const R = Math.round((r+m)*255), G = Math.round((g+m)*255), B = Math.round((b+m)*255);
  return '#' + [R,G,B].map(n => n.toString(16).padStart(2,'0')).join('');
}
function hexToHsv(hex) {
  hex = hex.replace('#','');
  if (hex.length === 3) hex = hex.split('').map(c=>c+c).join('');
  const r = parseInt(hex.slice(0,2),16)/255, g = parseInt(hex.slice(2,4),16)/255, b = parseInt(hex.slice(4,6),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g-b)/d) % 6);
    else if (max === g) h = 60 * ((b-r)/d + 2);
    else h = 60 * ((r-g)/d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d/max, v: max };
}

// Riferimenti DOM del picker cercati una volta sola: paintCP() viene invocata
// ad ogni pointermove durante il drag (fino a decine di volte al secondo) e
// ripetere 5 getElementById per chiamata era lavoro sprecato ad ogni frame.
const CPSV_EL      = document.getElementById('CPSV');
const CPSVCUR_EL   = document.getElementById('CPSVCUR');
const CPHUECUR_EL  = document.getElementById('CPHUECUR');
const CPPREVIEW_EL = document.getElementById('CPPREVIEW');
const CPHEX_EL      = document.getElementById('CPHEX');

function paintCP() {
  const hex = hsvToHex(cpHue, cpSat, cpVal);
  CPSV_EL.style.background =
    `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${cpHue},100%,50%))`;
  CPSVCUR_EL.style.left = (cpSat*100)+'%';
  CPSVCUR_EL.style.top  = ((1-cpVal)*100)+'%';
  CPHUECUR_EL.style.left = (cpHue/360*100)+'%';
  CPPREVIEW_EL.style.background = hex;
  CPHEX_EL.value = hex.toUpperCase();
}

function openColorPicker() {
  const start = /^#[0-9a-f]{6}$/i.test(S.color) ? S.color : '#111111';
  const hsv = hexToHsv(start);
  cpHue = hsv.h; cpSat = hsv.s; cpVal = hsv.v;
  const sw = document.getElementById('CPSWATCH');
  sw.innerHTML = '';
  CP_PRESETS.forEach(c => {
    const b = document.createElement('button');
    b.style.background = c;
    b.title = c;
    b.onclick = () => { const h = hexToHsv(c); cpHue=h.h; cpSat=h.s; cpVal=h.v; paintCP(); };
    sw.appendChild(b);
  });
  paintCP();
  document.getElementById('COLORM').classList.remove('off');
}

function setupColorPicker() {
  const sv = document.getElementById('CPSV');
  const hue = document.getElementById('CPHUE');

  // Il rettangolo non cambia durante un singolo drag: misurarlo una volta sola
  // al pointerdown invece che ad ogni pointermove evita un reflow forzato per
  // ogni frame del trascinamento.
  let svRect = null, hueRect = null;
  function dragSV(e) {
    const r = svRect;
    cpSat = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    cpVal = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    paintCP();
  }
  sv.addEventListener('pointerdown', e => {
    e.preventDefault(); sv.setPointerCapture(e.pointerId);
    svRect = sv.getBoundingClientRect();
    dragSV(e);
    sv.onpointermove = dragSV;
  });
  sv.addEventListener('pointerup', () => { sv.onpointermove = null; });

  function dragHue(e) {
    const r = hueRect;
    cpHue = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 360;
    paintCP();
  }
  hue.addEventListener('pointerdown', e => {
    e.preventDefault(); hue.setPointerCapture(e.pointerId);
    hueRect = hue.getBoundingClientRect();
    dragHue(e);
    hue.onpointermove = dragHue;
  });
  hue.addEventListener('pointerup', () => { hue.onpointermove = null; });

  document.getElementById('CPHEX').addEventListener('change', e => {
    const v = e.target.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v)) {
      const h = hexToHsv(v.startsWith('#') ? v : '#'+v);
      cpHue = h.h; cpSat = h.s; cpVal = h.v;
      paintCP();
    }
  });

  document.getElementById('COLORMORE').onclick = openColorPicker;
  document.getElementById('CPCANC').onclick = () => document.getElementById('COLORM').classList.add('off');
  document.getElementById('CPOK').onclick = () => {
    setColor(hsvToHex(cpHue, cpSat, cpVal));
    if (S.tool === 'eraser') document.querySelector('[data-t="pen"]').click();
    document.getElementById('COLORM').classList.add('off');
  };
}

// ── Popover verticale per lo spessore — a comparsa dal pulsante in toolbar ──
// La gomma ha un range più ampio e più spesso: 1-24px va bene per una punta
// fine, ma per cancellare comodamente serve poter arrivare più grossi.
function openSizePopover(anchor) {
  document.getElementById('_szp')?.remove();
  const isEraser = S.tool === 'eraser';
  const min = isEraser ? 6 : 1, max = isEraser ? 90 : 24;
  const cur = isEraser ? S.eraserSize : S.penSize;
  const pop = document.createElement('div');
  pop.id = '_szp';
  pop.className = 'sizePop';
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.round(r.left) + 'px';
  pop.style.top  = Math.round(r.bottom + 6) + 'px';
  pop.innerHTML = `
    <span class="sizePopV" id="_szpv">${cur}</span>
    <input type="range" min="${min}" max="${max}" step="1" value="${cur}" id="_szpr">
  `;
  document.body.appendChild(pop);
  const input = pop.querySelector('#_szpr');
  const label = pop.querySelector('#_szpv');
  input.oninput = () => {
    const v = parseInt(input.value);
    if (isEraser) S.eraserSize = v; else S.penSize = v;
    label.textContent = v;
    SZV.textContent = v;
  };
  setTimeout(() => document.addEventListener('click', function close(e) {
    if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
      pop.remove();
      document.removeEventListener('click', close);
    }
  }), 0);
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Accessori pagina corrente
function curPg() { return S.pages[S.curPage] || (S.pages[S.curPage] = { strokes:[], textItems:[], images:[] }); }

// Riversa lo stato di lavoro (S.strokes/textItems/imgs) nella pagina corrente.
// Va chiamata prima di qualunque operazione che legga S.pages nel suo insieme:
// salvataggio, cambio pagina, export PDF, duplicazione.
function syncCurrentPage() {
  const pg = curPg();
  pg.strokes   = [...S.strokes];
  pg.textItems = [...S.textItems];
  pg.images    = [...S.imgs];
  return pg;
}

// ── Nota vocale: nessun foglio in vista finché non c'è davvero contenuto ──
function pagesAreEmpty() {
  return S.pages.every(pg =>
    (!pg.strokes   || pg.strokes.length   === 0) &&
    (!pg.textItems || pg.textItems.length === 0) &&
    (!pg.images    || pg.images.length    === 0)
  );
}

// Il suggerimento si vede solo per note nate come "Nota vocale" (S.voiceFirst,
// marcatore persistente sulla nota) — un controllo sulle sole pagine vuote
// non basterebbe: anche una nota normale appena creata è vuota allo stesso
// modo, e deve invece mostrare subito il foglio bianco come sempre.
// S.forceCanvasView (impostato da "Inizia a scrivere") vince sempre: una
// volta rivelato il foglio in questa sessione, resta visibile anche se
// ancora vuoto — altrimenti sparirebbe di nuovo al primo ricalcolo.
function updateAudioOnlyView() {
  const showHint = S.voiceFirst && pagesAreEmpty() && !S.forceCanvasView;
  CA.classList.toggle('audioOnly', showHint);
}

// ── Draw helpers ──────────────────────────────────────────
function totalH() { return PH; }  // una pagina alla volta
function maxY() {
  let m = 0;
  (S.strokes||[]).forEach(s => s.pts && s.pts.forEach(p => { if (p.y > m) m = p.y; }));
  return m;
}

function drawGrid(c, dk) {
  if (S.grid === 'none') return;
  c.save(); c.lineWidth = .5;
  // Prima troppo tenue (.06/.18) — quasi invisibile su schermo
  const lc = dk ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.14)';
  const dc = dk ? 'rgba(255,255,255,.32)' : 'rgba(0,0,0,.32)';
  if (S.grid === 'lines' || S.grid === 'grid') {
    c.strokeStyle = lc;
    for (let y = GSP; y < PH; y += GSP) { c.beginPath(); c.moveTo(0, y); c.lineTo(PW, y); c.stroke(); }
    if (S.grid === 'grid') for (let x = GSP; x < PW; x += GSP) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, PH); c.stroke(); }
  } else if (S.grid === 'dots') {
    c.fillStyle = dc;
    for (let y = GSP; y < PH; y += GSP) for (let x = GSP; x < PW; x += GSP) { c.beginPath(); c.arc(x, y, 1.2, 0, Math.PI*2); c.fill(); }
  }
  c.restore();
}

function drawSeps() {}  // pagine separate — no separatori

function drawHi(c, hTs) {
  if (hTs == null) return;
  const nb = S.strokes.filter(s => s.aTs != null && Math.abs(s.aTs - hTs) < 1800 && s.t !== 'eraser');
  if (!nb.length) return;
  c.save(); c.fillStyle = 'rgba(255,215,0,.58)';
  nb.forEach(s => {
    if (!s.pts || s.pts.length < 2) return;
    let mx=1e9, Mx=-1e9, my=1e9, My=-1e9;
    s.pts.forEach(p => { mx=Math.min(mx,p.x); Mx=Math.max(Mx,p.x); my=Math.min(my,p.y); My=Math.max(My,p.y); });
    const pd=16, rx=mx-pd, ry=my-pd, rw=Mx-mx+pd*2, rh=My-my+pd*2, r=8;
    c.beginPath();
    c.moveTo(rx+r, ry); c.lineTo(rx+rw-r, ry); c.arcTo(rx+rw, ry, rx+rw, ry+r, r);
    c.lineTo(rx+rw, ry+rh-r); c.arcTo(rx+rw, ry+rh, rx+rw-r, ry+rh, r);
    c.lineTo(rx+r, ry+rh); c.arcTo(rx, ry+rh, rx, ry+rh-r, r);
    c.lineTo(rx, ry+r); c.arcTo(rx, ry, rx+r, ry, r);
    c.closePath(); c.fill();
  });
  c.restore();
}

const SHAPES = new Set(['rect','ellipse','line','arrow']);
const LASSO_COLOR = 'rgba(36,113,163,0.5)';

// Il nero/bianco "neutro" (swatch SW_BK) deve restare leggibile nel tema
// ATTUALE, indipendentemente da quello attivo quando il tratto è stato
// disegnato — altrimenti un tratto nero scritto in chiaro diventa
// invisibile passando a scuro (e un tratto bianco scritto in scuro diventa
// invisibile tornando in chiaro). I colori "veri" (rosso/blu/ecc.) restano
// leggibili su entrambi gli sfondi e non vengono toccati.
function ink(c, dark) {
  const lc = (c || '').toLowerCase();
  if (dark  && (lc === '#111' || lc === '#111111' || lc === '#000' || lc === '#000000')) return '#e0e4ea';
  if (!dark && (lc === '#fff' || lc === '#ffffff')) return '#111827';
  return c;
}

// dark: true solo per il rendering live in editor — miniature ed export PDF
// restano sempre foglio bianco/inchiostro scuro, quindi non lo passano.
function drawSS(c, ss, dark) {
  ss.forEach(s => {
    if (!s.pts || s.pts.length < 2) return;
    c.save();
    if (s.t === 'hl') {
      c.globalAlpha = .45; c.strokeStyle = '#ffe000'; c.lineCap = 'square'; c.lineWidth = (s.sz||3)*5;
      c.beginPath(); c.moveTo(s.pts[0].x, s.pts[0].y);
      for (let i=1; i<s.pts.length; i++) { const p=s.pts[i], pr=s.pts[i-1]; c.quadraticCurveTo(pr.x, pr.y, (pr.x+p.x)/2, (pr.y+p.y)/2); }
      c.stroke();
    } else if (s.t === 'eraser') {
      c.globalCompositeOperation = 'destination-out'; c.strokeStyle = 'rgba(0,0,0,1)'; c.lineCap = 'round';
      c.beginPath(); c.moveTo(s.pts[0].x, s.pts[0].y);
      for (let i=1; i<s.pts.length; i++) { const p=s.pts[i], pr=s.pts[i-1]; c.lineWidth=(s.sz||3)*(.5+(p.p||.5)*.8); c.quadraticCurveTo(pr.x, pr.y, (pr.x+p.x)/2, (pr.y+p.y)/2); }
      c.stroke();
    } else if (SHAPES.has(s.t)) {
      c.strokeStyle = ink(s.c, dark); c.lineWidth = s.sz || 2; c.lineCap = 'round'; c.lineJoin = 'round';
      const x0=s.pts[0].x, y0=s.pts[0].y, x1=s.pts[s.pts.length-1].x, y1=s.pts[s.pts.length-1].y;
      c.beginPath();
      if (s.t === 'rect') { c.strokeRect(x0, y0, x1-x0, y1-y0); }
      else if (s.t === 'ellipse') { c.ellipse((x0+x1)/2, (y0+y1)/2, Math.abs(x1-x0)/2, Math.abs(y1-y0)/2, 0, 0, Math.PI*2); c.stroke(); }
      else if (s.t === 'line') { c.moveTo(x0,y0); c.lineTo(x1,y1); c.stroke(); }
      else { // arrow
        c.moveTo(x0,y0); c.lineTo(x1,y1); c.stroke();
        const a=Math.atan2(y1-y0, x1-x0), hl=14;
        c.beginPath(); c.moveTo(x1,y1);
        c.lineTo(x1-hl*Math.cos(a-.4), y1-hl*Math.sin(a-.4));
        c.lineTo(x1-hl*Math.cos(a+.4), y1-hl*Math.sin(a+.4));
        c.closePath(); c.fillStyle = ink(s.c, dark); c.fill();
      }
    } else {
      // Catmull-Rom smoothing per tratto fluido
      c.strokeStyle = ink(s.c, dark); c.lineCap = 'round'; c.lineJoin = 'round';
      const pts = s.pts;
      if (pts.length === 2) {
        c.lineWidth = (s.sz||3) * (.5 + (pts[0].p||.5) * .8);
        c.beginPath(); c.moveTo(pts[0].x, pts[0].y); c.lineTo(pts[1].x, pts[1].y); c.stroke();
      } else {
        // Disegna con larghezza variabile per pressione
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[Math.max(i-1, 0)];
          const p1 = pts[i];
          const p2 = pts[Math.min(i+1, pts.length-1)];
          const p3 = pts[Math.min(i+2, pts.length-1)];
          // Punti di controllo Catmull-Rom
          const cp1x = p1.x + (p2.x - p0.x) / 6;
          const cp1y = p1.y + (p2.y - p0.y) / 6;
          const cp2x = p2.x - (p3.x - p1.x) / 6;
          const cp2y = p2.y - (p3.y - p1.y) / 6;
          const pressure = (p1.p || .5) * .5 + (p2.p || .5) * .5;
          c.lineWidth = (s.sz||3) * (.4 + pressure * .9);
          c.beginPath();
          c.moveTo(p1.x, p1.y);
          c.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
          c.stroke();
        }
      }
    }
    c.restore();
  });
}

// Sincronizza dimensioni canvas offscreen con CV
function syncOffscreenSize() {
  const dpr = window.devicePixelRatio || 1;
  const physW = Math.round(PW * dpr);
  const physH = Math.round(totalH() * dpr);
  if (_gridCanvas.width !== physW || _gridCanvas.height !== physH) {
    _gridCanvas.width    = physW; _gridCanvas.height   = physH;
    _strokeCanvas.width  = physW; _strokeCanvas.height = physH;
    // Stessa scala del canvas principale: dpr (non zoom, che è solo CSS)
    _gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _strokeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _gridDirty = true; _strokeDirty = true;
  }
}

// Marca griglia e strokes da ridisegnare (chiamato quando cambiano)
function markDirty(what) {
  if (what === 'grid' || what === 'all') _gridDirty = true;
  if (what === 'strokes' || what === 'all') _strokeDirty = true;
}

function redraw(hTs) {
  syncOffscreenSize();
  const dk = S.dark;

  // Layer 1: griglia (offscreen, ridisegnata solo se cambia)
  if (_gridDirty) {
    _gridCtx.clearRect(0, 0, PW, PH);
    _gridCtx.fillStyle = dk ? '#23272e' : '#fff';
    _gridCtx.fillRect(0, 0, PW, PH);
    drawGrid(_gridCtx, dk);
    drawSeps(_gridCtx, dk);
    _gridDirty = false;
  }

  // Layer 2: strokes statici (offscreen, ridisegnati solo se cambiano)
  if (_strokeDirty) {
    _strokeCtx.clearRect(0, 0, PW, PH);
    S.imgs.forEach(i => _strokeCtx.drawImage(i.el, i.x, i.y, i.w, i.h));
    drawSS(_strokeCtx, S.strokes || [], S.dark);
    _strokeDirty = false;
  }

  // Composita tutto sul canvas finale (coordinate logiche — il context è scalato dpr)
  cx.clearRect(0, 0, PW, PH);
  cx.drawImage(_gridCanvas, 0, 0, PW, PH);
  cx.drawImage(_strokeCanvas, 0, 0, PW, PH);

  // Layer 3: testo digitato + overlay dinamici
  (Array.isArray(S.textItems) ? S.textItems : []).forEach(ti => {
    cx.save();
    cx.font = `${ti.size||18}px 'Segoe UI',system-ui,sans-serif`;
    cx.fillStyle = ink(ti.color || '#111827', S.dark);
    cx.fillText(ti.text, ti.x, ti.y);
    cx.restore();
  });
  if (hTs != null) drawHi(cx, hTs);
  if (S.selectedIds.size > 0) {
    S.selectedIds.forEach(idx => { if (S.strokes[idx]) drawStrokeHighlight(cx, S.strokes[idx]); });
    drawSelectionBox(cx);
  }
  if (S.lassoPath && S.lassoPath.length > 1) drawLassoPath(cx, S.lassoPath);
  if (S.cur && SHAPES.has(S.cur.t)) drawSS(cx, [S.cur], S.dark);
  // cursor crosshair già gestito da CSS in textMode
}

function strokeBBox(s) {
  if (!s.pts || !s.pts.length) return null;
  let mx=1e9, Mx=-1e9, my=1e9, My=-1e9;
  s.pts.forEach(p => { mx=Math.min(mx,p.x); Mx=Math.max(Mx,p.x); my=Math.min(my,p.y); My=Math.max(My,p.y); });
  return { x: mx, y: my, x2: Mx, y2: My, w: Mx-mx, h: My-my };
}

function selBBox() {
  let mx=1e9, Mx=-1e9, my=1e9, My=-1e9;
  S.selectedIds.forEach(idx => {
    const bb = strokeBBox(S.strokes[idx]);
    if (!bb) return;
    mx=Math.min(mx,bb.x); Mx=Math.max(Mx,bb.x2);
    my=Math.min(my,bb.y); My=Math.max(My,bb.y2);
  });
  return { x:mx, y:my, x2:Mx, y2:My, w:Mx-mx, h:My-my };
}

function drawStrokeHighlight(c, s) {
  const bb = strokeBBox(s);
  if (!bb) return;
  c.save();
  c.strokeStyle = 'rgba(36,113,163,0.5)';
  c.lineWidth = 1;
  c.setLineDash([4, 3]);
  c.strokeRect(bb.x - 3, bb.y - 3, bb.w + 6, bb.h + 6);
  c.setLineDash([]);
  c.restore();
}

function drawSelectionBox(c) {
  const bb = selBBox();
  if (bb.x > 1e8) return;
  const pad = 8;
  const x = bb.x - pad, y = bb.y - pad;
  const w = bb.w + pad*2, h = bb.h + pad*2;

  c.save();
  // Box tratteggiato blu
  c.strokeStyle = '#2471a3';
  c.lineWidth = 1.5 / S.zoom;
  c.setLineDash([6/S.zoom, 4/S.zoom]);
  c.strokeRect(x, y, w, h);
  c.setLineDash([]);

  // Handle ELIMINA (X rossa in alto a destra)
  const hx = x + w, hy = y;
  const hr = 10 / S.zoom;
  c.fillStyle = '#c0392b';
  c.beginPath(); c.arc(hx, hy, hr, 0, Math.PI*2); c.fill();
  c.fillStyle = '#fff';
  c.font = `bold ${Math.round(11/S.zoom)}px system-ui`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('✕', hx, hy);

  // Handle SPOSTA (grip al centro basso)
  const gx = x + w/2, gy = y + h;
  c.fillStyle = '#2471a3';
  c.beginPath(); c.arc(gx, gy, hr, 0, Math.PI*2); c.fill();
  c.fillStyle = '#fff';
  c.font = `bold ${Math.round(11/S.zoom)}px system-ui`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('⠿', gx, gy);
  c.restore();
}

function drawLassoPath(c, pts) {
  c.save();
  c.strokeStyle = '#2471a3';
  c.lineWidth = 1.5 / S.zoom;
  c.setLineDash([6/S.zoom, 4/S.zoom]);
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  pts.forEach(p => c.lineTo(p.x, p.y));
  c.closePath();
  c.stroke();
  c.fillStyle = 'rgba(36,113,163,0.07)';
  c.fill();
  c.setLineDash([]);
  c.restore();
}

// Auto-extend pagine rimosso — usa il tasto +

// ── Zoom ──────────────────────────────────────────────────
// Pan offset per la pagina corrente (reset ad ogni cambio pagina)
let _panOffX = 0, _panOffY = 0;

// ── Stato del pan col mouse ───────────────────────────────
// Deve stare a livello di modulo: i gestori pointer di setupCanvas() usano
// startMPan/_spaceDown, che erano dichiarati dentro setupZoom() e quindi
// invisibili da lì. Il risultato era un ReferenceError su ogni pointerdown
// del canvas, cioè niente disegno con mouse/penna su desktop.
let _mPan = false, _spaceDown = false;
let _mPanStartX = 0, _mPanStartY = 0, _mPanStartOffX = 0, _mPanStartOffY = 0;

function startMPan(clientX, clientY) {
  _mPan = true;
  _mPanStartX = clientX; _mPanStartY = clientY;
  _mPanStartOffX = _panOffX; _mPanStartOffY = _panOffY;
  CO.style.cursor = 'grabbing';
  CV.style.cursor = 'grabbing';
}
function moveMPan(clientX, clientY) {
  if (!_mPan) return;
  _panOffX = _mPanStartOffX + (clientX - _mPanStartX);
  _panOffY = _mPanStartOffY + (clientY - _mPanStartY);
  _positionCanvas();   // _applyPan era stata rimossa senza sostituirne le chiamate
}
function endMPan() {
  if (!_mPan) return;
  _mPan = false;
  CO.style.cursor = _spaceDown ? 'grab' : '';
  CV.style.cursor = 'crosshair';
}

function setupZoom() {
  document.getElementById('ZI').onclick = () => {
    const i = ZOOM_STEPS.findIndex(z => z > S.zoom - .01);
    zTo(ZOOM_STEPS[Math.min(i < 0 ? ZOOM_STEPS.length-1 : i, ZOOM_STEPS.length-1)]);
  };
  document.getElementById('ZO').onclick = () => {
    const i = [...ZOOM_STEPS].reverse().findIndex(z => z < S.zoom + .01);
    zTo(ZOOM_STEPS[Math.max(ZOOM_STEPS.length-1-(i<0?ZOOM_STEPS.length-1:i), 0)]);
  };
  document.getElementById('ZF').onclick = fitW;

  // Wheel zoom (desktop) — centrato sul cursore
  CO.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Shift+rotella o scroll orizzontale → cambia pagina
      const d = e.deltaX || e.deltaY;
      if (Math.abs(d) > 50) goPage(d > 0 ? S.curPage + 1 : S.curPage - 1);
    } else {
      // Rotella (con o senza Ctrl) → zoom, più veloce
      const factor = e.deltaMode === 1 ? 0.12 : 0.001;
      zTo(S.zoom * (1 - e.deltaY * factor));
    }
  }, { passive: false });

  // Pan con mouse: middle click o click destro + drag, sull'area grigia
  // attorno al foglio (il pan che parte DAL foglio è già gestito dal
  // pointerdown di CV, che ha la sua logica di disegno/selezione da
  // rispettare — qui si esce subito se l'evento arriva da lì).
  // Pointer Events + setPointerCapture invece di mousedown/mouseup: senza
  // capture, se il drag usciva dai bordi di CO/CV prima del rilascio del
  // tasto, mouseup non arrivava più a nessuno dei due e il pan restava
  // bloccato per sempre ("non rilascia il drag").
  function panDown(e) {
    if (e.target === CV) return;
    if (e.button === 1 || e.button === 2) { e.preventDefault(); CO.setPointerCapture(e.pointerId); startMPan(e.clientX, e.clientY); }
    else if (e.button === 0 && _spaceDown) { e.preventDefault(); CO.setPointerCapture(e.pointerId); startMPan(e.clientX, e.clientY); }
  }
  function panMove(e) { if (_mPan) moveMPan(e.clientX, e.clientY); }
  function panUp(e)   { if (_mPan) endMPan(); }

  CO.addEventListener('pointerdown',   panDown);
  CO.addEventListener('pointermove',   panMove);
  CO.addEventListener('pointerup',     panUp);
  CO.addEventListener('pointercancel', panUp);
  CO.addEventListener('contextmenu', e => e.preventDefault());

  document.addEventListener('keydown', e => {
    if (e.key === ' ' && !_spaceDown && e.target === document.body) {
      e.preventDefault(); _spaceDown = true;
      CO.style.cursor = 'grab';
    }
  });
  document.addEventListener('keyup', e => {
    if (e.key === ' ') { _spaceDown = false; CO.style.cursor = ''; }
  });

  // Blocca zoom browser
  document.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  }, { passive: false });
}

function applyZoom() {
  const dpr = window.devicePixelRatio || 1;

  // Canvas logico verticale (PW x totalH) — invariato
  const logW = PW;
  const logH = PH;
  const physW = Math.round(logW * dpr);
  const physH = Math.round(logH * dpr);
  if (CV.width !== physW || CV.height !== physH) {
    CV.width  = physW;
    CV.height = physH;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    markDirty('all');
  }
  // Dimensione CSS = dimensione logica × zoom (il canvas resta a risoluzione dpr)
  CV.style.width  = Math.round(logW * S.zoom) + 'px';
  CV.style.height = Math.round(logH * S.zoom) + 'px';
  ZL.textContent = Math.round(S.zoom * 100) + '%';
  _positionCanvas();
}

// Pan offset
// _panOffX/_panOffY già dichiarato sopra

function _positionCanvas() {
  const cssW = Math.round(PW * S.zoom);
  const cssH = Math.round(PH * S.zoom);
  const coW  = CO.clientWidth  || CO.getBoundingClientRect().width  || 800;
  const coH  = CO.clientHeight || CO.getBoundingClientRect().height || 600;
  const x = Math.round((coW - cssW) / 2) + _panOffX;
  const y = Math.round((coH - cssH) / 2) + _panOffY;
  CV.style.position = 'absolute';
  CV.style.left     = x + 'px';
  CV.style.top      = y + 'px';
  CV.style.transform = '';
}

function zTo(z) {
  S.zoom = Math.max(.25, Math.min(3, z));
  markDirty('all');
  applyZoom();
  redraw();
}

function fitW() {
  const h = CO.clientHeight;
  const w = CO.clientWidth;
  if (h > 0 && w > 0) {
    const zH = (h - 140) / PH;
    const zW = (w - 80)  / PW;
    S.zoom = Math.max(.25, Math.min(3, Math.min(zH, zW)));
    applyZoom();
    redraw();
  }
}

// ── Canvas pointer events ─────────────────────────────────
function setupCanvas() {
  function gP(ex, ey) {
    // CV ha transform translateY — getBoundingClientRect() riflette la posizione reale
    const r = CV.getBoundingClientRect();
    return {
      x: (ex - r.left) / S.zoom,
      y: (ey - r.top)  / S.zoom
    };
  }

  function inGap(y) { return false; }  // pagine separate, nessun gap

  // Disegna un singolo segmento dal punto pr al punto pt
  function calibratePressure(raw) {
    // Apple Pencil: la pressure raw va da 0 a 1 ma la maggior parte
    // dei tratti normali sta tra 0.1 e 0.5 — calibriamo per renderla
    // più espressiva e lineare visivamente
    if (raw <= 0) return 0.2;
    // Curva di potenza: enfatizza le differenze nella zona media
    const p = Math.pow(raw, 0.6);
    return Math.max(0.15, Math.min(1.0, p));
  }

  function drawSegment(s, pr, pt) {
    cx.save();
    if (s.t === 'hl') {
      cx.globalAlpha=.45; cx.strokeStyle='#ffe000'; cx.lineCap='round';
      cx.lineWidth=(s.sz||3)*5;
    } else if (s.t === 'eraser') {
      cx.globalCompositeOperation='destination-out'; cx.strokeStyle='rgba(0,0,0,1)';
      cx.lineCap='round';
      const ep = calibratePressure(pt.p||.5);
      cx.lineWidth=(s.sz||3)*(0.5+ep*1.2);
    } else {
      cx.strokeStyle=ink(s.c, S.dark); cx.lineCap='round';
      // Interpola pressione tra punto precedente e corrente per transizioni fluide
      const pp = calibratePressure(pr.p||.5);
      const cp = calibratePressure(pt.p||.5);
      const avgP = (pp + cp) / 2;
      cx.lineWidth = (s.sz||3) * (0.3 + avgP * 1.4);
    }
    // Il segmento va disegnato fino al punto NUOVO (pt), non solo fino al
    // punto medio: fermarsi a metà lasciava un vuoto fra un segmento e il
    // successivo — visibile come tratto "tratteggiato" mentre si scrive,
    // che spariva solo al rilascio quando redraw()/drawSS() ridisegnava
    // l'intero tratto smussato da zero, "riempiendo" quei vuoti.
    cx.beginPath();
    cx.moveTo(pr.x, pr.y);
    cx.quadraticCurveTo(pr.x, pr.y, pt.x, pt.y);
    cx.stroke(); cx.restore();
  }

  // ── Touch handlers su CO: pan 1 dito, pinch-zoom+pan 2 dita ──
  // Tutto il lavoro pesante (zoom/scroll) viene schedulato via RAF
  // per garantire 60fps anche su dispositivi lenti.

  // Pan a dito e pinch-zoom condividono lo STESSO meccanismo di mouse/
  // rotellina (_panOffX/_panOffY applicati via _positionCanvas()), invece
  // di CO.scrollLeft/scrollTop come prima: erano due sistemi di
  // posizionamento indipendenti che non si parlavano — un pan da mouse
  // seguito da un pinch produceva risultati incoerenti perché la matematica
  // del pinch ignorava l'offset CSS già applicato dal pan precedente.
  let _pinchDist      = null; // distanza iniziale (fissa per tutta la durata del gesture)
  let _pinchStartZoom = null; // zoom al momento del touchstart
  let _pinchAnchor    = null; // punto in coord CONTENUTO sotto il centro delle dita (fisso)
  let _panStartX  = null, _panStartY  = null;
  let _panStartOffX = null, _panStartOffY = null;
  let _touchRaf   = null;
  let _gs = null;

  function midpoint(t0, t1) {
    return { x: (t0.clientX+t1.clientX)/2, y: (t0.clientY+t1.clientY)/2 };
  }

  // Applica lo stato gesture — chiamato dal RAF, mai direttamente dal touchmove
  function flushGesture() {
    _touchRaf = null;
    if (!_gs) return;

    if (_gs.type === 'pan') {
      const { cx, cy } = _gs;
      _panOffX = _panStartOffX + (cx - _panStartX);
      _panOffY = _panStartOffY + (cy - _panStartY);
      _positionCanvas();

    } else if (_gs.type === 'pinch') {
      const { dist, mx, my } = _gs;
      // Scale totale dall'inizio del gesture (non incrementale)
      const totalScale = dist / _pinchDist;
      const newZoom    = Math.max(.25, Math.min(3, _pinchStartZoom * totalScale));

      // _pinchAnchor è il punto del FOGLIO che deve restare sotto al centro
      // delle due dita — non sotto la posizione INIZIALE del centro, ma
      // sotto quella ATTUALE (mx,my): è quello che dà la sensazione naturale
      // "il contenuto segue le dita" invece di un pivot fisso e via via
      // scollegato da dove le dita si trovano davvero.
      const r   = CO.getBoundingClientRect();
      const coW = CO.clientWidth, coH = CO.clientHeight;
      const cvLeftRelCO = (mx - r.left) - _pinchAnchor.x * newZoom;
      const cvTopRelCO  = (my - r.top)  - _pinchAnchor.y * newZoom;
      _panOffX = cvLeftRelCO - (coW - PW * newZoom) / 2;
      _panOffY = cvTopRelCO  - (coH - PH * newZoom) / 2;

      S.zoom = newZoom;
      applyZoom();  // ridimensiona il canvas (anche in risoluzione) e riposiziona
      redraw();
      // _pinchDist e _pinchAnchor NON vengono aggiornati: restano quelli
      // dell'inizio del gesture, lo scale è sempre calcolato da lì.
    }
    _gs = null;
  }

  function scheduleGesture(gs) {
    _gs = gs;
    if (!_touchRaf) _touchRaf = requestAnimationFrame(flushGesture);
  }

  // touchType (per distinguere pennino da dito) esiste solo su Safari: su
  // tablet non-Safari (Chromium, la maggior parte degli e-ink) ogni tocco,
  // compreso quello della penna stessa, viene scambiato per un dito e fa
  // partire il pan — invisibile a zoom 100% (niente da scorrere), evidente
  // da zoomati. S.activePointers viene popolato dal pointerdown della penna
  // su CV: se la penna sta scrivendo, ignora qualunque touch come pan.
  function penIsActive() {
    for (const t of S.activePointers.values()) if (t === 'pen') return true;
    return false;
  }

  CO.addEventListener('touchstart', e => {
    if (penIsActive()) return;
    const fingers = Array.from(e.touches).filter(t => t.touchType !== 'stylus');
    if (!fingers.length) return;
    e.preventDefault();

    // Cancella RAF pendente
    if (_touchRaf) { cancelAnimationFrame(_touchRaf); _touchRaf = null; _gs = null; }

    if (fingers.length === 1) {
      const t = fingers[0];
      const pos = gP(t.clientX, t.clientY);

      // Lasso selezione con dito
      if (S.tool === 'lasso' && S.selectedIds.size > 0) {
        const handle = hitTestSelHandles(pos.x, pos.y);
        if (handle === 'delete') { deleteSelected(); return; }
        if (handle === 'move') {
          S.selDrag = true; S.selDragStart = pos; S.selDragFrom = {};
          S.selectedIds.forEach(idx => { S.selDragFrom[idx] = S.strokes[idx].pts.map(q=>({...q})); });
          return;
        }
        for (let i = S.strokes.length-1; i >= 0; i--) {
          if (strokeHitTest(S.strokes[i], pos.x, pos.y)) {
            selectStroke(i, false);
            S.selDrag = true; S.selDragStart = pos; S.selDragFrom = {};
            S.selectedIds.forEach(idx => { S.selDragFrom[idx] = S.strokes[idx].pts.map(q=>({...q})); });
            redraw(); return;
          }
        }
      }

      S.pan = true;
      _panStartX = t.clientX; _panStartY = t.clientY;
      _panStartOffX = _panOffX; _panStartOffY = _panOffY;
      showMP('touch');

    } else if (fingers.length >= 2) {
      S.pan = false;
      const mid = midpoint(fingers[0], fingers[1]);
      _pinchDist      = Math.hypot(fingers[0].clientX-fingers[1].clientX, fingers[0].clientY-fingers[1].clientY);
      _pinchStartZoom = S.zoom;
      _pinchAnchor    = gP(mid.x, mid.y);  // punto del foglio sotto al centro delle dita, ORA
      _panStartX  = mid.x; _panStartY  = mid.y;
      _panStartOffX = _panOffX; _panStartOffY = _panOffY;
    }
  }, { passive: false });

  CO.addEventListener('touchmove', e => {
    if (penIsActive()) return;
    const fingers = Array.from(e.touches).filter(t => t.touchType !== 'stylus');
    if (!fingers.length) return;
    e.preventDefault();

    // Drag selezione — diretto, nessun RAF (leggero)
    if (S.selDrag && S.selDragStart && S.selectedIds.size > 0) {
      const pos = gP(fingers[0].clientX, fingers[0].clientY);
      const dx = pos.x - S.selDragStart.x;
      const dy = pos.y - S.selDragStart.y;
      S.selectedIds.forEach(idx => {
        if (S.selDragFrom[idx]) S.strokes[idx].pts = S.selDragFrom[idx].map(q=>({...q,x:q.x+dx,y:q.y+dy}));
      });
      redraw(); return;
    }

    if (fingers.length === 1 && S.pan) {
      // Pan: accumula stato, RAF applica
      scheduleGesture({ type:'pan', cx: fingers[0].clientX, cy: fingers[0].clientY });

    } else if (fingers.length >= 2 && _pinchDist !== null) {
      // Pinch: accumula distanza e midpoint correnti
      const mid  = midpoint(fingers[0], fingers[1]);
      const dist = Math.hypot(fingers[0].clientX-fingers[1].clientX, fingers[0].clientY-fingers[1].clientY);
      scheduleGesture({ type:'pinch', dist, mx: mid.x, my: mid.y });
    }
  }, { passive: false });

  CO.addEventListener('touchend', e => {
    const fingers = Array.from(e.touches).filter(t => t.touchType !== 'stylus');

    if (S.selDrag) {
      S.selDrag = false; S.selDragStart = null; S.selDragFrom = null;
      // checkAutoPage rimosso S.undo.push([...S.strokes]); S.redo = [];
      scheduleAutoSave(); redraw();
    }

    if (fingers.length === 0) {
      // Tutte le dita alzate — ridisegna canvas a zoom finale
      S.pan = false; _pinchDist = null; _pinchAnchor = null;
      if (_touchRaf) { cancelAnimationFrame(_touchRaf); _touchRaf = null; _gs = null; }
      markDirty('all'); redraw();
    } else if (fingers.length === 1) {
      _pinchDist = null;
      S.pan = true;
      _panStartX = fingers[0].clientX; _panStartY = fingers[0].clientY;
      _panStartOffX = _panOffX; _panStartOffY = _panOffY;
    }
  }, { passive: false });

  // ── Pointer handlers su CV (canvas) per disegno ──────────
  // Registrare su CV invece che CO risolve il problema di input mancanti:
  // il canvas riceve gli eventi direttamente senza che il wrapper
  // possa intercettarli o perderli durante lo scroll
  CV.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (e.pointerType === 'touch') return;
    // Middle click o destro → pan, non disegno.
    // Il vecchio fallback "e.buttons===4" è stato rimosso: alcuni tablet/
    // penne lo riportano per errore durante la scrittura normale, facendo
    // partire un pan invece di disegnare — il documento "sbarella" mentre
    // si scrive col pennino. e.button identifica in modo affidabile quale
    // pulsante ha generato QUESTO evento, e.buttons era solo un fallback
    // ridondante e fonte del problema.
    if (e.button === 1 || e.button === 2) { CV.setPointerCapture(e.pointerId); startMPan(e.clientX, e.clientY); return; }
    // Spazio+click → pan
    if (_spaceDown && e.button === 0) { CV.setPointerCapture(e.pointerId); startMPan(e.clientX, e.clientY); return; }
    // Modalità posizionamento testo
    if (S.textMode && S._pendingText) {
      const p = gP(e.clientX, e.clientY);
      S.textItems.push({ id: Date.now(), text: S._pendingText.text, size: S._pendingText.size, x: p.x, y: p.y, color: S.color });
      S.textMode = false; S._pendingText = null;
      CV.style.cursor = 'crosshair';
      markDirty('strokes'); redraw(); scheduleAutoSave();
      return;
    }
    if (S.palmActive) return;
    CV.setPointerCapture(e.pointerId);
    S.activePointers.set(e.pointerId, e.pointerType);
    const p = gP(e.clientX, e.clientY);
    if (inGap(p.y)) return;
    const t = (e.buttons === 32 || e.button === 5) ? 'eraser' : S.tool;
    const aTs = S.recOn ? (Date.now() - S.recStart + S.recOffset) : null;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;

    if (t === 'lasso') {
      // Controlla se click su handle selezione
      const handle = hitTestSelHandles(p.x, p.y);
      if (handle === 'delete') { deleteSelected(); return; }
      if (handle === 'move') {
        S.selDrag = true; S.selDragStart = p;
        S.selDragFrom = {};
        S.selectedIds.forEach(idx => {
          S.selDragFrom[idx] = S.strokes[idx].pts.map(q => ({...q}));
        });
        return;
      }
      // Click su uno stroke → selezionalo
      for (let i = S.strokes.length-1; i >= 0; i--) {
        if (strokeHitTest(S.strokes[i], p.x, p.y)) {
          selectStroke(i, additive);
          S.selDrag = true; S.selDragStart = p;
          S.selDragFrom = {};
          S.selectedIds.forEach(idx => {
            S.selDragFrom[idx] = S.strokes[idx].pts.map(q => ({...q}));
          });
          redraw(); return;
        }
      }
      // Click su area vuota → deseleziona e inizia lasso
      if (!additive) S.selectedIds.clear();
      S.lassoPath = [p];
      redraw(); return;
    }

    // Tool non-lasso: deseleziona tutto
    S.selectedIds.clear();
    S.cur = SHAPES.has(t)
      ? { t, c: S.color, sz: sizeFor(t), pts: [p, {...p}], aTs }
      : { t, c: S.color, sz: sizeFor(t), pts: [{...p, p: e.pressure||.5}], aTs };
    showMP('pen');
  }, { passive: false });

  CV.addEventListener('pointermove', e => {
    e.preventDefault();
    if (e.pointerType === 'touch') return;
    if (_mPan) { moveMPan(e.clientX, e.clientY); return; }
    if (!S.cur) return;

    const events = (e.getCoalescedEvents && e.getCoalescedEvents().length > 0)
      ? e.getCoalescedEvents() : [e];

    // Drag selezione (fuori dal loop coalesced per performance)
    if (S.selDrag && S.selDragStart && S.selectedIds.size > 0) {
      const pos = gP(e.clientX, e.clientY);
      const dx = pos.x - S.selDragStart.x;
      const dy = pos.y - S.selDragStart.y;
      // Ripristina posizioni originali e applica nuovo offset
      S.selectedIds.forEach(idx => {
        if (S.selDragFrom[idx]) {
          S.strokes[idx].pts = S.selDragFrom[idx].map(q => ({...q, x:q.x+dx, y:q.y+dy}));
        }
      });
      redraw(); return;
    }

    // Lasso in corso
    if (S.lassoPath) {
      const pos = gP(e.clientX, e.clientY);
      S.lassoPath.push(pos);
      redraw(); return;
    }

    if (!S.cur) return;

    for (const ce of events) {
      const pos = gP(ce.clientX, ce.clientY);
      if (inGap(pos.y)) continue;

      if (SHAPES.has(S.cur.t)) {
        S.cur.pts[1] = {...pos}; redraw(); drawSS(cx, [S.cur], S.dark); break;
      }

      const pt = {...pos, p: ce.pressure || 0.5};
      const ps = S.cur.pts;
      if (ps.length > 0) drawSegment(S.cur, ps[ps.length-1], pt);
      S.cur.pts.push(pt);
    }
  }, { passive: false });

  CV.addEventListener('pointerup', e => {
    e.preventDefault();
    if (e.pointerType === 'touch') return;
    // Il pan è catturato via setPointerCapture: pointerup arriva sempre qui
    // in modo affidabile anche se il cursore è uscito da CV nel frattempo.
    if (_mPan) { endMPan(); return; }
    S.activePointers.delete(e.pointerId);

    // Fine drag selezione
    if (S.selDrag) {
      S.selDrag = false; S.selDragStart = null; S.selDragFrom = null;
      S.undo.push([...S.strokes]); S.redo = [];
      scheduleAutoSave(); redraw(); return;
    }

    // Fine lasso
    if (S.lassoPath && S.lassoPath.length > 3) {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      finalizeLasso(S.lassoPath, additive);
      S.lassoPath = null; return;
    }
    S.lassoPath = null;

    if (!S.cur) return;
    if (S.cur.pts.length > 1) {
      const recognized = S.shapeRecog ? recognizeShape(S.cur) : null;
      S.strokes.push(recognized || S.cur);
      S.undo.push([...S.strokes]);
      S.redo = [];
      markDirty('strokes');
      scheduleAutoSave();
    }
    S.cur = null;
    // checkExtend rimosso
    redraw();
    if (S.aBuf) drawTL();
  }, { passive: false });

  CV.addEventListener('pointercancel', e => {
    if (_mPan) endMPan();
    S.activePointers.delete(e.pointerId);
    S.cur = null; S.selDrag = false; S.lassoPath = null;
  });
  CV.addEventListener('contextmenu', e => e.preventDefault(), { passive: false });

  // ── Apple Pencil su Safari iOS: Touch Events nativi ──────
  // I Pointer Events su Safari iOS droppano pointerdown quando
  // si scrive velocemente. I Touch Events hanno priorità più alta
  // e non vengono mai droppati dal sistema.
  // touchType === 'stylus' distingue Apple Pencil dal dito.
  //
  // touchType è una proprietà esclusiva di WebKit/Safari: su ogni altro
  // browser (Chrome/Edge su tablet Windows, Chrome su Android, ecc.)
  // Touch.touchType è sempre undefined, quindi questo blocco scambierebbe
  // ogni tocco di penna per un dito, attivando il palm rejection e
  // bloccando il disegno. Va quindi registrato solo dove serve davvero.
  const SUPPORTS_STYLUS_TOUCH = typeof Touch !== 'undefined' && 'touchType' in Touch.prototype;
  if (SUPPORTS_STYLUS_TOUCH) {

  CV.addEventListener('touchstart', e => {
    // Palm rejection: traccia i tocchi con le dita
    for (const t of e.changedTouches) {
      if (t.touchType !== 'stylus') {
        S.palmActive = true;
        // Se stava disegnando, annulla il tratto corrente
        if (S.cur) { S.cur = null; redraw(); }
        showMP('palm');
      }
    }
    // Cerca il tocco con stylus (Apple Pencil)
    for (const t of e.changedTouches) {
      if (t.touchType === 'stylus') {
        e.preventDefault();
        const pos = gP(t.clientX, t.clientY);
        if (inGap(pos.y)) return;
        const aTs = S.recOn ? (Date.now() - S.recStart + S.recOffset) : null;
        // Con pennino: se tool è lasso, fai hit test; altrimenti disegna
        if (S.tool === 'lasso') {
          const handle = hitTestSelHandles(pos.x, pos.y);
          if (handle === 'delete') { deleteSelected(); return; }
          if (handle === 'move' || S.selectedIds.size > 0) {
            // Controlla hit su stroke esistente
            for (let i = S.strokes.length-1; i >= 0; i--) {
              if (strokeHitTest(S.strokes[i], pos.x, pos.y)) {
                if (!S.selectedIds.has(i)) { S.selectedIds.clear(); S.selectedIds.add(i); }
                S.selDrag = true; S.selDragStart = pos;
                S.selDragFrom = {};
                S.selectedIds.forEach(idx => { S.selDragFrom[idx] = S.strokes[idx].pts.map(q=>({...q})); });
                S._stylusId = t.identifier; redraw(); return;
              }
            }
          }
          S.lassoPath = [pos]; S._stylusId = t.identifier; return;
        }
        // Tool disegno normale: deseleziona
        S.selectedIds.clear();
        S.cur = SHAPES.has(S.tool)
          ? { t: S.tool, c: S.color, sz: sizeFor(S.tool), pts: [pos, {...pos}], aTs }
          : { t: S.tool, c: S.color, sz: sizeFor(S.tool), pts: [{...pos, p: t.force||0.5}], aTs };
        S._stylusId = t.identifier;

        return;
      }
    }
    // Dito → pan (se non sta già disegnando col pennino)
    if (!S.cur && e.touches.length === 1) {
      S.pan = true;
      S.pY = e.touches[0].clientY;
      S.pSY = CO.scrollTop;
    }
  }, { passive: false });

  CV.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      if (t.touchType === 'stylus' && t.identifier === S._stylusId && S.cur) {
        e.preventDefault();
        const allTouches = e.touches[0]?.touchType === 'stylus'
          ? Array.from(e.touches).filter(tt => tt.touchType === 'stylus')
          : [t];
        for (const ct of allTouches) {
          const pos = gP(ct.clientX, ct.clientY);
          if (inGap(pos.y)) continue;
          // Drag selezione con pennino
          if (S.selDrag && S.selDragStart) {
            const dx = pos.x - S.selDragStart.x;
            const dy = pos.y - S.selDragStart.y;
            S.selectedIds.forEach(idx => {
              if (S.selDragFrom[idx]) S.strokes[idx].pts = S.selDragFrom[idx].map(q=>({...q,x:q.x+dx,y:q.y+dy}));
            });
            redraw(); break;
          }
          // Lasso con pennino
          if (S.lassoPath) { S.lassoPath.push(pos); redraw(); break; }
          if (!S.cur) break;
          if (SHAPES.has(S.cur.t)) {
            S.cur.pts[1] = {...pos}; redraw(); drawSS(cx, [S.cur], S.dark); break;
          }
          const pt = {...pos, p: ct.force || 0.5};
          const ps = S.cur.pts;
          if (ps.length > 0) drawSegment(S.cur, ps[ps.length-1], pt);
          S.cur.pts.push(pt);
        }
        return;
      }
    }
    // Dito → scroll
    if (S.pan && !S.cur && e.touches.length === 1) {
      CO.scrollTop = S.pSY + (S.pY - e.touches[0].clientY);
    }
  }, { passive: false });

  CV.addEventListener('touchend', e => {
    for (const t of e.changedTouches) {
      if (t.touchType === 'stylus' && t.identifier === S._stylusId) {
        e.preventDefault();
        // Fine drag selezione
        if (S.selDrag) {
          S.selDrag=false; S.selDragStart=null; S.selDragFrom=null;
          S.undo.push([...S.strokes]); S.redo=[];
          scheduleAutoSave(); S._stylusId=null; redraw(); return;
        }
        // Fine lasso
        if (S.lassoPath && S.lassoPath.length > 3) {
          finalizeLasso(S.lassoPath, false);
          S.lassoPath=null; S._stylusId=null; return;
        }
        S.lassoPath=null;
        if (S.cur && S.cur.pts.length > 1) {
          const recognized = S.shapeRecog ? recognizeShape(S.cur) : null;
          S.strokes.push(recognized || S.cur);
          S.undo.push([...S.strokes]);
          S.redo = [];
        }
        S.cur = null; S._stylusId = null;
        // checkExtend rimosso
        redraw();
        scheduleAutoSave();
        if (S.aBuf) drawTL();
        return;
      }
    }
    // Controlla se ci sono ancora dita sul canvas
    let hasFinger = false;
    for (const t of e.touches) { if (t.touchType !== 'stylus') hasFinger = true; }
    S.palmActive = hasFinger;
    S.pan = false;
  }, { passive: false });

  CV.addEventListener('touchcancel', () => {
    S.cur = null; S.pan = false; S._stylusId = null; S.palmActive = false;
  }, { passive: true });

  } // SUPPORTS_STYLUS_TOUCH

  // Blocca menu contestuale Safari iOS (long press con Apple Pencil)
  CO.addEventListener('contextmenu', e => e.preventDefault(), { passive: false });

  // Blocca selezione testo durante scrittura
  document.addEventListener('selectstart', e => {
    if (S.cur) e.preventDefault();
  });
}

// ── Toolbar ───────────────────────────────────────────────
function setupToolbar() {
  document.querySelectorAll('[data-t]').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('[data-t]').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); S.tool = b.dataset.t;
      // Il numero in toolbar deve riflettere lo spessore dello strumento
      // appena selezionato (penna e gomma hanno dimensioni indipendenti)
      SZV.textContent = sizeFor(S.tool);
      document.getElementById('_szp')?.remove();
    };
  });
  document.querySelectorAll('.sw').forEach(s => {
    s.onclick = () => {
      setColor(s.dataset.c);
      if (S.tool === 'eraser') document.querySelector('[data-t="pen"]').click();
    };
  });
  setupColorPicker();
  SZR.onclick = () => openSizePopover(SZR);
  GSL.onchange = () => { S.grid = GSL.value; markDirty('all'); redraw(); };

  // Barra audio nascosta di default — questo pulsante la richiama/nasconde
  document.getElementById('AUDIOTOGGLE').onclick = () => {
    AB.style.display = (AB.style.display === 'none') ? 'flex' : 'none';
  };

  // Nota vocale: "Inizia a scrivere" rivela il foglio, una volta per tutte
  // per questa sessione — fitW() va rifatto perché mentre .CO era nascosto
  // le sue dimensioni erano 0 e lo zoom non poteva calcolarsi.
  document.getElementById('AOSTARTPAGE').onclick = () => {
    S.forceCanvasView = true;
    updateAudioOnlyView();
    requestAnimationFrame(() => requestAnimationFrame(fitW));
  };

  // Due pulsanti (libreria + editor) condividono lo stesso ciclo tema:
  // chiaro → scuro → e-ink → chiaro.
  document.querySelectorAll('.dkToggle').forEach(btn => btn.onclick = () => {
    const order = ['light', 'dark', 'eink'];
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    if (next === 'light') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
    S.dark = (next === 'dark');
    applyDarkColor();
    try { localStorage.setItem('auror-theme', next); } catch {}
    markDirty('all'); redraw();
  });

  document.getElementById('UDB').onclick = () => {
    if (S.undo.length < 2) { S.strokes = []; S.undo = []; }
    else { S.undo.pop(); S.strokes = [...S.undo[S.undo.length-1]]; }
    markDirty('strokes'); redraw(); if (S.aBuf) drawTL();
  };
  document.getElementById('RDB').onclick = () => {
    if (!S.redo.length) return;
    S.strokes = [...S.redo.pop()]; S.undo.push([...S.strokes]); markDirty('strokes'); redraw(); if (S.aBuf) drawTL();
  };
  document.getElementById('SRB').onclick = () => {
    S.shapeRecog = !S.shapeRecog;
    const btn = document.getElementById('SRB');
    btn.classList.toggle('on', S.shapeRecog);
    btn.title = S.shapeRecog ? 'Riconoscimento forme automatico (on)' : 'Riconoscimento forme automatico (off)';
    toast(S.shapeRecog ? '✓ Shape recognition attivo' : 'Shape recognition disattivato');
  };
  document.getElementById('CLB').onclick = () => {
    if (!confirm('Cancellare tutto il contenuto della nota?')) return;
    S.undo.push([...S.strokes]); S.strokes = []; S.imgs = []; markDirty('all'); redraw(); toast('Canvas pulita');
  };
  document.getElementById('SVB').onclick = () => saveNote(false);

  // Bottone Testo
  const txtB = document.getElementById('TXTB');
  if (txtB) {
    txtB.onclick = () => {
      document.getElementById('TXTI').value = '';
      document.getElementById('TXTM').classList.remove('off');
      setTimeout(() => document.getElementById('TXTI').focus(), 50);
    };
  }

  // Modal Testo: slider dimensione
  const txtSz = document.getElementById('TXTSZ');
  if (txtSz) txtSz.oninput = () => { document.getElementById('TXTSZV').textContent = txtSz.value; };
  const txtCancB = document.getElementById('TXTCANC');
  if (txtCancB) txtCancB.onclick = () => { document.getElementById('TXTM').classList.add('off'); S.textMode = false; };
  const txtOkB = document.getElementById('TXTOK');
  if (txtOkB) txtOkB.onclick = () => {
    const txt = document.getElementById('TXTI').value.trim();
    if (!txt) return;
    document.getElementById('TXTM').classList.add('off');
    S.textMode = true; // attendi click sul canvas
    S._pendingText = { text: txt, size: parseInt(document.getElementById('TXTSZ').value)||18 };
    CV.style.cursor = 'text';
    toast('Clicca sul canvas per posizionare il testo');
  };

  // Bottone Trascrivi — mostra/nascondi pannello con trascrizione salvata
  const transcB = document.getElementById('TRANSCB');
  if (transcB) {
    transcB.onclick = async () => {
      if (!S.curId) return;
      // Toggle: se il pannello è aperto, chiudilo
      if (document.getElementById('_tp')) { document.getElementById('_tp').remove(); return; }
      // Se in elaborazione
      if (S.whisperPending) { toast('⏳ Trascrizione in corso, attendi…'); return; }
      // Senza audio la richiesta fallisce silenziosamente lato server
      // (solo un console.warn, nessun feedback all'utente) — meglio bloccarla qui.
      if (!S.aBuf) { toast('⚠ Nessun audio da trascrivere — registra prima'); return; }
      try {
        const r = await fetch(`/api/notes/${S.curId}/transcript`);
        const d = await r.json();
        if (d.has_transcript && d.text) {
          S.whisperSegments = d.segments || null;
          const speakers = new Set((d.segments||[]).map(s=>s.speaker_label).filter(Boolean)).size;
          showTranscriptPanel({
            text: d.text, segments: d.segments,
            diarized: speakers > 0, speakers
          });
        } else {
          toast('⏳ Nessuna trascrizione — avvio…');
          autoTranscribe();
        }
      } catch(e) { toast('⚠ ' + e.message); }
    };
  }
  updateTranscribeBtn();
  if (S.dark) applyDarkColor();

  document.getElementById('PSB').onclick = pasteImg;

  // Condivisione — check difensivo se i bottoni esistono nell'HTML
  const shareB = document.getElementById('SHAREB');
  if (shareB) {
    shareB.onclick = () => {
      if (!S.curId) return;
      loadShares();
      document.getElementById('SHAREM').classList.remove('off');
    };
  }
  const shareCancB = document.getElementById('SHARECANCB');
  if (shareCancB) shareCancB.onclick = () => document.getElementById('SHAREM').classList.add('off');
  const shareCreB = document.getElementById('SHARECREB');
  if (shareCreB) shareCreB.onclick = async () => {
    const exp = document.getElementById('SHAREEXP').value;
    const r = await fetch(`/api/notes/${S.curId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires: exp || null })
    });
    const d = await r.json();
    if (r.ok) { await loadShares(); toast('✓ Link creato'); }
    else toast('⚠ ' + d.error);
  };

  document.getElementById('PDFB').onclick = () => document.getElementById('PM').classList.remove('off');
  document.getElementById('PCA').onclick  = () => document.getElementById('PM').classList.add('off');
  document.getElementById('POK').onclick  = () => {
    const wg = document.querySelector('input[name="ge"]:checked').value === 'yes';
    document.getElementById('PM').classList.add('off');
    exportPDF(wg);
  };

  // Audio
  document.getElementById('RCB').onclick = () => {
    if (S.recOn) {
      if (S.recPaused) resumeRec();
      else stopRec();
    } else {
      startRec();
    }
  };
  // Bottone pausa separato
  const pauseBtn = document.getElementById('PAUSEB');
  if (pauseBtn) {
    pauseBtn.onclick = () => {
      if (S.recPaused) resumeRec();
      else pauseRec();
      // Aggiorna icona
      pauseBtn.innerHTML = S.recPaused
        ? '<svg width="8" height="8" viewBox="0 0 24 24" fill="white"><rect x="5" y="4" width="4" height="16"/><rect x="15" y="4" width="4" height="16"/></svg>'
        : '<svg width="8" height="8" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>';
    };
  }
  document.getElementById('APB').onclick = () => { if (S.playing) stopAudio(); else startAudio(S.playOff); };
  // DELAUD ha data-ab-discard: audio-bar.js mostra il popover di conferma
  // e spara questo evento solo se l'utente conferma "Elimina".
  AB.addEventListener('auror-audio-discard', deleteAudio);
  PW2.onclick = e => {
    if (!S.aBuf) return;
    const r = PW2.getBoundingClientRect();
    seekAudio(((e.clientX - r.left) / r.width) * S.aBuf.duration);
  };

  setupKeyboard();
}

// ── Scorciatoie da tastiera ───────────────────────────────
// Handler unico: prima ce n'erano due registrati in parallelo, e le frecce
// comparivano due volte nello stesso handler, quindi un PageDown faceva
// avanzare di due pagine invece che di una.
function setupKeyboard() {
  document.addEventListener('keydown', e => {
    // Non rubare i tasti mentre si scrive in un campo
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;

    const m = e.ctrlKey || e.metaKey;
    if (m && e.key==='s')  { e.preventDefault(); saveNote(); return; }
    if (m && e.key==='z')  { e.preventDefault(); document.getElementById('UDB').click(); return; }
    if (m && (e.key==='y'||(e.shiftKey&&e.key==='Z'))) { e.preventDefault(); document.getElementById('RDB').click(); return; }
    if (m && (e.key==='=' || e.key==='+')) { e.preventDefault(); document.getElementById('ZI').click(); return; }
    if (m && e.key==='-')  { e.preventDefault(); document.getElementById('ZO').click(); return; }
    if (m && e.key==='0')  { e.preventDefault(); fitW(); return; }
    // Alcuni browser zoomano anche con Ctrl+frecce verticali
    if (m && (e.key==='ArrowUp'||e.key==='ArrowDown')) { e.preventDefault(); return; }
    if (m && e.key==='v')  { pasteImg(); return; }

    // Cambio pagina: PageUp/PageDown, o Ctrl/Cmd + frecce orizzontali
    if (e.key==='PageDown' || (m && e.key==='ArrowRight')) { e.preventDefault(); goPage(S.curPage + 1); return; }
    if (e.key==='PageUp'   || (m && e.key==='ArrowLeft'))  { e.preventDefault(); goPage(S.curPage - 1); return; }
    if (m) return;

    switch(e.key) {
      case 'p': document.querySelector('[data-t="pen"]')?.click(); return;
      case 'h': document.querySelector('[data-t="hl"]')?.click(); return;
      case 'e': document.querySelector('[data-t="eraser"]')?.click(); return;
      case 'r': document.querySelector('[data-t="rect"]')?.click(); return;
      case 'l': document.querySelector('[data-t="line"]')?.click(); return;
      case 'a': document.querySelector('[data-t="arrow"]')?.click(); return;
      case 'o': document.querySelector('[data-t="ellipse"]')?.click(); return;
      case 's': document.querySelector('[data-t="lasso"]')?.click(); return;
      case 't': document.getElementById('TXTB')?.click(); return;
      case 'ArrowRight': e.preventDefault(); goPage(S.curPage + 1); return;
      case 'ArrowLeft':  e.preventDefault(); goPage(S.curPage - 1); return;
    }

    if (e.key===' ' && e.target===document.body) { e.preventDefault(); document.getElementById('APB').click(); return; }
    if (e.key==='Escape') {
      S.selectedIds.clear(); S.lassoPath=null; S.selDrag=false;
      S.cur=null; S.textMode=false; S._pendingText=null;
      CV.style.cursor='crosshair'; redraw(); return;
    }
    if ((e.key==='Delete'||e.key==='Backspace') && document.activeElement===document.body) deleteSelected();
  });
}

// ── Libreria ──────────────────────────────────────────────
function setupLibrary() {
  document.getElementById('newB').onclick = newNote;
  document.getElementById('newVoiceB').onclick = newVoiceNote;

  // Torna alla libreria: salva se necessario, poi cambia schermata
  document.getElementById('BACKB').onclick = async () => {
    if (S.recOn) stopRec();
    if (S.playing) stopAudio();
    if (S.dirty) await saveNote(true);
    S.curId = null; S.strokes = []; S.textItems = [];
    showLibrary();
    renderNL();
  };

  // Ordinamento
  const sortSel = document.getElementById('SORT');
  if (sortSel) sortSel.addEventListener('change', () => { S.sortOrder = sortSel.value; renderNL(); });

  // Ricerca: locale + full-text server (debounced)
  const srch = document.getElementById('SRCH');
  let _srchTimer = null, _srchRaf = null;
  if (srch) {
    srch.addEventListener('input', () => {
      S.searchQ = srch.value;
      // Raggruppato sul prossimo frame: durante una digitazione veloce più
      // eventi 'input' arrivano prima del repaint, e ricostruire l'intera
      // griglia di card ad ogni tasto è lavoro sprecato — nessun ritardo
      // percepito, il rebuild avviene comunque prima del prossimo frame.
      if (_srchRaf == null) _srchRaf = requestAnimationFrame(() => { _srchRaf = null; renderNL(); });
      clearTimeout(_srchTimer);
      if (srch.value.trim().length >= 2) {
        _srchTimer = setTimeout(async () => {
          const r = await fetch(`/api/search?q=${encodeURIComponent(srch.value.trim())}`);
          if (!r.ok) return;
          const results = await r.json();
          // Mostra risultati full-text sotto i risultati locali
          renderFTSResults(results, srch.value.trim());
        }, 400);
      }
    });
  }
  // Export
  document.getElementById('exportB').onclick = async () => {
    toast('⏳ Preparazione archivio…');
    try {
      const r = await fetch('/api/export');
      if (!r.ok) throw new Error(await r.text());
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const cd = r.headers.get('Content-Disposition') || '';
      a.download = cd.match(/filename="([^"]+)"/)?.[1] || 'quetza-export.zip';
      a.click();
      URL.revokeObjectURL(url);
      toast('✓ Archivio scaricato');
    } catch(e) { toast('⚠ Errore export: ' + e.message); }
  };

  // Import
  document.getElementById('importFile').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (!confirm(`Importare "${file.name}"? Le note con lo stesso ID verranno sovrascritte.`)) return;
    toast('⏳ Importazione in corso…');
    try {
      const fd = new FormData(); fd.append('archive', file);
      const r = await fetch('/api/import', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      await loadNotes();
      toast(`✓ Importate ${d.imported} note${d.skipped ? ', ' + d.skipped + ' saltate' : ''}`);
    } catch(e) { toast('⚠ Errore import: ' + e.message); }
    e.target.value = '';
  };

  document.getElementById('logoutB').onclick = async () => {
    if (S.recOn) stopRec();
    await saveNote();
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  };
}

// ── Paste image ───────────────────────────────────────────
async function pasteImg() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/')) {
          const blob = await item.getType(type);
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            S.imgs.push({ el: img, x: 40, y: 40 + CO.scrollTop/S.zoom, w: Math.min(img.naturalWidth, PW-80), h: img.naturalHeight*(Math.min(img.naturalWidth, PW-80)/img.naturalWidth) });
            redraw(); toast('Immagine incollata');
          };
          img.src = url; return;
        }
      }
    }
    toast('Nessuna immagine negli appunti');
  } catch { toast('Incolla: copia prima un\'immagine'); }
}

// ── PDF export ────────────────────────────────────────────
// Ogni pagina di S.pages ha il proprio canvas in coordinate 0..PH.
// La versione precedente ritagliava fette verticali da un canvas unico usando
// PGAP (costante non più esistente → ReferenceError a ogni export) e leggeva
// sempre S.strokes, cioè la sola pagina corrente ripetuta su tutte le pagine.
function exportPDF(withGrid) {
  if (!window.jspdf?.jsPDF) { toast('⚠ Libreria PDF non caricata'); return; }
  toast('⏳ Generazione PDF…');
  setTimeout(() => {
    try {
      // Allinea la pagina corrente allo stato di S.pages prima di esportare
      syncCurrentPage();

      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

      S.pages.forEach((pg, p) => {
        if (p > 0) pdf.addPage();
        const off = document.createElement('canvas');
        off.width = PW; off.height = PH;
        const oc = off.getContext('2d');
        oc.fillStyle = '#fff'; oc.fillRect(0, 0, PW, PH);
        if (withGrid) drawGrid(oc, false);   // sempre in versione chiara sul PDF

        (pg.images || []).forEach(i => { if (i.el) oc.drawImage(i.el, i.x, i.y, i.w, i.h); });
        drawSS(oc, pg.strokes || []);
        (pg.textItems || []).forEach(ti => {
          oc.font = `${ti.size||18}px 'Segoe UI',system-ui,sans-serif`;
          oc.fillStyle = ti.color || '#111827';
          oc.fillText(ti.text, ti.x, ti.y);
        });

        pdf.addImage(off.toDataURL('image/jpeg', .95), 'JPEG', 0, 0, 210, 297, '', 'FAST');
      });

      pdf.save(`${(NTT.value||'quetza').replace(/[^a-z0-9]/gi,'_')}.pdf`);
      toast(`✓ PDF esportato (${S.pages.length} pagine)`);
    } catch(e) { toast('⚠ Errore export: ' + e.message); console.error(e); }
  }, 100);
}

// ── Network status ───────────────────────────────────────
function setNetStatus(state) {
  // Il pallino/etichetta "online" nella toolbar è stato rimosso — resta solo
  // il banner offline, l'unico feedback che conta davvero (errore bloccante).
  const ban = document.getElementById('OFFBANNER');
  if (!ban) return;
  ban.classList.toggle('on', state === 'offline');
}

async function checkServerReach() {
  try {
    const r = await fetch('/api/me', { method: 'GET', cache: 'no-store' });
    setNetStatus((r.ok || r.status === 401 || r.status === 403) ? 'online' : 'offline');
  } catch { setNetStatus('offline'); }
}

// ── Pagine ───────────────────────────────────────────────────
function setupPages() {
  const prev = document.getElementById('PGPREV');
  const next = document.getElementById('PGNEXT');
  const add  = document.getElementById('PGADD');
  const num  = document.getElementById('PGNUM');
  if (prev) prev.onclick = () => goPage(S.curPage - 1);
  if (next) next.onclick = () => goPage(S.curPage + 1);
  if (add)  add.onclick  = () => {
    syncCurrentPage();
    S.pages.push({ strokes: [], textItems: [], images: [] });
    goPage(S.pages.length - 1);
    scheduleAutoSave();
  };
  if (num) num.onclick = () => {
    const n = parseInt(prompt('Vai a pagina (1-' + S.pages.length + '):', S.curPage + 1));
    if (!isNaN(n)) goPage(n - 1);
  };
  updatePageNav();
}

function goPage(idx) {
  if (idx < 0 || idx >= S.pages.length) return;
  if (idx === S.curPage) return;

  // Salva stato pagina corrente (undo incluso, è per pagina)
  syncCurrentPage().undo = [...S.undo];

  S.curPage = idx;
  _panOffX = 0; _panOffY = 0;

  // Carica nuova pagina
  const pg = curPg();
  S.strokes   = pg.strokes   ? [...pg.strokes]   : [];
  S.textItems = pg.textItems ? [...pg.textItems] : [];
  S.imgs      = pg.images    ? [...pg.images]    : [];
  S.undo      = pg.undo      ? [...pg.undo]      : [[...S.strokes]];
  S.redo      = [];
  S.cur       = null;
  S.selectedIds.clear();

  markDirty('all');
  applyZoom();
  redraw();
  updatePageNav();
}

function updatePageNav() {
  const prev = document.getElementById('PGPREV');
  const next = document.getElementById('PGNEXT');
  const num  = document.getElementById('PGNUM');
  if (prev) prev.disabled = S.curPage === 0;
  if (next) next.disabled = S.curPage >= S.pages.length - 1;
  if (num)  num.textContent = (S.curPage + 1) + ' / ' + S.pages.length;
}

function startNetMonitor() {
  checkServerReach();
  setInterval(checkServerReach, 15000);
}

window.addEventListener('online',  () => checkServerReach());
window.addEventListener('offline', () => setNetStatus('offline'));

async function startRec() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('⚠ Microfono non supportato'); return;
  }
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
    toast('⚠ La registrazione richiede HTTPS'); return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';

    S.mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    S.recOffset = S.aBuf ? Math.round(S.aBuf.duration * 1000) : 0;
    S.recPaused = false;
    S._pausedMs = 0;
    S._pauseStart = null;
    S._recChunks = []; // accumula chunk in memoria — unione corretta a fine sessione
    S._recMime = mimeType || 'audio/webm';

    S.mr.ondataavailable = e => {
      if (e.data.size > 0) S._recChunks.push(e.data);
    };

    S.mr.onstop = onRecStop;
    S.recStart = Date.now();
    S.recOn = true;
    S.mr.start(100); // chunk frequenti per risposta UI fluida

    updateRecBtn('rec');

    const prevDur = S.aBuf ? S.aBuf.duration : 0;
    S._ri = setInterval(() => {
      if (S.recPaused) return;
      const elapsed = (Date.now() - S.recStart - S._pausedMs) / 1000;
      const total = prevDur + elapsed;
      const m = Math.floor(total / 60);
      const s2 = Math.floor(total % 60);
      RTM.textContent = `${m}:${s2.toString().padStart(2,'0')}`;
    }, 500);

    toast(S.aBuf ? '⏺ Continua registrazione' : '⏺ Registrazione avviata');
  } catch(err) {
    if (err.name === 'NotAllowedError') toast('⚠ Permesso microfono negato');
    else if (err.name === 'NotFoundError') toast('⚠ Nessun microfono trovato');
    else toast('⚠ Errore microfono: ' + err.message);
  }
}

function pauseRec() {
  if (!S.mr || S.mr.state !== 'recording') return;
  S.mr.pause();
  S.recPaused = true;
  S._pauseStart = Date.now();
  updateRecBtn('pause');
  toast('⏸ Pausa');
}

function resumeRec() {
  if (!S.mr || S.mr.state !== 'paused') return;
  S.mr.resume();
  S.recPaused = false;
  if (S._pauseStart) { S._pausedMs += Date.now() - S._pauseStart; S._pauseStart = null; }
  updateRecBtn('rec');
  toast('⏺ Ripresa');
}

function updateRecBtn(mode) {
  const pauseBtn = document.getElementById('PAUSEB');
  if (mode === 'rec' || mode === 'pause') {
    AB.dataset.state = 'recording';
    if (pauseBtn) pauseBtn.style.display = 'flex';
  } else {
    if (pauseBtn) pauseBtn.style.display = 'none';
  }
}

function stopRec() {
  if (!S.mr) return;
  S.recOn = false; S.recPaused = false;
  S.mr.stop(); S.mr.stream.getTracks().forEach(t => t.stop());
  clearInterval(S._ri);
  updateRecBtn('stop');
}

async function onRecStop() {
  toast('⏳ Salvataggio audio…');
  if (!S.aCtx) S.aCtx = new (window.AudioContext || window.webkitAudioContext)();

  try {
    // Crea il blob della nuova sessione nel formato nativo del browser
    const newBlob = new Blob(S._recChunks, { type: S._recMime });
    const ext = S._recMime.includes('mp4') ? 'mp4' : 'webm';

    // Carica sul server come nuova sessione (non sovrascrive le precedenti)
    if (S.curId) {
      const fd = new FormData();
      fd.append('audio', newBlob, `session.${ext}`);
      await fetch(`/api/notes/${S.curId}/audio`, { method: 'POST', body: fd });
      const idx = S.notes.findIndex(n => n.id === S.curId);
      if (idx >= 0) S.notes[idx].has_audio = 1;
      renderNL();
    }

    // Decodifica la nuova sessione e aggiorna il player con tutte le sessioni concatenate
    const newAb  = await newBlob.arrayBuffer();
    const newBuf = await S.aCtx.decodeAudioData(newAb);
    S.aBuf = S.aBuf ? concatAudioBuffers(S.aCtx, S.aBuf, newBuf) : newBuf;

    buildPeaks();
    AB.dataset.state = 'playback';
    drawWave(0); updAT(0);
    TSel.classList.add('on'); drawTL(0);
    toast('✓ Registrazione salvata');
    // Auto-trascrizione in background
    autoTranscribe();
  } catch(e) {
    console.error('onRecStop error:', e);
    toast('⚠ Errore: ' + e.message);
  }
}

// Concatena due AudioBuffer mantenendo il PCM intatto
function concatAudioBuffers(ctx, a, b) {
  const ch  = Math.max(a.numberOfChannels, b.numberOfChannels);
  const sr  = a.sampleRate;
  const out = ctx.createBuffer(ch, a.length + b.length, sr);
  for (let c = 0; c < ch; c++) {
    const od = out.getChannelData(c);
    od.set(c < a.numberOfChannels ? a.getChannelData(c) : new Float32Array(a.length), 0);
    // Piccolo crossfade 20ms per evitare click di giunzione
    const bd = c < b.numberOfChannels ? b.getChannelData(c) : new Float32Array(b.length);
    const fade = Math.min(Math.floor(sr * 0.02), bd.length);
    for (let i = 0; i < bd.length; i++) {
      od[a.length + i] = bd[i] * (i < fade ? i / fade : 1);
    }
  }
  return out;
}

async function deleteAudio() {
  if (S.playing) stopAudio();
  S.aBuf = null; S.peaks = null; S.playOff = 0;
  S.whisperSegments = null;
  document.getElementById('_tp')?.remove();
  AB.dataset.state = 'idle';
  wx.clearRect(0, 0, WC.width, WC.height);
  TSel.classList.remove('on');
  if (S.curId) {
    await fetch(`/api/notes/${S.curId}/audio`, { method: 'DELETE' });
    const idx = S.notes.findIndex(n => n.id === S.curId);
    if (idx >= 0) S.notes[idx].has_audio = 0;
    renderNL();
  }
  updateTranscribeBtn();
  toast('Audio eliminato');
}

// ── Audio playback ────────────────────────────────────────
function buildPeaks() {
  const data = S.aBuf.getChannelData(0); const N = 250;
  const pk = new Float32Array(N); const step = Math.floor(data.length / N);
  for (let i=0; i<N; i++) { let m=0; for (let j=0; j<step; j++) { const v=Math.abs(data[i*step+j]||0); if(v>m)m=v; } pk[i]=m; }
  S.peaks = pk;
}

function drawWave(f) {
  const W = WC.width  = PW2.clientWidth  || 170;
  const H = WC.height = PW2.clientHeight || 22;
  wx.clearRect(0, 0, W, H);
  if (!S.peaks) return;
  // Disegna waveform
  const n = S.peaks.length, bw = W / n;
  for (let i = 0; i < n; i++) {
    const h = Math.max(2, S.peaks[i] * H * 2.5);
    wx.fillStyle = (i/n) < f ? 'rgba(192,57,43,.85)' : 'rgba(255,255,255,.2)';
    wx.fillRect(i*bw, H/2-h/2, Math.max(1, bw-.5), Math.min(h, H));
  }
  // Sovrapponi punti di scrittura (drawTL ora usa WC direttamente)
  if (S.aBuf) drawTL(f);
}

function updAT(s) {
  if (!S.aBuf) return;
  const si=Math.floor(s), di=Math.floor(S.aBuf.duration);
  ATM.textContent = `${Math.floor(si/60)}:${(si%60).toString().padStart(2,'0')} / ${Math.floor(di/60)}:${(di%60).toString().padStart(2,'0')}`;
}

function startAudio(off) {
  stopAudio();
  if (S.aCtx.state === 'suspended') S.aCtx.resume();
  S.src = S.aCtx.createBufferSource(); S.src.buffer = S.aBuf; S.src.connect(S.aCtx.destination);
  S.playOff = off || 0; S.playSt = S.aCtx.currentTime;
  S.src.start(0, S.playOff); S.playing = true;
  S.src.onended = () => { if (S.playing) stopAudio(true); };
  document.getElementById('APB').innerHTML = '<svg width="8" height="8" viewBox="0 0 24 24" fill="white"><rect x="5" y="4" width="4" height="16"/><rect x="15" y="4" width="4" height="16"/></svg>';
  tickAudio();
}

function stopAudio(ended) {
  if (S.src) { try { S.src.stop(); } catch(e){} S.src = null; }
  S.playing = false; cancelAnimationFrame(S.raf);
  document.getElementById('APB').innerHTML = '<svg width="8" height="8" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>';
  if (ended) { S.playOff=0; SC.style.left='0%'; drawWave(0); drawTL(0); updAT(0); redraw(); }
}

function seekAudio(sec) {
  S.playOff = sec; const f = sec/S.aBuf.duration;
  SC.style.left = (f*100)+'%'; drawWave(f); updAT(sec); drawTL(f); redraw(sec*1000); scrollToTs(sec*1000);
  if (S.playing) startAudio(sec);
}

function tickAudio() {
  if (!S.playing) return;
  const el = S.aCtx.currentTime - S.playSt + S.playOff;
  const f = Math.min(el/S.aBuf.duration, 1); const ms = el*1000;
  // UI leggera ogni frame (60fps)
  SC.style.left = (f*100)+'%';
  updAT(el);
  // Canvas pesante a 30fps (ogni 2 frame) — l'occhio non nota la differenza
  if (!S._audioFrameSkip) {
    drawWave(f);
    redraw(ms);
    drawTL(f);
    scrollToTs(ms);
  }
  S._audioFrameSkip = !S._audioFrameSkip;
  // Highlight segmento attivo nel pannello trascrizione
  if (S.whisperSegments) highlightTranscriptSegment(el);
  S.raf = requestAnimationFrame(tickAudio);
}

function highlightTranscriptSegment(currentSec) {
  const panel = document.getElementById('_tp_text');
  if (!panel || !S.whisperSegments) return;
  const segs = panel.querySelectorAll('[data-seg]');
  segs.forEach(el => {
    const start = parseFloat(el.dataset.start);
    const end   = parseFloat(el.dataset.end);
    const active = currentSec >= start && currentSec <= end;
    el.style.background    = active ? 'rgba(245,160,0,.18)' : 'transparent';
    el.style.borderRadius  = active ? '5px' : '';
    el.style.marginLeft    = active ? '-4px' : '';
    el.style.paddingLeft   = active ? '4px'  : '';
    if (active) el.scrollIntoView({ block:'nearest', behavior:'smooth' });
  });
}

function scrollToTs(ms) {
  if (!S.aBuf || !S.strokes) return;
  const nb = S.strokes.filter(s => s.aTs != null && Math.abs(s.aTs - ms) < 2000);
  if (!nb.length) return;
  // Nessuno scroll necessario — pagina singola centrata
}

// ── Timeline ──────────────────────────────────────────────
// drawTL: disegna i punti di scrittura direttamente sulla waveform (WC)
// chiamata dopo drawWave() — sovrappone i punti sulla traccia orizzontale
function drawTL(frac) {
  if (!S.aBuf) return;
  const W = WC.width || WC.clientWidth || 200;
  const H = WC.height || 22;
  const dur = S.aBuf.duration * 1000;
  const curMs = (frac || 0) * dur;

  S.strokes.forEach(s => {
    if (s.aTs == null) return;
    const x = (s.aTs / dur) * W;
    if (x < 0 || x > W) return;
    const active = Math.abs(s.aTs - curMs) < 2000;
    wx.beginPath();
    wx.arc(x, H / 2, active ? 3.5 : 2, 0, Math.PI * 2);
    wx.fillStyle = active ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,.65)';
    wx.fill();
  });
}

// ── Utils ─────────────────────────────────────────────────
let mpT = null;
function showMP(m) {
  const labels = { pen: 'penna', touch: 'sposta', palm: 'palmo rilevato' };
  MP.className = 'MP '+m; MP.textContent = labels[m] || m;
  clearTimeout(mpT); mpT = setTimeout(()=>{ MP.style.opacity='0'; }, 1000);
}
let tT = null;
function toast(msg) {
  TT.textContent = msg; TT.classList.add('on');
  clearTimeout(tT); tT = setTimeout(()=>TT.classList.remove('on'), 2400);
}

// ── Selezione ────────────────────────────────────────────
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i=0, j=poly.length-1; i<poly.length; j=i++) {
    const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
    if (((yi>pt.y)!==(yj>pt.y)) && (pt.x<(xj-xi)*(pt.y-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}

function strokeHitTest(stroke, px, py) {
  // Clicca su un tratto se il punto è entro ~8px logici
  if (!stroke.pts || stroke.pts.length < 2) return false;
  const THRESH = 8 / S.zoom;
  for (let i=0; i<stroke.pts.length-1; i++) {
    const a=stroke.pts[i], b=stroke.pts[i+1];
    const dx=b.x-a.x, dy=b.y-a.y, len2=dx*dx+dy*dy;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((px-a.x)*dx+(py-a.y)*dy)/len2));
    const nx=a.x+t*dx-px, ny=a.y+t*dy-py;
    if (nx*nx+ny*ny < THRESH*THRESH) return true;
  }
  // Fallback: test bounding box per shape
  const bb = strokeBBox(stroke);
  if (!bb) return false;
  const pad = THRESH;
  return px >= bb.x-pad && px <= bb.x2+pad && py >= bb.y-pad && py <= bb.y2+pad;
}

function hitTestSelHandles(px, py) {
  // Restituisce 'delete' | 'move' | null
  if (S.selectedIds.size === 0) return null;
  const bb = selBBox(); if (bb.x > 1e8) return null;
  const pad = 8, hr = 12 / S.zoom;
  const x=bb.x-pad, y=bb.y-pad, w=bb.w+pad*2, h=bb.h+pad*2;
  if (Math.hypot(px-(x+w), py-y) < hr) return 'delete';
  if (Math.hypot(px-(x+w/2), py-(y+h)) < hr) return 'move';
  // Click dentro il box = move
  if (px>=x && px<=x+w && py>=y && py<=y+h) return 'move';
  return null;
}

function selectStroke(idx, additive) {
  if (!additive) S.selectedIds.clear();
  if (S.selectedIds.has(idx)) S.selectedIds.delete(idx);
  else S.selectedIds.add(idx);
}

function deleteSelected() {
  if (!S.selectedIds.size) return;
  S.strokes = S.strokes.filter((_, i) => !S.selectedIds.has(i));
  S.selectedIds.clear();
  S.undo.push([...S.strokes]); S.redo = [];
  scheduleAutoSave(); redraw();
}

function finalizeLasso(poly, additive) {
  if (!additive) S.selectedIds.clear();
  S.strokes.forEach((s, idx) => {
    if (!s.pts) return;
    // Seleziona se almeno la metà dei punti è dentro il lasso
    const inside = s.pts.filter(p => pointInPoly(p, poly)).length;
    if (inside > s.pts.length * 0.4) S.selectedIds.add(idx);
  });
  S.lassoPath = null;
  redraw();
}

// ── Shape Recognition ────────────────────────────────────
// Analizza un tratto freehand e lo converte in forma geometrica
// se supera la soglia di somiglianza
function recognizeShape(stroke) {
  const pts = stroke.pts;
  if (pts.length < 4) return null;

  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  if (w < 10 && h < 10) return null; // troppo piccolo

  // ── Linea retta ──────────────────────────────────────────
  const dx = pts[pts.length-1].x - pts[0].x;
  const dy = pts[pts.length-1].y - pts[0].y;
  const len = Math.hypot(dx, dy);
  if (len > 20) {
    let maxDev = 0;
    for (const p of pts) {
      // Distanza punto dalla retta pts[0]→pts[last]
      const dev = Math.abs(dy * p.x - dx * p.y + pts[pts.length-1].x * pts[0].y - pts[pts.length-1].y * pts[0].x) / len;
      if (dev > maxDev) maxDev = dev;
    }
    if (maxDev / len < 0.08) {
      return { ...stroke, t: 'line', pts: [pts[0], pts[pts.length-1]] };
    }
  }

  // ── Rettangolo ───────────────────────────────────────────
  // Controlla se il tratto torna vicino al punto di partenza e
  // ha ~4 angoli con cambi di direzione bruschi
  const startEnd = Math.hypot(pts[pts.length-1].x - pts[0].x, pts[pts.length-1].y - pts[0].y);
  const perim = w * 2 + h * 2;
  if (startEnd < perim * 0.15 && w > 20 && h > 20) {
    // Conta i cambi di direzione bruschi (angoli)
    let corners = 0;
    for (let i = 2; i < pts.length - 2; i++) {
      const ax = pts[i].x - pts[i-2].x, ay = pts[i].y - pts[i-2].y;
      const bx = pts[i+2].x - pts[i].x, by = pts[i+2].y - pts[i].y;
      const dot = ax*bx + ay*by;
      const cross = Math.abs(ax*by - ay*bx);
      if (cross > Math.hypot(ax,ay) * Math.hypot(bx,by) * 0.6) corners++;
    }
    if (corners >= 3) {
      return { ...stroke, t: 'rect', pts: [{ x: minX, y: minY }, { x: maxX, y: maxY }] };
    }
  }

  // ── Cerchio / Ellisse ─────────────────────────────────────
  if (startEnd < perim * 0.15 && pts.length > 8) {
    const cx2 = (minX + maxX) / 2, cy2 = (minY + maxY) / 2;
    const rx = w / 2, ry = h / 2;
    let totalDev = 0;
    for (const p of pts) {
      // Distanza normalizzata dall'ellisse
      const nx = (p.x - cx2) / rx, ny = (p.y - cy2) / ry;
      totalDev += Math.abs(Math.hypot(nx, ny) - 1);
    }
    const avgDev = totalDev / pts.length;
    if (avgDev < 0.25 && w > 20 && h > 20) {
      return { ...stroke, t: 'ellipse', pts: [{ x: minX, y: minY }, { x: maxX, y: maxY }] };
    }
  }

  return null; // nessuna forma riconosciuta
}

function seekToSegment(sec) {
  if (!S.aBuf || !S.aCtx) return;
  seekAudio(Math.max(0, Math.min(sec, S.aBuf.duration)));
}

// ── Full-text search results ─────────────────────────────
function renderFTSResults(results, q) {
  const el = document.getElementById('NL');
  // Rimuovi sezione FTS precedente
  el.querySelectorAll('.fts-section, .fts-card').forEach(e => e.remove());
  if (!results.length) return;
  // Filtra quelli non già visibili per titolo
  const visibleIds = new Set(S.notes.filter(n => n.title.toLowerCase().includes(q.toLowerCase())).map(n => n.id));
  const extra = results.filter(r => !visibleIds.has(r.id));
  if (!extra.length) return;
  const sep = document.createElement('div');
  sep.className = 'fts-section';
  sep.textContent = 'Trovate nel contenuto';
  el.appendChild(sep);
  extra.forEach(r => {
    const d = buildNoteCard(r);
    d.classList.add('fts-card');
    if (r.snippet) {
      const sn = document.createElement('div');
      sn.className = 'snippet';
      sn.innerHTML = r.snippet;
      d.querySelector('.meta').appendChild(sn);
    }
    el.appendChild(d);
  });
}

// ── Transcript Panel ─────────────────────────────────────
function showTranscriptPanel(data) {
  document.getElementById('_tp')?.remove();
  const panel = document.createElement('div');
  panel.id = '_tp';
  panel.style.cssText = `
    position:fixed;right:16px;top:50%;transform:translateY(-50%);
    width:320px;max-height:70vh;
    background:#1a2635;color:#e8e8f0;
    border-radius:12px;border:1px solid rgba(255,255,255,.1);
    box-shadow:0 16px 48px rgba(0,0,0,.5);
    z-index:500;display:flex;flex-direction:column;overflow:hidden;
  `;

  const hdr = document.createElement('div');
  hdr.style.cssText = 'padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;flex-shrink:0';
  const title = data.diarized
    ? `Trascrizione · ${data.speakers} parlant${data.speakers===1?'e':'i'}`
    : 'Trascrizione';
  hdr.innerHTML = `
    <span style="font-size:.82rem;font-weight:600">${title}</span>
    <div style="display:flex;gap:6px">
      <button onclick="navigator.clipboard.writeText(document.getElementById('_tp_text').innerText).then(()=>toast('✓ Copiato'))"
        style="padding:3px 8px;border:1px solid rgba(255,255,255,.15);border-radius:5px;background:transparent;color:#e8e8f0;font-size:.7rem;cursor:pointer;font-family:inherit">
        Copia
      </button>
      <button onclick="document.getElementById('_tp').remove()"
        style="width:22px;height:22px;border:none;background:rgba(255,255,255,.1);border-radius:5px;color:#e8e8f0;cursor:pointer;font-size:.85rem;display:flex;align-items:center;justify-content:center">
        ✕
      </button>
    </div>
  `;

  const body = document.createElement('div');
  body.id = '_tp_text';
  body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 14px;font-size:.78rem;line-height:1.6';

  if (data.diarized && data.segments?.length) {
    // Visualizzazione diarizzata con bolle per ogni parlante
    const colors = ['#f5a000','#2471a3','#1e8449','#8e44ad','#c0392b','#e67e22'];
    const speakerColors = {};
    let colorIdx = 0;
    body.innerHTML = data.segments.map(seg => {
      if (!speakerColors[seg.speaker_label]) {
        speakerColors[seg.speaker_label] = colors[colorIdx++ % colors.length];
      }
      const color = speakerColors[seg.speaker_label];
      const mm = String(Math.floor(seg.start/60)).padStart(2,'0');
      const ss = String(Math.floor(seg.start%60)).padStart(2,'0');
      return `
        <div data-seg="1" data-start="${seg.start}" data-end="${seg.end}"
             style="margin-bottom:10px;padding:4px 0;transition:background .15s,padding .15s">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
            <span style="width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0"></span>
            <span style="font-weight:600;font-size:.7rem;color:${color}">${seg.speaker_label||'Voce'}</span>
            <span style="font-size:.64rem;color:rgba(255,255,255,.3);margin-left:auto;cursor:pointer"
                  onclick="seekToSegment(${seg.start})">${mm}:${ss}</span>
          </div>
          <div style="padding-left:13px;color:rgba(255,255,255,.82);line-height:1.55">${esc(seg.text)}</div>
        </div>
      `;
    }).join('');
  } else if (data.segments?.length) {
    // Segmenti senza diarizzazione — highlight sync comunque
    body.innerHTML = data.segments.map(seg => {
      const mm = String(Math.floor(seg.start/60)).padStart(2,'0');
      const ss = String(Math.floor(seg.start%60)).padStart(2,'0');
      return `<span data-seg="1" data-start="${seg.start}" data-end="${seg.end}"
                style="display:inline;transition:background .15s;border-radius:3px;cursor:pointer"
                onclick="seekToSegment(${seg.start})">${esc(seg.text)} </span>`;
    }).join('');
  } else {
    // Testo puro senza segmenti
    body.style.whiteSpace = 'pre-wrap';
    body.textContent = data.text;
  }

  panel.appendChild(hdr);
  panel.appendChild(body);
  document.body.appendChild(panel);
}

// ── Auto-trascrizione ────────────────────────────────────
async function autoTranscribe() {
  if (!S.curId) return;
  S.whisperPending = true;
  updateTranscribeBtn();

  try {
    // Chiama endpoint async (risponde subito 202, processa in background)
    await fetch(`/api/notes/${S.curId}/transcribe-async`, { method: 'POST' });

    // Polling ogni 5s finché la trascrizione non è pronta (max 10 minuti)
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      if (attempts > 120) { clearInterval(poll); S.whisperPending = false; updateTranscribeBtn(); return; }
      if (S.curId === null) { clearInterval(poll); return; }
      try {
        const r = await fetch(`/api/notes/${S.curId}/transcript`);
        if (!r.ok) return;
        const d = await r.json();
        if (d.has_transcript && d.text) {
          clearInterval(poll);
          S.whisperSegments = d.segments || null;
          S.whisperPending  = false;
          updateTranscribeBtn();
          toast('✓ Trascrizione completata');
        }
      } catch {}
    }, 5000);
  } catch(e) {
    S.whisperPending = false;
    updateTranscribeBtn();
  }
}

// Pulsante "AI" — la scritta resta sempre la stessa, lo stato si legge da
// data-pending/data-ready (stile in app.css) e dal title (tooltip).
function updateTranscribeBtn() {
  const btn = document.getElementById('TRANSCB');
  if (!btn) return;
  btn.removeAttribute('data-pending');
  btn.removeAttribute('data-ready');
  btn.style.opacity = '1';
  if (S.whisperPending) {
    btn.setAttribute('data-pending', '');
    btn.title = 'Trascrizione in corso…';
    btn.disabled = true;
  } else if (S.whisperSegments || document.getElementById('_tp')) {
    btn.setAttribute('data-ready', '');
    btn.title = 'Trascrizione pronta — clicca per rivedere';
    btn.disabled = false;
  } else if (!S.aBuf) {
    // Nessun audio registrato — niente da trascrivere
    btn.style.opacity = '.4';
    btn.disabled = false;
    btn.title = 'Registra un audio prima di trascrivere';
  } else {
    btn.disabled = false;
    btn.title = 'Trascrivi audio con Whisper (AI)';
  }
}

// ── Share helpers ─────────────────────────────────────────
async function loadShares() {
  if (!S.curId) return;
  const r = await fetch(`/api/notes/${S.curId}/shares`);
  const shares = await r.json();
  const el = document.getElementById('SHARELIST');
  if (!shares.length) { el.innerHTML = '<p style="font-size:.74rem;color:var(--mu);text-align:center;padding:8px">Nessun link attivo</p>'; return; }
  el.innerHTML = shares.map(s => {
    const url = `${location.origin}/share/${s.token}`;
    const exp = s.expires_at ? `Scade ${new Date(s.expires_at).toLocaleDateString('it-IT')}` : 'Nessuna scadenza';
    return `<div style="background:var(--bh);border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:.74rem">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mu)">${s.token.slice(0,12)}…</span>
        <span style="color:var(--mu);font-size:.68rem">${exp}</span>
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button onclick="copyShareLink('${url}')" style="flex:1;padding:4px 8px;border:.5px solid var(--tbr);border-radius:4px;background:transparent;cursor:pointer;font-size:.7rem;color:var(--ink)">📋 Copia</button>
        <button onclick="shareNative('${url}','${document.getElementById('NTT').value}')" style="flex:1;padding:4px 8px;border:.5px solid var(--tbr);border-radius:4px;background:transparent;cursor:pointer;font-size:.7rem;color:var(--ink)">📤 Condividi</button>
        <button onclick="mailShare('${url}','${document.getElementById('NTT').value}')" style="flex:1;padding:4px 8px;border:.5px solid var(--tbr);border-radius:4px;background:transparent;cursor:pointer;font-size:.7rem;color:var(--ink)">✉️ Mail</button>
        <button onclick="deleteShare('${s.token}')" style="padding:4px 8px;border:.5px solid var(--acc);border-radius:4px;background:transparent;cursor:pointer;font-size:.7rem;color:var(--acc)">Revoca</button>
      </div>
    </div>`;
  }).join('');
}

async function deleteShare(token) {
  await fetch(`/api/shares/${token}`, { method: 'DELETE' });
  await loadShares();
  toast('Link revocato');
}

function copyShareLink(url) {
  navigator.clipboard.writeText(url).then(() => toast('✓ Link copiato')).catch(() => {
    prompt('Copia questo link:', url);
  });
}

function shareNative(url, title) {
  if (navigator.share) {
    navigator.share({ title: `Nota: ${title}`, url }).catch(() => {});
  } else {
    copyShareLink(url);
  }
}

function mailShare(url, title) {
  const sub = encodeURIComponent(`Nota Quetza: ${title}`);
  const body = encodeURIComponent(`Ciao,

ti condivido questa nota:
${url}

— inviato da Quetza`);
  window.open(`mailto:?subject=${sub}&body=${body}`);
}

// ── Start ─────────────────────────────────────────────────
init();