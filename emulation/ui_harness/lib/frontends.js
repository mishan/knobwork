'use strict';

// WebSocket frontends for MMUI, DBAPI, and AppSDK. In mock mode each
// connection gets its own scenario session; in proxy mode it is handed to the
// matching ProxyService. The two paths share nothing else.

const WebSocket = require('ws');
const { ScenarioSession } = require('./scenario');
const { toBuffer } = require('./frames');

const SERVICES = Object.freeze([
  Object.freeze({ key: 'mmui', backend: 'guiifm', protocol: 'ihu-guiifm-protocol', portKey: 'mmui' }),
  Object.freeze({ key: 'dbapi', backend: 'dbapi', protocol: 'ihu-dbapi-protocol', portKey: 'dbapi' }),
  Object.freeze({ key: 'appsdk', backend: 'appsdk', protocol: 'ihu-appsdk-protocol', portKey: 'appsdk' }),
]);

const FRONTEND_MAX_PAYLOAD = 16 * 1024 * 1024;

// maxPayload: in mock mode the scenario's inbound limit, so an oversized frame
// is refused before it is buffered (ws treats 0 as "no limit", hence at least 1).
function createWebSocketServer(service, { proxyMode, maxPayload = FRONTEND_MAX_PAYLOAD }) {
  const wss = new WebSocket.Server({
    noServer: true,
    maxPayload: Math.max(1, maxPayload),
    perMessageDeflate: false,
    // Proxy mode must forward guest bytes exactly, including text frames whose
    // trailing sequence byte is not valid UTF-8.
    skipUTF8Validation: Boolean(proxyMode),
    handleProtocols: () => service.protocol,
  });
  return wss;
}

function attachMock(ws, service, scenario, scenarioStats, clientStats) {
  const sink = {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: (code, reason) => {
      try { ws.close(code, reason); } catch (_) { ws.terminate(); }
    },
  };
  const session = new ScenarioSession(scenario, service.key, sink, scenarioStats);
  ws.on('message', (data, isBinary) => {
    try {
      session.handleFrame(toBuffer(data), isBinary);
    } catch (error) {
      clientStats.errors++;
    }
  });
  ws.on('close', () => session.close());
  ws.on('error', () => { clientStats.errors++; });
  session.start();
  return session;
}

// True when the upgrade request offers this service's subprotocol.
function offersProtocol(req, service) {
  const header = req.headers['sec-websocket-protocol'] || '';
  return header.split(',').map((p) => p.trim()).includes(service.protocol);
}

module.exports = { SERVICES, createWebSocketServer, attachMock, offersProtocol };
