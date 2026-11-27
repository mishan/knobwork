#!/usr/bin/env node
'use strict';

// Run the whole suite several times at once. Races that never show in a
// single run (timer ordering, port reuse, reads before writes settle) have
// shown up only under this kind of load.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const runs = Number(process.env.STRESS_RUNS || 6);
const testDir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).map((f) => path.join(testDir, f));

const results = Array.from({ length: runs }, (_, i) => new Promise((resolve) => {
  let output = '';
  const child = spawn(process.execPath, ['--test', ...files], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.on('close', (code) => {
    const failed = output.split('\n').filter((l) => new RegExp(`^${String.fromCharCode(0x2716)} (?!failing tests)`).test(l));
    process.stdout.write(`run ${i + 1}: ${code === 0 ? 'pass' : `FAIL ${[...new Set(failed)].join('; ')}`}\n`);
    resolve(code === 0);
  });
}));

Promise.all(results).then((ok) => process.exit(ok.every(Boolean) ? 0 : 1));
