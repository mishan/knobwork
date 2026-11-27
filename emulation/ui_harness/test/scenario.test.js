'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { validateScenario, loadScenarioFile, ScenarioSession, ScenarioStats, ScenarioError, SEQUENCE_MAX } = require('../lib/scenario');
const { parseJsonObject } = require('../lib/frames');
const { DEFAULT_SCENARIO } = require('../lib/harness');
const { makeTemp } = require('./helpers');

function base(extra = {}) {
  return Object.assign({
    schema: 'mazda-cmu-ui-scenario',
    version: 1,
    contexts: { A: { uiaId: 'app', ctxtId: 'A', focus: ['app'] }, B: { uiaId: 'app', ctxtId: 'B', focus: ['app'] } },
    services: { mmui: { rules: [] } },
  }, extra);
}

function session(scenario, service = 'mmui') {
  const sent = [];
  const closed = [];
  const stats = new ScenarioStats();
  const s = new ScenarioSession(scenario, service, { send: (t) => sent.push(t), close: (c, r) => closed.push([c, r]) }, stats);
  s.start();
  const event = (eventId, extra = {}) => s.handleFrame(Buffer.from(JSON.stringify(Object.assign({ msgType: 'event', eventId, uiaId: 'system' }, extra))), false);
  const parsed = () => sent.map((t) => parseJsonObject(Buffer.from(t)));
  return { s, sent, closed, stats, event, parsed };
}

const withRule = (rule, service = 'mmui') => base({ services: { [service]: { rules: [Object.assign({ id: 'r', match: {}, actions: [] }, rule)] } } });
const withActions = (actions, service) => withRule({ actions }, service);
const withWhen = (when) => withRule({ when });

test('scenario: every validation clause rejects, and every limit accepts its exact bound', () => {
  const big = (n) => ({ t: 'x'.repeat(n - 8) }); // JSON.stringify adds 8 bytes: {"t":""}
  const rejected = [
    ['not an object', () => [], /must be a JSON object/],
    ['schema', () => base({ schema: 'other' }), /schema/],
    ['version', () => base({ version: 2 }), /unsupported version/],
    ['limit not an integer', () => base({ limits: { maxDelayMs: 1.5 } }), /limits.maxDelayMs/],
    ['limit negative', () => base({ limits: { maxInboundBytes: -1 } }), /limits.maxInboundBytes/],
    ['limit over its maximum', () => base({ limits: { maxDelayMs: 10001 } }), /limits.maxDelayMs/],
    ['context not an object', () => base({ contexts: { A: 'x' } }), /uiaId and ctxtId/],
    ['context without uiaId', () => base({ contexts: { A: { ctxtId: 'A', focus: ['a'] } } }), /uiaId and ctxtId/],
    ['context without ctxtId', () => base({ contexts: { A: { uiaId: 'a', focus: ['a'] } } }), /uiaId and ctxtId/],
    ['focus empty', () => base({ contexts: { A: { uiaId: 'a', ctxtId: 'A', focus: [] } } }), /focus/],
    ['focus not strings', () => base({ contexts: { A: { uiaId: 'a', ctxtId: 'A', focus: [1] } } }), /focus/],
    ['focus with one non-string', () => base({ contexts: { A: { uiaId: 'a', ctxtId: 'A', focus: ['a', 1] } } }), /focus/],
    ['params not an object', () => base({ contexts: { A: { uiaId: 'a', ctxtId: 'A', focus: ['a'], params: [] } } }), /params/],
    ['unknown service', () => base({ services: { other: {} } }), /unknown service/],
    ['service not an object', () => base({ services: { mmui: [] } }), /must be an object/],
    ['rules not a list', () => base({ services: { mmui: { rules: {} } } }), /lists/],
    ['onConnect not a list', () => base({ services: { mmui: { onConnect: {} } } }), /lists/],
    ['rule not an object', () => base({ services: { mmui: { rules: [1] } } }), /rule must be an object/],
    ['rule without id', () => withRule({ id: '' }), /needs an id/],
    ['rule id not a string', () => withRule({ id: 5 }), /needs an id/],
    ['invalid onConnect action', () => base({ services: { dbapi: { onConnect: [{ type: 'explode' }] } } }), /onConnect\[0\]/],
    ['rule without match', () => withRule({ match: null }), /match object/],
    ['match value not scalar', () => withRule({ match: { a: { b: 1 } } }), /scalars/],
    ['actions not a list', () => withRule({ actions: {} }), /actions list/],
    ['too many actions', () => base({ limits: { maxActionsPerMessage: 1 }, services: { mmui: { rules: [{ id: 'r', match: {}, actions: [{ type: 'timeout' }, { type: 'timeout' }] }] } } }), /too many/],
    ['predicate not an object', () => withWhen(1), /predicate must be an object/],
    ['predicate with two keys', () => withWhen({ contextIs: 'A', contextIsNot: 'B' }), /exactly one/],
    ['unknown predicate', () => withWhen({ magic: 1 }), /exactly one/],
    ['contextIs unknown', () => withWhen({ contextIs: 'Nope' }), /unknown context/],
    ['contextIsNot not a string', () => withWhen({ contextIsNot: 1 }), /unknown context/],
    ['stackDepthAtLeast fractional', () => withWhen({ stackDepthAtLeast: 1.5 }), /small integer/],
    ['stackDepthAtLeast negative', () => withWhen({ stackDepthAtLeast: -1 }), /small integer/],
    ['stackDepthAtLeast over 64', () => withWhen({ stackDepthAtLeast: 65 }), /small integer/],
    ['stateEquals not an object', () => withWhen({ stateEquals: 'x' }), /path and value/],
    ['stateEquals without path', () => withWhen({ stateEquals: { value: 1 } }), /path and value/],
    ['stateEquals without value', () => withWhen({ stateEquals: { path: 'a' } }), /path and value/],
    ['all empty', () => withWhen({ all: [] }), /non-empty list/],
    ['any not a list', () => withWhen({ any: {} }), /non-empty list/],
    ['invalid inside all', () => withWhen({ all: [{ magic: 1 }] }), /all\[0\]/],
    ['invalid inside any', () => withWhen({ any: [{ magic: 1 }] }), /any\[0\]/],
    ['invalid inside not', () => withWhen({ not: { magic: 1 } }), /\.not/],
    ['action not an object', () => withActions([1]), /action must be an object/],
    ['unknown action type', () => withActions([{ type: 'explode' }]), /unknown action type/],
    ['delay not a number', () => withActions([{ type: 'timeout', delayMs: '5' }]), /delayMs/],
    ['delay not finite', () => withActions([{ type: 'timeout', delayMs: Infinity }]), /delayMs/],
    ['delay negative', () => withActions([{ type: 'timeout', delayMs: -1 }]), /delayMs/],
    ['delay over the limit', () => withActions([{ type: 'timeout', delayMs: 2001 }]), /delayMs/],
    ['context action outside mmui', () => withActions([{ type: 'popContext' }], 'dbapi'), /only valid for mmui/],
    ['send without message', () => withActions([{ type: 'send', message: 'x' }]), /message object/],
    ['send with unknown sequence', () => withActions([{ type: 'send', message: {}, sequence: 'later' }]), /sequence/],
    ['send over maxOutboundBytes', () => withActions([{ type: 'send', message: big(65537) }]), /maxOutboundBytes/],
    ['pushContext unknown', () => withActions([{ type: 'pushContext', context: 'Nope' }]), /unknown context/],
    ['resetContext not a string', () => withActions([{ type: 'resetContext', context: 1 }]), /unknown context/],
    ['setState without path', () => withActions([{ type: 'setState', value: 1 }]), /path and value/],
    ['setState with empty path', () => withActions([{ type: 'setState', path: '', value: 1 }]), /path and value/],
    ['setState without value', () => withActions([{ type: 'setState', path: 'a' }]), /path and value/],
    ['setState path not a string', () => withActions([{ type: 'setState', path: 5, value: 1 }]), /path and value/],
    ...[999, 1001, 2999, 5000, 3000.5, '1000'].map((code) => [`disconnect code ${code}`, () => withActions([{ type: 'disconnect', code }]), /disconnect code/]),
    ['duplicate of an invalid action', () => withActions([{ type: 'duplicate', action: { type: 'explode' } }]), /action\.?.*unknown action type/],
    ['reorder of one action', () => withActions([{ type: 'reorder', actions: [{ type: 'timeout' }] }]), /at least two/],
    ...['disconnect', 'timeout'].map((type) => [`duplicate of ${type}`, () => withActions([{ type: 'duplicate', action: { type } }]), /cannot be nested/]),
    ['reorder containing a disconnect', () => withActions([{ type: 'reorder', actions: [{ type: 'send', message: {} }, { type: 'disconnect' }] }]), /cannot be nested/],
    ['nested delay', () => withActions([{ type: 'duplicate', action: { type: 'send', message: {}, delayMs: 5 } }]), /nested/],
    ['duplicate inside duplicate', () => withActions([{ type: 'duplicate', action: { type: 'duplicate', action: { type: 'send', message: {} } } }]), /cannot be nested/],
    ['reorder inside duplicate', () => withActions([{ type: 'duplicate', action: { type: 'reorder', actions: [{ type: 'send', message: {} }, { type: 'send', message: {} }] } }]), /cannot be nested/],
    ['reorder of invalid actions', () => withActions([{ type: 'reorder', actions: [{ type: 'send', message: {} }, { type: 'explode' }] }]), /actions\[1\]/],
    ['malformed without text', () => withActions([{ type: 'malformed', text: 5 }]), /bounded text/],
    ['malformed over the limit', () => withActions([{ type: 'malformed', text: 'x'.repeat(65537) }]), /bounded text/],
  ];
  for (const [name, make, pattern] of rejected) {
    assert.throws(() => validateScenario(make()), (e) => e instanceof ScenarioError && pattern.test(e.message), name);
  }
  const accepted = [
    ['limits at their maximums', () => base({ limits: { maxDelayMs: 10000, maxInboundBytes: 1048576, maxOutboundBytes: 1048576, maxActionsPerMessage: 1024 } })],
    ['limits at zero', () => base({ limits: { maxDelayMs: 0, maxInboundBytes: 0, maxOutboundBytes: 65536, maxActionsPerMessage: 0 } })],
    ['actions at maxActionsPerMessage', () => base({ limits: { maxActionsPerMessage: 2 }, services: { mmui: { rules: [{ id: 'r', match: {}, actions: [{ type: 'timeout' }, { type: 'timeout' }] }] } } })],
    ['stackDepthAtLeast 0 and 64', () => withWhen({ all: [{ stackDepthAtLeast: 0 }, { stackDepthAtLeast: 64 }] })],
    ['delay 0 and at the limit', () => withActions([{ type: 'timeout', delayMs: 0 }, { type: 'timeout', delayMs: 2000 }])],
    ['send exactly maxOutboundBytes', () => withActions([{ type: 'send', message: big(65536) }])],
    ['malformed exactly maxOutboundBytes', () => withActions([{ type: 'malformed', text: 'x'.repeat(65536) }])],
    ['every sequence mode', () => withActions(['none', 'current', 'next'].map((sequence) => ({ type: 'send', message: {}, sequence })))],
    ['disconnect codes 1000, 3000, 4999, none', () => withActions([1000, 3000, 4999].map((code) => ({ type: 'disconnect', code })).concat([{ type: 'disconnect' }]))],
    ['context params object', () => base({ contexts: { A: { uiaId: 'a', ctxtId: 'A', focus: ['a'], params: {} } } })],
    ['null match value', () => withRule({ match: { a: null } })],
  ];
  for (const [name, make] of accepted) assert.doesNotThrow(() => validateScenario(make()), name);
});

test('scenario: loader rejects malformed and oversized files', () => {
  const dir = makeTemp();
  const p = path.join(dir, 's.json');
  fs.writeFileSync(p, '{ not json');
  assert.throws(() => loadScenarioFile(p), /not valid JSON/);
  fs.writeFileSync(p, ' '.repeat(1024 * 1024 + 1));
  assert.throws(() => loadScenarioFile(p), /at most/);
  assert.throws(() => loadScenarioFile(path.join(dir, 'missing.json')), /unavailable/);
});

test('scenario: the default v74 scenario validates and contains no code', () => {
  const s = loadScenarioFile(DEFAULT_SCENARIO);
  assert.equal(s.version, 1);
  const text = fs.readFileSync(DEFAULT_SCENARIO, 'utf8');
  assert.ok(!/function|=>|<script/i.test(text));
});

test('scenario: default startup, HomeScreen, Applications, and Back', () => {
  const t = session(loadScenarioFile(DEFAULT_SCENARIO));
  t.event('Global.GetStartupSettings', { uiaId: 'common' });
  const settings = t.parsed().map((p) => p.object);
  assert.ok(settings.every((m) => m.msgType === 'msg' && m.uiaId === 'syssettings'));
  const byId = Object.fromEntries(settings.map((m) => [m.msgId, m.params.payload]));
  assert.equal(byId.Region.RegionValue, 'Region_NorthAmerica');
  assert.equal(byId.LanguageSupported.languageName.languageID, 'LANGS_US_ENGLISH');
  assert.equal(byId.KeyboardLanguage.keyboardLanguage, 'LANGS_KB_US_ENGLISH');
  assert.equal(byId.TimeFormat.timeFormat, '12hrs');

  // Navigation before InitGui is ignored.
  t.sent.length = 0;
  t.event('Global.IntentHome', { uiaId: 'common' });
  assert.equal(t.sent.length, 0);

  t.event('Global.InitGui', { uiaId: 'common' });
  let frames = t.parsed();
  assert.ok(frames.some((f) => f.object.msgId === 'StatusMenu' && f.object.params.payload.statusMenu.appName === 'syssettings'));
  const ctx = frames.slice(-3);
  assert.deepEqual(ctx.map((f) => f.object.msgType), ['ctxtChg', 'focusStack', 'transition']);
  assert.equal(ctx[0].object.ctxtId, 'HomeScreen');
  const seq1 = ctx[0].seq;
  assert.ok(seq1 >= 1 && seq1 <= 255);
  assert.ok(ctx.every((f) => f.seq === seq1));
  assert.equal(ctx[0].object.contextSeq, seq1);
  assert.equal(ctx[2].object.enabled, false);

  t.sent.length = 0;
  t.event('SelectApplications');
  frames = t.parsed();
  assert.equal(frames[0].object.ctxtId, 'Applications');
  assert.ok(frames[0].seq > seq1);
  assert.equal(frames[0].object.contextSeq, frames[0].seq);

  t.sent.length = 0;
  t.event('Global.GoBack', { uiaId: 'common' });
  frames = t.parsed();
  assert.equal(frames[0].object.ctxtId, 'HomeScreen');

  // Back at the root context does nothing.
  t.sent.length = 0;
  t.event('Global.GoBack', { uiaId: 'common' });
  assert.equal(t.sent.length, 0);
  assert.deepEqual(t.s.stack, ['HomeScreen']);

  for (const [eventId, ctxtId] of [['SelectEntertainment', 'Entertainment'], ['SelectCommunication', 'Communication'],
    ['SelectNavigation', 'NaviLoading'], ['SelectSettings', 'DevicesTab']]) {
    t.sent.length = 0;
    t.event(eventId);
    assert.equal(t.parsed()[0].object.ctxtId, ctxtId, eventId);
  }
  t.sent.length = 0;
  t.event('Global.IntentHome', { uiaId: 'common' });
  assert.equal(t.parsed()[0].object.ctxtId, 'HomeScreen');
  assert.deepEqual(t.s.stack, ['HomeScreen']);
  // Home before InitGui and Back at the root are recorded as unhandled.
  assert.equal(t.stats.services.mmui.unhandled.items.length, 2);
});

test('scenario: context stacks are per client', () => {
  const sc = loadScenarioFile(DEFAULT_SCENARIO);
  const a = session(sc);
  const b = session(sc);
  a.event('Global.InitGui', { uiaId: 'common' });
  b.event('Global.InitGui', { uiaId: 'common' });
  a.event('SelectApplications');
  assert.deepEqual(a.s.stack, ['HomeScreen', 'Applications']);
  assert.deepEqual(b.s.stack, ['HomeScreen']);
});

test('scenario: sequence values advance, stay nonzero, and wrap within one byte', () => {
  const sc = validateScenario(base({
    services: { mmui: { rules: [{ id: 'flip', match: { eventId: 'x' }, actions: [{ type: 'resetContext', context: 'A' }] }] } },
  }));
  const t = session(sc);
  const seen = [];
  for (let i = 0; i < SEQUENCE_MAX + 5; i++) {
    t.sent.length = 0;
    t.event('x');
    seen.push(t.parsed()[0].seq);
  }
  assert.ok(seen.every((v) => v >= 1 && v <= SEQUENCE_MAX));
  assert.equal(seen[0], 1);
  assert.equal(seen[SEQUENCE_MAX], 1);
});

test('scenario: invalid and oversized mock input is counted, not fatal', () => {
  const t = session(validateScenario(base({ limits: { maxInboundBytes: 200 } })));
  t.s.handleFrame(Buffer.from('{ broken'), false);
  t.s.handleFrame(Buffer.from('x'.repeat(300)), false);
  t.s.handleFrame(Buffer.from([1, 2, 3]), true);
  t.event('nobody');
  const st = t.stats.services.mmui;
  assert.equal(st.invalid, 1);
  assert.equal(st.oversized, 1);
  assert.equal(st.receivedBinary, 1);
  assert.equal(st.unhandled.items.length, 1);
});

test('scenario: fault actions: duplicate, reorder, malformed, timeout, disconnect, delay', async () => {
  const sc = validateScenario(base({
    services: {
      mmui: {
        rules: [
          { id: 'dup', match: { eventId: 'dup' }, actions: [{ type: 'duplicate', action: { type: 'send', message: { n: 1 } } }] },
          { id: 'reo', match: { eventId: 'reo' }, actions: [{ type: 'reorder', actions: [{ type: 'send', message: { n: 1 } }, { type: 'send', message: { n: 2 } }] }] },
          { id: 'bad', match: { eventId: 'bad' }, actions: [{ type: 'malformed', text: '{"oops"' }] },
          { id: 'quiet', match: { eventId: 'quiet' }, actions: [{ type: 'timeout' }] },
          { id: 'late', match: { eventId: 'late' }, actions: [{ type: 'send', message: { n: 'slow' }, delayMs: 30 }, { type: 'send', message: { n: 'after' } }] },
          { id: 'bye', match: { eventId: 'bye' }, actions: [{ type: 'disconnect', code: 4000, reason: 'test' }] },
        ],
      },
    },
  }));
  const t = session(sc);
  t.event('dup');
  assert.deepEqual(t.sent, ['{"n":1}', '{"n":1}']);
  t.sent.length = 0;
  t.event('reo');
  assert.deepEqual(t.sent, ['{"n":2}', '{"n":1}']);
  t.sent.length = 0;
  t.event('bad');
  assert.deepEqual(t.sent, ['{"oops"']);
  t.sent.length = 0;
  t.event('quiet');
  assert.deepEqual(t.sent, []);
  t.event('late');
  assert.deepEqual(t.sent, []);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(t.sent, ['{"n":"slow"}', '{"n":"after"}'], 'delays preserve order');
  t.event('bye');
  assert.deepEqual(t.closed, [[4000, 'test']]);
  t.s.close();
});

test('scenario: state predicates and placeholders', () => {
  const sc = validateScenario(base({
    initialState: { user: { name: 'n1' } },
    services: {
      mmui: {
        rules: [
          { id: 'set', match: { eventId: 'set' }, actions: [{ type: 'setState', path: 'flag', value: true }] },
          { id: 'gated', match: { eventId: 'go' }, when: { all: [{ stateEquals: { path: 'flag', value: true } }, { not: { contextIs: 'B' } }] }, actions: [{ type: 'send', message: { who: { $state: 'user.name' } } }] },
          { id: 'proto', match: { eventId: 'proto' }, actions: [{ type: 'setState', path: '__proto__.polluted', value: 1 }] },
        ],
      },
    },
  }));
  const t = session(sc);
  t.event('go');
  assert.deepEqual(t.sent, []);
  t.event('set');
  t.event('go');
  assert.deepEqual(t.sent, ['{"who":"n1"}']);
  t.event('proto');
  assert.equal({}.polluted, undefined);
});

test('scenario: pending output is bounded and dropped on close', async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ type: 'send', message: { i }, delayMs: 1 }));
  const sc = validateScenario(base({
    limits: { maxActionsPerMessage: 300 },
    services: { mmui: { rules: [
      { id: 'flood', match: { eventId: 'flood' }, actions: many },
      { id: 'later', match: { eventId: 'later' }, actions: [{ type: 'send', message: { late: true }, delayMs: 30 }] },
    ] } },
  }));
  const flood = session(sc);
  flood.event('flood');
  assert.deepEqual(flood.closed, [[1011, 'mock scenario timer limit']]);
  assert.equal(flood.s.pending.length, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(flood.sent.length, 0, 'nothing is emitted after the limit closes the session');

  const t = session(sc);
  t.event('later');
  t.s.close();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(t.sent, []);
});

// Fires timers that fall due together in reverse insertion order, which a
// real timer service is free to do; output order must not depend on it.
function adversarialClock() {
  let now = 0;
  let id = 0;
  const pending = new Map();
  return {
    now: () => ++now,
    advance: (ms) => { now += ms; },
    setTimeout: (fn, ms) => { const t = ++id; pending.set(t, { due: now + ms, fn, t }); return t; },
    clearTimeout: (t) => pending.delete(t),
    runAll() {
      while (pending.size) {
        const [next] = [...pending.values()].sort((a, b) => a.due - b.due || b.t - a.t);
        pending.delete(next.t);
        now = Math.max(now, next.due);
        next.fn();
      }
    },
  };
}

test('scenario: delayed output keeps action order whatever order timers fire in', () => {
  const sc = validateScenario(base({
    services: { mmui: { rules: [{ id: 'late', match: { eventId: 'late' }, actions: [
      { type: 'send', message: { n: 1 }, delayMs: 30 },
      { type: 'send', message: { n: 2 } },
      { type: 'send', message: { n: 3 }, delayMs: 5 },
      { type: 'send', message: { n: 4 } },
    ] }] } },
  }));
  const clock = adversarialClock();
  const sent = [];
  const s = new ScenarioSession(sc, 'mmui', { send: (x) => sent.push(x), close: () => {} }, new ScenarioStats(), clock);
  s.start();
  s.handleFrame(Buffer.from('{"eventId":"late"}'), false);
  assert.deepEqual(sent, []);
  clock.runAll();
  assert.deepEqual(sent, ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}']);
});

function fakeSession(scenario, service = 'mmui', clock) {
  const sent = [];
  const closed = [];
  const s = new ScenarioSession(scenario, service, { send: (x) => sent.push(x), close: (c) => closed.push(c) }, new ScenarioStats(), clock);
  s.start();
  const frame = (o) => s.handleFrame(Buffer.from(JSON.stringify(o)), false);
  return { s, sent, closed, frame };
}

test('scenario: every predicate evaluates against the session', () => {
  const { s } = fakeSession(validateScenario(base({ initialState: { mode: 'x' } })));
  s.stack = ['A', 'B'];
  const cases = [
    [{ contextIs: 'B' }, true], [{ contextIs: 'A' }, false],
    [{ contextIsNot: 'A' }, true], [{ contextIsNot: 'B' }, false],
    [{ stackDepthAtLeast: 2 }, true], [{ stackDepthAtLeast: 3 }, false],
    [{ stateEquals: { path: 'mode', value: 'x' } }, true], [{ stateEquals: { path: 'mode', value: 'y' } }, false],
    [{ all: [{ contextIs: 'B' }, { stackDepthAtLeast: 2 }] }, true], [{ all: [{ contextIs: 'B' }, { contextIs: 'A' }] }, false],
    [{ any: [{ contextIs: 'A' }, { contextIs: 'B' }] }, true], [{ any: [{ contextIs: 'A' }, { stackDepthAtLeast: 3 }] }, false],
    [{ not: { contextIs: 'A' } }, true], [{ not: { contextIs: 'B' } }, false],
  ];
  for (const [pred, want] of cases) assert.equal(s.evaluate(pred), want, JSON.stringify(pred));
});

test('scenario: setState never reaches a prototype, and nested paths are created', () => {
  const paths = ['__proto__.polluted', 'constructor.prototype.polluted', 'a.__proto__.polluted', 'prototype.polluted',
    'a.constructor.prototype.polluted', '__proto__', 'constructor', 'a.prototype'];
  const sc = validateScenario(base({ services: { mmui: { rules: paths.map((path, i) => (
    { id: `p${i}`, match: { eventId: `p${i}` }, actions: [{ type: 'setState', path, value: { polluted: 1 } }] })).concat([
    { id: 'nest', match: { eventId: 'nest' }, actions: [{ type: 'setState', path: 'a.b.c', value: 7 },
      { type: 'setState', path: 'a.b.d', value: 8 }, { type: 'setState', path: 'n', value: null },
      { type: 'send', message: { list: [{ $state: 'a.b.c' }, 2], obj: { $state: 'a.b.c', extra: 1 },
        sibling: { $state: 'a.b.d' }, throughNull: { $state: 'n.x' }, inherited: { $state: 'toString' } } }] },
  ]) } } }));
  const { s, sent, frame } = fakeSession(sc);
  const protoKeys = Object.getOwnPropertyNames(Object.prototype).join();
  paths.forEach((_, i) => frame({ eventId: `p${i}` }));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.polluted, undefined);
  assert.equal(Object.getOwnPropertyNames(Object.prototype).join(), protoKeys);
  assert.equal(Object.getPrototypeOf(s.state), Object.prototype, 'the state object keeps its prototype');
  frame({ eventId: 'nest' });
  assert.deepEqual(JSON.parse(sent.at(-1)), { list: [7, 2], obj: { $state: 'a.b.c', extra: 1 }, sibling: 8 });
});

test('scenario: onConnect actions run when a client connects', () => {
  const sc = validateScenario(base({ services: { dbapi: { onConnect: [{ type: 'send', message: { hello: 1 } }] } } }));
  assert.deepEqual(fakeSession(sc, 'dbapi').sent, ['{"hello":1}']);
});

test('scenario: sequence modes none, next, and current', () => {
  const sc = validateScenario(base({ services: { mmui: { rules: ['none', 'next', 'current'].map((sequence) => (
    { id: sequence, match: { eventId: sequence }, actions: [{ type: 'send', message: { m: sequence }, sequence }] })) } } }));
  const fresh = fakeSession(sc);
  fresh.frame({ eventId: 'current' });
  assert.equal(fresh.sent[0], '{"m":"current"}\u0001', 'current allocates the first value');
  const { sent, frame } = fakeSession(sc);
  frame({ eventId: 'none' });
  frame({ eventId: 'next' });
  frame({ eventId: 'current' });
  frame({ eventId: 'next' });
  frame({ eventId: 'current' });
  assert.deepEqual(sent, ['{"m":"none"}', '{"m":"next"}\u0001', '{"m":"current"}\u0001', '{"m":"next"}\u0002',
    '{"m":"current"}\u0002']);
});

test('scenario: stack edges: same top, depth cap, and pop at the root', () => {
  const sc = validateScenario(base({ services: { mmui: { rules: [
    { id: 'a', match: { eventId: 'a' }, actions: [{ type: 'pushContext', context: 'A' }] },
    { id: 'b', match: { eventId: 'b' }, actions: [{ type: 'pushContext', context: 'B' }] },
    { id: 'pop', match: { eventId: 'pop' }, actions: [{ type: 'popContext' }] },
  ] } } }));
  const { s, sent, frame } = fakeSession(sc);
  frame({ eventId: 'a' });
  frame({ eventId: 'a' });
  assert.deepEqual(s.stack, ['A'], 'pushing the current top does not grow the stack');
  assert.equal(sent.length, 6, 'but the context is announced again');
  for (let i = 0; i < 70; i++) frame({ eventId: i % 2 ? 'a' : 'b' });
  assert.equal(s.stack.length, 64);
  const { s: root, sent: rootSent, frame: rootFrame } = fakeSession(sc);
  rootFrame({ eventId: 'a' });
  rootFrame({ eventId: 'pop' });
  assert.deepEqual(root.stack, ['A']);
  assert.match(rootSent.at(-3), /"ctxtId":"A"/, 'pop at the root re-announces the root');
});

test('scenario: inbound and pending limits hold at their exact bounds', () => {
  const sc = validateScenario(base({ limits: { maxInboundBytes: 40, maxActionsPerMessage: 300 }, services: { mmui: { rules: [
    { id: 'x', match: { eventId: 'x' }, actions: [] },
    { id: 'n256', match: { eventId: 'n256' }, actions: Array.from({ length: 256 }, () => ({ type: 'send', message: {}, delayMs: 1 })) },
    { id: 'n257', match: { eventId: 'n257' }, actions: Array.from({ length: 257 }, () => ({ type: 'send', message: {}, delayMs: 1 })) },
  ] } } }));
  const { s } = fakeSession(sc);
  const exact = Buffer.from(JSON.stringify({ eventId: 'x', pad: 'p'.repeat(40 - 24) }));
  assert.equal(exact.length, 40);
  s.handleFrame(exact, false);
  s.handleFrame(Buffer.concat([exact, Buffer.from(' ')]), false);
  assert.equal(s.stats.handled, 1);
  assert.equal(s.stats.oversized, 1);
  const ok = fakeSession(sc, 'mmui', adversarialClock());
  ok.frame({ eventId: 'n256' });
  assert.deepEqual(ok.closed, [], '256 pending outputs are allowed');
  const over = fakeSession(sc, 'mmui', adversarialClock());
  over.frame({ eventId: 'n257' });
  assert.deepEqual(over.closed, [1011]);
});

test('scenario: a late timer never lets newer output overtake older output', () => {
  const sc = validateScenario(base({ services: { mmui: { rules: [
    { id: 'slow', match: { eventId: 'slow' }, actions: [{ type: 'send', message: { n: 'slow' }, delayMs: 10 }] },
    { id: 'now', match: { eventId: 'now' }, actions: [{ type: 'send', message: { n: 'now' } }] },
  ] } } }));
  const clock = adversarialClock();
  const { sent, frame } = fakeSession(sc, 'mmui', clock);
  frame({ eventId: 'slow' });
  clock.advance(50); // the timer is overdue but has not fired yet
  frame({ eventId: 'now' });
  clock.runAll();
  assert.deepEqual(sent, ['{"n":"slow"}', '{"n":"now"}']);
});

test('scenario: context frames carry the focus list and params', () => {
  const sc = validateScenario(base({
    contexts: { A: { uiaId: 'app', ctxtId: 'A', focus: ['app', 'system'] } },
    services: { mmui: { rules: [{ id: 'a', match: { eventId: 'a' }, actions: [{ type: 'resetContext', context: 'A' }] }] } },
  }));
  const { sent, frame } = fakeSession(sc);
  frame({ eventId: 'a' });
  const [ctx, focus] = sent.map((t) => JSON.parse(t.slice(0, -1)));
  assert.deepEqual(ctx.params, {}, 'a context without params announces an empty object');
  assert.deepEqual(focus.appIdList, [{ id: 'app' }, { id: 'system' }]);
});
