'use strict';

// Invariant: no peer can crash the process or deny service to other clients.
// Every socket type gets garbage, protocol violations, and abrupt resets; a
// client connected beforehand must keep working and health must answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');

const { makeRoot, freePort, freeGuestPair, waitFor, sendControl, startOn } = require('./helpers');

const SERVICES = [['mmui', 'ihu-guiifm-protocol'], ['dbapi', 'ihu-dbapi-protocol'], ['appsdk', 'ihu-appsdk-protocol']];
// A masked client frame with a reserved opcode: a protocol violation.
const INVALID_CLIENT_FRAME = Buffer.from([0x83, 0x80, 0, 0, 0, 0]);
// An unmasked server frame with a reserved opcode.
const INVALID_SERVER_FRAME = Buffer.from([0x83, 0x00]);

function client(port, protocol) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, protocol, { skipUTF8Validation: true });
    ws.got = [];
    ws.on('message', (d, isBinary) => ws.got.push([Buffer.from(d), isBinary]));
    ws.on('error', () => {});
    ws.once('open', () => resolve(ws));
    // With this listener registered, ws leaves aborting the request to us.
    ws.once('unexpected-response', (req, res) => {
      req.destroy();
      reject(new Error(`handshake refused: ${res.statusCode}`));
    });
  });
}

function rawTcp(port, bytes, { reset = false, resetAfterMs = 0 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      if (bytes) s.write(bytes);
      if (reset) setTimeout(() => s.resetAndDestroy(), resetAfterMs);
      else s.end();
    });
    s.on('error', () => {});
    s.on('close', resolve);
    s.resume();
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function abuseWebSocketPort(port, protocol) {
  await rawTcp(port, Buffer.from('\x00\xff garbage \r\n\r\n'));
  await rawTcp(port, 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  await rawTcp(port, null, { reset: true });
  for (const action of ['invalid-frame', 'reset', 'payloads']) {
    let ws;
    try { ws = await client(port, protocol); } catch (_) { continue; }
    if (action === 'invalid-frame') ws._socket.write(INVALID_CLIENT_FRAME);
    // Reset only a connection that is still open: resetting a socket that ws
    // has already begun closing (a replaced MMUI client) leaves the test's own
    // handle registered and keeps the test process alive.
    if (action === 'reset') {
      if (ws.readyState === WebSocket.OPEN) ws._socket.resetAndDestroy();
      else ws._socket.destroy();
    }
    if (action === 'payloads') {
      ws.send('not json {');
      ws.send(Buffer.from([0xff, 0x00]), { binary: true });
      ws.send('{"msgType":"event"}\u00ff');
    }
    await pause(50);
    ws.terminate();
  }
}

async function abuseHttp(port) {
  await rawTcp(port, 'NOT HTTP AT ALL\r\n\r\n');
  await rawTcp(port, 'GET /%zz%00 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  await rawTcp(port, 'GET / HTTP/1.1\r\n', { reset: true });
}

function healthOk(port) {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/__emu/health`, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    }).on('error', () => resolve(false));
  });
}

test('abuse: mock frontends and HTTP survive hostile peers', async (t) => {
  const { root } = makeRoot();
  const { harness, config } = await startOn({ ROOTFS_PATH: root });
  t.after(() => harness.stop());
  const observer = await client(config.ports.mmui, 'ihu-guiifm-protocol');

  for (const [key, protocol] of SERVICES) await abuseWebSocketPort(config.ports[key], protocol);
  await abuseHttp(config.ports.http);

  assert.ok(await healthOk(config.ports.http));
  observer.send('{"msgType":"event","eventId":"Global.InitGui","uiaId":"common"}');
  await waitFor(() => observer.got.some(([d]) => /"ctxtId":"HomeScreen"/.test(d.toString('latin1'))));
});

test('abuse: proxy frontends, guests, and the control channel survive hostile peers', async (t) => {
  const { root } = makeRoot();
  const fronts = {};
  for (const [key] of SERVICES) {
    let p;
    do { p = await freeGuestPair(); } while (Object.values(fronts).includes(p));
    fronts[key] = p;
  }
  const { harness, config } = await startOn({
    ROOTFS_PATH: root, PROXY_MODE: 'true',
    MMUI_PORT: String(fronts.mmui), DBAPI_PORT: String(fronts.dbapi), APPSDK_PORT: String(fronts.appsdk),
  });
  // Each guest misbehaves on every connection after the first.
  const guests = {};
  for (const [key, protocol] of SERVICES) {
    const wss = new WebSocket.Server({ port: fronts[key] + 10000, host: '127.0.0.1', skipUTF8Validation: true, handleProtocols: () => protocol });
    wss.got = [];
    let n = 0;
    wss.on('connection', (ws) => {
      ws.on('error', () => {});
      ws.on('message', (d) => wss.got.push(Buffer.from(d)));
      if (n++ === 0) return;
      ws.send('not json {');
      ws.send('{"msgType":"ctxtChg"}\u00ff');
      ws.send(Buffer.from([0xff]), { binary: true });
      setTimeout(() => ws._socket.write(INVALID_SERVER_FRAME), 20);
      setTimeout(() => ws._socket.destroy(), 40);
    });
    await new Promise((r) => wss.once('listening', r));
    guests[key] = wss;
  }
  t.after(async () => {
    await harness.stop();
    for (const g of Object.values(guests)) { for (const c of g.clients) c.terminate(); g.close(); }
  });

  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  // Observers: the first connection to each guest behaves.
  const observers = {};
  for (const [key, protocol] of SERVICES) {
    observers[key] = await client(config.ports[key], protocol);
    await waitFor(() => guests[key].clients.size === 1);
  }
  // The MMUI observer itself carries non-JSON text both ways (bridge parsing).
  observers.mmui.send('not json {');
  [...guests.mmui.clients][0].send('also not json');
  await waitFor(() => observers.mmui.got.length === 1);

  for (const [key, protocol] of SERVICES) await abuseWebSocketPort(config.ports[key], protocol);
  for (const [key, protocol] of SERVICES.slice(1)) {
    // Fresh frontends whose guest connections misbehave.
    const ws = await client(config.ports[key], protocol);
    await waitFor(() => ws.readyState !== WebSocket.OPEN, 3000).catch(() => {});
    ws.terminate();
  }
  await rawTcp(config.ports.displayControl, Buffer.alloc(4000, 0xff));
  // Reset while the harness is mid-read, so its socket sees ECONNRESET.
  await rawTcp(config.ports.displayControl, Buffer.from('splash'), { reset: true, resetAfterMs: 50 });
  await rawTcp(config.ports.displayControl, null, { reset: true });
  await abuseHttp(config.ports.http);

  assert.ok(await healthOk(config.ports.http));
  // A newer MMUI frontend replaces the observer by design, so for MMUI the
  // check is that a fresh frontend is still served: the guest's first frame
  // to it (junk text) arrives intact.
  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  const fresh = await client(config.ports.mmui, 'ihu-guiifm-protocol');
  await waitFor(() => fresh.got.some(([d]) => d.toString() === 'not json {'));
  fresh.terminate();
  for (const [key] of SERVICES.slice(1)) {
    const before = guests[key].got.length;
    observers[key].send(`{"still":"${key}"}`);
    await waitFor(() => guests[key].got.length > before);
    assert.equal(guests[key].got.at(-1).toString(), `{"still":"${key}"}`);
  }
});

function resourceCounts() {
  const counts = {};
  for (const type of process.getActiveResourcesInfo()) counts[type] = (counts[type] || 0) + 1;
  return counts;
}

// Invariant: once the test has closed its own sockets and stopped the harness,
// nothing the harness opened is still alive.
test('abuse: stop releases everything, even after a replaced MMUI client resets', async () => {
  const before = resourceCounts();
  const { root } = makeRoot();
  const mmuiFront = await freeGuestPair();
  const { harness, config } = await startOn({ ROOTFS_PATH: root, PROXY_MODE: 'true', MMUI_PORT: String(mmuiFront) });
  const guest = new WebSocket.Server({ port: mmuiFront + 10000, host: '127.0.0.1', handleProtocols: () => 'ihu-guiifm-protocol' });
  await new Promise((r) => guest.once('listening', r));
  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  const observer = await client(config.ports.mmui, 'ihu-guiifm-protocol');
  await waitFor(() => guest.clients.size === 1);
  const replacing = await client(config.ports.mmui, 'ihu-guiifm-protocol');
  await pause(50);
  replacing._socket.resetAndDestroy();
  replacing.terminate();
  observer.terminate();
  await harness.stop();
  for (const c of guest.clients) c.terminate();
  await new Promise((r) => guest.close(r));
  // Earlier tests may still be closing when `before` is taken, so the check is
  // that no resource type ends above its baseline, not exact equality.
  const extra = () => {
    const after = resourceCounts();
    return Object.keys(after).filter((k) => after[k] > (before[k] || 0)).map((k) => `${k} +${after[k] - (before[k] || 0)}`);
  };
  await waitFor(() => extra().length === 0, 3000).catch(() => {});
  assert.deepEqual(extra(), []);
});

// A refused upgrade affects only that client, whichever check refuses it.
// The harness runs as its own process here: the failure being guarded
// against is that process exiting, which an in-process test runner absorbs.
test('abuse: a client that resets after a refused upgrade does not crash the harness', async (t) => {
  const { root } = makeRoot();
  const ports = { HTTP_PORT: await freePort(), DBAPI_PORT: await freePort(), MMUI_PORT: await freePort(), APPSDK_PORT: await freePort() };
  const env = Object.assign({}, process.env, { ROOTFS_PATH: root }, Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, String(v)])));
  const child = require('child_process').spawn(process.execPath, [require('path').join(__dirname, '..', 'main.js')],
    { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let exited = null;
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (code) => { exited = code; });
  t.after(() => child.kill());
  await waitFor(() => healthOk(ports.HTTP_PORT), 5000);
  const upgrade = (host, extra) => `GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' + extra + 'Content-Length: 8388608\r\n\r\n';
  const ok = 'Sec-WebSocket-Protocol: ihu-dbapi-protocol\r\n';
  const refusals = {
    host: upgrade('evil.example', ok),
    origin: upgrade('127.0.0.1', ok + 'Origin: https://evil.example\r\n'),
    protocol: upgrade('127.0.0.1', ''),
    capacity: upgrade('127.0.0.1', ok),
  };
  const held = [];
  for (const [name, request] of Object.entries(refusals)) {
    if (name === 'capacity') {
      for (let i = 0; i < 32; i++) held.push(await client(ports.DBAPI_PORT, 'ihu-dbapi-protocol'));
    }
    for (let i = 0; i < 200 && exited === null; i++) {
      await new Promise((resolve) => {
        const s = net.connect(ports.DBAPI_PORT, '127.0.0.1', () => {
          s.write(request);
          s.write(Buffer.alloc(1024 * 1024, 120)); // a large pipelined body
          s.resetAndDestroy(); // before the harness has answered
        });
        s.on('error', () => {});
        s.on('close', resolve);
      });
    }
    assert.equal(exited, null, `harness exited after ${name} refusals: ${stderr.split('\n').find((l) => /Error/.test(l))}`);
    assert.ok(await healthOk(ports.HTTP_PORT), `harness answers after ${name} refusals`);
  }
  for (const ws of held) ws.terminate();
});
