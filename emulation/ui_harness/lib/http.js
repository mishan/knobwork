'use strict';

// Read-only HTTP frontend: stock files from jci/gui (confined), in-memory
// index.html injection and CSS translation, implementation-owned resources,
// and bounded JSON diagnostics. No request handler writes to the filesystem.

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { openConfined, decodeRequestPath, readFdBounded, readSmallRegular } = require('./rootfs');
const { transformCss } = require('./css');
const { overlayStatus, integrationOverridePath } = require('./overlay');

const COMPAT_ROUTE = '/__emu/compat.js';
const COMPAT_SOURCE = path.join(__dirname, '..', 'public', 'compat.js');
const OPTIONAL_STYLESHEETS = new Set([
  '/apps/audiosettings/css/audiosettingsApp.css',
  '/apps/tutorial/css/tutorialApp.css',
]);
const OVERLAY_APP_SCRIPT = '/apps/system/js/developerdiagnosticsApp.js';
const INTEGRATION_ROUTE = '/data/integration/developer_mode_GuiConfig.js';
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_CSS_BYTES = 8 * 1024 * 1024;
const MAX_OVERRIDE_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const NO_STORE = 'no-store, no-cache, must-revalidate, max-age=0';

class HttpStats {
  constructor(failOverlayAppScript) {
    this.requests = 0;
    this.notFound = 0;
    this.rejectedPaths = 0;
    this.indexInjections = 0;
    this.cssTranslations = 0;
    this.cssTokenChanges = 0;
    this.optionalStylesheets = {};
    for (const p of OPTIONAL_STYLESHEETS) this.optionalStylesheets[p] = 0;
    this.integrationOverride = { served: 0, empty: 0 };
    this.rejectedHosts = 0;
    this.injectedFailures = { overlayAppScript: { enabled: Boolean(failOverlayAppScript), requests: 0 } };
    this.errors = 0;
  }
}

function send(res, status, headers, body) {
  if (res.headersSent) return;
  res.writeHead(status, headers);
  res.end(res.req && res.req.method === 'HEAD' ? undefined : body);
}

function sendJson(res, status, object) {
  let text = JSON.stringify(object);
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) {
    status = 500;
    text = JSON.stringify({ ok: false, error: 'diagnostic response exceeded its size bound' });
  }
  send(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': NO_STORE,
    'X-Content-Type-Options': 'nosniff',
  }, text);
}

function escapeForScript(json) {
  return json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// Insert config + compat script immediately after the opening <head> tag so
// they run before any stock script.
function injectIndex(html, config) {
  const snippet =
    `<script>window.__mazdaEmulatorConfig=${escapeForScript(JSON.stringify(config))};</script>` +
    `<script src="${COMPAT_ROUTE}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + snippet + html.slice(at);
  }
  return snippet + html;
}

function readOpened(opened, limit) {
  try {
    const raw = readFdBounded(opened.fd, limit);
    if (raw === null) throw new Error(`file exceeds ${limit} bytes`);
    return raw;
  } finally {
    fs.closeSync(opened.fd);
  }
}

function createHttpHandler(ctx) {
  // ctx: { config, workspace, stats, health(), can, browserConfig, access }
  const { config, stats } = ctx;
  const guiReal = fs.realpathSync(config.guiPath);

  function serveIndex(res) {
    const index = openConfined(guiReal, '/index.html');
    if (!index.ok) {
      stats.rejectedPaths++;
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found\n');
      return;
    }
    const raw = readOpened(index, MAX_INDEX_BYTES);
    stats.indexInjections++;
    send(res, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': NO_STORE,
    }, injectIndex(raw.toString('utf8'), ctx.browserConfig));
  }

  function serveCompat(res) {
    const body = fs.readFileSync(COMPAT_SOURCE);
    send(res, 200, { 'Content-Type': MIME['.js'], 'Cache-Control': NO_STORE }, body);
  }

  function serveIntegration(res) {
    const override = integrationOverridePath(ctx.workspace);
    const body = override ? readSmallRegular(override, MAX_OVERRIDE_BYTES) : null;
    if (body) stats.integrationOverride.served++;
    else stats.integrationOverride.empty++;
    send(res, 200, { 'Content-Type': MIME['.js'], 'Cache-Control': NO_STORE }, body || '');
  }

  function serveStock(req, res, urlPath) {
    const result = openConfined(guiReal, urlPath);
    if (!result.ok) {
      if (result.reason === 'missing' && OPTIONAL_STYLESHEETS.has(result.normalized)) {
        stats.optionalStylesheets[result.normalized]++;
        send(res, 200, { 'Content-Type': MIME['.css'], 'Cache-Control': NO_STORE }, '');
        return;
      }
      if (result.reason !== 'missing') stats.rejectedPaths++;
      stats.notFound++;
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found\n');
      return;
    }
    const ext = path.extname(result.file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (ext === '.css') {
      const { css, changes } = transformCss(readOpened(result, MAX_CSS_BYTES).toString('utf8'));
      stats.cssTranslations++;
      stats.cssTokenChanges += changes;
      send(res, 200, { 'Content-Type': type, 'Cache-Control': NO_STORE }, css);
      return;
    }
    // No Content-Length: the body is whatever the open descriptor yields, so
    // the framing cannot disagree with it if the file changes underneath.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') { fs.closeSync(result.fd); res.end(); return; }
    // pipeline destroys the file stream (and closes the descriptor) when the client goes away.
    pipeline(fs.createReadStream(null, { fd: result.fd }), res, (error) => { if (error) stats.errors++; });
  }


  return function handle(req, res) {
    stats.requests++;
    try {
      if (!ctx.access.hostAllowed(req.headers.host)) {
        stats.rejectedHosts++;
        send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden host\n');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed\n');
        return;
      }
      const rawPath = String(req.url || '/').split('?')[0].split('#')[0];
      // Routes match the decoded path, so an encoded spelling reaches the same route.
      const urlPath = decodeRequestPath(rawPath) || rawPath;
      if (urlPath === '/' || urlPath === '/index.html') return serveIndex(res);
      if (urlPath === '/favicon.ico') {
        send(res, 200, { 'Content-Type': 'image/x-icon', 'Cache-Control': NO_STORE }, '');
        return;
      }
      if (urlPath === '/__emu' || urlPath.startsWith('/__emu/')) {
        switch (urlPath) {
          case COMPAT_ROUTE: return serveCompat(res);
          case '/__emu/health': return sendJson(res, 200, ctx.health());
          case '/__emu/can': return sendJson(res, 200, ctx.can.endpoint());
          case '/__emu/overlay': {
            const { status, body } = overlayStatus(ctx.workspace);
            return sendJson(res, status, body);
          }
          default: return sendJson(res, 404, { ok: false, error: 'unknown emulator route' });
        }
      }
      if (urlPath === INTEGRATION_ROUTE) return serveIntegration(res);
      if (config.failOverlayAppScript && urlPath === OVERLAY_APP_SCRIPT) {
        stats.injectedFailures.overlayAppScript.requests++;
        send(res, 503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': NO_STORE },
          'Injected test fault: overlay application script unavailable\n');
        return;
      }
      return serveStock(req, res, rawPath);
    } catch (error) {
      stats.errors++;
      send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal error\n');
    }
  };
}

module.exports = {
  createHttpHandler,
  injectIndex,
  HttpStats,
  COMPAT_ROUTE,
  OPTIONAL_STYLESHEETS,
  OVERLAY_APP_SCRIPT,
  INTEGRATION_ROUTE,
};
