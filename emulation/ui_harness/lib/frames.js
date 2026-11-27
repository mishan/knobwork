'use strict';

// Frame helpers. Payloads are opaque Buffers; these functions only produce
// bounded diagnostic summaries and, for the mock engine, parse or encode the
// "JSON object + optional one-byte sequence suffix" form used by MMUI.

const PREVIEW_LIMIT = 160;
const SUMMARY_FIELDS = ['msgType', 'eventId', 'uiaId', 'ctxtId', 'msgId', 'contextSeq', 'enabled', 'alertId'];

function toBuffer(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
}

// Try to read a JSON object from a text payload, allowing exactly one trailing
// non-JSON byte (the MMUI sequence suffix). Returns { object, seq } or null.
function parseJsonObject(buffer) {
  const text = buffer.toString('utf8');
  // A trailing character after the closing brace is the sequence suffix. Check
  // this form first: JSON.parse would silently accept a whitespace suffix.
  // A '}' suffix (sequence 125) is tried after the unsuffixed form.
  const suffixed = text.length > 1 ? [text.slice(0, -1), text.charCodeAt(text.length - 1)] : null;
  const attempts = [];
  if (suffixed && text[text.length - 1] !== '}') attempts.push(suffixed);
  attempts.push([text, null]);
  if (suffixed && text[text.length - 1] === '}') attempts.push(suffixed);
  for (const [candidate, seq] of attempts) {
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return { object: value, seq };
    } catch (_) { /* try the next form */ }
  }
  return null;
}

function summarize(object) {
  const summary = {};
  for (const key of SUMMARY_FIELDS) {
    const v = object[key];
    if (v === undefined) continue;
    // Control characters would each cost six bytes in JSON; real ids never contain them.
    if (typeof v === 'string') summary[key] = v.slice(0, 80).replace(/[\x00-\x1f\x7f-\x9f]/g, '.');
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) summary[key] = v;
  }
  return summary;
}

// Bounded metadata record for diagnostics. Binary payloads never get a preview.
function describeFrame(data, isBinary, direction, parsed = isBinary ? null : parseJsonObject(toBuffer(data))) {
  const buffer = toBuffer(data);
  const record = {
    at: new Date().toISOString(),
    direction,
    binary: Boolean(isBinary),
    bytes: buffer.length,
    summary: null,
  };
  if (!isBinary) {
    if (parsed) {
      record.summary = summarize(parsed.object);
      if (parsed.seq !== null) record.sequence = parsed.seq;
    }
    const head = buffer.subarray(0, PREVIEW_LIMIT * 4).toString('utf8');
    // Replace control characters so a preview can never carry raw bytes.
    record.preview = head.slice(0, PREVIEW_LIMIT).replace(/[\x00-\x1f\x7f-\x9f]/g, '.');
    record.truncated = buffer.length > Buffer.byteLength(record.preview);
  }
  return record;
}

// Encode a mock MMUI message: JSON text with an optional one-byte suffix.
function encodeMmui(object, seq) {
  const json = JSON.stringify(object);
  if (seq === undefined || seq === null) return json;
  return json + String.fromCharCode(seq);
}

class BoundedList {
  constructor(limit) {
    this.limit = limit;
    this.items = [];
    this.dropped = 0;
  }

  push(item) {
    this.items.push(item);
    while (this.items.length > this.limit) {
      this.items.shift();
      this.dropped++;
    }
  }

  clear() { this.items = []; }

  toJSON() { return this.items.slice(); }
}

module.exports = { toBuffer, parseJsonObject, summarize, describeFrame, encodeMmui, BoundedList, PREVIEW_LIMIT };
