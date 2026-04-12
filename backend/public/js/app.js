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
const PGAP = 32;  // gap between pages
const GSP = 28;   // grid spacing
const ZOOM_STEPS = [.25,.33,.5,.67,.75,.9,1,1.1,1.25,1.5,1.75,2,2.5,3];

// ── State ─────────────────────────────────────────────────
const S = {
  // Drawing
  tool: 'pen', color: '#111', size: 3,
  strokes: [], undo: [], redo: [], cur: null, imgs: [],
  grid: 'lines', pages: 3,
  // Zoom / pan
  zoom: 1, pan: false, pY: 0, pSY: 0,
  // Palm rejection
  palmActive: false,  // true se un dito è sul canvas mentre scriviamo
  activePointers: new Map(), // pointerId → type
  // Audio
  aCtx: null, aBuf: null, src: null,
  playing: false, recOn: false,
  recStart: 0, playOff: 0, playSt: 0,
  raf: null, peaks: null,
  // UI
  dark: false,
  shapeRecog: false,
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
const CW   = document.getElementById('CW');
const SB   = document.getElementById('SB');
const ED   = document.getElementById('ED');
const EM   = document.getElementById('EM');
const NTT  = document.getElementById('NTT');
const APP  = document.getElementById('W');
const MP   = document.getElementById('MP');
const TT   = document.getElementById('TT');
const TSel = document.getElementById('TS');
const TC   = document.getElementById('TC');
const tx   = TC.getContext('2d');
const WC   = document.getElementById('WC');
const wx   = WC.getContext('2d');
const PW2  = document.getElementById('PW');
const SC   = document.getElementById('SC');
const ATM  = document.getElementById('ATM');
const AH   = document.getElementById('AH');
const ARC  = document.getElementById('ARC');
const APL  = document.getElementById('APL');
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
    document.getElementById('UNAME').textContent = d.user.displayName || d.user.username;
  } catch { window.location.href = '/login.html'; return; }

  await loadNotes();
  setupToolbar();
  setupSidebar();
  setupZoom();
  setupCanvas();
}

// ── Notes API ─────────────────────────────────────────────
async function loadNotes() {
  const r = await fetch('/api/notes');
  S.notes = await r.json();
  renderNL();
}

async function openNote(id) {
  if (S.recOn) stopRec();
  if (S.playing) stopAudio();

  const r = await fetch(`/api/notes/${id}`);
  const n = await r.json();
  S.curId = id;
  S.strokes = n.strokes || [];
  S.imgs    = n.images  || [];
  S.grid    = n.grid    || 'lines';
  S.pages   = Math.max(3, Math.ceil(maxY() / PH) + 1);
  S.undo = []; S.redo = [];
  GSL.value = S.grid;
  NTT.value = n.title;

  // Reset audio UI
  S.aBuf = null; S.peaks = null; S.playOff = 0;
  AH.style.display = ''; APL.style.display = 'none'; ARC.style.display = 'none';
  wx.clearRect(0, 0, WC.width, WC.height);
  TSel.classList.remove('on');

  // Load audio if exists
  if (n.has_audio) {
    try {
      const ar = await fetch(`/api/notes/${id}/audio`);
      if (ar.ok) {
        const ab = await ar.arrayBuffer();
        if (!S.aCtx) S.aCtx = new (window.AudioContext || window.webkitAudioContext)();
        S.aBuf = await S.aCtx.decodeAudioData(ab);
        buildPeaks();
        AH.style.display = 'none'; APL.style.display = 'flex';
        drawWave(0); updAT(0); TSel.classList.add('on');
      }
    } catch (e) { console.warn('Audio load failed:', e); }
  }

  EM.style.display = 'none'; ED.className = 'on';
  // Imposta dimensioni logiche del canvas (coordinate di disegno)
  CV.width = PW; CV.height = totalH();
  renderNL();
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
    body: JSON.stringify({ title: 'Nuova nota' })
  });
  const n = await r.json();
  S.notes.unshift(n);
  renderNL();
  await openNote(n.id);
}

async function deleteNote(id) {
  if (!confirm('Eliminare questa nota?')) return;
  await fetch(`/api/notes/${id}`, { method: 'DELETE' });
  S.notes = S.notes.filter(n => n.id !== id);
  if (S.curId === id) { S.curId = null; S.strokes = []; ED.className = ''; EM.style.display = ''; }
  renderNL();
}

function scheduleAutoSave() {
  S.dirty = true;
  clearTimeout(S.autoSaveTimer);
  S.autoSaveTimer = setTimeout(() => saveNote(true), 4000); // 4s dopo l'ultimo tratto
}

async function saveNote(silent = false) {
  if (!S.curId) return;
  // Titolo automatico se ancora "Nuova nota"
  let title = NTT.value.trim();
  if (!title || title === 'Nuova nota') {
    const now = new Date();
    const dateStr = now.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' });
    const timeStr = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    title = `Nota ${dateStr} ${timeStr}`;
    NTT.value = title;
  }
  const thumbnail = genThumb();

  await fetch(`/api/notes/${S.curId}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strokes: S.strokes, images: S.imgs, thumbnail, grid: S.grid })
  });
  await fetch(`/api/notes/${S.curId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, grid: S.grid })
  });

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
}

function genThumb() {
  const o = document.createElement('canvas');
  o.width = 280; o.height = 100;
  const oc = o.getContext('2d');
  oc.fillStyle = '#fff'; oc.fillRect(0, 0, 280, 100);
  const sc = Math.min(280 / PW, 100 / PH);
  oc.save(); oc.scale(sc, sc); drawSS(oc, S.strokes); oc.restore();
  return o.toDataURL('image/jpeg', 0.7);
}

function renderNL(filter) {
  const el = document.getElementById('NL');
  el.innerHTML = '';
  const q = (filter || S.searchQ || '').toLowerCase().trim();
  const notes = q ? S.notes.filter(n => n.title.toLowerCase().includes(q)) : S.notes;
  if (!notes.length) {
    el.innerHTML = `<div style="padding:16px 8px;text-align:center;color:var(--mu);font-size:.72rem">${q ? 'Nessun risultato' : 'Nessuna nota'}</div>`;
    return;
  }
  notes.forEach(n => {
    const d = document.createElement('div');
    d.className = 'ni' + (n.id === S.curId ? ' on' : '');
    const date = new Date(n.updated_at || n.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    d.innerHTML = `
      <button class="ndl" title="Elimina">✕</button>
      <div class="nt">${esc(n.title)}</div>
      <div class="nd">${date}</div>
      ${n.has_audio ? '<div class="na">⏺ audio</div>' : ''}
      ${n.thumbnail ? `<div class="nth"><img src="${n.thumbnail}" alt=""></div>` : ''}
    `;
    d.querySelector('.ndl').onclick = e => { e.stopPropagation(); deleteNote(n.id); };
    d.onclick = () => openNote(n.id);
    el.appendChild(d);
  });
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Draw helpers ──────────────────────────────────────────
function totalH() { return S.pages * PH + (S.pages - 1) * PGAP; }
function maxY() {
  let m = 0;
  S.strokes.forEach(s => s.pts && s.pts.forEach(p => { if (p.y > m) m = p.y; }));
  return m;
}

function drawGrid(c, dk) {
  if (S.grid === 'none') return;
  c.save(); c.lineWidth = .5;
  const lc = dk ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.06)';
  const dc = dk ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.18)';
  for (let p = 0; p < S.pages; p++) {
    const py = p * (PH + PGAP);
    if (S.grid === 'lines' || S.grid === 'grid') {
      c.strokeStyle = lc;
      for (let y = GSP; y < PH; y += GSP) { c.beginPath(); c.moveTo(0, py+y); c.lineTo(PW, py+y); c.stroke(); }
      if (S.grid === 'grid') for (let x = GSP; x < PW; x += GSP) { c.beginPath(); c.moveTo(x, py); c.lineTo(x, py+PH); c.stroke(); }
    } else {
      c.fillStyle = dc;
      for (let y = GSP; y < PH; y += GSP) for (let x = GSP; x < PW; x += GSP) { c.beginPath(); c.arc(x, py+y, 1.2, 0, Math.PI*2); c.fill(); }
    }
  }
  c.restore();
}

function drawSeps(c, dk) {
  c.save();
  for (let p = 0; p < S.pages - 1; p++) {
    const sy = (p + 1) * PH + p * PGAP;
    c.fillStyle = dk ? 'rgba(0,0,0,.35)' : 'rgba(0,0,0,.07)';
    c.fillRect(0, sy, PW, PGAP);
    c.setLineDash([8, 6]);
    c.strokeStyle = dk ? 'rgba(255,255,255,.15)' : 'rgba(0,0,0,.2)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, sy+PGAP); c.lineTo(PW, sy+PGAP); c.stroke();
    c.setLineDash([]);
    c.fillStyle = dk ? 'rgba(255,255,255,.2)' : 'rgba(0,0,0,.18)';
    c.font = '11px system-ui'; c.textAlign = 'right';
    c.fillText(`${p+1} / ${S.pages}`, PW - 10, sy - 6);
  }
  c.fillStyle = dk ? 'rgba(255,255,255,.2)' : 'rgba(0,0,0,.18)';
  c.font = '11px system-ui'; c.textAlign = 'right';
  c.fillText(`${S.pages} / ${S.pages}`, PW - 10, totalH() - 6);
  c.restore();
}

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

function drawSS(c, ss) {
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
      c.strokeStyle = s.c; c.lineWidth = s.sz || 2; c.lineCap = 'round'; c.lineJoin = 'round';
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
        c.closePath(); c.fillStyle = s.c; c.fill();
      }
    } else {
      // Catmull-Rom smoothing per tratto fluido
      c.strokeStyle = s.c; c.lineCap = 'round'; c.lineJoin = 'round';
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

function redraw(hTs) {
  const dk = S.dark;
  cx.clearRect(0, 0, CV.width, CV.height);
  cx.fillStyle = dk ? '#23272e' : '#fff';
  for (let p = 0; p < S.pages; p++) cx.fillRect(0, p*(PH+PGAP), PW, PH);
  drawGrid(cx, dk); drawSeps(cx, dk);
  S.imgs.forEach(i => cx.drawImage(i.el, i.x, i.y, i.w, i.h));
  drawHi(cx, hTs);
  // Disegna strokes con highlight selezione
  S.strokes.forEach((s, idx) => {
    drawSS(cx, [s]);
    if (S.selectedIds.has(idx)) drawStrokeHighlight(cx, s);
  });
  // Bounding box + handle selezione multipla
  if (S.selectedIds.size > 0) drawSelectionBox(cx);
  // Lasso in corso
  if (S.lassoPath && S.lassoPath.length > 1) drawLassoPath(cx, S.lassoPath);
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

// ── Auto-extend pages ─────────────────────────────────────
function checkExtend() {
  const my = maxY();
  if (my > S.pages * (PH + PGAP) - PH * 0.3) {
    S.pages++;
    CV.height = totalH();
    drawTL();
  }
}

// ── Zoom ──────────────────────────────────────────────────
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

  // Pinch-to-zoom centrato sul punto di contatto
  let lp = null, lpCx = 0, lpCy = 0;
  CO.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      lp = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      // Centro del pinch in coordinate relative al viewport CO
      const r = CO.getBoundingClientRect();
      lpCx = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - r.left;
      lpCy = ((e.touches[0].clientY + e.touches[1].clientY) / 2) - r.top;
    }
  }, { passive: true });
  CO.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && lp) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const r = CO.getBoundingClientRect();
      const cx2 = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - r.left;
      const cy2 = ((e.touches[0].clientY + e.touches[1].clientY) / 2) - r.top;
      zTo(S.zoom * (d / lp), cx2 + CO.scrollLeft, cy2 + CO.scrollTop);
      lp = d; lpCx = cx2; lpCy = cy2;
    }
  }, { passive: true });
  CO.addEventListener('touchend', () => { lp = null; }, { passive: true });

  // Ctrl+wheel zoom centrato sul cursore
  CO.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const r = CO.getBoundingClientRect();
      const mx = (e.clientX - r.left) + CO.scrollLeft;
      const my = (e.clientY - r.top)  + CO.scrollTop;
      zTo(S.zoom + (e.deltaY > 0 ? -.08 : .08), mx, my);
    }
  }, { passive: false });
}

function applyZoom() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.round(PW * S.zoom);
  const cssH = Math.round(totalH() * S.zoom);

  // Dimensioni CSS: quello che occupa nella pagina
  CV.style.width  = cssW + 'px';
  CV.style.height = cssH + 'px';

  // Dimensioni fisiche canvas: CSS * dpr per Retina
  // Solo se cambiate (evita reset del canvas inutili)
  const physW = Math.round(cssW * dpr);
  const physH = Math.round(cssH * dpr);
  if (CV.width !== physW || CV.height !== physH) {
    CV.width  = physW;
    CV.height = physH;
    // Scala il context per le coordinate logiche
    cx.setTransform(dpr * S.zoom, 0, 0, dpr * S.zoom, 0, 0);
  }

  CW.style.height = (cssH + 32) + 'px';
  ZL.textContent = Math.round(S.zoom * 100) + '%';
  redraw();
}

function zTo(z, pivotX, pivotY) {
  // pivotX/Y: punto in CSS px attorno a cui zoomare (default: centro del viewport)
  const oldZ = S.zoom;
  S.zoom = Math.max(.25, Math.min(3, z));

  if (pivotX !== undefined && pivotY !== undefined) {
    // Mantieni il punto sotto il pivot fermo durante lo zoom
    const ratio = S.zoom / oldZ;
    const scrollX = CO.scrollLeft;
    const scrollY = CO.scrollTop;
    CO.scrollLeft = (scrollX + pivotX) * ratio - pivotX;
    CO.scrollTop  = (scrollY + pivotY) * ratio - pivotY;
  } else {
    // Zoom proporzionale allo scroll corrente
    const f = CO.scrollTop / (CW.scrollHeight || 1);
    applyZoom();
    CO.scrollTop = f * CW.scrollHeight;
    return;
  }
  applyZoom();
}

function fitW() {
  const w = CO.clientWidth;
  if (w > 0) {
    S.zoom = Math.max(.25, Math.min(3, (w - 32) / PW));
    applyZoom();
  }
}

// ── Canvas pointer events ─────────────────────────────────
function setupCanvas() {
  function gP(ex, ey) {
    const r = CV.getBoundingClientRect();
    // r.width = PW * zoom (CSS px)
    // Coordinate logiche = (css_offset / zoom)
    return {
      x: (ex - r.left) / S.zoom,
      y: (ey - r.top)  / S.zoom
    };
  }

  function inGap(y) {
    for (let p = 0; p < S.pages - 1; p++) {
      const g = (p+1)*PH + p*PGAP;
      if (y >= g && y <= g + PGAP) return true;
    }
    return false;
  }

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
      cx.strokeStyle=s.c; cx.lineCap='round';
      // Interpola pressione tra punto precedente e corrente per transizioni fluide
      const pp = calibratePressure(pr.p||.5);
      const cp = calibratePressure(pt.p||.5);
      const avgP = (pp + cp) / 2;
      cx.lineWidth = (s.sz||3) * (0.3 + avgP * 1.4);
    }
    cx.beginPath();
    cx.moveTo(pr.x, pr.y);
    cx.lineTo(pt.x, pt.y);
    cx.stroke(); cx.restore();
  }

  // ── Touch handlers su CO (wrapper) per pan con dito ─────
  CO.addEventListener('touchstart', e => {
    if (e.touches.length === 1 && e.touches[0].touchType !== 'stylus') {
      S.pan = true; S.pY = e.touches[0].clientY; S.pSY = CO.scrollTop;
      showMP('touch');
    }
  }, { passive: true });
  CO.addEventListener('touchmove', e => {
    if (S.pan && e.touches.length === 1) {
      CO.scrollTop = S.pSY + (S.pY - e.touches[0].clientY);
    }
  }, { passive: true });
  CO.addEventListener('touchend', () => { S.pan = false; }, { passive: true });

  // ── Pointer handlers su CV (canvas) per disegno ──────────
  // Registrare su CV invece che CO risolve il problema di input mancanti:
  // il canvas riceve gli eventi direttamente senza che il wrapper
  // possa intercettarli o perderli durante lo scroll
  CV.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (e.pointerType === 'touch') return;
    if (S.palmActive) return;
    CV.setPointerCapture(e.pointerId);
    S.activePointers.set(e.pointerId, e.pointerType);
    const p = gP(e.clientX, e.clientY);
    if (inGap(p.y)) return;
    const t = (e.buttons === 32 || e.button === 5) ? 'eraser' : S.tool;
    const aTs = S.recOn ? (Date.now() - S.recStart) : null;
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
      ? { t, c: S.color, sz: S.size, pts: [p, {...p}], aTs }
      : { t, c: S.color, sz: S.size, pts: [{...p, p: e.pressure||.5}], aTs };
    showMP('pen');
  }, { passive: false });

  CV.addEventListener('pointermove', e => {
    e.preventDefault();
    if (e.pointerType === 'touch' || !S.cur) return;

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
        S.cur.pts[1] = {...pos}; redraw(); drawSS(cx, [S.cur]); break;
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
      scheduleAutoSave();
    }
    S.cur = null;
    checkExtend();
    redraw();
    if (S.aBuf) drawTL();
  }, { passive: false });

  CV.addEventListener('pointercancel', e => {
    S.activePointers.delete(e.pointerId);
    S.cur = null; S.selDrag = false; S.lassoPath = null;
  });
  CV.addEventListener('contextmenu', e => e.preventDefault(), { passive: false });

  // ── Apple Pencil su Safari iOS: Touch Events nativi ──────
  // I Pointer Events su Safari iOS droppano pointerdown quando
  // si scrive velocemente. I Touch Events hanno priorità più alta
  // e non vengono mai droppati dal sistema.
  // touchType === 'stylus' distingue Apple Pencil dal dito.

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
        const aTs = S.recOn ? (Date.now() - S.recStart) : null;
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
          ? { t: S.tool, c: S.color, sz: S.size, pts: [pos, {...pos}], aTs }
          : { t: S.tool, c: S.color, sz: S.size, pts: [{...pos, p: t.force||0.5}], aTs };
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
            S.cur.pts[1] = {...pos}; redraw(); drawSS(cx, [S.cur]); break;
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
        checkExtend();
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

  // Blocca menu contestuale Safari iOS (long press con Apple Pencil)
  CO.addEventListener('contextmenu', e => e.preventDefault(), { passive: false });
  CV.addEventListener('contextmenu', e => e.preventDefault(), { passive: false });

  // ── Apple Pencil su Safari iOS: Touch Events nativi ──────
  // I Pointer Events su Safari iOS droppano pointerdown quando
  // si scrive velocemente. I Touch Events hanno priorità più alta
  // e non vengono mai droppati dal sistema.
  // touchType === 'stylus' distingue Apple Pencil dal dito.

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
        const aTs = S.recOn ? (Date.now() - S.recStart) : null;
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
          ? { t: S.tool, c: S.color, sz: S.size, pts: [pos, {...pos}], aTs }
          : { t: S.tool, c: S.color, sz: S.size, pts: [{...pos, p: t.force||0.5}], aTs };
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
            S.cur.pts[1] = {...pos}; redraw(); drawSS(cx, [S.cur]); break;
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
        checkExtend();
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
    };
  });
  document.querySelectorAll('.sw').forEach(s => {
    s.onclick = () => {
      document.querySelectorAll('.sw').forEach(x => x.classList.remove('on'));
      s.classList.add('on'); S.color = s.dataset.c;
      if (S.tool === 'eraser') document.querySelector('[data-t="pen"]').click();
    };
  });
  SZR.oninput = () => { S.size = parseInt(SZR.value); SZV.textContent = S.size; };
  GSL.onchange = () => { S.grid = GSL.value; redraw(); };

  document.getElementById('DKB').onclick = () => {
    S.dark = !S.dark;
    S.dark ? APP.setAttribute('data-dk','1') : APP.removeAttribute('data-dk');
    redraw();
  };

  document.getElementById('UDB').onclick = () => {
    if (S.undo.length < 2) { S.strokes = []; S.undo = []; }
    else { S.undo.pop(); S.strokes = [...S.undo[S.undo.length-1]]; }
    redraw(); if (S.aBuf) drawTL();
  };
  document.getElementById('RDB').onclick = () => {
    if (!S.redo.length) return;
    S.strokes = [...S.redo.pop()]; S.undo.push([...S.strokes]); redraw(); if (S.aBuf) drawTL();
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
    S.undo.push([...S.strokes]); S.strokes = []; S.imgs = []; redraw(); toast('Canvas pulita');
  };
  document.getElementById('SVB').onclick = () => saveNote(false);

  document.getElementById('PSB').onclick = pasteImg;

  document.getElementById('PDFB').onclick = () => document.getElementById('PM').classList.remove('off');
  document.getElementById('PCA').onclick  = () => document.getElementById('PM').classList.add('off');
  document.getElementById('POK').onclick  = () => {
    const wg = document.querySelector('input[name="ge"]:checked').value === 'yes';
    document.getElementById('PM').classList.add('off');
    exportPDF(wg);
  };

  // Audio
  document.getElementById('RCB').onclick = () => { if (S.recOn) stopRec(); else startRec(); };
  document.getElementById('APB').onclick = () => { if (S.playing) stopAudio(); else startAudio(S.playOff); };
  document.getElementById('DELAUD').onclick = deleteAudio;
  PW2.onclick = e => {
    if (!S.aBuf) return;
    const r = PW2.getBoundingClientRect();
    seekAudio(((e.clientX - r.left) / r.width) * S.aBuf.duration);
  };

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const m = e.ctrlKey || e.metaKey;
    if (m && e.key==='s')  { e.preventDefault(); saveNote(); }
    if (m && e.key==='z')  { e.preventDefault(); document.getElementById('UDB').click(); }
    if (m && (e.key==='y'||(e.shiftKey&&e.key==='Z'))) { e.preventDefault(); document.getElementById('RDB').click(); }
    if (m && e.key==='=')  { e.preventDefault(); document.getElementById('ZI').click(); }
    if (m && e.key==='-')  { e.preventDefault(); document.getElementById('ZO').click(); }
    if (m && e.key==='0')  { e.preventDefault(); zTo(1); }
    if (m && e.key==='v')  { pasteImg(); }
    if (!m) {
      switch(e.key) {
        case 'p': document.querySelector('[data-t="pen"]').click(); break;
        case 'h': document.querySelector('[data-t="hl"]').click(); break;
        case 'e': document.querySelector('[data-t="eraser"]').click(); break;
        case 'r': document.querySelector('[data-t="rect"]').click(); break;
        case 'l': document.querySelector('[data-t="line"]').click(); break;
        case 'a': document.querySelector('[data-t="arrow"]').click(); break;
        case 'o': document.querySelector('[data-t="ellipse"]').click(); break;
        case 's': document.querySelector('[data-t="lasso"]').click(); break;
      }
    }
    if (e.key===' ' && e.target===document.body) { e.preventDefault(); document.getElementById('APB').click(); }
    if (e.key==='Escape') { S.selectedIds.clear(); S.lassoPath=null; S.selDrag=false; S.cur=null; redraw(); }
    if ((e.key==='Delete'||e.key==='Backspace') && document.activeElement===document.body) { deleteSelected(); }
  });
}

// ── Sidebar ───────────────────────────────────────────────
function setupSidebar() {
  document.getElementById('sbC').onclick = () => { SB.classList.add('off'); document.getElementById('sbO').style.display='flex'; };
  document.getElementById('sbO').onclick = () => { SB.classList.remove('off'); document.getElementById('sbO').style.display='none'; };
  document.getElementById('newB').onclick = newNote;

  // Ricerca note
  const srch = document.getElementById('SRCH');
  if (srch) {
    srch.addEventListener('input', () => {
      S.searchQ = srch.value;
      renderNL();
    });
  }
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
function exportPDF(withGrid) {
  toast('⏳ Generazione PDF…');
  setTimeout(() => {
    try {
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      for (let p = 0; p < S.pages; p++) {
        if (p > 0) pdf.addPage();
        const off = document.createElement('canvas'); off.width = PW; off.height = PH;
        const oc = off.getContext('2d'); oc.fillStyle = '#fff'; oc.fillRect(0, 0, PW, PH);
        if (withGrid) drawGrid(oc, false);
        const pt = p*(PH+PGAP), pb = pt+PH;
        S.imgs.forEach(i => { if (i.y+i.h>pt && i.y<pb) oc.drawImage(i.el, i.x, i.y-pt, i.w, i.h); });
        drawSS(oc, S.strokes.filter(s => s.pts && s.pts.some(q => q.y>=pt && q.y<=pb)).map(s => ({...s, pts: s.pts.map(q => ({...q, y: q.y-pt}))})));
        pdf.addImage(off.toDataURL('image/jpeg', .95), 'JPEG', 0, 0, 210, 297, '', 'FAST');
      }
      pdf.save(`${(NTT.value||'quetza').replace(/[^a-z0-9]/gi,'_')}.pdf`);
      toast('✓ PDF esportato');
    } catch(e) { toast('⚠ Errore export'); console.error(e); }
  }, 100);
}

// ── Audio recording ───────────────────────────────────────
async function startRec() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('⚠ Microfono non supportato in questo browser'); return;
  }
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
    toast('⚠ La registrazione richiede HTTPS'); return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : '';
    S.chunks = [];
    S.mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    S.mr.ondataavailable = e => { if (e.data.size > 0) S.chunks.push(e.data); };
    S.mr.onstop = onRecStop;
    S.recStart = Date.now(); S.recOn = true; S.mr.start(100);
    const btn = document.getElementById('RCB');
    btn.classList.add('rec');
    btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="white"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
    AH.style.display = 'none'; ARC.style.display = 'flex';
    S._ri = setInterval(() => {
      const e = Date.now() - S.recStart;
      RTM.textContent = `${Math.floor(e/60000)}:${(Math.floor(e/1000)%60).toString().padStart(2,'0')}`;
    }, 500);
    toast('⏺ Registrazione avviata');
  } catch(err) {
    console.error('getUserMedia error:', err);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      toast('⚠ Permesso microfono negato — controlla le impostazioni del browser');
    } else if (err.name === 'NotFoundError') {
      toast('⚠ Nessun microfono trovato');
    } else {
      toast('⚠ Errore microfono: ' + err.message);
    }
  }
}

function stopRec() {
  if (!S.mr) return;
  S.recOn = false; S.mr.stop(); S.mr.stream.getTracks().forEach(t => t.stop());
  clearInterval(S._ri); ARC.style.display = 'none';
  const btn = document.getElementById('RCB');
  btn.classList.remove('rec');
  btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="white"><circle cx="12" cy="12" r="6"/></svg>';
}

async function onRecStop() {
  const blob = new Blob(S.chunks, { type: 'audio/webm' });

  // Decode for playback
  if (!S.aCtx) S.aCtx = new (window.AudioContext || window.webkitAudioContext)();
  const ab = await blob.arrayBuffer();
  S.aBuf = await S.aCtx.decodeAudioData(ab.slice(0));

  // Upload to server
  if (S.curId) {
    const fd = new FormData();
    fd.append('audio', blob, 'recording.webm');
    await fetch(`/api/notes/${S.curId}/audio`, { method: 'POST', body: fd });
    // Update note has_audio flag
    const idx = S.notes.findIndex(n => n.id === S.curId);
    if (idx >= 0) S.notes[idx].has_audio = 1;
    renderNL();
  }

  buildPeaks();
  AH.style.display = 'none'; APL.style.display = 'flex';
  drawWave(0); updAT(0);
  TSel.classList.add('on'); drawTL(0);
  toast('✓ Registrazione salvata');
}

async function deleteAudio() {
  if (!confirm('Eliminare la registrazione audio?')) return;
  if (S.playing) stopAudio();
  S.aBuf = null; S.peaks = null; S.playOff = 0;
  AH.style.display = ''; APL.style.display = 'none';
  wx.clearRect(0, 0, WC.width, WC.height);
  TSel.classList.remove('on');
  if (S.curId) {
    await fetch(`/api/notes/${S.curId}/audio`, { method: 'DELETE' });
    const idx = S.notes.findIndex(n => n.id === S.curId);
    if (idx >= 0) S.notes[idx].has_audio = 0;
    renderNL();
  }
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
  const W = WC.width = PW2.clientWidth || 170; const H = WC.height = 20;
  wx.clearRect(0, 0, W, H); if (!S.peaks) return;
  const n = S.peaks.length, bw = W/n;
  for (let i=0; i<n; i++) {
    const h = Math.max(2, S.peaks[i]*H*2.5);
    wx.fillStyle = (i/n)<f ? 'rgba(192,57,43,.9)' : 'rgba(255,255,255,.22)';
    wx.fillRect(i*bw, H/2-h/2, Math.max(1,bw-.5), Math.min(h,H));
  }
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
  SC.style.left = (f*100)+'%'; drawWave(f); updAT(el); redraw(ms); drawTL(f); scrollToTs(ms);
  S.raf = requestAnimationFrame(tickAudio);
}

function scrollToTs(ms) {
  const nb = S.strokes.filter(s => s.aTs!=null && Math.abs(s.aTs-ms)<2000);
  if (!nb.length) return;
  const avgY = nb.reduce((a,s) => a+s.pts.reduce((b,p)=>b+p.y,0)/s.pts.length, 0) / nb.length;
  CO.scrollTo({ top: Math.max(0, avgY*S.zoom - CO.clientHeight/2+16), behavior: 'smooth' });
}

// ── Timeline ──────────────────────────────────────────────
function drawTL(frac) {
  const H = TSel.clientHeight || 400; const W = 34;
  TC.width = W; TC.height = H; tx.clearRect(0,0,W,H);
  const dH = totalH(); const pad = 12;
  for (let p=0; p<S.pages; p++) {
    const y1=pad+(p*(PH+PGAP)/dH)*(H-pad*2);
    const y2=pad+((p*(PH+PGAP)+PH)/dH)*(H-pad*2);
    tx.fillStyle='rgba(255,255,255,.07)'; tx.fillRect(3,y1,W-6,y2-y1);
    tx.strokeStyle='rgba(255,255,255,.13)'; tx.lineWidth=.5; tx.strokeRect(3,y1,W-6,y2-y1);
    tx.fillStyle='rgba(255,255,255,.2)'; tx.font='7px system-ui'; tx.textAlign='center';
    tx.fillText(p+1, W/2, y1+9);
  }
  if (S.aBuf) {
    const dur = S.aBuf.duration*1000;
    S.strokes.forEach(s => {
      if (s.aTs==null) return;
      const avgY = s.pts.reduce((a,b)=>a+b.y,0)/s.pts.length;
      const ty = pad+(avgY/dH)*(H-pad*2);
      const hue = 200-(s.aTs/dur)*160;
      tx.fillStyle = `hsla(${Math.round(hue)},80%,65%,.75)`;
      tx.beginPath(); tx.arc(W/2, ty, 2.5, 0, Math.PI*2); tx.fill();
    });
  }
  if (frac != null) {
    const ms = frac*(S.aBuf?S.aBuf.duration*1000:1);
    const nb = S.strokes.filter(s=>s.aTs!=null&&Math.abs(s.aTs-ms)<2000);
    let ty;
    if (nb.length) {
      const avgY = nb.reduce((a,s)=>a+s.pts.reduce((b,p)=>b+p.y,0)/s.pts.length,0)/nb.length;
      ty = pad+(avgY/dH)*(H-pad*2);
    } else ty = pad+frac*(H-pad*2);
    tx.strokeStyle='#c0392b'; tx.lineWidth=1.5;
    tx.beginPath(); tx.moveTo(2,ty); tx.lineTo(W-2,ty); tx.stroke();
    tx.fillStyle='#c0392b';
    tx.beginPath(); tx.moveTo(2,ty); tx.lineTo(7,ty-3); tx.lineTo(7,ty+3); tx.closePath(); tx.fill();
  }
}
TC.onclick = e => {
  if (!S.aBuf) return;
  const r = TC.getBoundingClientRect(); const pad=12;
  seekAudio(Math.max(0,Math.min(1,(e.clientY-r.top-pad)/(r.height-pad*2)))*S.aBuf.duration);
};

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

function moveSelected(dx, dy) {
  S.selectedIds.forEach(idx => {
    const s = S.strokes[idx];
    if (!s || !s.pts) return;
    s.pts = s.pts.map(p => ({...p, x: p.x+dx, y: p.y+dy}));
  });
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

// ── Start ─────────────────────────────────────────────────
init();