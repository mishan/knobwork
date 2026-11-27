'use strict';

// Generic invariant checks (DESIGN.md, "Property checks"). Seeded so any
// failure can be replayed: PROP_SEED=<seed> PROP_RUNS=<n>.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

const { transformCss } = require('../lib/css');
const { makeRoot, freeGuestPair, waitFor, startOn, rawHttp, rawGetRequest } = require('./helpers');

const SEED = Number(process.env.PROP_SEED || Date.now() % 2147483647);
const RUNS = Number(process.env.PROP_RUNS || 300);
test.before(() => process.stdout.write(`# property seed ${SEED}, runs ${RUNS}\n`));

// Park-Miller generator: small, deterministic, good enough for test input.
function rng(seed) {
  let s = seed % 2147483647 || 1;
  const next = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return {
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
    bytes: (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(next() * 256))),
  };
}

const rawRequest = (port, rawPath) => rawHttp(port, rawGetRequest(rawPath));

// ------------------------------------------------------------------ P1
test('P1: no request path serves a file outside the GUI tree', async (t) => {
  const { root, gui, base } = makeRoot();
  const SECRET = 'outside-secret-7f3a\n';
  fs.writeFileSync(path.join(base, 'secret.txt'), SECRET);
  fs.symlinkSync(path.join(base, 'secret.txt'), path.join(gui, 'escape.txt'));
  fs.symlinkSync(base, path.join(gui, 'escapedir'));
  fs.symlinkSync(path.join(gui, 'a.js'), path.join(gui, 'inside.js'));
  fs.symlinkSync(path.join(gui, 'css'), path.join(gui, 'cssdir'));
  const guiReal = fs.realpathSync(gui);
  // Every body a 200 may legitimately carry: each regular file inside the
  // GUI tree, raw or CSS-translated, plus the empty optional resources.
  const legitimate = new Set(['']);
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        const text = fs.readFileSync(p, 'latin1');
        legitimate.add(text);
        legitimate.add(transformCss(text).css);
      }
    }
  };
  walk(guiReal);
  const { harness, config } = await startOn({ ROOTFS_PATH: root });
  t.after(() => harness.stop());

  const segments = ['..', '.', '', '%2e%2e', '%2E%2e', '.%2e', '%2e.', '%252e%252e', '..%2f', '%2f', '%5c', '..%5c',
    '%00', 'a.js', 'css', 'x.css', 'escape.txt', 'escapedir', 'secret.txt', 'inside.js', 'cssdir', '%2fetc', 'etc', 'passwd',
    '..;', '...', '%c0%ae%c0%ae', '%%32%65'];
  const r = rng(SEED);
  let served = 0;
  // Known-servable paths first, so every run exercises the serving path.
  const fixed = ['/a.js', '/css/x.css', '/inside.js', '/cssdir/x.css', '/css/../a.js'];
  for (let i = 0; i < RUNS + fixed.length; i++) {
    const n = 1 + r.int(6);
    const raw = i < fixed.length ? fixed[i]
      : '/' + Array.from({ length: n }, () => r.pick(segments)).join(r.pick(['/', '/', '//']));
    const res = await rawRequest(config.ports.http, raw);
    assert.ok(!res.body.includes('outside-secret-7f3a'), `seed ${SEED} case ${i}: ${raw} leaked the secret`);
    if (res.status === 200 && !res.body.includes('__mazdaEmulatorConfig')) {
      assert.ok(legitimate.has(res.body), `seed ${SEED} case ${i}: ${raw} served a body that is no GUI file`);
      if (res.body !== '') served++;
    }
  }
  // Guard against a run that never exercised the serving path.
  assert.ok(served > 0, `seed ${SEED}: no generated path was served at all`);
});

// ------------------------------------------------------------------ P2
test('P2: CSS translation changes only recognized -o- tokens', () => {
  const r = rng(SEED + 1);
  const plain = ['.a', '#b', ' ', '{', '}', ';', ':', ',', '\n', 'color', 'red', '1s', '0 0', '(', ')', 'top', '10px',
    '-webkit-transform', 'x-o-transform', '-o-object-fit', '-o-transformer', '-o-', '-o-transform-like', '@media', 'rotate(1deg)'];
  const translatable = ['-o-transform', '-o-transition', '-o-animation', '-o-user-select', '-o-text-overflow',
    '-o-transform-origin', '-o-transition-duration', '-o-animation-name', '-o-linear-gradient(', '@-o-keyframes',
    '-o-linear-gradient(top, ', '-o-linear-gradient( top left ,', '-o-linear-gradient(30deg,', '-o-linear-gradient(#000,'];
  const protectedFragments = ['"-o-transform: x"', "'@-o-keyframes'", '/* -o-transition: 1s */', 'url(-o-animation.png)',
    '"a\\"-o-transform"', '/* @-o-keyframes x { } */'];
  let totalChanges = 0;
  for (let i = 0; i < RUNS; i++) {
    const parts = [];
    const guarded = [];
    const n = 1 + r.int(25);
    for (let j = 0; j < n; j++) {
      const kind = r.int(3);
      if (kind === 0) parts.push(r.pick(plain));
      else if (kind === 1) parts.push(' ' + r.pick(translatable));
      else { const f = r.pick(protectedFragments); parts.push(' ' + f + ' '); guarded.push(f); }
    }
    const input = parts.join('');
    const { css: out, changes } = transformCss(input);
    const where = `seed ${SEED + 1} case ${i}: ${JSON.stringify(input)}`;
    assert.equal(transformCss(out).css, out, `(a) idempotent, ${where}`);
    // Only -o- prefixes and a gradient's first (direction) argument may change.
    const strip = (s) => s.replace(/-o-/gi, '').replace(/linear-gradient\([^,()]*,/gi, 'linear-gradient(,');
    assert.equal(strip(out), strip(input), `(b) only -o- and gradient directions changed, ${where}`);
    const count = (s) => (s.match(/-o-/gi) || []).length;
    assert.equal(count(input) - count(out), changes, `(c) changes counted, ${where}`);
    let cursor = 0;
    for (const f of guarded) {
      const at = out.indexOf(f, cursor);
      assert.ok(at >= 0, `(d) protected fragment ${f} kept, ${where}`);
      cursor = at + f.length;
    }
    totalChanges += changes;
  }
  assert.ok(totalChanges > 0, 'the run translated something');
});

// ------------------------------------------------------------------ P3, P4, P6
function wsClient(port, protocol) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, protocol, { skipUTF8Validation: true, maxPayload: 1 << 24 });
    ws.got = [];
    ws.on('message', (d, isBinary) => ws.got.push([Buffer.from(d), isBinary]));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function guestServer(port, protocol) {
  const server = http.createServer();
  const wss = new WebSocket.Server({ server, skipUTF8Validation: true, maxPayload: 1 << 24, handleProtocols: () => protocol });
  wss.got = [];
  wss.on('connection', (ws) => ws.on('message', (d, isBinary) => wss.got.push([Buffer.from(d), isBinary])));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  wss.shutdown = () => { for (const c of wss.clients) c.terminate(); server.close(); };
  return wss;
}

function randomFrame(r) {
  const size = r.pick([0, 1, 2, 7, 125, 126, 127, 65535, 65536, r.int(4096), r.int(65537)]);
  return [r.bytes(size), r.int(2) === 1];
}

test('P3/P4/P6: proxy frames are byte-exact, never synthesized, and diagnostics stay bounded', async (t) => {
  const { root } = makeRoot();
  const dbapiFront = await freeGuestPair();
  let appsdkFront;
  do { appsdkFront = await freeGuestPair(); } while (appsdkFront === dbapiFront);
  const { harness, config } = await startOn({
    ROOTFS_PATH: root, PROXY_MODE: 'true', DBAPI_PORT: String(dbapiFront), APPSDK_PORT: String(appsdkFront),
  });
  const guests = {
    dbapi: await guestServer(dbapiFront + 10000, 'ihu-dbapi-protocol'),
    appsdk: await guestServer(appsdkFront + 10000, 'ihu-appsdk-protocol'),
  };
  t.after(async () => { await harness.stop(); for (const g of Object.values(guests)) g.shutdown(); });

  const r = rng(SEED + 2);
  const frames = Math.max(50, Math.floor(RUNS / 2));
  for (const [key, protocol, port] of [['dbapi', 'ihu-dbapi-protocol', dbapiFront], ['appsdk', 'ihu-appsdk-protocol', appsdkFront]]) {
    const front = await wsClient(port, protocol);
    await waitFor(() => guests[key].clients.size === 1);
    const guestSide = [...guests[key].clients][0];
    const up = Array.from({ length: frames }, () => randomFrame(r));
    const down = Array.from({ length: frames }, () => randomFrame(r));
    for (const [b, isBinary] of up) front.send(b, { binary: isBinary });
    for (const [b, isBinary] of down) guestSide.send(b, { binary: isBinary });
    await waitFor(() => guests[key].got.length === frames && front.got.length === frames, 20000);
    const same = (a, b, label) => {
      assert.equal(a.length, b.length, `${label}: frame count`);
      a.forEach(([buf, isBinary], i) => {
        assert.equal(b[i][1], isBinary, `seed ${SEED + 2} ${label} frame ${i}: type`);
        assert.ok(buf.equals(b[i][0]), `seed ${SEED + 2} ${label} frame ${i}: bytes (${buf.length})`);
      });
    };
    same(up, guests[key].got, `${key} frontend-to-guest`);
    same(down, front.got, `${key} guest-to-frontend (P4: nothing else reached the frontend)`);
    front.close();
  }

  // P6: plus a burst of HTTP misses, then the health response stays bounded.
  for (let i = 0; i < 200; i++) await rawRequest(config.ports.http, `/missing/${i}/${'x'.repeat(200)}`);
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${config.ports.http}/__emu/health`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
  assert.ok(body.length < 1024 * 1024, `health is ${body.length} bytes`);
  const parsed = JSON.parse(body.toString('utf8'));
  for (const b of Object.values(parsed.proxy.backends)) {
    assert.ok(b.recentMessages.length <= 50);
    assert.ok(b.controlMessages.length <= 2200);
    for (const m of b.recentMessages) assert.ok(!m.preview || m.preview.length <= 160);
  }
});
