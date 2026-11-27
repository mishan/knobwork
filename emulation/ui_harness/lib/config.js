'use strict';

// Validated process configuration. Every listener port is checked before any
// socket is opened so a bad setting can never leave a partial harness running.

const path = require('path');
const { validateRootfs } = require('./rootfs');

class ConfigError extends Error {}

const DEFAULT_PORTS = Object.freeze({
  http: 8080,
  mmui: 2700,
  dbapi: 2766,
  appsdk: 2800,
  displayControl: 2990,
});

const GUEST_PORT_OFFSET = 10000;

function parsePort(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const text = String(raw).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new ConfigError(`${name} must be an integer from 1 through 65535 (got ${JSON.stringify(raw)})`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(`${name} must be an integer from 1 through 65535 (got ${JSON.stringify(raw)})`);
  }
  return value;
}

function parseFlag(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return false;
  const text = String(raw).trim().toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  throw new ConfigError(`${name} must be "true" or "false" (got ${JSON.stringify(raw)})`);
}

function parseHoldMs(env) {
  const raw = env.EMU_MMUI_READINESS_HOLD_MS;
  if (raw === undefined || raw === '') return 0;
  const value = Number(String(raw).trim());
  if (String(raw).trim() === '' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(
      `EMU_MMUI_READINESS_HOLD_MS must be a finite, nonnegative number (got ${JSON.stringify(raw)})`);
  }
  return value;
}

function parseHost(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const text = String(raw).trim();
  if (!text || /[\s/]/.test(text)) {
    throw new ConfigError(`${name} is not a valid host (got ${JSON.stringify(raw)})`);
  }
  return text;
}

function loadConfig(env = process.env) {
  const selected = env.ROOTFS_PATH || env.CMU_ROOTFS;
  if (!selected) throw new ConfigError('Set ROOTFS_PATH or CMU_ROOTFS to an extracted CMU root');
  let rootfs;
  try {
    rootfs = validateRootfs(selected);
  } catch (error) {
    throw new ConfigError(error.message);
  }

  const proxyMode = parseFlag(env, 'PROXY_MODE');
  const ports = {
    http: parsePort(env, 'HTTP_PORT', DEFAULT_PORTS.http),
    mmui: parsePort(env, 'MMUI_PORT', DEFAULT_PORTS.mmui),
    dbapi: parsePort(env, 'DBAPI_PORT', DEFAULT_PORTS.dbapi),
    appsdk: parsePort(env, 'APPSDK_PORT', DEFAULT_PORTS.appsdk),
    displayControl: parsePort(env, 'DISPLAY_CONTROL_PORT', DEFAULT_PORTS.displayControl),
  };

  // The display-control listener only exists in proxy mode.
  const listened = ['http', 'mmui', 'dbapi', 'appsdk'].concat(proxyMode ? ['displayControl'] : []);
  const seen = new Map();
  for (const key of listened) {
    if (seen.has(ports[key])) {
      throw new ConfigError(`Duplicate listener port ${ports[key]} for ${seen.get(ports[key])} and ${key}`);
    }
    seen.set(ports[key], key);
  }
  if (proxyMode) {
    for (const key of ['mmui', 'dbapi', 'appsdk']) {
      if (ports[key] + GUEST_PORT_OFFSET > 65535) {
        throw new ConfigError(`${key} port ${ports[key]} has no valid guest port (port + ${GUEST_PORT_OFFSET})`);
      }
    }
  }

  const canReplayPath = env.CAN_REPLAY_PATH ? path.resolve(env.CAN_REPLAY_PATH) : null;

  return Object.freeze({
    rootfs: rootfs.root,
    guiPath: rootfs.gui,
    host: parseHost(env, 'HOST', '127.0.0.1'),
    qemuHost: parseHost(env, 'QEMU_HOST', '127.0.0.1'),
    ports: Object.freeze(ports),
    mode: proxyMode ? 'proxy' : 'mock',
    readinessHoldMs: parseHoldMs(env),
    failOverlayAppScript: parseFlag(env, 'EMU_FAIL_OVERLAY_APP_SCRIPT'),
    canReplayPath,
    scenarioPath: env.EMU_SCENARIO ? path.resolve(env.EMU_SCENARIO) : null,
  });
}

function isLoopbackHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// A warning for a HOST that is reachable from other machines, or null.
function exposureWarning(config) {
  if (isLoopbackHost(config.host)) return null;
  const exposed = ['the stock GUI files', 'diagnostics (including absolute paths and traffic previews)',
    'the MMUI, DBAPI, and AppSDK WebSockets'];
  if (config.mode === 'proxy') exposed.push('traffic to the guest', 'the unauthenticated display-control port');
  return `WARNING: HOST ${config.host} is not loopback. Reachable from the network without authentication: ${exposed.join('; ')}.`;
}

module.exports = { loadConfig, ConfigError, DEFAULT_PORTS, GUEST_PORT_OFFSET, parsePort, exposureWarning };
