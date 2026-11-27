'use strict';

// Fail-closed native proxy. Each frontend WebSocket is paired with one guest
// WebSocket on frontend port + 10000 using the same subprotocol. Payload bytes
// and text/binary frame type are forwarded unchanged in both directions. No
// scenario is loaded and no response is ever synthesized here; the only
// injected frames come from the display lifecycle bridge.

const WebSocket = require('ws');
const { describeFrame, parseJsonObject, BoundedList, toBuffer } = require('./frames');

const QUEUE_LIMIT = 256;
const QUEUE_BYTE_LIMIT = 16 * 1024 * 1024;
// Backpressure: stop reading from one side while the other side's send
// buffer is above HIGH_WATER, and resume once it drains below LOW_WATER.
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const CLOSE_UNAVAILABLE = 1013; // Try Again Later: guest service unavailable
const CLOSE_OVERFLOW = 1008; // Policy Violation: early-message queue overflow
const MAX_PAYLOAD = 16 * 1024 * 1024;
const RECENT_LIMIT = 50;
const CONTROL_LIMIT = 200;
const PINNED_LIMIT = 1000;
const CONTROL_TYPES = new Set(['event', 'ctxtChg', 'focusStack', 'transition', 'alertComplete', 'alert']);

class BackendStats {
  constructor(name) {
    this.name = name;
    this.status = 'idle';
    this.connectionAttempts = 0;
    this.activeConnections = 0;
    this.guestConnections = 0;
    this.frontendToGuestMessages = 0;
    this.guestToFrontendMessages = 0;
    this.frontendToGuestBinaryMessages = 0;
    this.guestToFrontendBinaryMessages = 0;
    this.queueDepth = 0;
    this.queueOverflows = 0;
    this.replacedFrontends = 0;
    this.lastError = null;
    this.lastCloseReason = null;
    this.lastConnectedAt = null;
    this.lastMessageAt = null;
    this.recentMessages = new BoundedList(RECENT_LIMIT);
    this.controlRecent = new BoundedList(CONTROL_LIMIT);
    this.controlPinned = [];
    this.pinning = true;
  }

  // Control-message log: entries for the current guest connection are pinned
  // until the HomeScreen context is reached, then roll off normally.
  resetControl() {
    this.controlPinned = [];
    this.controlRecent.clear();
    this.pinning = true;
  }

  recordControl(entry) {
    if (this.pinning && this.controlPinned.length < PINNED_LIMIT) this.controlPinned.push(entry);
    else this.controlRecent.push(entry);
  }

  unpin() {
    if (!this.pinning) return;
    this.pinning = false;
  }

  toJSON() {
    return {
      status: this.status,
      connectionAttempts: this.connectionAttempts,
      activeConnections: this.activeConnections,
      guestConnections: this.guestConnections,
      frontendToGuestMessages: this.frontendToGuestMessages,
      guestToFrontendMessages: this.guestToFrontendMessages,
      frontendToGuestBinaryMessages: this.frontendToGuestBinaryMessages,
      guestToFrontendBinaryMessages: this.guestToFrontendBinaryMessages,
      queueDepth: this.queueDepth,
      queueLimit: QUEUE_LIMIT,
      queueOverflows: this.queueOverflows,
      replacedFrontends: this.replacedFrontends,
      lastError: this.lastError,
      lastCloseReason: this.lastCloseReason,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
      recentMessages: this.recentMessages.toJSON(),
      controlMessages: this.controlPinned.concat(this.controlRecent.toJSON()),
    };
  }
}

function controlEntry(buffer, isBinary, direction, parsed) {
  if (parsed && !CONTROL_TYPES.has(parsed.object.msgType)) return null;
  if (!parsed && !isBinary) return null;
  const meta = describeFrame(buffer, isBinary, direction, parsed);
  const summary = parsed ? meta.summary : null;
  return { at: meta.at, direction, binary: Boolean(isBinary), bytes: buffer.length, sequence: meta.sequence, summary };
}

function relay(source, target, buffer, isBinary) {
  target.send(buffer, { binary: isBinary }, () => {
    if (source.isPaused && target.bufferedAmount <= LOW_WATER && source.readyState === WebSocket.OPEN) source.resume();
  });
  if (target.bufferedAmount > HIGH_WATER && !source.isPaused) source.pause();
}

class ProxyService {
  // service: { key, backend, protocol, port }
  constructor({ service, qemuHost, readiness, bridge, stats }) {
    this.service = service;
    this.qemuHost = qemuHost;
    this.readiness = service.key === 'mmui' ? readiness : null;
    this.bridge = service.key === 'mmui' ? bridge : null;
    // Only MMUI has a lifecycle to retain; other backends keep recent messages.
    if (!this.bridge) stats.pinning = false;
    this.stats = stats;
    this.sessions = new Set();
  }

  get guestUrl() {
    const host = this.qemuHost.includes(':') && !this.qemuHost.startsWith('[') ? `[${this.qemuHost}]` : this.qemuHost;
    return `ws://${host}:${this.service.port + 10000}/`;
  }

  attach(frontend, protocol) {
    // One MMUI session at a time keeps readiness and lifecycle tracking
    // unambiguous; the newest wins, because a reload's new socket can arrive
    // before the old one has closed.
    if (this.service.key === 'mmui') {
      for (const old of [...this.sessions]) {
        this.stats.replacedFrontends++;
        this.closeFrontend(old, 1001, 'replaced by a newer MMUI frontend');
      }
    }
    const session = {
      frontend,
      guest: null,
      queue: [],
      queuedBytes: 0,
      released: false,
      closed: false,
      cancelWait: null,
    };
    this.sessions.add(session);
    this.stats.activeConnections++;

    frontend.on('message', (data, isBinary) => this.fromFrontend(session, toBuffer(data), isBinary));
    frontend.on('close', () => this.teardown(session, null));
    frontend.on('error', (error) => { this.stats.lastError = `frontend: ${error.message}`; });

    const connect = () => this.connectGuest(session, protocol);
    if (this.readiness) session.cancelWait = this.readiness.whenReleased(connect);
    else connect();
    this.updateStatus();
  }

  updateStatus() {
    const states = [...this.sessions].map((s) => {
      if (s.released) return 'connected';
      return s.guest ? 'connecting' : 'waiting-for-mmui-ready';
    });
    for (const state of ['connected', 'connecting', 'waiting-for-mmui-ready']) {
      if (states.includes(state)) { this.stats.status = state; return; }
    }
    this.stats.status = this.stats.lastCloseReason ? 'closed' : 'idle';
  }

  connectGuest(session, protocol) {
    session.cancelWait = null;
    this.stats.connectionAttempts++;
    let guest;
    try {
      guest = new WebSocket(this.guestUrl, protocol ? [protocol] : [], {
        skipUTF8Validation: true,
        maxPayload: MAX_PAYLOAD,
        perMessageDeflate: false,
        handshakeTimeout: 5000,
      });
    } catch (error) {
      this.failSession(session, `guest connection failed: ${error.message}`);
      return;
    }
    session.guest = guest;
    this.updateStatus();
    let opened = false;
    guest.on('open', () => {
      opened = true;
      this.stats.guestConnections++;
      this.stats.lastConnectedAt = new Date().toISOString();
      if (this.bridge) {
        this.stats.resetControl();
        session.sendSynthetic = (object) => this.sendSynthetic(session, object);
        this.bridge.attachGuest(session.sendSynthetic);
      }
      session.released = true;
      this.updateStatus();
      const queued = session.queue;
      session.queue = [];
      session.queuedBytes = 0;
      this.updateQueueDepth();
      for (const [buffer, isBinary] of queued) this.forwardToGuest(session, buffer, isBinary);
      if (this.bridge) this.bridge.finishIfPending();
    });
    guest.on('message', (data, isBinary) => this.fromGuest(session, toBuffer(data), isBinary));
    guest.on('error', (error) => { this.stats.lastError = `guest: ${error.message}`; });
    guest.on('close', (code, reason) => {
      if (this.bridge && session.sendSynthetic) this.bridge.detachGuest(session.sendSynthetic);
      // Only an unexpected loss resets readiness; when the harness closes the
      // guest itself (frontend gone or replaced), the session is already closed.
      if (this.readiness && opened && !session.closed) this.readiness.reset();
      const why = opened ? `guest connection lost (${code})` : 'guest connection failed';
      this.failSession(session, why);
    });
  }

  failSession(session, reason) {
    if (!session.closed) {
      this.stats.lastError = reason;
      this.stats.lastCloseReason = reason;
    }
    this.closeFrontend(session, CLOSE_UNAVAILABLE, reason);
  }

  closeFrontend(session, code, reason) {
    if (session.closed) return;
    try { session.frontend.close(code, reason.slice(0, 120)); } catch (_) { session.frontend.terminate(); }
    this.teardown(session, reason);
  }

  teardown(session, reason) {
    if (session.closed) return;
    session.closed = true;
    if (session.cancelWait) session.cancelWait();
    this.sessions.delete(session);
    this.stats.activeConnections--;
    session.queue = [];
    this.updateQueueDepth();
    if (session.guest) {
      try { session.guest.close(); } catch (_) { session.guest.terminate(); }
    }
    this.updateStatus();
  }

  updateQueueDepth() {
    let depth = 0;
    for (const s of this.sessions) depth += s.queue.length;
    this.stats.queueDepth = depth;
  }

  fromFrontend(session, buffer, isBinary) {
    if (session.closed) return;
    if (!session.released || !session.guest || session.guest.readyState !== WebSocket.OPEN) {
      if (session.queue.length >= QUEUE_LIMIT || session.queuedBytes + buffer.length > QUEUE_BYTE_LIMIT) {
        this.stats.queueOverflows++;
        const reason = `frontend queue overflow (${QUEUE_LIMIT} frames or ${QUEUE_BYTE_LIMIT} bytes)`;
        this.stats.lastError = reason;
        this.stats.lastCloseReason = reason;
        this.closeFrontend(session, CLOSE_OVERFLOW, reason);
        return;
      }
      session.queue.push([buffer, isBinary]);
      session.queuedBytes += buffer.length;
      // Cumulative count of frames that arrived before release.
      if (this.readiness) this.readiness.queuedFrontendMessages++;
      this.updateQueueDepth();
      return;
    }
    this.forwardToGuest(session, buffer, isBinary);
  }

  forwardToGuest(session, buffer, isBinary) {
    const direction = 'frontend-to-guest';
    const parsed = this.count(direction, buffer, isBinary);
    relay(session.frontend, session.guest, buffer, isBinary);
    if (this.bridge && parsed) this.bridge.frontendMessage(parsed.object);
  }

  fromGuest(session, buffer, isBinary) {
    if (session.closed) return;
    const direction = 'guest-to-frontend';
    const parsed = this.count(direction, buffer, isBinary);
    relay(session.guest, session.frontend, buffer, isBinary);
    if (this.bridge && parsed) {
      this.bridge.guestMessage(parsed.object);
      if (parsed.object.msgType === 'ctxtChg' && parsed.object.ctxtId === 'HomeScreen') this.stats.unpin();
    }
  }

  sendSynthetic(session, object) {
    if (session.closed || !session.guest || session.guest.readyState !== WebSocket.OPEN) return false;
    const buffer = Buffer.from(JSON.stringify(object), 'utf8');
    this.count('native-display-to-guest', buffer, false);
    session.guest.send(buffer, { binary: false });
    return true;
  }

  count(direction, buffer, isBinary) {
    const s = this.stats;
    if (direction === 'guest-to-frontend') {
      if (isBinary) s.guestToFrontendBinaryMessages++; else s.guestToFrontendMessages++;
    } else if (direction === 'frontend-to-guest') {
      if (isBinary) s.frontendToGuestBinaryMessages++; else s.frontendToGuestMessages++;
    }
    s.lastMessageAt = new Date().toISOString();
    const parsed = isBinary ? null : parseJsonObject(buffer);
    s.recentMessages.push(describeFrame(buffer, isBinary, direction, parsed));
    const entry = controlEntry(buffer, isBinary, direction, parsed);
    if (entry) s.recordControl(entry);
    return parsed;
  }
}

module.exports = { ProxyService, BackendStats, QUEUE_LIMIT, CLOSE_UNAVAILABLE, CLOSE_OVERFLOW };
