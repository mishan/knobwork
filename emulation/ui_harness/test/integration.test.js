'use strict';

// End-to-end tests against synthetic GUI trees and fake guest services. No
// firmware content is used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

const { loadConfig } = require('../lib/config');
const { Harness } = require('../lib/harness');
const { makeRoot, makeOverlayWorkspace, freePort, freeGuestPair, waitFor, sendControl, snapshotTree, retryOnAddrInUse, rawHttp, rawGetRequest } = require('./helpers');

// P5: every tree a test hands to a harness is identical after the test.
const watchedTrees = [];
function watchTree(root) {
  const dir = path.dirname(root);
  watchedTrees.push([dir, snapshotTree(dir)]);
}
test.afterEach(() => {
  for (const [dir, before] of watchedTrees.splice(0)) assert.equal(snapshotTree(dir), before, `${dir} changed`);
});

const REPO = path.resolve(__dirname, '..', '..', '..');
const CAN_SAMPLE = path.join(REPO, 'emulation', 'fixtures', 'can', 'public-private-sample.jsonl');

async function ports(n) {
  const out = [];
  while (out.length < n) {
    const p = await freePort();
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function startHarness(env) {
  return retryOnAddrInUse(() => startHarnessOnce(env));
}

async function startHarnessOnce(env) {
  const [httpPort, mmui, dbapi, appsdk, control] = await ports(5);
  const config = loadConfig(Object.assign({
    HTTP_PORT: String(httpPort), MMUI_PORT: String(mmui), DBAPI_PORT: String(dbapi), APPSDK_PORT: String(appsdk),
    DISPLAY_CONTROL_PORT: String(control),
  }, env));
  watchTree(config.rootfs);
  const harness = new Harness(config, { log: () => {} });
  await harness.start();
  return { harness, config, url: `http://127.0.0.1:${httpPort}` };
}

function get(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const rawGet = async (port, rawPath) => (await rawHttp(port, rawGetRequest(rawPath))).status;

function json(res) { return JSON.parse(res.body); }

function connect(port, protocol) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, protocol, { skipUTF8Validation: true });
    ws.messages = [];
    ws.closeInfo = null;
    ws.on('message', (d, isBinary) => ws.messages.push({ data: Buffer.from(d), isBinary }));
    ws.on('close', (code, reason) => { ws.closeInfo = { code, reason: String(reason) }; });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// ------------------------------------------------------------------ HTTP
test('http: index injection, stock files, CSS, traversal, routes, and read-only root', async (t) => {
  const { root, gui, base } = makeRoot();
  fs.symlinkSync(path.join(base, 'secret.txt'), path.join(gui, 'link.txt'));
  const before = snapshotTree(base);
  const { harness, url, config } = await startHarness({ ROOTFS_PATH: root });
  t.after(() => harness.stop());

  const index = await get(url + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['cache-control'], /no-store/);
  const headAt = index.body.indexOf('<head>') + 6;
  assert.ok(index.body.slice(headAt).startsWith('<script>window.__mazdaEmulatorConfig='));
  assert.ok(index.body.indexOf('/__emu/compat.js') < index.body.indexOf('a.js'));
  assert.match(index.body, /"backendMode":"mock"/);
  assert.equal((await get(url + '/index.html')).body, index.body);
  assert.ok(!fs.readFileSync(path.join(gui, 'index.html'), 'utf8').includes('__mazdaEmulator'));

  const compat = await get(url + '/__emu/compat.js');
  assert.equal(compat.status, 200);
  assert.match(compat.headers['content-type'], /javascript/);

  const js = await get(url + '/a.js');
  assert.equal(js.body, 'var synthetic = 1;\n');
  assert.match(js.headers['content-type'], /javascript/);

  const css = await get(url + '/css/x.css');
  assert.equal(css.body, '.a { transform: none; content: "-o-transform"; }\n');
  assert.match(css.headers['cache-control'], /no-store/);

  for (const p of ['/apps/audiosettings/css/audiosettingsApp.css', '/apps/tutorial/css/tutorialApp.css']) {
    const r = await get(url + p);
    assert.equal(r.status, 200);
    assert.equal(r.body, '');
    assert.match(r.headers['content-type'], /text\/css/);
  }
  assert.equal((await get(url + '/apps/other/css/missing.css')).status, 404);
  assert.equal((await get(url + '/missing.js')).status, 404);
  assert.equal((await get(url + '/css/')).status, 404, 'no directory listings');
  assert.equal((await get(url + '/css')).status, 404);
  assert.equal((await get(url + '/link.txt')).status, 404, 'symlink escape');
  for (const raw of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/css/..%5c..%5csecret.txt', '/%00']) {
    assert.equal(await rawGet(config.ports.http, raw), 404, raw);
  }
  const fav = await get(url + '/favicon.ico');
  assert.equal(fav.status, 200);
  assert.equal(fav.body, '');
  const unknown = await get(url + '/__emu/nope');
  assert.equal(unknown.status, 404);
  assert.equal(json(unknown).ok, false);
  const integ = await get(url + '/data/integration/developer_mode_GuiConfig.js');
  assert.equal(integ.status, 200);
  assert.equal(integ.body, '');
  assert.equal((await get(url + '/a.js', 'POST')).status, 405);
  assert.equal((await get(url + '/apps/system/js/developerdiagnosticsApp.js')).status, 200, 'no fault unless enabled');

  const health = json(await get(url + '/__emu/health'));
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'mock');
  assert.equal(health.nativeProxyReady, false);
  assert.equal(health.rootfs, root);
  assert.equal(health.guiPath, gui);
  assert.equal(health.overlayWorkspace, false);
  assert.equal(health.proxy, null);
  assert.deepEqual(health.canReplay, { available: false, frameCount: 0, publicFrames: 0, privateFrames: 0, recentLimit: 200 });
  assert.equal(health.stats.httpCompatibility.optionalStylesheets['/apps/tutorial/css/tutorialApp.css'], 1);
  assert.deepEqual(health.stats.httpCompatibility.injectedFailures.overlayAppScript, { enabled: false, requests: 0 });
  assert.equal(json(await get(url + '/__emu/overlay')).available, false);
  assert.equal((await get(url + '/__emu/overlay')).status, 404);

  assert.equal(snapshotTree(base), before, 'root unchanged');
});

test('http: overlay workspace, integration override, app-script fault, and CAN replay', async (t) => {
  const ws = makeOverlayWorkspace();
  fs.writeFileSync(path.join(ws.base, 'data', 'integration', 'developer_mode_GuiConfig.js'), 'var overlay = true;\n');
  fs.writeFileSync(path.join(ws.base, 'data', 'cmu-overlay', 'state'), 'enabled\n');
  fs.symlinkSync('../data', path.join(ws.root, 'data'));
  const { harness, url } = await startHarness({
    ROOTFS_PATH: ws.root, EMU_FAIL_OVERLAY_APP_SCRIPT: 'true', CAN_REPLAY_PATH: CAN_SAMPLE,
  });
  t.after(() => harness.stop());

  assert.equal((await get(url + '/data/integration/developer_mode_GuiConfig.js')).body, 'var overlay = true;\n');
  assert.equal((await get(url + '/data/cmu-overlay/state')).status, 404, 'no arbitrary data paths');

  const fault = await get(url + '/apps/system/js/developerdiagnosticsApp.js');
  assert.equal(fault.status, 503);
  assert.match(fault.headers['content-type'], /text\/plain/);
  assert.match(fault.headers['cache-control'], /no-store/);
  assert.equal((await get(url + '/apps/system/js/other.js')).status, 200);
  assert.equal((await get(url + '/apps/system/js/developerdiagnosticsApp.js?x=1')).status, 503);

  const overlay = await get(url + '/__emu/overlay');
  assert.equal(overlay.status, 200);
  assert.deepEqual(json(overlay), {
    available: true, overlayId: 'synthetic-overlay', managerState: 'enabled', activeTransaction: 'none',
    bootAttempts: '0', mountState: 'unknown', watchdog: 'unknown', journal: [],
  });

  const can = json(await get(url + '/__emu/can'));
  assert.equal(can.available, true);
  assert.equal(can.mode, 'replay');
  assert.equal(can.schema, 'mazda-cmu-vim-can-v1');
  assert.equal(can.frameCount, 4);
  assert.equal(can.publicFrames, 2);
  assert.equal(can.privateFrames, 2);
  assert.equal(can.frames.length, 4);

  const health = json(await get(url + '/__emu/health'));
  assert.equal(health.overlayWorkspace, true);
  assert.equal(health.canReplay.frameCount, 4);
  assert.deepEqual(health.stats.httpCompatibility.injectedFailures.overlayAppScript, { enabled: true, requests: 2 });
});

test('http: integration override refuses a symlink', async (t) => {
  const ws = makeOverlayWorkspace();
  fs.writeFileSync(path.join(ws.base, 'elsewhere.js'), 'var leaked = 1;\n');
  fs.symlinkSync(path.join(ws.base, 'elsewhere.js'), path.join(ws.base, 'data', 'integration', 'developer_mode_GuiConfig.js'));
  const { harness, url } = await startHarness({ ROOTFS_PATH: ws.root });
  t.after(() => harness.stop());
  const r = await get(url + '/data/integration/developer_mode_GuiConfig.js');
  assert.equal(r.status, 200);
  assert.equal(r.body, '');
});

// ------------------------------------------------------------------ listeners
test('listeners: open transactionally and fail as a whole', async () => {
  const { root } = makeRoot();
  const blocker = net.createServer();
  const [httpPort, mmui, dbapi, appsdk] = await ports(4);
  await new Promise((r) => blocker.listen(appsdk, '127.0.0.1', r));
  const harness = new Harness(loadConfig({
    ROOTFS_PATH: root, HTTP_PORT: String(httpPort), MMUI_PORT: String(mmui), DBAPI_PORT: String(dbapi), APPSDK_PORT: String(appsdk),
  }), { log: () => {} });
  await assert.rejects(harness.start(), /failed to open listener/);
  // Earlier listeners were closed again.
  for (const p of [httpPort, mmui, dbapi]) {
    await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(p, '127.0.0.1', () => s.close(resolve));
    });
  }
  blocker.close();
});

// ------------------------------------------------------------------ mock WebSockets
test('mock: three sockets, subprotocols, startup, navigation, malformed input isolation', async (t) => {
  const { root } = makeRoot();
  const { harness, config, url } = await startHarness({ ROOTFS_PATH: root });
  t.after(() => harness.stop());
  const mmui = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  const dbapi = await connect(config.ports.dbapi, 'ihu-dbapi-protocol');
  const appsdk = await connect(config.ports.appsdk, 'ihu-appsdk-protocol');
  const other = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  assert.equal(mmui.protocol, 'ihu-guiifm-protocol');
  assert.equal(dbapi.protocol, 'ihu-dbapi-protocol');
  assert.equal(appsdk.protocol, 'ihu-appsdk-protocol');

  mmui.send('{"msgType":"event","eventId":"Global.InitGui","uiaId":"common"}');
  await waitFor(() => mmui.messages.some((m) => /"ctxtId":"HomeScreen"/.test(m.data.toString('utf8'))));

  other.send('{ this is not json');
  other.send(Buffer.from([1, 2, 3]));
  dbapi.send('{"msgType":"method","msgContent":{"api":"x","methodName":"y"}}');
  mmui.send('{"msgType":"event","eventId":"SelectApplications","uiaId":"system"}');
  await waitFor(() => mmui.messages.some((m) => /"ctxtId":"Applications"/.test(m.data.toString())));
  assert.equal(other.readyState, WebSocket.OPEN);
  assert.equal(other.messages.length, 0);

  const health = json(await get(url + '/__emu/health'));
  assert.equal(health.stats.mock.mmui.activeConnections, 2);
  assert.equal(health.stats.mock.mmui.invalid, 1);
  assert.equal(health.stats.mock.dbapi.accepted.length, 1);
  assert.equal(health.stats.mock.dbapi.unhandled.length, 1, 'missing DBAPI behavior is observable');
  for (const ws of [mmui, dbapi, appsdk, other]) ws.close();
});

// ------------------------------------------------------------------ proxy
async function fakeGuest(port, protocol, onConnection) {
  const server = http.createServer();
  const wss = new WebSocket.Server({ server, skipUTF8Validation: true, handleProtocols: (p) => {
    wss.offered.push([...p]);
    return p.has(protocol) ? protocol : false;
  } });
  wss.offered = [];
  wss.received = [];
  // Stops accepting new connections while existing ones stay open.
  wss.stopListening = () => server.close();
  wss.on('connection', (ws) => {
    ws.on('message', (d, isBinary) => wss.received.push({ data: Buffer.from(d), isBinary }));
    if (onConnection) onConnection(ws);
  });
  const close = wss.close.bind(wss);
  wss.close = () => { for (const c of wss.clients) c.terminate(); close(); server.close(); };
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return wss;
}

function startProxy(extraEnv = {}) {
  return retryOnAddrInUse(() => startProxyOnce(extraEnv));
}

async function startProxyOnce(extraEnv) {
  const { root } = makeRoot();
  const mmui = await freeGuestPair();
  let dbapi;
  let appsdk;
  do { dbapi = await freeGuestPair(); } while (dbapi === mmui);
  do { appsdk = await freeGuestPair(); } while (appsdk === mmui || appsdk === dbapi);
  const [httpPort, control] = await ports(2);
  const config = loadConfig(Object.assign({
    ROOTFS_PATH: root, PROXY_MODE: 'true', HTTP_PORT: String(httpPort), MMUI_PORT: String(mmui),
    DBAPI_PORT: String(dbapi), APPSDK_PORT: String(appsdk), DISPLAY_CONTROL_PORT: String(control),
  }, extraEnv));
  watchTree(config.rootfs);
  const harness = new Harness(config, { log: () => {} });
  await harness.start();
  return { harness, config, url: `http://127.0.0.1:${httpPort}` };
}

test('proxy: bytes and frame types preserved, MMUI gated on readiness, lifecycle bridged', async (t) => {
  const { harness, config, url } = await startProxy({ EMU_MMUI_READINESS_HOLD_MS: '200' });
  const guests = {};
  guests.mmui = await fakeGuest(config.ports.mmui + 10000, 'ihu-guiifm-protocol');
  guests.dbapi = await fakeGuest(config.ports.dbapi + 10000, 'ihu-dbapi-protocol');
  guests.appsdk = await fakeGuest(config.ports.appsdk + 10000, 'ihu-appsdk-protocol');
  t.after(async () => { await harness.stop(); for (const g of Object.values(guests)) g.close(); });

  const index = await get(url + '/');
  assert.match(index.body, /"backendMode":"proxy"/);

  const mmui = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  const dbapi = await connect(config.ports.dbapi, 'ihu-dbapi-protocol');
  const appsdk = await connect(config.ports.appsdk, 'ihu-appsdk-protocol');

  // Early MMUI traffic queues until mmui-ready + hold.
  mmui.send('{"msgType":"event","eventId":"Early","uiaId":"common"}');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(guests.mmui.clients.size, 0, 'no guest MMUI connection before readiness');
  let health = json(await get(url + '/__emu/health'));
  assert.equal(health.proxy.mmuiReadiness.ready, false);
  assert.equal(health.proxy.mmuiReadiness.queuedFrontendMessages, 1);
  assert.equal(health.proxy.backends.guiifm.queueDepth, 1);
  assert.deepEqual(Object.keys(health.proxy.backends).sort(), ['appsdk', 'dbapi', 'guiifm']);
  assert.equal(health.proxy.mockFallbackMessages, 0);
  assert.equal(health.stats.mock, null);

  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(guests.mmui.received.length, 0, 'hold delays release after the marker');
  await waitFor(() => guests.mmui.received.length === 1);
  assert.equal(guests.mmui.received[0].data.toString(), '{"msgType":"event","eventId":"Early","uiaId":"common"}');

  for (const [key, protocol] of [['mmui', 'ihu-guiifm-protocol'], ['dbapi', 'ihu-dbapi-protocol'], ['appsdk', 'ihu-appsdk-protocol']]) {
    assert.deepEqual(guests[key].offered, [[protocol]], `${key} guest is offered the frontend subprotocol`);
  }

  // Exact bytes, both directions, text vs binary.
  const guestMmui = [...guests.mmui.clients][0];
  const textWithSeq = Buffer.concat([Buffer.from('{"msgType":"ctxtChg","uiaId":"system","ctxtId":"IntroAnimation"}'), Buffer.from([0xfe])]);
  guestMmui.send(textWithSeq, { binary: false });
  guestMmui.send(Buffer.from([0, 1, 2, 0xff]), { binary: true });
  await waitFor(() => mmui.messages.length === 2);
  assert.deepEqual(mmui.messages[0].data, textWithSeq);
  assert.equal(mmui.messages[0].isBinary, false);
  assert.deepEqual(mmui.messages[1].data, Buffer.from([0, 1, 2, 0xff]));
  assert.equal(mmui.messages[1].isBinary, true);
  dbapi.send(Buffer.from([9, 8, 7]), { binary: true });
  await waitFor(() => guests.dbapi.received.length === 1);
  assert.equal(guests.dbapi.received[0].isBinary, true);
  appsdk.send('{"msgType":"method"}');
  await waitFor(() => guests.appsdk.received.length === 1);
  assert.equal(guests.appsdk.received[0].isBinary, false);

  // Lifecycle: InitializeGuiComplete -> StartIntroAnimation.
  mmui.send('{"msgType":"event","eventId":"InitializeGuiComplete","uiaId":"system"}');
  await waitFor(() => guests.mmui.received.some((m) => /StartIntroAnimation/.test(m.data)));
  // Unsupported notification is an error, not an event.
  await sendControl(config.ports.displayControl, 'surprise\n');
  // Splash completion twice: Finish + ShowDisclaimer exactly once.
  await sendControl(config.ports.displayControl, 'splash-complete surface=TRANLOGO_SURFACE\n');
  await sendControl(config.ports.displayControl, 'splash-complete surface=TRANLOGO_SURFACE\n');
  await waitFor(() => guests.mmui.received.some((m) => /ShowDisclaimer/.test(m.data)));
  guestMmui.send('{"msgType":"ctxtChg","uiaId":"system","ctxtId":"Disclaimer"}\u0002');
  mmui.send('{"msgType":"event","eventId":"DisposeIntroVideo","uiaId":"system"}');
  mmui.send('{"msgType":"event","eventId":"Timeout","uiaId":"system"}');
  guestMmui.send('{"msgType":"ctxtChg","uiaId":"system","ctxtId":"HomeScreen"}\u0003');
  mmui.send('{"msgType":"event","eventId":"NotifyDisclaimerEnd","uiaId":"system"}');
  await waitFor(() => guests.mmui.received.some((m) => /NotifyDisclaimerEnd/.test(m.data)));
  await waitFor(() => mmui.messages.length === 4);

  const synthetic = guests.mmui.received.map((m) => JSON.parse(m.data.toString())).map((m) => m.eventId);
  for (const m of guests.mmui.received.map((r) => r.data.toString())) {
    const o = JSON.parse(m); // also proves there is no sequence suffix
    if (['StartIntroAnimation', 'FinishIntroAnimation', 'ShowDisclaimer'].includes(o.eventId)) {
      assert.equal(guests.mmui.received.find((r) => r.data.toString() === m).isBinary, false, `${o.eventId} is a text frame`);
      assert.deepEqual(o, { msgType: 'event', eventId: o.eventId, uiaId: 'system', params: '{}', fromVui: false,
        currentUiaId: 'system', currentContextId: 'IntroAnimation' });
    }
  }
  assert.deepEqual(synthetic, ['Early', 'InitializeGuiComplete', 'StartIntroAnimation', 'FinishIntroAnimation',
    'ShowDisclaimer', 'DisposeIntroVideo', 'Timeout', 'NotifyDisclaimerEnd']);
  assert.equal(guests.mmui.received.filter((m) => /Timeout/.test(m.data)).length, 1, 'Timeout forwarded, never generated');

  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  health = json(await get(url + '/__emu/health'));
  const nd = health.proxy.nativeDisplay;
  assert.equal(nd.startEvents, 1);
  assert.equal(nd.finishEvents, 1);
  assert.equal(nd.showDisclaimerEvents, 1);
  assert.equal(nd.frontendDisposeEvents, 1);
  assert.equal(nd.notifications, 3);
  assert.equal(nd.lastError, null, 'reset when the lifecycle completes');
  assert.equal(health.nativeProxyReady, true);
  const g = health.proxy.backends.guiifm;
  assert.equal(g.status, 'connected');
  assert.equal(g.activeConnections, 1);
  assert.equal(g.guestToFrontendMessages, 3);
  assert.equal(g.guestToFrontendBinaryMessages, 1);
  assert.equal(g.frontendToGuestMessages, 5);
  const dirs = g.controlMessages.map((m) => [m.direction, m.summary && (m.summary.eventId || m.summary.ctxtId)]);
  assert.deepEqual(dirs.filter(([d]) => d === 'native-display-to-guest').map(([, e]) => e),
    ['StartIntroAnimation', 'FinishIntroAnimation', 'ShowDisclaimer']);
  assert.ok(dirs.some(([d, e]) => d === 'guest-to-frontend' && e === 'HomeScreen'));
  assert.ok(g.controlMessages.some((m) => m.binary && m.summary === null));
  assert.equal(health.proxy.mmuiReadiness.lastNotification, 'mmui-ready');
  assert.match(health.proxy.mmuiReadiness.lastNotificationAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(health.proxy.backends.dbapi.frontendToGuestBinaryMessages, 1);

  // Guest loss closes the frontend as unavailable and resets readiness.
  guestMmui.terminate();
  await waitFor(() => mmui.closeInfo);
  assert.equal(mmui.closeInfo.code, 1013);
  health = json(await get(url + '/__emu/health'));
  assert.equal(health.proxy.mmuiReadiness.ready, false);
  assert.equal(health.nativeProxyReady, false);
  dbapi.close();
  appsdk.close();
});

test('proxy: unavailable guest closes the frontend; queue overflow is bounded', async (t) => {
  const { harness, config, url } = await startProxy();
  t.after(() => harness.stop());
  // No DBAPI guest listening.
  const dbapi = await connect(config.ports.dbapi, 'ihu-dbapi-protocol');
  await waitFor(() => dbapi.closeInfo);
  assert.equal(dbapi.closeInfo.code, 1013);
  let health = json(await get(url + '/__emu/health'));
  assert.match(health.proxy.backends.dbapi.lastError, /guest/);

  // MMUI never becomes ready; 257th early frame overflows.
  const mmui = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  for (let i = 0; i < 257; i++) mmui.send(`{"n":${i}}`);
  await waitFor(() => mmui.closeInfo);
  assert.equal(mmui.closeInfo.code, 1008);
  health = json(await get(url + '/__emu/health'));
  assert.match(health.proxy.backends.guiifm.lastError, /overflow/);
  assert.equal(health.proxy.backends.guiifm.queueOverflows, 1);
  assert.equal(health.proxy.backends.guiifm.queueDepth, 0);
  assert.equal(health.proxy.mockFallbackMessages, 0);
});

test('proxy: display-control input is bounded per connection', async (t) => {
  const { harness, config, url } = await startProxy();
  t.after(() => harness.stop());
  await new Promise((resolve) => {
    const s = net.connect(config.ports.displayControl, '127.0.0.1', () => s.write('x'.repeat(2000)));
    s.on('close', resolve);
    s.on('error', resolve);
  });
  await sendControl(config.ports.displayControl, '   \n');
  const health = json(await get(url + '/__emu/health'));
  assert.equal(health.proxy.displayControl.oversized, 1);
  assert.equal(health.proxy.nativeDisplay.notifications, 0);
  assert.equal(health.proxy.mmuiReadiness.notifications, 0);
});

function connectRaw(port, protocols) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, protocols);
    ws.once('open', () => resolve({ opened: true, ws }));
    ws.once('unexpected-response', (req, res) => resolve({ opened: false, status: res.statusCode }));
    ws.once('error', () => resolve({ opened: false, status: null }));
  });
}

test('frontends: a handshake without the service subprotocol is refused', async (t) => {
  const { root } = makeRoot();
  const { harness, config, url } = await startHarness({ ROOTFS_PATH: root });
  t.after(() => harness.stop());
  const ok = await connectRaw(config.ports.dbapi, ['ihu-dbapi-protocol']);
  assert.equal(ok.opened, true);
  ok.ws.close();
  for (const protocols of [[], ['ihu-guiifm-protocol'], ['something-else']]) {
    const r = await connectRaw(config.ports.dbapi, protocols);
    assert.equal(r.opened, false, JSON.stringify(protocols));
    assert.equal(r.status, 400, JSON.stringify(protocols));
  }
  assert.equal(json(await get(url + '/__emu/health')).stats.clients.protocolMismatches, 3);
});

test('proxy: a newer MMUI frontend replaces the active one, as a reload does', async (t) => {
  const { harness, config, url } = await startProxy();
  const guest = await fakeGuest(config.ports.mmui + 10000, 'ihu-guiifm-protocol');
  t.after(async () => { await harness.stop(); guest.close(); });
  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  const first = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  await waitFor(() => guest.clients.size === 1);
  // The new tab arrives before the old one has closed.
  const second = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  await waitFor(() => first.closeInfo);
  assert.equal(first.closeInfo.code, 1001);
  second.send('{"msgType":"event","eventId":"Reloaded"}');
  await waitFor(() => guest.received.some((m) => /Reloaded/.test(m.data)));
  assert.equal(second.readyState, WebSocket.OPEN);
  await waitFor(() => guest.clients.size === 1);
  const health = json(await get(url + '/__emu/health'));
  assert.equal(health.proxy.mmuiReadiness.ready, true, 'replacing a frontend does not reset readiness');
  assert.equal(health.proxy.backends.guiifm.activeConnections, 1);
  second.close();
});

test('proxy: a frontend that leaves does not reset readiness; guest loss does', async (t) => {
  const { harness, config, url } = await startProxy();
  const guest = await fakeGuest(config.ports.mmui + 10000, 'ihu-guiifm-protocol');
  t.after(async () => { await harness.stop(); guest.close(); });
  const ready = async () => json(await get(url + '/__emu/health')).proxy.mmuiReadiness.ready;
  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  const first = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  await waitFor(() => guest.clients.size === 1);
  first.close();
  await waitFor(() => guest.clients.size === 0);
  assert.equal(await ready(), true, 'the harness closing its own guest connection is not a loss');
  const second = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  await waitFor(() => guest.clients.size === 1, 1000);
  [...guest.clients][0].terminate();
  await waitFor(() => second.closeInfo);
  assert.equal(await ready(), false, 'an unexpected guest loss resets readiness');
});

test('proxy: backend status reflects all of its connections', async (t) => {
  const { harness, config, url } = await startProxy();
  const guest = await fakeGuest(config.ports.dbapi + 10000, 'ihu-dbapi-protocol');
  t.after(async () => { await harness.stop(); guest.close(); });
  const status = async () => json(await get(url + '/__emu/health')).proxy.backends.dbapi;
  const a = await connect(config.ports.dbapi, 'ihu-dbapi-protocol');
  await waitFor(() => guest.clients.size === 1);
  assert.equal((await status()).status, 'connected');
  // Stop accepting new guest connections; the existing one stays up.
  guest.stopListening();
  const b = await connect(config.ports.dbapi, 'ihu-dbapi-protocol');
  await waitFor(() => b.closeInfo);
  assert.equal(a.readyState, WebSocket.OPEN);
  const s = await status();
  assert.equal(s.activeConnections, 1);
  assert.equal(s.status, 'connected', 'a failed second connection does not hide a working one');
  a.close();
  await waitFor(async () => (await status()).activeConnections === 0);
});

test('proxy: a frontend that leaves before release or handshake leaves nothing behind', async (t) => {
  const { harness, config, url } = await startProxy();
  // A guest that accepts TCP but never completes the WebSocket handshake.
  const stalledSockets = [];
  const stalled = net.createServer((socket) => {
    socket.resume(); // a paused socket never reports its peer closing
    socket.closedByPeer = false;
    socket.on('close', () => { socket.closedByPeer = true; });
    stalledSockets.push(socket);
  });
  await new Promise((r) => stalled.listen(config.ports.dbapi + 10000, '127.0.0.1', r));
  const guest = await fakeGuest(config.ports.mmui + 10000, 'ihu-guiifm-protocol');
  t.after(async () => { await harness.stop(); guest.close(); stalled.close(); });

  const waiting = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  waiting.send('{"n":1}');
  waiting.close();
  await waitFor(() => waiting.closeInfo);
  await waitFor(() => harness.proxy.services.mmui.sessions.size === 0);
  assert.equal(harness.proxy.readiness.waiters.size, 0, 'the readiness waiter is canceled');
  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(guest.clients.size, 0, 'no guest connection for a frontend that already left');

  const connecting = await connect(config.ports.dbapi, 'ihu-dbapi-protocol');
  await waitFor(() => stalledSockets.length === 1);
  connecting.close();
  await waitFor(() => connecting.closeInfo);
  await waitFor(() => stalledSockets[0].closedByPeer, 2000);
  await waitFor(async () => {
    const h = json(await get(url + '/__emu/health')).proxy.backends;
    return h.guiifm.activeConnections === 0 && h.dbapi.activeConnections === 0 && h.dbapi.queueDepth === 0;
  });
});

test('shutdown: clients are closed with 1001 and every listener is released', async () => {
  const { root } = makeRoot();
  const { harness, config } = await startHarness({ ROOTFS_PATH: root });
  const ws = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  await harness.stop();
  await waitFor(() => ws.closeInfo);
  assert.equal(ws.closeInfo.code, 1001);
  for (const p of [config.ports.http, config.ports.mmui, config.ports.dbapi, config.ports.appsdk]) {
    await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(p, '127.0.0.1', () => s.close(resolve));
    });
  }
});

test('proxy: control messages keep the lifecycle until HomeScreen', async (t) => {
  const { harness, config, url } = await startProxy();
  const guest = await fakeGuest(config.ports.mmui + 10000, 'ihu-guiifm-protocol');
  t.after(async () => { await harness.stop(); guest.close(); });
  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  const mmui = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  await waitFor(() => guest.clients.size === 1);
  const guestSide = [...guest.clients][0];
  const control = async () => json(await get(url + '/__emu/health')).proxy.backends.guiifm.controlMessages;
  guestSide.send('{"msgType":"ctxtChg","uiaId":"system","ctxtId":"IntroAnimation"}\u0001');
  for (let i = 0; i < 300; i++) mmui.send(`{"msgType":"event","eventId":"Busy${i}"}`);
  await waitFor(() => guest.received.length === 300);
  let entries = await control();
  assert.ok(entries.some((e) => e.summary && e.summary.ctxtId === 'IntroAnimation'), 'intro kept before HomeScreen');
  assert.ok(entries.some((e) => e.summary && e.summary.eventId === 'Busy0'), 'every frame before HomeScreen is kept');
  guestSide.send('{"msgType":"ctxtChg","uiaId":"system","ctxtId":"HomeScreen"}\u0002');
  for (let i = 0; i < 300; i++) mmui.send(`{"msgType":"event","eventId":"After${i}"}`);
  await waitFor(() => guest.received.length === 600);
  entries = await control();
  assert.ok(entries.length <= 300 + 2 + 200, `bounded after HomeScreen (${entries.length})`);

  // A later guest connection gets its own retained lifecycle.
  mmui.close();
  await waitFor(() => guest.clients.size === 0);
  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  const again = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  await waitFor(() => guest.clients.size === 1);
  [...guest.clients][0].send('{"msgType":"ctxtChg","uiaId":"system","ctxtId":"IntroAnimation"}\u0003');
  for (let i = 0; i < 300; i++) again.send(`{"msgType":"event","eventId":"Second${i}"}`);
  await waitFor(() => guest.received.length === 900);
  entries = await control();
  assert.ok(entries.some((e) => e.summary && e.summary.eventId === 'Second0'), 'second connection lifecycle kept');
  assert.ok(!entries.some((e) => e.summary && e.summary.eventId === 'Busy0'), 'previous connection entries dropped');
  again.close();
});

test('proxy: an oversized control connection is closed by the harness', async (t) => {
  const { harness, config } = await startProxy();
  t.after(() => harness.stop());
  const started = Date.now();
  await new Promise((resolve) => {
    const s = net.connect(config.ports.displayControl, '127.0.0.1', () => s.write('x'.repeat(2000)));
    s.on('close', resolve);
    s.on('error', () => {});
  });
  assert.ok(Date.now() - started < 1000, `closed after ${Date.now() - started} ms`);
});

test('proxy: several DBAPI and AppSDK frontends are served at once', async (t) => {
  const { harness, config } = await startProxy();
  const guest = await fakeGuest(config.ports.dbapi + 10000, 'ihu-dbapi-protocol');
  t.after(async () => { await harness.stop(); guest.close(); });
  const a = await connect(config.ports.dbapi, 'ihu-dbapi-protocol');
  const b = await connect(config.ports.dbapi, 'ihu-dbapi-protocol');
  await waitFor(() => guest.clients.size === 2);
  a.send('{"from":"a"}');
  b.send('{"from":"b"}');
  await waitFor(() => guest.received.length === 2);
  assert.equal(a.readyState, WebSocket.OPEN);
  assert.equal(b.readyState, WebSocket.OPEN);
  a.close();
  b.close();
});

test('http: special routes match the decoded path', async (t) => {
  const { root } = makeRoot();
  const { harness, url } = await startHarness({ ROOTFS_PATH: root });
  t.after(() => harness.stop());
  const emu = await get(url + '/%5F%5Femu/nope');
  assert.equal(emu.status, 404);
  assert.equal(json(emu).ok, false);
  assert.match((await get(url + '/%69ndex.html')).body, /__mazdaEmulatorConfig/);
});

test('http: an index.html symlink out of the GUI tree is not served', async (t) => {
  const { root, gui, base } = makeRoot();
  fs.writeFileSync(path.join(base, 'outside.html'), '<html><head></head>outside-secret</html>');
  fs.unlinkSync(path.join(gui, 'index.html'));
  fs.symlinkSync(path.join(base, 'outside.html'), path.join(gui, 'index.html'));
  const { harness, url } = await startHarness({ ROOTFS_PATH: root });
  t.after(() => harness.stop());
  const leaked = await get(url + '/');
  assert.equal(leaked.status, 404);
  assert.ok(!leaked.body.includes('outside-secret'));
});

test('http: an aborted static download releases its file descriptor', async (t) => {
  const { root, gui } = makeRoot();
  fs.writeFileSync(path.join(gui, 'big.bin'), Buffer.alloc(8 * 1024 * 1024, 1));
  const { harness, config } = await startHarness({ ROOTFS_PATH: root });
  t.after(() => harness.stop());
  const fds = () => fs.readdirSync('/proc/self/fd').length;
  const before = fds();
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${config.ports.http}/big.bin`, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {});
    });
  }
  await waitFor(() => fds() <= before + 1, 2000).catch(() => {});
  assert.ok(fds() <= before + 1, `fds went from ${before} to ${fds()}`);
});

test('proxy: a splash before the guest connection never overtakes queued frontend frames', async (t) => {
  const { harness, config } = await startProxy();
  const guest = await fakeGuest(config.ports.mmui + 10000, 'ihu-guiifm-protocol');
  t.after(async () => { await harness.stop(); guest.close(); });
  await sendControl(config.ports.displayControl, 'splash-complete surface=TRANLOGO_SURFACE\n');
  const mmui = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  mmui.send('{"msgType":"event","eventId":"InitializeGuiComplete","uiaId":"system"}');
  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  await waitFor(() => guest.received.length === 4);
  assert.deepEqual(guest.received.map((m) => JSON.parse(m.data.toString()).eventId),
    ['InitializeGuiComplete', 'StartIntroAnimation', 'FinishIntroAnimation', 'ShowDisclaimer']);
  mmui.close();
});

test('proxy: a large JSON control frame still gets a summary', async (t) => {
  const { harness, config, url } = await startProxy();
  const guest = await fakeGuest(config.ports.dbapi + 10000, 'ihu-dbapi-protocol');
  t.after(async () => { await harness.stop(); guest.close(); });
  const dbapi = await connect(config.ports.dbapi, 'ihu-dbapi-protocol');
  await waitFor(() => guest.clients.size === 1);
  dbapi.send(JSON.stringify({ msgType: 'event', eventId: 'Big', pad: 'x'.repeat(70 * 1024) }));
  await waitFor(() => guest.received.length === 1);
  const entries = json(await get(url + '/__emu/health')).proxy.backends.dbapi.controlMessages;
  assert.equal(entries.at(-1).summary && entries.at(-1).summary.eventId, 'Big');
  dbapi.close();
});

test('shutdown: a silent display-control connection does not hold stop open', async () => {
  const { harness, config } = await startProxy();
  const idle = net.connect(config.ports.displayControl, '127.0.0.1');
  idle.on('error', () => {});
  await new Promise((r) => idle.once('connect', r));
  const started = Date.now();
  await harness.stop();
  assert.ok(Date.now() - started < 1000, `stop took ${Date.now() - started} ms`);
  idle.destroy();
});

test('proxy: a slow receiver pauses the sender instead of buffering without limit', async (t) => {
  const { harness, config } = await startProxy();
  const guest = await fakeGuest(config.ports.dbapi + 10000, 'ihu-dbapi-protocol');
  t.after(async () => { await harness.stop(); guest.close(); });
  const front = await connect(config.ports.dbapi, 'ihu-dbapi-protocol');
  await waitFor(() => guest.clients.size === 1);
  front.pause(); // the browser stops reading
  const guestSide = [...guest.clients][0];
  const frames = Array.from({ length: 64 }, (_, i) => Buffer.alloc(1024 * 1024, i));
  for (const f of frames) guestSide.send(f, { binary: true });
  const [session] = harness.proxy.services.dbapi.sessions;
  // Let the flow settle: the guest's own buffer stops draining once the
  // harness stops reading from it.
  let last = -1;
  await waitFor(async () => {
    const now = guestSide.bufferedAmount;
    const settled = now === last;
    last = now;
    await new Promise((r) => setTimeout(r, 200));
    return settled;
  }, 10000);
  assert.ok(guestSide.bufferedAmount > 0, 'the pushback reached the guest');
  assert.ok(session.frontend.bufferedAmount <= 6 * 1024 * 1024,
    `harness buffered ${session.frontend.bufferedAmount} bytes toward the stalled browser`);
  front.resume();
  await waitFor(() => front.messages.length === 64, 20000);
  front.messages.forEach((m, i) => assert.ok(m.isBinary && m.data.equals(frames[i]), `frame ${i}`));
  front.close();
});

test('proxy: the early queue is bounded in bytes as well as frames', async (t) => {
  const { harness, config, url } = await startProxy();
  t.after(() => harness.stop());
  const mmui = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  for (let i = 0; i < 17; i++) mmui.send(Buffer.alloc(1024 * 1024, i), { binary: true });
  await waitFor(() => mmui.closeInfo, 5000);
  assert.equal(mmui.closeInfo.code, 1008);
  assert.match(json(await get(url + '/__emu/health')).proxy.backends.guiifm.lastError, /overflow/);
});

test('proxy: diagnostics stay under the health bound and stay recent under hostile traffic', async (t) => {
  const { harness, config, url } = await startProxy();
  const guests = {};
  for (const [key, protocol] of [['mmui', 'ihu-guiifm-protocol'], ['dbapi', 'ihu-dbapi-protocol'], ['appsdk', 'ihu-appsdk-protocol']]) {
    guests[key] = await fakeGuest(config.ports[key] + 10000, protocol);
  }
  t.after(async () => { await harness.stop(); for (const g of Object.values(guests)) g.close(); });
  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  const hostile = '\u0001"'.repeat(100);
  for (const [key, protocol] of [['mmui', 'ihu-guiifm-protocol'], ['dbapi', 'ihu-dbapi-protocol'], ['appsdk', 'ihu-appsdk-protocol']]) {
    const ws = await connect(config.ports[key], protocol);
    await waitFor(() => guests[key].clients.size === 1);
    for (let i = 0; i < 3000; i++) {
      ws.send(JSON.stringify({ msgType: 'event', eventId: `${hostile}${i}`, uiaId: hostile, ctxtId: hostile, msgId: hostile, alertId: hostile }));
    }
    ws.send('{"msgType":"event","eventId":"Last"}');
    await waitFor(() => guests[key].received.length === 3001, 20000);
  }
  const res = await get(url + '/__emu/health');
  assert.equal(res.status, 200);
  assert.ok(Buffer.byteLength(res.body) < 4 * 1024 * 1024, `health is ${Buffer.byteLength(res.body)} bytes`);
  const dbapi = json(res).proxy.backends.dbapi.controlMessages;
  assert.equal(dbapi.at(-1).summary.eventId, 'Last');
  assert.ok(dbapi.length <= 200, `DBAPI keeps only recent control messages (${dbapi.length})`);
});

test('http: a file swapped for an outside symlink mid-request is never served', async (t) => {
  const { root, gui, base } = makeRoot();
  fs.writeFileSync(path.join(base, 'secret.txt'), 'SECRET-OUTSIDE\n');
  fs.writeFileSync(path.join(gui, 'g.txt'), 'innocent\n');
  // Another process flips g.txt between a regular file and an escaping symlink.
  const racer = require('child_process').spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const g = ${JSON.stringify(path.join(gui, 'g.txt'))}, tmp = g + '.tmp', link = g + '.lnk';
    for (;;) {
      try { fs.writeFileSync(tmp, 'innocent\\n'); fs.renameSync(tmp, g); } catch (_) {}
      try { fs.symlinkSync(${JSON.stringify(path.join(base, 'secret.txt'))}, link); fs.renameSync(link, g); } catch (_) {}
    }`], { stdio: 'ignore' });
  const { harness, url } = await startHarness({ ROOTFS_PATH: root });
  t.after(async () => { racer.kill(); await harness.stop(); });
  watchedTrees.length = 0; // the racer changes this tree on purpose
  // One request per connection, with a deadline: a length taken from one file
  // and bytes from the other either corrupt the framing or never complete.
  const fetchOnce = () => new Promise((resolve, reject) => {
    const req = http.get(url + '/g.txt', { agent: false, timeout: 1000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
  let leaked = 0;
  let broken = 0;
  for (let i = 0; i < 300; i++) {
    try {
      const body = await fetchOnce();
      if (body.includes('SECRET-OUTSIDE')) leaked++;
    } catch (_) {
      broken++;
    }
  }
  assert.deepEqual({ leaked, broken }, { leaked: 0, broken: 0 });
});

const rawStatus = async (port, request) => (await rawHttp(port, request)).status;

function wsHandshake(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, 'ihu-dbapi-protocol', { headers });
    ws.once('open', () => { ws.terminate(); resolve('open'); });
    ws.once('unexpected-response', (req, res) => { req.destroy(); resolve(res.statusCode); });
    ws.once('error', () => resolve('error'));
  });
}

test('access: HTTP and WebSocket requests from other hosts and origins are refused', async (t) => {
  const { root } = makeRoot();
  const { harness, config, url } = await startHarness({ ROOTFS_PATH: root });
  t.after(() => harness.stop());
  const p = config.ports.http;
  const req = (host) => `GET /__emu/health HTTP/1.1\r\n${host === null ? '' : `Host: ${host}\r\n`}Connection: close\r\n\r\n`;
  assert.equal(await rawStatus(p, req(`127.0.0.1:${p}`)), 200);
  assert.equal(await rawStatus(p, req(`localhost:${p}`)), 200);
  assert.equal(await rawStatus(p, 'GET /__emu/health HTTP/1.0\r\n\r\n'), 200, 'no Host header (non-browser client)');
  assert.equal(await rawStatus(p, req(`evil.example:${p}`)), 403, 'DNS rebinding');
  const d = config.ports.dbapi;
  assert.equal(await wsHandshake(d, {}), 'open', 'no Origin (non-browser client)');
  assert.equal(await wsHandshake(d, { Origin: `http://127.0.0.1:${p}` }), 'open', 'the harness page itself');
  assert.equal(await wsHandshake(d, { Origin: 'https://evil.example' }), 403);
  assert.equal(await wsHandshake(d, { Origin: `http://127.0.0.1:${p + 1}` }), 403, 'another local page');
  assert.equal(await wsHandshake(d, { Host: `evil.example:${d}` }), 403, 'DNS rebinding');
  const stats = json(await get(url + '/__emu/health')).stats;
  assert.equal(stats.httpCompatibility.rejectedHosts, 1);
  assert.equal(stats.clients.rejectedOrigins + stats.clients.rejectedHosts, 3);
});

test('mock: a frame over the scenario inbound limit closes that client only', async (t) => {
  const { root } = makeRoot();
  const { harness, config } = await startHarness({ ROOTFS_PATH: root });
  t.after(() => harness.stop());
  const other = await connect(config.ports.dbapi, 'ihu-dbapi-protocol');
  const big = await connect(config.ports.dbapi, 'ihu-dbapi-protocol');
  big.send('x'.repeat(65537));
  await waitFor(() => big.closeInfo);
  assert.equal(big.closeInfo.code, 1009);
  assert.equal(other.readyState, WebSocket.OPEN);
  other.close();
});

test('frontends: sessions per service and control connections are capped', async (t) => {
  const { harness, config, url } = await startProxy();
  // A DBAPI guest keeps those sessions open; without it each would close with 1013.
  const guest = await fakeGuest(config.ports.dbapi + 10000, 'ihu-dbapi-protocol');
  t.after(async () => { await harness.stop(); guest.close(); });
  const opened = [];
  for (let i = 0; i < 32; i++) opened.push(await connect(config.ports.mmui, 'ihu-guiifm-protocol'));
  const refused = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${config.ports.appsdk}/`, 'ihu-appsdk-protocol');
    ws.once('open', () => { ws.terminate(); resolve('open'); });
    ws.once('unexpected-response', (req, res) => { req.destroy(); resolve(res.statusCode); });
  });
  assert.equal(refused, 'open', 'the cap is per service');
  const extra = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${config.ports.mmui}/`, 'ihu-guiifm-protocol');
    ws.once('open', () => { ws.terminate(); resolve('open'); });
    ws.once('unexpected-response', (req, res) => { req.destroy(); resolve(res.statusCode); });
  });
  // MMUI replaces older sessions, so its 32 are closing; the cap counts live sockets.
  assert.ok(extra === 'open' || extra === 503, `MMUI ${extra}`);
  for (const ws of opened) ws.terminate();

  const dbapi = [];
  for (let i = 0; i < 32; i++) dbapi.push(await connect(config.ports.dbapi, 'ihu-dbapi-protocol'));
  await waitFor(() => guest.clients.size === 32);
  const over = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${config.ports.dbapi}/`, 'ihu-dbapi-protocol');
    ws.once('open', () => { ws.terminate(); resolve('open'); });
    ws.once('unexpected-response', (req, res) => { req.destroy(); resolve(res.statusCode); });
    ws.once('error', () => resolve('error'));
  });
  assert.equal(over, 503);
  for (const ws of dbapi) ws.terminate();

  const idle = [];
  for (let i = 0; i < 16; i++) {
    const s = net.connect(config.ports.displayControl, '127.0.0.1');
    s.on('error', () => {});
    await new Promise((r) => s.once('connect', r));
    idle.push(s);
  }
  const closedEarly = await new Promise((resolve) => {
    const s = net.connect(config.ports.displayControl, '127.0.0.1');
    s.on('error', () => {});
    s.once('close', () => resolve(true));
    setTimeout(() => { s.destroy(); resolve(false); }, 1000);
  });
  assert.equal(closedEarly, true, 'the 17th control connection is closed at once');
  for (const s of idle) s.destroy();
  const health = json(await get(url + '/__emu/health'));
  assert.equal(health.stats.clients.rejectedCapacity, 1);
  assert.equal(health.proxy.displayControl.refused, 1);
});

test('proxy: after guest loss, an early splash finishes the next connection', async (t) => {
  const { harness, config } = await startProxy();
  const guest = await fakeGuest(config.ports.mmui + 10000, 'ihu-guiifm-protocol');
  t.after(async () => { await harness.stop(); guest.close(); });
  const synthetic = (ws) => guest.received.filter((m) => m.ws === ws).map((m) => JSON.parse(m.data.toString()).eventId)
    .filter((e) => ['StartIntroAnimation', 'FinishIntroAnimation', 'ShowDisclaimer'].includes(e));
  guest.on('connection', (ws) => ws.on('message', () => { guest.received.at(-1).ws = ws; }));
  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  const first = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  await waitFor(() => guest.clients.size === 1);
  const firstGuest = [...guest.clients][0];
  first.send('{"msgType":"event","eventId":"InitializeGuiComplete","uiaId":"system"}');
  await sendControl(config.ports.displayControl, 'splash-complete surface=TRANLOGO_SURFACE\n');
  await waitFor(() => synthetic(firstGuest).length === 3);
  firstGuest.terminate(); // guest MMUI connection lost
  await waitFor(() => first.closeInfo);
  await sendControl(config.ports.displayControl, 'splash-complete surface=TRANLOGO_SURFACE\n');
  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  const second = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  await waitFor(() => guest.clients.size === 1);
  const secondGuest = [...guest.clients][0];
  await waitFor(() => synthetic(secondGuest).includes('ShowDisclaimer'), 2000);
  assert.deepEqual(synthetic(secondGuest), ['FinishIntroAnimation', 'ShowDisclaimer']);
  second.close();
});

test('proxy: readiness expiry does not pause a released session, only new ones', async (t) => {
  const { harness, config, url } = await startProxy();
  const guest = await fakeGuest(config.ports.mmui + 10000, 'ihu-guiifm-protocol');
  t.after(async () => { await harness.stop(); guest.close(); });
  await sendControl(config.ports.displayControl, 'mmui-ready\n');
  const mmui = await connect(config.ports.mmui, 'ihu-guiifm-protocol');
  await waitFor(() => guest.clients.size === 1);
  const readiness = harness.proxy.readiness;
  const realNow = readiness.now;
  readiness.now = () => realNow() + 10000; // five-second expiry has passed
  const health = json(await get(url + '/__emu/health'));
  assert.equal(health.proxy.mmuiReadiness.ready, false);
  assert.equal(health.nativeProxyReady, false);
  mmui.send('{"msgType":"event","eventId":"AfterExpiry"}');
  await waitFor(() => guest.received.some((m) => /AfterExpiry/.test(m.data)));
  [...guest.clients][0].send('{"msgType":"ctxtChg","ctxtId":"Still"}');
  await waitFor(() => mmui.messages.some((m) => /Still/.test(m.data)));
  assert.equal(mmui.readyState, WebSocket.OPEN);
  mmui.close();
});

test('http: any path that normalizes to /index.html gets the injection', async (t) => {
  const { root } = makeRoot();
  const { harness, config } = await startHarness({ ROOTFS_PATH: root });
  t.after(() => harness.stop());
  for (const p of ['//index.html', '/./index.html', '/%2e/index.html', '/x/../index.html', '/x/%2e%2e/index.html',
    '/../index.html', '/css/../index.html?x=1']) {
    const r = await rawHttp(config.ports.http, rawGetRequest(p));
    assert.equal(r.status, 200, p);
    assert.match(r.body, /__mazdaEmulatorConfig/, p);
  }
});

test('http: the app-script fault applies to every spelling of its path', async (t) => {
  const ws = makeOverlayWorkspace();
  const { harness, config } = await startHarness({ ROOTFS_PATH: ws.root, EMU_FAIL_OVERLAY_APP_SCRIPT: 'true' });
  t.after(() => harness.stop());
  for (const p of ['/apps/system/js//developerdiagnosticsApp.js', '/apps/system/./js/developerdiagnosticsApp.js',
    '/apps/x/../system/js/developerdiagnosticsApp.js']) {
    assert.equal((await rawHttp(config.ports.http, rawGetRequest(p))).status, 503, p);
  }
});
