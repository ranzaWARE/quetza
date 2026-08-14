// Carica i moduli nativi se disponibili, altrimenti ricade sugli shim in
// tests/shims. Serve a far girare i test anche dove better-sqlite3 non compila.
const Module = require('module');
const path   = require('path');
const orig   = Module._load;

const FALLBACKS = {
  'better-sqlite3':  path.join(__dirname, 'shims', 'better-sqlite3'),
  'connect-sqlite3': path.join(__dirname, 'shims', 'connect-sqlite3'),
};

Module._load = function (request, parent, isMain) {
  if (FALLBACKS[request]) {
    try { return orig.call(this, request, parent, isMain); }
    catch { return orig.call(this, FALLBACKS[request], parent, isMain); }
  }
  return orig.call(this, request, parent, isMain);
};

// Piccolo helper di asserzione condiviso dalle suite
const state = { fails: 0, total: 0 };
function check(name, cond, extra = '') {
  state.total++;
  if (!cond) state.fails++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ' → ' + extra : ''}`);
}
function section(title) { console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 40 - title.length))}`); }
function done() {
  console.log(`\n${state.fails === 0
    ? `✓ ${state.total} test passati`
    : `✗ ${state.fails} test falliti su ${state.total}`}\n`);
  process.exit(state.fails === 0 ? 0 : 1);
}
module.exports = { check, section, done, state };
