'use strict';

// Synthetic fixtures only: tiny invented GUI trees in temporary directories.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

function makeTemp(prefix = 'ui-harness-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Minimal synthetic root: jci/gui/index.html plus a few invented resources.
function makeRoot(base = makeTemp(), name = 'root') {
  const root = path.join(base, name);
  const gui = path.join(root, 'jci', 'gui');
  fs.mkdirSync(path.join(gui, 'css'), { recursive: true });
  fs.mkdirSync(path.join(gui, 'apps', 'system', 'js'), { recursive: true });
  fs.writeFileSync(path.join(gui, 'index.html'),
    '<!DOCTYPE html>\n<html>\n<head>\n<title>synthetic</title>\n<script src="a.js"></script>\n</head>\n<body></body>\n</html>\n');
  fs.writeFileSync(path.join(gui, 'a.js'), 'var synthetic = 1;\n');
  fs.writeFileSync(path.join(gui, 'css', 'x.css'), '.a { -o-transform: none; content: "-o-transform"; }\n');
  fs.writeFileSync(path.join(gui, 'apps', 'system', 'js', 'developerdiagnosticsApp.js'), 'var dd = 1;\n');
  fs.writeFileSync(path.join(gui, 'apps', 'system', 'js', 'other.js'), 'var other = 1;\n');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'outside\n');
  return { base, root, gui };
}

function makeOverlayWorkspace(meta = { kind: 'mazda-cmu-overlay-workspace', format: 2, overlay_id: 'synthetic-overlay' }) {
  const base = makeTemp('ui-harness-ws-');
  const { root, gui } = makeRoot(base, 'root');
  fs.writeFileSync(path.join(base, '.overlay-workspace.json'), JSON.stringify(meta));
  fs.mkdirSync(path.join(base, 'data', 'integration'), { recursive: true });
  fs.mkdirSync(path.join(base, 'data', 'cmu-overlay'), { recursive: true });
  fs.mkdirSync(path.join(base, 'emulated'), { recursive: true });
  return { base, root, gui };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A free port P such that P + 10000 is also free and within range.
async function freeGuestPair() {
  for (let i = 0; i < 50; i++) {
    const front = 20000 + Math.floor(Math.random() * 30000);
    const ok = await Promise.all([front, front + 10000].map((p) => new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    })));
    if (ok.every(Boolean)) return front;
  }
  throw new Error('no free port pair');
}

async function waitFor(predicate, timeoutMs = 3000, interval = 10) {
  const start = Date.now();
  for (;;) {
    let value;
    try { value = await predicate(); } catch (_) { value = false; }
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, interval));
  }
}

function sendControl(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end(text));
    socket.on('close', resolve);
    socket.on('error', reject);
  });
}

function snapshotTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      out.push([path.relative(dir, p), st.size, st.mtimeMs, st.mode].join(' '));
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.join('\n');
}

// One raw HTTP exchange on its own connection, for requests a client library
// would normalize. Decodes chunked bodies, which every harness response may use.
function rawHttp(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('latin1');
      const split = text.indexOf('\r\n\r\n');
      const head = split === -1 ? text : text.slice(0, split);
      let body = split === -1 ? '' : text.slice(split + 4);
      if (/^transfer-encoding: chunked$/im.test(head)) {
        let out = '';
        for (;;) {
          const eol = body.indexOf('\r\n');
          const size = parseInt(body.slice(0, eol), 16);
          if (!size) break;
          out += body.slice(eol + 2, eol + 2 + size);
          body = body.slice(eol + 2 + size + 2);
        }
        body = out;
      }
      resolve({ status: Number(text.split(' ')[1]), head, body });
    });
    socket.on('error', reject);
  });
}

const rawGetRequest = (rawPath) => `GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`;

// A port found free can be taken by another process before the harness binds
// it, so retry startup with fresh ports when that happens.
async function retryOnAddrInUse(start, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await start();
    } catch (error) {
      if (i >= attempts || !/EADDRINUSE/.test(error.message)) throw error;
    }
  }
}

// Start a harness on free ports; `env` may pin any of them.
function startOn(env) {
  return retryOnAddrInUse(() => startOnce(env));
}

async function startOnce(env) {
  const { loadConfig } = require('../lib/config');
  const { Harness } = require('../lib/harness');
  const ports = new Set();
  while (ports.size < 5) ports.add(await freePort());
  const [httpPort, mmui, dbapi, appsdk, control] = [...ports];
  const config = loadConfig(Object.assign({
    HTTP_PORT: String(httpPort), MMUI_PORT: String(mmui), DBAPI_PORT: String(dbapi),
    APPSDK_PORT: String(appsdk), DISPLAY_CONTROL_PORT: String(control),
  }, env));
  const harness = new Harness(config, { log: () => {} });
  await harness.start();
  return { harness, config };
}

module.exports = {
  makeTemp, makeRoot, makeOverlayWorkspace, freePort, freeGuestPair, waitFor, sendControl, snapshotTree, startOn, retryOnAddrInUse, rawHttp, rawGetRequest,
};
