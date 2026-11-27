'use strict';

// Composition root. Builds either the mock or the proxy backend (never both),
// opens every listener transactionally, and exposes health diagnostics.

const http = require('http');
const path = require('path');
const { detectOverlayWorkspace } = require('./rootfs');
const { CanReplay } = require('./can');
const { loadScenarioFile, ScenarioStats } = require('./scenario');
const { createHttpHandler, HttpStats } = require('./http');
const { SERVICES, createWebSocketServer, attachMock, offersProtocol } = require('./frontends');
const { createAccessPolicy } = require('./access');
const { ProxyService, BackendStats } = require('./proxy');
const { MmuiReadiness } = require('./readiness');
const { NativeDisplayBridge, createControlServer } = require('./display');

const MAX_SESSIONS_PER_SERVICE = 32;
const DEFAULT_SCENARIO = path.join(__dirname, '..', 'scenarios', 'v74-na-default.json');
const VERSION = '0.1.0';

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    } catch (_) {
      resolve();
    }
  });
}

class Harness {
  constructor(config, { log = console.log } = {}) {
    this.config = config;
    this.log = log;
    this.startedAt = new Date().toISOString();
    this.workspace = detectOverlayWorkspace(config.rootfs);
    this.can = CanReplay.fromPath(config.canReplayPath);
    this.httpStats = new HttpStats(config.failOverlayAppScript);
    this.clientStats = { protocolMismatches: 0, rejectedHosts: 0, rejectedOrigins: 0, rejectedCapacity: 0, errors: 0, connections: 0, active: 0 };
    this.access = createAccessPolicy({ host: config.host, httpPort: config.ports.http });
    this.servers = [];
    this.wsServers = {};
    this.mock = null;
    this.proxy = null;

    if (config.mode === 'mock') {
      this.mock = {
        scenario: loadScenarioFile(config.scenarioPath || DEFAULT_SCENARIO),
        stats: new ScenarioStats(),
      };
    } else {
      const readiness = new MmuiReadiness({ holdMs: config.readinessHoldMs });
      const bridge = new NativeDisplayBridge({ readiness, log });
      const controlStats = { connections: 0, oversized: 0, refused: 0, errors: 0 };
      const backends = {};
      const services = {};
      for (const s of SERVICES) {
        backends[s.backend] = new BackendStats(s.backend);
        services[s.key] = new ProxyService({
          service: Object.assign({ port: config.ports[s.portKey] }, s),
          qemuHost: config.qemuHost,
          readiness,
          bridge,
          stats: backends[s.backend],
        });
      }
      this.proxy = { readiness, bridge, controlStats, backends, services };
    }

    this.browserConfig = {
      backendMode: config.mode,
      ports: { http: config.ports.http, mmui: config.ports.mmui, dbapi: config.ports.dbapi, appsdk: config.ports.appsdk },
    };
  }

  health() {
    const c = this.config;
    let nativeProxyReady = false;
    let proxy = null;
    if (this.proxy) {
      const p = this.proxy;
      const backends = {};
      for (const [k, v] of Object.entries(p.backends)) backends[k] = v.toJSON();
      nativeProxyReady = p.readiness.isReady() &&
        Object.values(p.backends).every((b) => b.status === 'connected' && b.activeConnections > 0);
      proxy = {
        qemuHost: c.qemuHost,
        guestPortOffset: 10000,
        mockFallbackMessages: 0,
        backends,
        mmuiReadiness: p.readiness.toJSON(),
        nativeDisplay: p.bridge.toJSON(),
        displayControl: Object.assign({ port: c.ports.displayControl }, p.controlStats),
      };
    }
    return {
      ok: true,
      version: VERSION,
      startedAt: this.startedAt,
      mode: c.mode,
      nativeProxyReady,
      rootfs: c.rootfs,
      guiPath: c.guiPath,
      ports: { http: c.ports.http, mmui: c.ports.mmui, dbapi: c.ports.dbapi, appsdk: c.ports.appsdk },
      overlayWorkspace: Boolean(this.workspace),
      canReplay: this.can.healthSummary(),
      stats: {
        mock: this.mock ? Object.assign({ scenario: this.mock.scenario.name }, this.mock.stats.toJSON()) : null,
        httpCompatibility: this.httpStats,
        clients: this.clientStats,
      },
      proxy,
    };
  }

  attachFrontend(service, ws, protocol) {
    this.clientStats.connections++;
    this.clientStats.active++;
    ws.on('close', () => { this.clientStats.active--; });
    if (this.mock) attachMock(ws, service, this.mock.scenario, this.mock.stats, this.clientStats);
    else this.proxy.services[service.key].attach(ws, protocol);
  }

  buildServers() {
    const c = this.config;
    const handler = createHttpHandler({
      config: c,
      workspace: this.workspace,
      stats: this.httpStats,
      can: this.can,
      browserConfig: this.browserConfig,
      access: this.access,
      health: () => this.health(),
    });
    const plan = [{ name: 'http', port: c.ports.http, server: http.createServer(handler) }];
    for (const s of SERVICES) {
      const wss = createWebSocketServer(s, {
        proxyMode: c.mode === 'proxy',
        ...(this.mock ? { maxPayload: this.mock.scenario.limits.maxInboundBytes } : {}),
      });
      this.wsServers[s.key] = wss;
      const server = http.createServer((req, res) => {
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('WebSocket upgrade required\n');
      });
      server.on('upgrade', (req, socket, head) => {
        // A client can reset before a refusal is written; that must end only
        // its own socket, never the process.
        socket.on('error', () => { this.clientStats.errors++; });
        const refuse = (counter, status = '403 Forbidden') => {
          this.clientStats[counter]++;
          socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        };
        if (!this.access.hostAllowed(req.headers.host)) return refuse('rejectedHosts');
        if (!this.access.originAllowed(req.headers.origin)) return refuse('rejectedOrigins');
        if (wss.clients.size >= MAX_SESSIONS_PER_SERVICE) return refuse('rejectedCapacity', '503 Service Unavailable');
        if (!offersProtocol(req, s)) {
          this.clientStats.protocolMismatches++;
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          try {
            this.attachFrontend(s, ws, ws.protocol);
          } catch (error) {
            this.clientStats.errors++;
            ws.terminate();
          }
        });
      });
      server.on('clientError', (error, socket) => socket.destroy());
      plan.push({ name: s.key, port: c.ports[s.portKey], server });
    }
    if (this.proxy) {
      plan.push({
        name: 'displayControl',
        port: c.ports.displayControl,
        server: createControlServer(this.proxy.bridge, this.proxy.controlStats),
      });
    }
    plan[0].server.on('clientError', (error, socket) => socket.destroy());
    return plan;
  }

  // Open all listeners or none.
  async start() {
    const plan = this.buildServers();
    const opened = [];
    try {
      for (const entry of plan) {
        await listen(entry.server, entry.port, this.config.host);
        opened.push(entry);
      }
    } catch (error) {
      await Promise.all(opened.map((e) => closeServer(e.server)));
      throw new Error(`failed to open listener: ${error.message}`);
    }
    this.servers = opened;
    return opened.map((e) => ({ name: e.name, address: `${this.config.host}:${e.server.address().port}` }));
  }

  async stop() {
    for (const wss of Object.values(this.wsServers)) {
      for (const client of wss.clients) {
        try { client.close(1001, 'harness shutting down'); } catch (_) { client.terminate(); }
      }
    }
    if (this.proxy) this.proxy.readiness.stop();
    setTimeout(() => {
      for (const wss of Object.values(this.wsServers)) for (const client of wss.clients) client.terminate();
    }, 250).unref();
    await Promise.all(this.servers.map((e) => closeServer(e.server)));
    for (const wss of Object.values(this.wsServers)) wss.close();
    this.servers = [];
  }
}

module.exports = { Harness, DEFAULT_SCENARIO, VERSION };
