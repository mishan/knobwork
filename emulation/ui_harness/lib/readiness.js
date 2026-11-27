'use strict';

// MMUI readiness gate. Readiness comes only from an explicit `mmui-ready`
// display-control notification, expires after five seconds without refresh,
// and is cleared when the active MMUI guest connection is lost.

const { performance } = require('perf_hooks');

const EXPIRY_MS = 5000;
const MAX_TIMER_MS = 2 ** 31 - 1; // larger delays overflow to 1 ms

class MmuiReadiness {
  constructor({ holdMs = 0, now = () => performance.now() } = {}) {
    this.holdMs = holdMs;
    this.now = now;
    this.lastAt = null;
    this.readySince = null;
    this.notifications = 0;
    this.lastNotification = null;
    this.queuedFrontendMessages = 0;
    this.resets = 0;
    this.waiters = new Set();
    this.timer = null;
  }

  isReady() {
    return this.lastAt !== null && this.now() - this.lastAt <= EXPIRY_MS;
  }

  // Ready, and the optional test hold since the start of this readiness period
  // has elapsed.
  isReleased() {
    return this.isReady() && this.now() - this.readySince >= this.holdMs;
  }

  notify(text) {
    const now = this.now();
    if (!this.isReady()) this.readySince = now;
    this.lastAt = now;
    this.notifications++;
    this.lastNotification = { text, at: new Date().toISOString() };
    this.wake();
  }

  reset() {
    this.lastAt = null;
    this.readySince = null;
    this.resets++;
  }

  // Run `fn` once released. Returns a cancel function.
  whenReleased(fn) {
    if (this.isReleased()) {
      fn();
      return () => {};
    }
    this.waiters.add(fn);
    this.wake();
    return () => this.waiters.delete(fn);
  }

  wake() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.waiters.size === 0) return;
    if (this.isReleased()) {
      const waiting = [...this.waiters];
      this.waiters.clear();
      for (const fn of waiting) fn();
      return;
    }
    if (this.isReady()) {
      const remaining = Math.max(0, this.readySince + this.holdMs - this.now());
      this.timer = setTimeout(() => { this.timer = null; this.wake(); }, Math.min(remaining, MAX_TIMER_MS));
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.waiters.clear();
  }

  toJSON() {
    return {
      ready: this.isReady(),
      released: this.isReleased(),
      notifications: this.notifications,
      queuedFrontendMessages: this.queuedFrontendMessages,
      holdMs: this.holdMs,
      expiryMs: EXPIRY_MS,
      lastNotification: this.lastNotification ? this.lastNotification.text : null,
      lastNotificationAt: this.lastNotification ? this.lastNotification.at : null,
      resets: this.resets,
    };
  }
}

module.exports = { MmuiReadiness, EXPIRY_MS };
