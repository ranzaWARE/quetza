// Test della logica pagine ed export PDF di app.js, caricato in jsdom con un
// contesto canvas finto che registra le operazioni di disegno.
// Richiede la devDependency jsdom: npm install
const { check, section, done } = require('./_env');
const fs   = require('fs');
const path = require('path');
(async () => {
const { JSDOM } = require('jsdom');

const APP = path.join(__dirname, '..', 'public', 'js', 'app.js');

// ID richiesti a livello di modulo da app.js
const IDS = ['C','CO','CW','SB','ED','EM','NTT','W','MP','TT','WC','PW','SC','ATM',
             'AH','ARC','APL','RTM','ZL','SZR','SZV','GSL','UNAME','UNAME2','PGPREV',
             'PGNEXT','PGADD','PGNUM','UDB','RDB','SRB','CLB','SVB','DKB','PSB','PDFB',
             'PM','PCA','POK','RCB','APB','DELAUD','TXTB','TRANSCB','NL','newB','sbC',
             'sbO','logoutB','exportB','importFile','ZI','ZO','ZF','TXTI','TXTM','TXTSZ',
             'TXTSZV','TXTCANC','TXTOK','SHAREB','SHAREM','SHARECANCB','SHARECREB','SHAREEXP',
             'SHARELIST','NETDOT','NETLBL','OFFBANNER','SORT','SRCH','adminLink','PAUSEB','APPHDR','brandLogo'];

const html = `<!doctype html><html><body>
  ${IDS.map(id => id === 'C' || id === 'WC' ? `<canvas id="${id}"></canvas>` : `<div id="${id}"></div>`).join('\n')}
  <input id="ge_a" type="radio" name="ge" value="no" checked>
</body></html>`;

const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'https://quetza.test/' });
const { window } = dom;

// ── Canvas finto: registra ogni operazione ────────────────────────────
const drawLog = [];
function fakeCtx(tag) {
  const rec = (op) => (...args) => { drawLog.push({ tag: tag(), op, args }); };
  const ctx = {
    canvas: { width: 794, height: 1123 },
    save: () => {}, restore: () => {}, beginPath: () => {}, closePath: () => {},
    moveTo: () => {}, lineTo: () => {}, arc: () => {}, arcTo: () => {}, ellipse: () => {},
    quadraticCurveTo: () => {}, bezierCurveTo: () => {}, stroke: () => {}, fill: () => {},
    clearRect: () => {}, fillRect: () => {}, strokeRect: () => {}, setLineDash: () => {},
    setTransform: () => {}, scale: () => {}, drawImage: () => {},
    getImageData: () => ({ data: [] }), putImageData: () => {},
    measureText: () => ({ width: 10 }),
    fillText: rec('fillText'),
  };
  return ctx;
}
let ctxTag = () => 'main';
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(() => ctxTag()); };
window.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/jpeg;base64,AAAA'; };

// ── jsPDF finto ───────────────────────────────────────────────────────
const pdfOps = [];
window.jspdf = {
  jsPDF: class {
    constructor() { pdfOps.push({ op: 'new' }); }
    addPage() { pdfOps.push({ op: 'addPage' }); }
    addImage() { pdfOps.push({ op: 'addImage' }); }
    save(name) { pdfOps.push({ op: 'save', name }); }
  }
};

window.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
window.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){} });
window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.cancelAnimationFrame = () => {};
window.AudioContext = function(){ return { createBuffer(){}, get state(){return 'running';} }; };
window.confirm = () => true;
window.alert = () => {};

// Carica app.js senza eseguire init() (farebbe fetch/redirect)
let src = fs.readFileSync(APP, 'utf8').replace(/\ninit\(\);\s*$/, '\n');
src += '\n;window.__S = S;';  // S è const: non diventa proprietà del global
const vm = require('vm');
vm.createContext(window);
vm.runInContext(src, window, { filename: 'app.js' });

const S = window.__S;

const stroke = (tag) => ({ t:'pen', c:'#111', sz:3, pts:[{x:1,y:1,p:.5},{x:9,y:9,p:.5}], tag });

section('syncCurrentPage / goPage');
S.pages = [
  { strokes: [], textItems: [], images: [] },
  { strokes: [], textItems: [], images: [] },
  { strokes: [], textItems: [], images: [] },
];
S.curPage = 0;
S.strokes = [stroke('p0')]; S.textItems = [{ text:'testo0', x:1, y:1, size:18 }]; S.imgs = [];
window.goPage(1);
check('cambio pagina svuota il canvas di lavoro', S.strokes.length === 0, `${S.strokes.length} tratti`);
S.strokes = [stroke('p1a'), stroke('p1b')]; S.textItems = [{ text:'testo1', x:2, y:2, size:20 }];
window.goPage(2);
S.strokes = [stroke('p2')]; S.textItems = [];
window.goPage(0);
check('tornando a pagina 1 i tratti sono quelli giusti', S.strokes.length === 1 && S.strokes[0].tag === 'p0');
check('tornando a pagina 1 il testo è quello giusto', S.textItems[0]?.text === 'testo0');
window.goPage(1);
check('pagina 2 conserva 2 tratti', S.strokes.length === 2 && S.strokes[1].tag === 'p1b');
check('pagina 2 conserva il suo testo', S.textItems[0]?.text === 'testo1');
window.goPage(5);
check('goPage fuori range ignorato', S.curPage === 1, `curPage=${S.curPage}`);
window.goPage(-1);
check('goPage negativo ignorato', S.curPage === 1, `curPage=${S.curPage}`);

section('Export PDF (era sempre in errore)');
window.document.getElementById('NTT').value = 'Verbale riunione';
drawLog.length = 0; pdfOps.length = 0;
S.curPage = 1;
S.strokes = [stroke('p1a'), stroke('p1b')];
S.textItems = [{ text:'testo1', x:2, y:2, size:20 }];

let toastMsg = '';
window.toast = (m) => { toastMsg = m; };

window.exportPDF(false);
await new Promise(r => setTimeout(r, 250));

check('nessun errore di export', !/Errore/.test(toastMsg), `toast: "${toastMsg}"`);
check('PDF creato', pdfOps[0]?.op === 'new');
check('3 immagini = 3 pagine', pdfOps.filter(o => o.op === 'addImage').length === 3,
      `${pdfOps.filter(o => o.op === 'addImage').length} pagine`);
check('2 addPage (la prima è implicita)', pdfOps.filter(o => o.op === 'addPage').length === 2);
check('file salvato con nome dal titolo', pdfOps.find(o => o.op === 'save')?.name === 'Verbale_riunione.pdf',
      pdfOps.find(o => o.op === 'save')?.name);

// Il testo di OGNI pagina deve finire nel PDF, non solo quello della pagina corrente
const texts = drawLog.filter(d => d.op === 'fillText').map(d => d.args[0]);
check('testo pagina 1 nel PDF', texts.includes('testo0'), texts.join(','));
check('testo pagina 2 nel PDF', texts.includes('testo1'), texts.join(','));
check('non ripete lo stesso testo su tutte le pagine',
      texts.filter(t => t === 'testo1').length === 1, `"testo1" ×${texts.filter(t=>t==='testo1').length}`);

section('Export senza libreria PDF');
const savedLib = window.jspdf; window.jspdf = undefined; toastMsg = '';
window.exportPDF(false);
await new Promise(r => setTimeout(r, 50));
check('avvisa invece di lanciare eccezioni', /Libreria PDF/.test(toastMsg), toastMsg);
window.jspdf = savedLib;

done();
})();
