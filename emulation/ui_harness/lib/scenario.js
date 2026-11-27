'use strict';

// Versioned, data-driven mock scenario engine. A scenario file describes the
// initial state, inbound message shapes, predicates, state transitions, and
// ordered outbound actions for each frontend service. This module knows the
// action vocabulary but nothing about any particular HMI screen.

const fs = require('fs');
const { parseJsonObject, summarize, encodeMmui, BoundedList } = require('./frames');

const SCHEMA = 'mazda-cmu-ui-scenario';
const SUPPORTED_VERSIONS = new Set([1]);
const SERVICES = ['mmui', 'dbapi', 'appsdk'];
const SCHEMA_MAX_DELAY_MS = 10000;
const SCHEMA_MAX_INBOUND_BYTES = 1024 * 1024;
const MAX_SCENARIO_FILE_BYTES = 1024 * 1024;
const MAX_PENDING_TIMERS = 256;
const MAX_STACK_DEPTH = 64;
const SEQUENCE_MAX = 127; // stays a single byte in a UTF-8 text frame

const ACTION_TYPES = new Set([
  'send', 'pushContext', 'popContext', 'resetContext', 'setState',
  'disconnect', 'timeout', 'duplicate', 'reorder', 'malformed',
]);
const PREDICATE_KEYS = new Set(['contextIs', 'contextIsNot', 'stackDepthAtLeast', 'stateEquals', 'all', 'any', 'not']);

class ScenarioError extends Error {}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fail(where, message) {
  throw new ScenarioError(`${where}: ${message}`);
}

function validatePredicate(pred, where, contexts) {
  if (!isPlainObject(pred)) fail(where, 'predicate must be an object');
  const keys = Object.keys(pred);
  if (keys.length !== 1 || !PREDICATE_KEYS.has(keys[0])) {
    fail(where, `predicate must have exactly one of ${[...PREDICATE_KEYS].join(', ')}`);
  }
  const [key] = keys;
  const value = pred[key];
  switch (key) {
    case 'contextIs':
    case 'contextIsNot':
      if (typeof value !== 'string' || !contexts[value]) fail(where, `unknown context ${JSON.stringify(value)}`);
      break;
    case 'stackDepthAtLeast':
      if (!Number.isInteger(value) || value < 0 || value > MAX_STACK_DEPTH) fail(where, 'stackDepthAtLeast must be a small integer');
      break;
    case 'stateEquals':
      if (!isPlainObject(value) || typeof value.path !== 'string' || !('value' in value)) {
        fail(where, 'stateEquals needs path and value');
      }
      break;
    case 'all':
    case 'any':
      if (!Array.isArray(value) || value.length === 0) fail(where, `${key} needs a non-empty list`);
      value.forEach((p, i) => validatePredicate(p, `${where}.${key}[${i}]`, contexts));
      break;
    case 'not':
      validatePredicate(value, `${where}.not`, contexts);
      break;
    default:
      break;
  }
}

function validateAction(action, where, scenario, service, nested = false) {
  if (!isPlainObject(action)) fail(where, 'action must be an object');
  if (!ACTION_TYPES.has(action.type)) fail(where, `unknown action type ${JSON.stringify(action.type)}`);
  // duplicate and reorder act on the frames an action produces, so a nested
  // action must produce frames now.
  // Nesting duplicate or reorder would multiply output without a bound.
  if (nested && ['disconnect', 'timeout', 'duplicate', 'reorder'].includes(action.type)) fail(where, `${action.type} cannot be nested`);
  if (nested && 'delayMs' in action) fail(where, 'delayMs cannot be nested; put it on the outer action');
  if ('delayMs' in action) {
    const d = action.delayMs;
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0 || d > scenario.limits.maxDelayMs) {
      fail(where, `delayMs must be from 0 through ${scenario.limits.maxDelayMs}`);
    }
  }
  const contextual = new Set(['pushContext', 'popContext', 'resetContext']);
  if (contextual.has(action.type) && service !== 'mmui') fail(where, `${action.type} is only valid for mmui`);
  switch (action.type) {
    case 'send':
      if (!isPlainObject(action.message)) fail(where, 'send needs a message object');
      if ('sequence' in action && !['none', 'current', 'next'].includes(action.sequence)) {
        fail(where, 'sequence must be none, current, or next');
      }
      if (Buffer.byteLength(JSON.stringify(action.message)) > scenario.limits.maxOutboundBytes) {
        fail(where, 'message exceeds maxOutboundBytes');
      }
      break;
    case 'pushContext':
    case 'resetContext':
      if (typeof action.context !== 'string' || !scenario.contexts[action.context]) {
        fail(where, `unknown context ${JSON.stringify(action.context)}`);
      }
      break;
    case 'setState':
      if (typeof action.path !== 'string' || !action.path || !('value' in action)) fail(where, 'setState needs path and value');
      break;
    case 'disconnect':
      if ('code' in action && !(Number.isInteger(action.code) && (action.code === 1000 || (action.code >= 3000 && action.code <= 4999)))) {
        fail(where, 'disconnect code must be 1000 or 3000-4999');
      }
      break;
    case 'duplicate':
      validateAction(action.action, `${where}.action`, scenario, service, true);
      break;
    case 'reorder':
      if (!Array.isArray(action.actions) || action.actions.length < 2) fail(where, 'reorder needs at least two actions');
      action.actions.forEach((a, i) => validateAction(a, `${where}.actions[${i}]`, scenario, service, true));
      break;
    case 'malformed':
      if (typeof action.text !== 'string' || Buffer.byteLength(action.text) > scenario.limits.maxOutboundBytes) {
        fail(where, 'malformed needs a bounded text');
      }
      break;
    default:
      break;
  }
}

function validateScenario(input) {
  if (!isPlainObject(input)) fail('scenario', 'must be a JSON object');
  if (input.schema !== SCHEMA) fail('scenario', `schema must be ${SCHEMA}`);
  if (!SUPPORTED_VERSIONS.has(input.version)) fail('scenario', `unsupported version ${JSON.stringify(input.version)}`);
  const limits = Object.assign({ maxDelayMs: 2000, maxInboundBytes: 65536, maxOutboundBytes: 65536, maxActionsPerMessage: 64 }, input.limits || {});
  for (const [key, max] of [['maxDelayMs', SCHEMA_MAX_DELAY_MS], ['maxInboundBytes', SCHEMA_MAX_INBOUND_BYTES],
    ['maxOutboundBytes', SCHEMA_MAX_INBOUND_BYTES], ['maxActionsPerMessage', 1024]]) {
    if (!Number.isInteger(limits[key]) || limits[key] < 0 || limits[key] > max) fail(`limits.${key}`, `must be an integer from 0 through ${max}`);
  }
  const scenario = {
    schema: SCHEMA,
    version: input.version,
    name: typeof input.name === 'string' ? input.name : 'unnamed',
    limits,
    initialState: isPlainObject(input.initialState) ? input.initialState : {},
    contexts: isPlainObject(input.contexts) ? input.contexts : {},
    services: {},
  };
  for (const [name, ctx] of Object.entries(scenario.contexts)) {
    if (!isPlainObject(ctx) || typeof ctx.uiaId !== 'string' || typeof ctx.ctxtId !== 'string') {
      fail(`contexts.${name}`, 'needs uiaId and ctxtId strings');
    }
    if (!Array.isArray(ctx.focus) || ctx.focus.length === 0 || !ctx.focus.every((f) => typeof f === 'string')) {
      fail(`contexts.${name}`, 'focus must be a non-empty list of uiaIds');
    }
    if ('params' in ctx && !isPlainObject(ctx.params)) fail(`contexts.${name}`, 'params must be an object');
  }
  const services = isPlainObject(input.services) ? input.services : {};
  for (const key of Object.keys(services)) {
    if (!SERVICES.includes(key)) fail(`services.${key}`, 'unknown service');
  }
  for (const service of SERVICES) {
    const def = services[service] || {};
    if (!isPlainObject(def)) fail(`services.${service}`, 'must be an object');
    const onConnect = def.onConnect || [];
    const rules = def.rules || [];
    if (!Array.isArray(onConnect) || !Array.isArray(rules)) fail(`services.${service}`, 'onConnect and rules must be lists');
    onConnect.forEach((a, i) => validateAction(a, `services.${service}.onConnect[${i}]`, scenario, service));
    rules.forEach((rule, i) => {
      const where = `services.${service}.rules[${i}]`;
      if (!isPlainObject(rule)) fail(where, 'rule must be an object');
      if (typeof rule.id !== 'string' || !rule.id) fail(where, 'rule needs an id');
      if (!isPlainObject(rule.match)) fail(where, 'rule needs a match object');
      for (const v of Object.values(rule.match)) {
        if (v !== null && typeof v === 'object') fail(where, 'match values must be scalars');
      }
      if ('when' in rule) validatePredicate(rule.when, `${where}.when`, scenario.contexts);
      if (!Array.isArray(rule.actions)) fail(where, 'rule needs an actions list');
      if (rule.actions.length > limits.maxActionsPerMessage) fail(where, 'too many actions');
      rule.actions.forEach((a, j) => validateAction(a, `${where}.actions[${j}]`, scenario, service));
    });
    scenario.services[service] = { onConnect, rules };
  }
  return scenario;
}

function loadScenarioFile(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { throw new ScenarioError(`scenario is unavailable: ${file}`); }
  if (!st.isFile() || st.size > MAX_SCENARIO_FILE_BYTES) throw new ScenarioError(`scenario must be a regular file of at most ${MAX_SCENARIO_FILE_BYTES} bytes`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ScenarioError(`scenario is not valid JSON: ${error.message}`);
  }
  return validateScenario(parsed);
}

function getPath(object, dotted) {
  let cur = object;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(object, dotted, value) {
  const parts = dotted.split('.');
  let cur = object;
  for (const part of parts.slice(0, -1)) {
    // __proto__ is the only segment that reaches a prototype; other non-plain values are replaced below.
    if (part === '__proto__') return;
    if (!isPlainObject(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  const last = parts[parts.length - 1];
  if (last === '__proto__') return;
  cur[last] = value;
}

// Replace {"$state": "path"} placeholders with current state values.
function render(template, state) {
  if (Array.isArray(template)) return template.map((t) => render(t, state));
  if (isPlainObject(template)) {
    const keys = Object.keys(template);
    if (keys.length === 1 && keys[0] === '$state') return getPath(state, template.$state);
    const out = {};
    for (const k of keys) out[k] = render(template[k], state);
    return out;
  }
  return template;
}

function matches(match, object) {
  return Object.entries(match).every(([k, v]) => getPath(object, k) === v);
}

// Per-service, per-scenario counters shared by all sessions.
class ScenarioStats {
  constructor() {
    this.services = {};
    for (const s of SERVICES) {
      this.services[s] = {
        connections: 0,
        activeConnections: 0,
        received: 0,
        receivedBinary: 0,
        invalid: 0,
        oversized: 0,
        handled: 0,
        sent: 0,
        faults: 0,
        ruleHits: {},
        unhandled: new BoundedList(50),
        accepted: new BoundedList(50),
      };
    }
  }

  toJSON() {
    const out = {};
    for (const [k, v] of Object.entries(this.services)) {
      out[k] = Object.assign({}, v, { unhandled: v.unhandled.toJSON(), accepted: v.accepted.toJSON() });
    }
    return out;
  }
}

const { performance } = require('perf_hooks');

// Monotonic, so a wall-clock step cannot stall or rush mock output.
const realClock = { now: () => performance.now(), setTimeout, clearTimeout };

class ScenarioSession {
  constructor(scenario, service, sink, stats, clock = realClock) {
    this.clock = clock;
    this.scenario = scenario;
    this.service = service;
    this.sink = sink;
    this.stats = stats.services[service];
    this.state = JSON.parse(JSON.stringify(scenario.initialState));
    this.stack = [];
    this.sequence = 0;
    // Pending output, sorted by due time because `cursor` only moves forward.
    // One timer serves the head, so emit order never depends on timer order.
    this.pending = [];
    this.timer = null;
    this.closed = false;
    this.cursor = 0;
  }

  start() {
    this.stats.connections++;
    this.stats.activeConnections++;
    this.runActions(this.scenario.services[this.service].onConnect);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stats.activeConnections--;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }

  get top() {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }

  evaluate(pred) {
    const [key] = Object.keys(pred);
    const v = pred[key];
    switch (key) {
      case 'contextIs': return this.top === v;
      case 'contextIsNot': return this.top !== v;
      case 'stackDepthAtLeast': return this.stack.length >= v;
      case 'stateEquals': return getPath(this.state, v.path) === v.value;
      case 'all': return v.every((p) => this.evaluate(p));
      case 'any': return v.some((p) => this.evaluate(p));
      case 'not': return !this.evaluate(v);
      default: return false;
    }
  }

  handleFrame(buffer, isBinary) {
    if (this.closed) return;
    if (isBinary) {
      this.stats.receivedBinary++;
      return;
    }
    this.stats.received++;
    if (buffer.length > this.scenario.limits.maxInboundBytes) {
      this.stats.oversized++;
      return;
    }
    const parsed = parseJsonObject(buffer);
    if (!parsed) {
      this.stats.invalid++;
      return;
    }
    const message = parsed.object;
    const summary = summarize(message);
    this.stats.accepted.push(summary);
    const rule = this.scenario.services[this.service].rules.find(
      (r) => matches(r.match, message) && (!r.when || this.evaluate(r.when)));
    if (!rule) {
      this.stats.unhandled.push(summary);
      return;
    }
    this.stats.handled++;
    this.stats.ruleHits[rule.id] = (this.stats.ruleHits[rule.id] || 0) + 1;
    this.runActions(rule.actions);
  }

  // Each action is planned immediately (so state transitions are applied in
  // order) but its output is emitted no earlier than the previous action's.
  runActions(actions) {
    for (const action of actions) this.plan(action);
  }

  schedule(delayMs, fn) {
    if (this.closed) return;
    const now = this.clock.now();
    this.cursor = Math.max(this.cursor, now) + (delayMs || 0);
    if (this.cursor <= now && this.pending.length === 0) {
      fn();
      return;
    }
    if (this.pending.length >= MAX_PENDING_TIMERS) {
      this.stats.faults++;
      this.sink.close(1011, 'mock scenario timer limit');
      this.close();
      return;
    }
    this.pending.push({ due: this.cursor, fn });
    if (!this.timer) this.arm();
  }

  arm() {
    const wait = Math.max(0, this.pending[0].due - this.clock.now());
    this.timer = this.clock.setTimeout(() => this.flush(), wait);
  }

  flush() {
    this.timer = null;
    const now = this.clock.now();
    while (!this.closed && this.pending.length && this.pending[0].due <= now) this.pending.shift().fn();
    if (!this.closed && this.pending.length) this.arm();
  }

  nextSequence() {
    this.sequence = (this.sequence % SEQUENCE_MAX) + 1;
    return this.sequence;
  }

  // Produce output frames for a single action without delays.
  framesFor(action) {
    switch (action.type) {
      case 'send': {
        const message = render(action.message, this.state);
        let seq = null;
        if (action.sequence === 'current') seq = this.sequence || this.nextSequence();
        else if (action.sequence === 'next') seq = this.nextSequence();
        return [encodeMmui(message, seq)];
      }
      case 'pushContext':
        if (this.top !== action.context) {
          this.stack.push(action.context);
          if (this.stack.length > MAX_STACK_DEPTH) this.stack.shift();
        }
        return this.contextFrames();
      case 'popContext':
        if (this.stack.length > 1) this.stack.pop();
        return this.stack.length ? this.contextFrames() : [];
      case 'resetContext':
        this.stack = [action.context];
        return this.contextFrames();
      case 'setState':
        setPath(this.state, action.path, render(action.value, this.state));
        return [];
      case 'malformed':
        this.stats.faults++;
        return [action.text];
      case 'duplicate': {
        this.stats.faults++;
        const frames = this.framesFor(action.action);
        return frames.concat(frames);
      }
      case 'reorder': {
        this.stats.faults++;
        const groups = action.actions.map((a) => this.framesFor(a));
        return [].concat(...groups.reverse());
      }
      default:
        return [];
    }
  }

  plan(action) {
    if (action.type === 'timeout') {
      this.stats.faults++;
      return; // deliberately produce no response
    }
    if (action.type === 'disconnect') {
      this.stats.faults++;
      this.schedule(action.delayMs, () => {
        this.sink.close(action.code || 1000, String(action.reason || 'scenario disconnect').slice(0, 100));
        this.close();
      });
      return;
    }
    const frames = this.framesFor(action);
    const delay = action.delayMs || 0;
    if (frames.length === 0) return;
    this.schedule(delay, () => {
      for (const f of frames) { this.stats.sent++; this.sink.send(f); }
    });
  }

  // ctxtChg, focusStack, and transition share one sequence value so the stock
  // client routes them together in that order.
  contextFrames() {
    const ctx = this.scenario.contexts[this.top];
    const seq = this.nextSequence();
    return [
      encodeMmui({ msgType: 'ctxtChg', uiaId: ctx.uiaId, ctxtId: ctx.ctxtId, contextSeq: seq, params: render(ctx.params || {}, this.state) }, seq),
      encodeMmui({ msgType: 'focusStack', appIdList: ctx.focus.map((id) => ({ id })) }, seq),
      encodeMmui({ msgType: 'transition', enabled: false }, seq),
    ];
  }
}

module.exports = {
  validateScenario,
  loadScenarioFile,
  ScenarioSession,
  ScenarioStats,
  ScenarioError,
  SCHEMA,
  SEQUENCE_MAX,
};
