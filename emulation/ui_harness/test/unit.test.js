'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { loadConfig, ConfigError } = require('../lib/config');
const { confine, decodeRequestPath, detectOverlayWorkspace } = require('../lib/rootfs');
const { transformCss } = require('../lib/css');
const { parseJsonObject, describeFrame, encodeMmui, PREVIEW_LIMIT } = require('../lib/frames');
const { loadCanReplay, CanReplay, CanReplayError } = require('../lib/can');
const { overlayStatus } = require('../lib/overlay');
const { MmuiReadiness } = require('../lib/readiness');
const { makeRoot, makeTemp, makeOverlayWorkspace } = require('./helpers');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CAN_SAMPLE = path.join(REPO, 'emulation', 'fixtures', 'can', 'public-private-sample.jsonl');

// ---------------------------------------------------------------- config
test('config: defaults are loopback and the documented ports', () => {
  const { root } = makeRoot();
  const c = loadConfig({ ROOTFS_PATH: root });
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.mode, 'mock');
  assert.deepEqual({ ...c.ports }, { http: 8080, mmui: 2700, dbapi: 2766, appsdk: 2800, displayControl: 2990 });
  assert.equal(c.readinessHoldMs, 0);
});

test('config: CMU_ROOTFS is accepted and roots are resolved absolute', () => {
  const { root } = makeRoot();
  const rel = path.relative(process.cwd(), root);
  assert.equal(loadConfig({ CMU_ROOTFS: rel }).rootfs, root);
});

test('config: rejects invalid roots', () => {
  assert.throws(() => loadConfig({}), ConfigError);
  const cases = {
    'root missing': (d) => path.join(d, 'nope'),
    'root is a file': (d) => { fs.writeFileSync(path.join(d, 'f'), ''); return path.join(d, 'f'); },
    'jci/gui missing': (d) => { fs.mkdirSync(path.join(d, 'jci'), { recursive: true }); return d; },
    'jci/gui is a file': (d) => { fs.mkdirSync(path.join(d, 'jci'), { recursive: true }); fs.writeFileSync(path.join(d, 'jci', 'gui'), ''); return d; },
    'index.html missing': (d) => { fs.mkdirSync(path.join(d, 'jci', 'gui'), { recursive: true }); return d; },
    'index.html is a directory': (d) => { fs.mkdirSync(path.join(d, 'jci', 'gui', 'index.html'), { recursive: true }); return d; },
  };
  for (const [name, setup] of Object.entries(cases)) {
    assert.throws(() => loadConfig({ ROOTFS_PATH: setup(makeTemp()) }), /Not a CMU rootfs/, name);
  }
  assert.doesNotThrow(() => loadConfig({ ROOTFS_PATH: makeRoot().root }));
});
test('config: rejects bad and duplicate ports', () => {
  const { root } = makeRoot();
  for (const bad of ['0', '65536', '-1', '80.5', 'abc', '1e3', ' ']) {
    assert.throws(() => loadConfig({ ROOTFS_PATH: root, HTTP_PORT: bad }), ConfigError, bad);
  }
  assert.throws(() => loadConfig({ ROOTFS_PATH: root, MMUI_PORT: '8080' }), /Duplicate/);
  assert.throws(() => loadConfig({ ROOTFS_PATH: root, PROXY_MODE: 'true', DISPLAY_CONTROL_PORT: '2700' }), /Duplicate/);
  // Display control is not a listener in mock mode.
  assert.doesNotThrow(() => loadConfig({ ROOTFS_PATH: root, DISPLAY_CONTROL_PORT: '2700' }));
  assert.throws(() => loadConfig({ ROOTFS_PATH: root, PROXY_MODE: 'true', MMUI_PORT: '60000' }), /guest port/);
});

test('config: readiness hold must be finite and nonnegative', () => {
  const { root } = makeRoot();
  assert.equal(loadConfig({ ROOTFS_PATH: root, EMU_MMUI_READINESS_HOLD_MS: '3000' }).readinessHoldMs, 3000);
  for (const bad of ['-1', 'NaN', 'Infinity', 'soon']) {
    assert.throws(() => loadConfig({ ROOTFS_PATH: root, EMU_MMUI_READINESS_HOLD_MS: bad }), ConfigError, bad);
  }
  assert.throws(() => loadConfig({ ROOTFS_PATH: root, PROXY_MODE: 'yes' }), ConfigError);
});

// ---------------------------------------------------------------- path confinement
test('paths: decodes and normalizes ordinary requests', () => {
  const { gui } = makeRoot();
  const real = fs.realpathSync(gui);
  const ok = confine(real, '/css/./x.css');
  assert.equal(ok.ok, true);
  assert.equal(ok.file, path.join(real, 'css', 'x.css'));
  assert.equal(confine(real, '/a%2Ejs').ok, true);
});

test('paths: traversal never reaches outside the GUI tree', () => {
  const { gui } = makeRoot();
  const real = fs.realpathSync(gui);
  // Dot segments resolve inside the root (RFC 3986); backslashes, NUL, and bad
  // escapes are refused outright.
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2E%2E%2Fsecret.txt', '/css/..%2f..%2fsecret.txt',
    '/css/%2e%2e/%2e%2e/%2e%2e/etc/passwd']) {
    const r = confine(real, p);
    assert.equal(r.ok, false, `${p} names no file inside the tree`);
  }
  assert.equal(confine(real, '/../../a.js').file, path.join(real, 'a.js'), 'clamped at the root, never above it');
  for (const p of ['/..\\secret.txt', '/%5c..%5csecret.txt', '/a.js%00', '/%zz']) {
    assert.equal(confine(real, p).reason, 'invalid', p);
  }
  assert.equal(decodeRequestPath('/x/../y'), '/y');
  assert.equal(decodeRequestPath('/../../y'), '/y');
});

test('paths: rejects symlinks that leave the GUI tree, allows internal ones', () => {
  const { base, gui } = makeRoot();
  const real = fs.realpathSync(gui);
  fs.symlinkSync(path.join(base, 'secret.txt'), path.join(gui, 'escape.txt'));
  fs.symlinkSync(base, path.join(gui, 'escapedir'));
  fs.symlinkSync(path.join(gui, 'a.js'), path.join(gui, 'inside.js'));
  assert.equal(confine(real, '/escape.txt').ok, false);
  assert.equal(confine(real, '/escapedir/secret.txt').ok, false);
  assert.equal(confine(real, '/inside.js').ok, true);
});

// ---------------------------------------------------------------- CSS
test('css: translates recognized Opera tokens', () => {
  const input = [
    '@-o-keyframes spin { from { -o-transform: rotate(0deg); } }',
    '.a { background: -o-linear-gradient(top, #000, #fff); -o-transition: -o-transform 1s; }',
    '.b { -o-animation: spin 1s; -o-animation-name: spin; -o-user-select: none; -o-text-overflow: ellipsis; }',
    '.c { -O-TRANSFORM-ORIGIN: 0 0; -o-transition-duration: 2s; }',
  ].join('\n');
  const { css, changes } = transformCss(input);
  assert.equal(css, [
    '@keyframes spin { from { transform: rotate(0deg); } }',
    '.a { background: linear-gradient(to bottom, #000, #fff); transition: transform 1s; }',
    '.b { animation: spin 1s; animation-name: spin; user-select: none; text-overflow: ellipsis; }',
    '.c { transform-origin: 0 0; transition-duration: 2s; }',
  ].join('\n'));
  assert.equal(changes, 11);
});

test('css: leaves strings, comments, urls, selectors, and unknown tokens intact', () => {
  const cases = [
    '.x { content: "-o-transform: none"; }',
    '.x { content: "a -o-transform"; }',
    ".x { content: 'a @-o-keyframes'; }",
    ".x { content: '@-o-keyframes'; }",
    '/* -o-transform: rotate(1deg); @-o-keyframes x {} */ .y {}',
    '.x { background: url(img/-o-transform.png); }',
    '.x { background: url("-o-linear-gradient(x)"); }',
    '.menu-o-transform { color: red; } #id-o-transition { }',
    '.x-o-animation, .-o-transform-like { }',
    '.x { -o-object-fit: cover; -o-tab-size: 4; }',
    '.x { -o-transformer: 1; -o-linear-gradientx(1); }',
    '.x { -webkit-transform: none; -moz-transition: none; }',
    '.x { -o-linear-gradient: 1; }',
    '@-o-viewport { }',
    '.x { width: 10px-o-transform; }',
  ];
  for (const input of cases) {
    const out = transformCss(input);
    if (input === '.x { width: 10px-o-transform; }') {
      // "10px-o-transform" is a single dimension token, not an identifier.
      assert.equal(out.css, input);
      continue;
    }
    assert.equal(out.css, input, input);
    assert.equal(out.changes, 0, input);
  }
});

test('css: handles escapes and unterminated constructs without throwing', () => {
  assert.equal(transformCss('.a\\-o-transform { }').css, '.a\\-o-transform { }');
  assert.equal(transformCss('.a { content: "unterminated').css, '.a { content: "unterminated');
  assert.equal(transformCss('/* open comment -o-transform').css, '/* open comment -o-transform');
});

// ---------------------------------------------------------------- frames
test('frames: parses JSON with and without a one-byte sequence suffix', () => {
  const plain = parseJsonObject(Buffer.from('{"msgType":"event","eventId":"X"}'));
  assert.equal(plain.object.eventId, 'X');
  assert.equal(plain.seq, null);
  const withSeq = parseJsonObject(Buffer.from(encodeMmui({ msgType: 'ctxtChg', ctxtId: 'A' }, 7)));
  assert.equal(withSeq.object.ctxtId, 'A');
  assert.equal(withSeq.seq, 7);
  assert.equal(parseJsonObject(Buffer.from('not json')), null);
  assert.equal(parseJsonObject(Buffer.from('[1,2]')), null);
});

test('frames: diagnostics are bounded and never carry binary bodies', () => {
  const big = Buffer.from(JSON.stringify({ msgType: 'msg', msgId: 'Big', params: { blob: 'x'.repeat(100000) } }));
  const d = describeFrame(big, false, 'guest-to-frontend');
  assert.ok(d.preview.length <= PREVIEW_LIMIT);
  assert.equal(d.truncated, true);
  assert.equal(d.bytes, big.length);
  const bin = describeFrame(Buffer.from([0, 1, 2, 255]), true, 'guest-to-frontend');
  assert.equal(bin.preview, undefined);
  assert.equal(bin.summary, null);
  const ctl = describeFrame(Buffer.from('{"msgType":"x"}\u0001'), false, 'x');
  assert.ok(!/[\x00-\x1f]/.test(ctl.preview));
});

// ---------------------------------------------------------------- CAN
test('can: loads the synthetic fixture with channel counts', () => {
  const replay = CanReplay.fromPath(CAN_SAMPLE);
  assert.deepEqual(replay.healthSummary(), { available: true, frameCount: 4, publicFrames: 2, privateFrames: 2, recentLimit: 200 });
  const e = replay.endpoint();
  assert.equal(e.schema, 'mazda-cmu-vim-can-v1');
  assert.equal(e.mode, 'replay');
  assert.equal(e.frames.at(-1).data, 'DEADBEEF01020304');
  assert.equal(e.frames[0].idHex, '0x120');
});

test('can: unavailable form', () => {
  assert.deepEqual(new CanReplay(null).endpoint(),
    { available: false, mode: 'unavailable', frameCount: 0, publicFrames: 0, privateFrames: 0, frames: [] });
});

test('can: rejects missing, non-regular, empty, and malformed input', () => {
  const dir = makeTemp();
  const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  const frame = { schema: 'mazda-cmu-vim-can-v1', sequence: 1, channel: 'public', port: 1, id: 0x123, idHex: '0x123', length: 1, data: 'AA' };
  const line = (o) => JSON.stringify(Object.assign({}, frame, o));
  assert.throws(() => loadCanReplay(path.join(dir, 'missing.jsonl')), CanReplayError);
  assert.throws(() => loadCanReplay(dir), /regular/);
  assert.throws(() => loadCanReplay(write('empty.jsonl', '\n\n')), /no frames/);
  assert.throws(() => loadCanReplay(write('bad.jsonl', '{')), /invalid JSON/);
  assert.throws(() => loadCanReplay(write('id.jsonl', line({ id: 0x160, idHex: '0x160' }))), /outside/);
  assert.throws(() => loadCanReplay(write('port.jsonl', line({ port: 0 }))), /must use port/);
  assert.throws(() => loadCanReplay(write('hex.jsonl', line({ data: 'aa' }))), /uppercase hex/);
  assert.throws(() => loadCanReplay(write('len.jsonl', line({ length: 65, data: 'AA'.repeat(65) }))), /length/);
  assert.throws(() => loadCanReplay(write('seq.jsonl', line({}) + '\n' + line({}))), /increase/);
  assert.throws(() => loadCanReplay(write('priv.jsonl', line({ channel: 'private', port: 0 }))), /outside/);
});

// ---------------------------------------------------------------- overlay
test('overlay: detects only valid format-2 workspaces', () => {
  const ws = makeOverlayWorkspace();
  assert.deepEqual(detectOverlayWorkspace(ws.root), { workspace: ws.base, overlayId: 'synthetic-overlay' });
  const meta = (w, text) => fs.writeFileSync(path.join(w.base, '.overlay-workspace.json'), text);
  const rejected = {
    'no metadata': () => makeRoot().root,
    'root not named root': () => { const w = makeOverlayWorkspace(); const o = path.join(w.base, 'rootx'); fs.renameSync(w.root, o); return o; },
    'format 1': () => makeOverlayWorkspace({ kind: 'mazda-cmu-overlay-workspace', format: 1 }).root,
    'format as a string': () => makeOverlayWorkspace({ kind: 'mazda-cmu-overlay-workspace', format: '2' }).root,
    'other kind': () => makeOverlayWorkspace({ kind: 'other', format: 2 }).root,
    'invalid JSON': () => { const w = makeOverlayWorkspace(); meta(w, '{'); return w.root; },
    'JSON array': () => { const w = makeOverlayWorkspace(); meta(w, '[]'); return w.root; },
    'JSON null': () => { const w = makeOverlayWorkspace(); meta(w, 'null'); return w.root; },
    'metadata is a symlink': () => {
      const w = makeOverlayWorkspace();
      const m = path.join(w.base, '.overlay-workspace.json');
      fs.renameSync(m, path.join(w.base, 'meta.json'));
      fs.symlinkSync(path.join(w.base, 'meta.json'), m);
      return w.root;
    },
    'data/integration missing': () => { const w = makeOverlayWorkspace(); fs.rmdirSync(path.join(w.base, 'data', 'integration')); return w.root; },
    'data/cmu-overlay missing': () => { const w = makeOverlayWorkspace(); fs.rmdirSync(path.join(w.base, 'data', 'cmu-overlay')); return w.root; },
    'data/cmu-overlay is a symlink': () => {
      const w = makeOverlayWorkspace();
      const d = path.join(w.base, 'data', 'cmu-overlay');
      fs.rmdirSync(d);
      fs.mkdirSync(path.join(w.base, 'elsewhere'));
      fs.symlinkSync(path.join(w.base, 'elsewhere'), d);
      return w.root;
    },
  };
  for (const [name, setup] of Object.entries(rejected)) assert.equal(detectOverlayWorkspace(setup()), null, name);
  const unnamed = makeOverlayWorkspace({ kind: 'mazda-cmu-overlay-workspace', format: 2, overlay_id: 7 });
  assert.equal(detectOverlayWorkspace(unnamed.root).overlayId, 'unknown');
});

test('overlay: state files are read only when regular and at most 65536 bytes', () => {
  const ws = makeOverlayWorkspace();
  const workspace = detectOverlayWorkspace(ws.root);
  const state = path.join(ws.base, 'data', 'cmu-overlay', 'state');
  fs.writeFileSync(state, 'x'.repeat(65536));
  assert.equal(overlayStatus(workspace).body.managerState.length, 65536);
  fs.writeFileSync(state, 'x'.repeat(65537));
  assert.equal(overlayStatus(workspace).body.managerState, 'factory');
});

test('overlay: a FIFO in the workspace does not block the harness', () => {
  const ws = makeOverlayWorkspace();
  require('child_process').execFileSync('mkfifo', [path.join(ws.base, 'data', 'cmu-overlay', 'state')]);
  // Opening a FIFO blocks the whole process, so read in a child with a hard limit.
  const script = `const { detectOverlayWorkspace } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'rootfs'))});
    const { overlayStatus } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'overlay'))});
    process.stdout.write(overlayStatus(detectOverlayWorkspace(${JSON.stringify(ws.root)})).body.managerState);`;
  const r = require('child_process').spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8' });
  assert.equal(r.signal, null, 'the read did not hang');
  assert.equal(r.stdout, 'factory');
});
test('overlay: fallbacks, trimming, journal bound, and symlink refusal', () => {
  const ws = makeOverlayWorkspace({ kind: 'mazda-cmu-overlay-workspace', format: 2 });
  const workspace = detectOverlayWorkspace(ws.root);
  let s = overlayStatus(workspace).body;
  assert.deepEqual(s, {
    available: true, overlayId: 'unknown', managerState: 'factory', activeTransaction: 'none',
    bootAttempts: '0', mountState: 'unknown', watchdog: 'unknown', journal: [],
  });
  const mgr = path.join(ws.base, 'data', 'cmu-overlay');
  fs.writeFileSync(path.join(mgr, 'state'), '  enabled \n');
  fs.writeFileSync(path.join(mgr, 'boot-attempts'), '');
  fs.writeFileSync(path.join(mgr, 'active-transaction'), 'x'.repeat(65537));
  fs.writeFileSync(path.join(ws.base, 'secret'), 'mounted');
  fs.symlinkSync(path.join(ws.base, 'secret'), path.join(ws.base, 'emulated', 'mount-state'));
  fs.mkdirSync(path.join(ws.base, 'emulated', 'watchdog'));
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  fs.writeFileSync(path.join(mgr, 'journal.log'), lines.join('\r\n') + '\r\n\r\n');
  s = overlayStatus(workspace).body;
  assert.equal(s.managerState, 'enabled');
  assert.equal(s.bootAttempts, '0');
  assert.equal(s.activeTransaction, 'none');
  assert.equal(s.mountState, 'unknown');
  assert.equal(s.watchdog, 'unknown');
  assert.equal(s.journal.length, 40);
  assert.equal(s.journal[0], 'line 10');
  assert.equal(s.journal.at(-1), 'line 49');
  assert.deepEqual(overlayStatus(null), { status: 404, body: { available: false, error: 'selected root is not a validated overlay workspace' } });
});

// ---------------------------------------------------------------- readiness
test('readiness: explicit marker, expiry, hold, and reset', () => {
  let now = 1000;
  const r = new MmuiReadiness({ holdMs: 3000, now: () => now });
  assert.equal(r.isReady(), false);
  r.notify('mmui-ready');
  assert.equal(r.isReady(), true);
  assert.equal(r.isReleased(), false);
  now += 2000; r.notify('mmui-ready');
  now += 1000;
  assert.equal(r.isReleased(), true);
  now += 5001;
  assert.equal(r.isReady(), false);
  r.notify('mmui-ready');
  assert.equal(r.isReleased(), false, 'hold restarts for a new readiness period');
  r.reset();
  assert.equal(r.isReady(), false);
  r.stop();
});

// ---------------------------------------------------------------- display lifecycle bridge
const { NativeDisplayBridge, SHOW_DISCLAIMER_DELAY_MS } = require('../lib/display');

function bridgeWithSender() {
  const readiness = new MmuiReadiness();
  const bridge = new NativeDisplayBridge({ readiness });
  const sent = [];
  const sender = (o) => { sent.push(o); return true; };
  return { bridge, sent, sender, readiness };
}

test('display: splash before the guest connection; finish once flushed, disclaimer ~100 ms later', async () => {
  const { bridge, sent, sender } = bridgeWithSender();
  bridge.controlNotification('splash-complete surface=TRANLOGO_SURFACE');
  assert.equal(sent.length, 0);
  bridge.attachGuest(sender);
  assert.equal(sent.length, 0, 'attaching alone sends nothing');
  bridge.finishIfPending();
  assert.deepEqual(sent.map((o) => o.eventId), ['FinishIntroAnimation']);
  await new Promise((r) => setTimeout(r, SHOW_DISCLAIMER_DELAY_MS / 2));
  assert.equal(sent.length, 1);
  await new Promise((r) => setTimeout(r, SHOW_DISCLAIMER_DELAY_MS));
  assert.deepEqual(sent.map((o) => o.eventId), ['FinishIntroAnimation', 'ShowDisclaimer']);
  bridge.controlNotification('splash-complete surface=TRANLOGO_SURFACE');
  await new Promise((r) => setTimeout(r, SHOW_DISCLAIMER_DELAY_MS * 2));
  assert.equal(sent.length, 2, 'duplicate splash is idempotent');
  assert.equal(bridge.finishEvents, 1);
  assert.equal(bridge.showDisclaimerEvents, 1);
});

test('display: start once per connection; disclaimer dropped if the connection goes away', async () => {
  const { bridge, sent, sender } = bridgeWithSender();
  bridge.attachGuest(sender);
  bridge.frontendMessage({ msgType: 'event', eventId: 'InitializeGuiComplete' });
  bridge.frontendMessage({ msgType: 'event', eventId: 'InitializeGuiComplete' });
  assert.deepEqual(sent.map((o) => o.eventId), ['StartIntroAnimation']);
  bridge.controlNotification('splash-complete surface=TRANLOGO_SURFACE');
  bridge.detachGuest(sender);
  await new Promise((r) => setTimeout(r, SHOW_DISCLAIMER_DELAY_MS * 2));
  assert.deepEqual(sent.map((o) => o.eventId), ['StartIntroAnimation', 'FinishIntroAnimation']);
  // A new connection gets its own Start.
  const sent2 = [];
  bridge.attachGuest((o) => { sent2.push(o); return true; });
  bridge.frontendMessage({ msgType: 'event', eventId: 'InitializeGuiComplete' });
  assert.deepEqual(sent2.map((o) => o.eventId), ['StartIntroAnimation']);
});

test('display: unsupported and empty notifications produce no lifecycle events', () => {
  const { bridge, sent, sender, readiness } = bridgeWithSender();
  bridge.attachGuest(sender);
  bridge.controlNotification('');
  bridge.controlNotification('splash-complete surface=OTHER');
  assert.equal(sent.length, 0);
  assert.equal(bridge.notifications, 1);
  assert.match(bridge.lastError, /unsupported/);
  bridge.controlNotification('mmui-ready');
  assert.equal(bridge.notifications, 1, 'mmui-ready is counted by readiness, not display');
  assert.equal(readiness.notifications, 1);
  readiness.stop();
});

test('display: completion and its lastError reset require HomeScreen, in either order', () => {
  for (const order of [['end', 'home'], ['home', 'end']]) {
    const { bridge, sender, readiness } = bridgeWithSender();
    bridge.attachGuest(sender);
    bridge.controlNotification('unexpected');
    bridge.guestMessage({ msgType: 'ctxtChg', ctxtId: 'Disclaimer' });
    assert.match(bridge.lastError, /unsupported/, `${order}: not complete before HomeScreen`);
    order.forEach((step, i) => {
      if (step === 'end') bridge.frontendMessage({ msgType: 'event', eventId: 'NotifyDisclaimerEnd' });
      else bridge.guestMessage({ msgType: 'ctxtChg', ctxtId: 'HomeScreen' });
      if (i === 0) assert.match(bridge.lastError, /unsupported/, `${step} alone does not complete`);
    });
    assert.equal(bridge.lastError, null, order.join(' then '));
    readiness.stop();
  }
});

test('display: a stale detach from an old connection does not clear a newer one', () => {
  const { bridge, sender } = bridgeWithSender();
  const newer = [];
  bridge.attachGuest(sender);
  bridge.attachGuest((o) => { newer.push(o.eventId); return true; });
  bridge.detachGuest(sender);
  bridge.frontendMessage({ msgType: 'event', eventId: 'InitializeGuiComplete' });
  assert.deepEqual(newer, ['StartIntroAnimation']);
});

test('display: a duplicate splash after Finish is not carried to the next connection', async () => {
  const { bridge, sender } = bridgeWithSender();
  bridge.attachGuest(sender);
  bridge.controlNotification('splash-complete surface=TRANLOGO_SURFACE');
  bridge.controlNotification('splash-complete surface=TRANLOGO_SURFACE');
  bridge.detachGuest(sender);
  const next = [];
  bridge.attachGuest((o) => { next.push(o.eventId); return true; });
  bridge.finishIfPending();
  await new Promise((r) => setTimeout(r, SHOW_DISCLAIMER_DELAY_MS * 2));
  assert.deepEqual(next, []);
  assert.equal(bridge.finishEvents, 1);
});

test('readiness: a waiter added during the hold runs when the hold ends, once', async () => {
  const r = new MmuiReadiness({ holdMs: 60 });
  r.notify('mmui-ready');
  await new Promise((done) => setTimeout(done, 10));
  let runs = 0;
  r.whenReleased(() => runs++);
  assert.equal(runs, 0);
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(runs, 1, 'released at the end of the hold, without another marker');
  r.notify('mmui-ready');
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(runs, 1, 'a released waiter never runs again');
  r.stop();
});

test('css: translation resumes after strings, comments, and url()', () => {
  const cases = [
    'a { content: "x"; -o-transform: none }',
    "a { content: 'x'; -o-transform: none }",
    'a { content: "a\\"b"; -o-transform: none }',
    'a { content: "unterminated\n; -o-transform: none }',
    'a { /* note */ -o-transform: none }',
    'a { background: url(x.png); -o-transform: none }',
    'a { background: url( "x.png" ); -o-transform: none }',
    'a { background: url(a\\)b.png); -o-transform: none }',
    'a { url -o-transform: none }',
    'a { width: 1/2; -o-transform: none }',
    '* { -o-transform: none }',
  ];
  for (const input of cases) {
    const { css, changes } = transformCss(input);
    assert.equal(changes, 1, input);
    assert.equal(css, input.replace('-o-transform', 'transform'), input);
  }
});

test('css: every recognized -o- property is translated', () => {
  const props = ['transform', 'transform-origin', 'transform-style', 'transition', 'transition-property',
    'transition-duration', 'transition-timing-function', 'transition-delay', 'animation', 'animation-name',
    'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count',
    'animation-direction', 'animation-fill-mode', 'animation-play-state', 'user-select', 'text-overflow'];
  for (const p of props) assert.equal(transformCss(`a { -o-${p}: x }`).css, `a { ${p}: x }`, p);
});

test('css: -o- names inside other tokens are not translated', () => {
  for (const input of ['.-o-transform { }', '#-o-transform { }', '@-o-transform { }', '.x_-o-transform { }',
    '.x9-o-transform { }', '.\u00e9-o-transform { }', 'a { b: url(-o-transform) }', 'a { -o-transform-x: 1 }',
    'a { animation: my-transition 1s }', 'a { /*/ -o-transform */ }', 'a { b: url("a)-o-transform") }',
    'a { b: url(a\\)-o-transform) }']) {
    assert.equal(transformCss(input).css, input, input);
  }
});

test('readiness: a hold beyond the timer range does not spin', async () => {
  const realSetTimeout = global.setTimeout;
  let armed = 0;
  global.setTimeout = (fn, ms, ...rest) => { armed++; return realSetTimeout(fn, ms, ...rest); };
  const r = new MmuiReadiness({ holdMs: 3e9 });
  try {
    r.notify('mmui-ready');
    r.whenReleased(() => {});
    await new Promise((done) => realSetTimeout(done, 100));
  } finally {
    global.setTimeout = realSetTimeout;
    r.stop();
  }
  assert.ok(armed <= 2, `timer armed ${armed} times in 100 ms`);
});

test('proxy: an IPv6 guest host is bracketed in the guest URL', () => {
  const { ProxyService } = require('../lib/proxy');
  const svc = new ProxyService({ service: { key: 'dbapi', port: 2766 }, qemuHost: '::1', stats: {} });
  assert.equal(new URL(svc.guestUrl).hostname, '[::1]');
  assert.equal(new URL(svc.guestUrl).port, '12766');
});

test('css: -o-linear-gradient directions are converted to the standard syntax', () => {
  const cases = [
    ['-o-linear-gradient(top, #000, #fff)', 'linear-gradient(to bottom, #000, #fff)'],
    ['-o-linear-gradient(left,#000 0%,#fff 100%)', 'linear-gradient(to right,#000 0%,#fff 100%)'],
    ['-o-linear-gradient(bottom, #000, #fff)', 'linear-gradient(to top, #000, #fff)'],
    ['-o-linear-gradient(right, #000, #fff)', 'linear-gradient(to left, #000, #fff)'],
    ['-o-linear-gradient(top left, #000, #fff)', 'linear-gradient(to bottom right, #000, #fff)'],
    ['-o-linear-gradient(0deg, #000, #fff)', 'linear-gradient(90deg, #000, #fff)'],
    ['-o-linear-gradient(90deg, #000, #fff)', 'linear-gradient(0deg, #000, #fff)'],
    ['-o-linear-gradient(45deg, #000, #fff)', 'linear-gradient(45deg, #000, #fff)'],
    ['-o-linear-gradient(#000, #fff)', 'linear-gradient(#000, #fff)'],
  ];
  for (const [input, want] of cases) assert.equal(transformCss(`a { background: ${input} }`).css, `a { background: ${want} }`, input);
});

test('proxy: a bracketed IPv6 guest host is not bracketed twice', () => {
  const { ProxyService } = require('../lib/proxy');
  const svc = new ProxyService({ service: { key: 'dbapi', port: 2766 }, qemuHost: '[::1]', stats: {} });
  assert.equal(new URL(svc.guestUrl).hostname, '[::1]');
});

test('css: translation time stays linear for unterminated gradients', () => {
  const input = '-o-linear-gradient('.repeat(200000);
  const started = Date.now();
  transformCss(input);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms for ${input.length} bytes`);
});

test('access: Host and Origin allowlist', () => {
  const { createAccessPolicy } = require('../lib/access');
  const loopback = createAccessPolicy({ host: '127.0.0.1', httpPort: 8080 });
  const hosts = [
    [undefined, true], ['localhost', true], ['localhost:8080', true], ['LOCALHOST:2700', true],
    ['127.0.0.1:8080', true], ['127.5.6.7', true], ['[::1]:8080', true], ['[::1]', true],
    ['evil.example', false], ['evil.example:8080', false], ['192.168.1.5:8080', false], ['localhost.evil.example', false],
    ['127.0.0.1.evil.example', false], ['', false],
  ];
  for (const [header, want] of hosts) assert.equal(loopback.hostAllowed(header), want, `Host ${header}`);
  const origins = [
    [undefined, true], ['http://127.0.0.1:8080', true], ['http://localhost:8080', true], ['http://[::1]:8080', true],
    ['https://evil.example', false], ['http://evil.example:8080', false], ['http://127.0.0.1:9999', false],
    ['http://127.0.0.1', false], ['null', false], ['not a url', false], ['https://127.0.0.1:8080', false],
  ];
  for (const [header, want] of origins) assert.equal(loopback.originAllowed(header), want, `Origin ${header}`);

  const named = createAccessPolicy({ host: 'devbox.lan', httpPort: 8080 });
  assert.equal(named.hostAllowed('devbox.lan:8080'), true);
  assert.equal(named.originAllowed('http://devbox.lan:8080'), true);
  assert.equal(named.hostAllowed('192.168.1.5'), false);

  const wildcard = createAccessPolicy({ host: '0.0.0.0', httpPort: 8080 });
  assert.equal(wildcard.hostAllowed('192.168.1.5:8080'), true, 'any IP literal when HOST is a wildcard');
  assert.equal(wildcard.originAllowed('http://192.168.1.5:8080'), true);
  assert.equal(wildcard.hostAllowed('evil.example'), false, 'hostnames still need the allowlist');
});

test('config: a non-loopback HOST produces a warning naming what is exposed', () => {
  const { exposureWarning } = require('../lib/config');
  const { root } = makeRoot();
  for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '::1']) {
    assert.equal(exposureWarning(loadConfig({ ROOTFS_PATH: root, HOST: host })), null, host);
  }
  const mock = exposureWarning(loadConfig({ ROOTFS_PATH: root, HOST: '0.0.0.0' }));
  assert.match(mock, /0\.0\.0\.0/);
  assert.match(mock, /diagnostics/);
  assert.doesNotMatch(mock, /display-control/);
  assert.match(exposureWarning(loadConfig({ ROOTFS_PATH: root, HOST: '192.168.1.5', PROXY_MODE: 'true' })), /display-control/);
});

test('display: after guest loss, a splash belongs to the next connection, even before it opens', () => {
  const { bridge, sender } = bridgeWithSender();
  bridge.attachGuest(sender);
  bridge.frontendMessage({ msgType: 'event', eventId: 'InitializeGuiComplete' });
  bridge.controlNotification('splash-complete surface=TRANLOGO_SURFACE');
  bridge.detachGuest(sender); // the guest connection is lost
  bridge.controlNotification('splash-complete surface=TRANLOGO_SURFACE');
  const next = [];
  bridge.attachGuest((o) => { next.push(o.eventId); return true; });
  bridge.finishIfPending();
  assert.deepEqual(next, ['FinishIntroAnimation']);
});
