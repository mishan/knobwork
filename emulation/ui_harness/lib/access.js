'use strict';

// Which Host and Origin headers the harness accepts. Browsers let any page
// open WebSockets to 127.0.0.1, and DNS rebinding can point an attacker's
// hostname at it, so requests must name an allowed host and WebSockets must
// come from the harness page itself (or from a non-browser client, which
// sends no Origin).

const net = require('net');

const WILDCARDS = new Set(['0.0.0.0', '::', '']);

function isLoopback(host) {
  if (host === 'localhost') return true;
  if (net.isIPv4(host)) return host.startsWith('127.');
  return host === '::1';
}

// "name:port", "[v6]:port", "name", "[v6]" -> lowercase host without brackets.
function hostOf(header) {
  const value = String(header).trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) return bracketed[1];
  const plain = /^([^:\s]+)(?::\d+)?$/.exec(value);
  return plain ? plain[1] : null;
}

function createAccessPolicy({ host, httpPort }) {
  const configured = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  const wildcard = WILDCARDS.has(configured);

  function allowedName(name) {
    if (name === null) return false;
    if (isLoopback(name) || name === configured) return true;
    return wildcard && net.isIP(name) !== 0; // explicitly exposed: any address, never a hostname
  }

  return {
    // An absent Host comes only from non-browser clients.
    hostAllowed(header) {
      return header === undefined || allowedName(hostOf(header));
    },
    originAllowed(header) {
      if (header === undefined) return true;
      let origin;
      try { origin = new URL(header); } catch (_) { return false; }
      return origin.protocol === 'http:' && Number(origin.port) === httpPort &&
        allowedName(hostOf(origin.hostname));
    },
  };
}

module.exports = { createAccessPolicy };
