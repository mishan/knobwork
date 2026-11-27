'use strict';

// Read-only access to the selected firmware root. Nothing in this module (or
// anywhere in the harness) opens a file beneath the root for writing.

const fs = require('fs');
const path = require('path');

const SMALL_FILE_LIMIT = 65536;

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function validateRootfs(selected) {
  const root = path.resolve(String(selected));
  const gui = path.join(root, 'jci', 'gui');
  const index = path.join(gui, 'index.html');
  let indexStat = null;
  try { indexStat = fs.statSync(index); } catch (_) { /* reported below */ }
  if (!isDirectory(root) || !indexStat || !indexStat.isFile()) {
    throw new Error(`Not a CMU rootfs: ${root} (expected jci/gui/index.html)`);
  }
  return { root, gui, index, guiReal: fs.realpathSync(gui) };
}

// Map a raw request path to a file beneath the GUI directory, or null when the
// request would escape it. Handles percent-encoding, backslashes, NUL bytes,
// dot segments, and symlinks whose targets leave the GUI tree.
function decodeRequestPath(rawPath) {
  const pathOnly = String(rawPath).split('?')[0].split('#')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch (_) {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  // Remove dot segments as RFC 3986 does, clamping at the root, so every
  // spelling of a path reaches the same route; confinement still checks the
  // real path of whatever this names.
  return path.posix.resolve('/', decoded);
}

function confine(guiReal, requestPath) {
  const normalized = decodeRequestPath(requestPath);
  if (normalized === null) return { ok: false, reason: 'invalid' };
  const candidate = path.join(guiReal, normalized);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (_) {
    return { ok: false, reason: 'missing', normalized };
  }
  if (!inside(guiReal, real)) {
    return { ok: false, reason: 'escape' };
  }
  return { ok: true, file: real, normalized };
}

function inside(guiReal, real) {
  return real === guiReal || real.startsWith(guiReal + path.sep);
}

// The path an open descriptor actually refers to (Linux); null elsewhere, in
// which case the earlier realpath check is the only guard and a swap between
// it and the open remains possible.
function descriptorPath(fd) {
  try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch (_) { return null; }
}

// Open a request path as a regular file inside the GUI tree. The checks are
// made on the open descriptor, so a file swapped for a symlink after the
// path check cannot be read.
function openConfined(guiReal, requestPath) {
  const result = confine(guiReal, requestPath);
  if (!result.ok) return result;
  let fd;
  try {
    fd = fs.openSync(result.file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  } catch (_) {
    return { ok: false, reason: 'missing', normalized: result.normalized };
  }
  const st = fs.fstatSync(fd);
  const real = descriptorPath(fd);
  if (!st.isFile() || (real !== null && !inside(guiReal, real))) {
    fs.closeSync(fd);
    return { ok: false, reason: st.isFile() ? 'escape' : 'missing', normalized: result.normalized };
  }
  return { ok: true, fd, size: st.size, file: result.file, normalized: result.normalized };
}

// Read at most `limit` bytes from an open descriptor; null if there are more.
function readFdBounded(fd, limit) {
  const buffer = Buffer.alloc(limit + 1);
  let total = 0;
  for (;;) {
    const n = fs.readSync(fd, buffer, total, buffer.length - total, null);
    if (n === 0) return buffer.subarray(0, total);
    total += n;
    if (total > limit) return null;
  }
}

// Read a small regular file at exactly `p`, refusing symlinks at that path.
// Returns null on any failure.
function readSmallRegular(p, limit = SMALL_FILE_LIMIT) {
  let fd;
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size > limit) return null;
    fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.size > limit) return null;
    const buffer = Buffer.alloc(Math.min(fst.size, limit) + 1);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > limit) return null;
    }
    return buffer.subarray(0, total);
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

function isRealDirectory(p) {
  try { return fs.lstatSync(p).isDirectory(); } catch (_) { return false; }
}

// Overlay workspace format 2 (see specification). Any failure means "not a
// workspace"; it is never a startup error.
function detectOverlayWorkspace(root) {
  try {
    if (path.basename(root) !== 'root') return null;
    const workspace = path.dirname(root);
    const meta = readSmallRegular(path.join(workspace, '.overlay-workspace.json'));
    if (!meta) return null;
    const parsed = JSON.parse(meta.toString('utf8'));
    if (parsed.kind !== 'mazda-cmu-overlay-workspace' || parsed.format !== 2) return null;
    if (!isRealDirectory(path.join(workspace, 'data', 'integration'))) return null;
    if (!isRealDirectory(path.join(workspace, 'data', 'cmu-overlay'))) return null;
    return {
      workspace,
      overlayId: typeof parsed.overlay_id === 'string' ? parsed.overlay_id : 'unknown',
    };
  } catch (_) {
    return null;
  }
}

module.exports = {
  validateRootfs,
  decodeRequestPath,
  confine,
  openConfined,
  readFdBounded,
  readSmallRegular,
  detectOverlayWorkspace,
  SMALL_FILE_LIMIT,
};
