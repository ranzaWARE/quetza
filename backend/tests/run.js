#!/usr/bin/env node
// Esegue tutte le suite Node in sequenza. `npm test` dalla cartella backend.
const { spawnSync } = require('child_process');
const path = require('path');

const suites = ['db.test.js', 'server.test.js', 'app.test.js'];
let failed = [];

for (const s of suites) {
  console.log(`\n${'═'.repeat(46)}\n  ${s}\n${'═'.repeat(46)}`);
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(s);
}

console.log(`\n${'═'.repeat(46)}`);
if (failed.length) { console.log(`✗ suite fallite: ${failed.join(', ')}\n`); process.exit(1); }
console.log('✓ tutte le suite passate\n');
