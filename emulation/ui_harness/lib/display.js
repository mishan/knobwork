'use strict';

// Display-control channel and native display lifecycle bridge (proxy mode).
//
// The control channel is a TCP listener. Each guest connection carries one
// ASCII notification; the harness reads to end-of-stream, never writes, and
// bounds input to 1024 bytes.
//
// The lifecycle bridge supplies only the display edges a headless guest lacks:
// StartIntroAnimation after the frontend's InitializeGuiComplete has been
// forwarded; FinishIntroAnimation once both the splash-complete notification
// and an active MMUI guest connection are present; and ShowDisclaimer about
// 100 ms after that. Everything else is observed, never generated.

const net = require('net');

const CONTROL_INPUT_LIMIT = 1024;
const CONTROL_CONNECTION_LIMIT = 16;
const READY_MARKER = 'mmui-ready';
const SPLASH_MARKER = 'splash-complete surface=TRANLOGO_SURFACE';

const SHOW_DISCLAIMER_DELAY_MS = 100;

// Synthetic lifecycle frames: an ordinary GUI-to-MMUI event, one text frame,
// no sequence suffix (specification, "Synthetic lifecycle frames").
function syntheticEvent(eventId) {
  return {
    msgType: 'event',
    eventId,
    uiaId: 'system',
    params: '{}',
    fromVui: false,
    currentUiaId: 'system',
    currentContextId: 'IntroAnimation',
  };
}

class NativeDisplayBridge {
  constructor({ readiness, log = () => {} }) {
    this.readiness = readiness;
    this.log = log;
    this.notifications = 0;
    this.startEvents = 0;
    this.finishEvents = 0;
    this.showDisclaimerEvents = 0;
    this.frontendDisposeEvents = 0;
    this.frontendTimeoutEvents = 0;
    this.disclaimerEndEvents = 0;
    this.lastNotification = null;
    this.lastError = null;
    this.unsupportedNotifications = 0;
    this.sender = null; // function(object) -> boolean, set by the MMUI proxy
    this.splashPending = false; // a splash notification not yet consumed
    this.resetLifecycle();
  }

  resetLifecycle() {
    this.phase = {
      startSent: false,
      finishSent: false,
      homeSeen: false,
      disclaimerEndSeen: false,
      complete: false,
    };
  }

  // Called by the MMUI proxy when a new guest MMUI connection becomes active.
  attachGuest(sender) {
    this.sender = sender;
    this.resetLifecycle();
  }

  // Called once the connection's queued frontend frames have been flushed, so
  // a splash that arrived earlier never overtakes them.
  finishIfPending() {
    if (this.splashPending) this.finish();
  }

  // Losing the active connection ends its lifecycle, so a later splash
  // belongs to the next connection. A stale detach can arrive after a new
  // connection attached and must change nothing.
  detachGuest(sender) {
    if (this.sender !== sender) return;
    this.sender = null;
    this.resetLifecycle();
  }

  // Callers ensure a sender exists.
  send(eventId) {
    const ok = this.sender(syntheticEvent(eventId));
    if (!ok) this.lastError = `failed to send ${eventId} to guest MMUI`;
    return ok;
  }

  frontendMessage(object) {
    if (!object || object.msgType !== 'event') return;
    switch (object.eventId) {
      case 'InitializeGuiComplete':
        if (!this.phase.startSent) {
          this.phase.startSent = true;
          if (this.send('StartIntroAnimation')) this.startEvents++;
        }
        break;
      case 'DisposeIntroVideo':
        this.frontendDisposeEvents++;
        break;
      case 'Timeout':
        this.frontendTimeoutEvents++;
        break;
      case 'NotifyDisclaimerEnd':
        this.disclaimerEndEvents++;
        this.phase.disclaimerEndSeen = true;
        if (this.phase.homeSeen) this.complete();
        break;
      default:
        break;
    }
  }

  guestMessage(object) {
    if (!object || object.msgType !== 'ctxtChg') return;
    if (object.ctxtId === 'HomeScreen') {
      this.phase.homeSeen = true;
      if (this.phase.disclaimerEndSeen) this.complete();
    }
  }

  complete() {
    this.phase.complete = true;
    this.lastError = null;
  }

  // Requires an active guest connection; consumes the pending splash.
  finish() {
    if (this.phase.finishSent || !this.sender) return;
    this.phase.finishSent = true;
    this.splashPending = false;
    if (!this.send('FinishIntroAnimation')) return;
    this.finishEvents++;
    const sender = this.sender;
    setTimeout(() => {
      if (this.sender !== sender) return; // connection gone or replaced
      if (this.send('ShowDisclaimer')) this.showDisclaimerEvents++;
    }, SHOW_DISCLAIMER_DELAY_MS);
  }

  // One complete control notification (already trimmed).
  controlNotification(text) {
    if (text === '') return;
    if (text === READY_MARKER) {
      this.readiness.notify(text);
      return;
    }
    this.notifications++;
    this.lastNotification = text.slice(0, 200);
    if (text === SPLASH_MARKER) {
      if (this.phase.finishSent) return; // duplicate on this connection: idempotent
      this.splashPending = true;
      this.finish(); // no-op until a guest connection is present
      return;
    }
    this.unsupportedNotifications++;
    this.lastError = `unsupported control notification: ${JSON.stringify(text.slice(0, 120))}`;
    this.log(this.lastError);
  }

  toJSON() {
    return {
      notifications: this.notifications,
      unsupportedNotifications: this.unsupportedNotifications,
      startEvents: this.startEvents,
      finishEvents: this.finishEvents,
      showDisclaimerEvents: this.showDisclaimerEvents,
      frontendDisposeEvents: this.frontendDisposeEvents,
      frontendTimeoutEvents: this.frontendTimeoutEvents,
      disclaimerEndEvents: this.disclaimerEndEvents,
      lifecycle: Object.assign({ splashPending: this.splashPending }, this.phase),
      lastNotification: this.lastNotification,
      lastError: this.lastError,
    };
  }
}

function createControlServer(bridge, stats) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    if (sockets.size >= CONTROL_CONNECTION_LIMIT) {
      stats.refused++;
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    stats.connections++;
    const chunks = [];
    let size = 0;
    let destroyed = false;
    socket.setTimeout(10000, () => socket.destroy());
    socket.on('data', (chunk) => {
      if (destroyed) return;
      size += chunk.length;
      if (size > CONTROL_INPUT_LIMIT) {
        destroyed = true;
        stats.oversized++;
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () => {
      if (destroyed) return;
      const raw = Buffer.concat(chunks);
      // ASCII only; anything else is unsupported text.
      const text = raw.toString('latin1').trim();
      try {
        bridge.controlNotification(text);
      } catch (error) { // last guard at a process boundary; nothing here is expected to throw
        bridge.lastError = `control notification failed: ${error.message}`;
      }
    });
    socket.on('error', () => { stats.errors++; });
  });
  server.closeAllConnections = () => { for (const s of sockets) s.destroy(); };
  return server;
}

module.exports = {
  NativeDisplayBridge,
  createControlServer,
  syntheticEvent,
  SHOW_DISCLAIMER_DELAY_MS,
  CONTROL_INPUT_LIMIT,
  READY_MARKER,
  SPLASH_MARKER,
};
