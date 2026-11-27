#!/usr/bin/env node
'use strict';

// Repository checks that tests cannot make: harness source stays plain ASCII
// (editing tools have turned escape sequences into the literal characters), and
// every test file runs under mutation testing.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const problems = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const sources = ['lib', 'test', 'public', 'tools', 'scenarios'].flatMap((d) => walk(path.join(ROOT, d)))
  .concat([path.join(ROOT, 'main.js'), path.join(ROOT, 'stryker.config.mjs')]);
for (const file of sources) {
  fs.readFileSync(file).toString('latin1').split('\n').forEach((line, i) => {
    if (/[^\x00-\x7f]/.test(line)) problems.push(`${path.relative(ROOT, file)}:${i + 1}: non-ASCII byte`);
  });
}

const stryker = fs.readFileSync(path.join(ROOT, 'stryker.config.mjs'), 'utf8');
for (const file of fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js'))) {
  if (!stryker.includes(`/${file}`)) problems.push(`test/${file}: not run by any Stryker group`);
}

for (const p of problems) process.stderr.write(`${p}\n`);
process.exit(problems.length ? 1 : 0);
