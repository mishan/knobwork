'use strict';

// Receive-only CAN replay data. The Python CLI is the authoritative validator;
// this loader re-checks the same bounds so the Node process never trusts an
// unvalidated file.

const fs = require('fs');

const SCHEMA = 'mazda-cmu-vim-can-v1';
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FRAMES = 100000;
const MAX_PAYLOAD = 64;
const RECENT_LIMIT = 200;
const READINESS_ID = 0x160;
const CHANNELS = {
  public: { port: 1, first: 0x100, last: 0x17f },
  private: { port: 0, first: 0x180, last: 0x1ff },
};

class CanReplayError extends Error {}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function validateRecord(record, line, previous) {
  const fail = (msg) => { throw new CanReplayError(`line ${line}: ${msg}`); };
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('frame must be a JSON object');
  if (record.schema !== SCHEMA) fail('unsupported CAN capture schema');
  if (!isInt(record.sequence)) fail('sequence must be an integer');
  if (record.sequence <= previous) fail('sequence must increase');
  const rule = Object.prototype.hasOwnProperty.call(CHANNELS, record.channel) ? CHANNELS[record.channel] : null;
  if (!rule) fail('channel must be public or private');
  if (!isInt(record.port)) fail('port must be an integer');
  if (record.port !== rule.port) fail(`${record.channel} channel must use port ${rule.port}`);
  if (!isInt(record.id)) fail('id must be an integer');
  if (record.id < rule.first || record.id > rule.last || record.id === READINESS_ID) {
    fail(`ID is outside the ${record.channel} VIM range`);
  }
  const idHex = '0x' + record.id.toString(16).toUpperCase().padStart(3, '0');
  if (record.idHex !== idHex) fail(`idHex must be ${idHex}`);
  if (!isInt(record.length) || record.length < 0 || record.length > MAX_PAYLOAD) {
    fail(`length must be between 0 and ${MAX_PAYLOAD}`);
  }
  if (typeof record.data !== 'string' || !/^[0-9A-F]*$/.test(record.data) || record.data.length !== record.length * 2) {
    fail('data must be uppercase hex matching length');
  }
  return {
    schema: SCHEMA,
    sequence: record.sequence,
    channel: record.channel,
    port: record.port,
    id: record.id,
    idHex,
    length: record.length,
    data: record.data,
  };
}

function loadCanReplay(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    throw new CanReplayError(`CAN capture is unavailable: ${file}`);
  }
  if (!st.isFile()) throw new CanReplayError(`CAN capture is not a regular file: ${file}`);
  if (st.size > MAX_BYTES) throw new CanReplayError(`CAN capture exceeds ${MAX_BYTES} bytes`);
  const raw = fs.readFileSync(file);
  if (raw.length > MAX_BYTES) throw new CanReplayError(`CAN capture exceeds ${MAX_BYTES} bytes`);
  const text = raw.toString('utf8');
  if (Buffer.byteLength(text) !== raw.length || text.includes('\uFFFD')) {
    throw new CanReplayError('CAN capture is not readable UTF-8');
  }
  const frames = [];
  let previous = -1;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (frames.length >= MAX_FRAMES) throw new CanReplayError(`CAN capture exceeds ${MAX_FRAMES} frames`);
    let decoded;
    try {
      decoded = JSON.parse(line);
    } catch (error) {
      throw new CanReplayError(`line ${index + 1}: invalid JSON`);
    }
    const frame = validateRecord(decoded, index + 1, previous);
    frames.push(frame);
    previous = frame.sequence;
  }
  if (frames.length === 0) throw new CanReplayError('CAN capture contains no frames');
  return frames;
}

class CanReplay {
  constructor(frames) {
    this.frames = frames || null;
    this.publicFrames = frames ? frames.filter((f) => f.channel === 'public').length : 0;
    this.privateFrames = frames ? frames.length - this.publicFrames : 0;
  }

  static fromPath(file) {
    return new CanReplay(file ? loadCanReplay(file) : null);
  }

  get available() { return Boolean(this.frames); }

  healthSummary() {
    return {
      available: this.available,
      frameCount: this.available ? this.frames.length : 0,
      publicFrames: this.publicFrames,
      privateFrames: this.privateFrames,
      recentLimit: RECENT_LIMIT,
    };
  }

  endpoint() {
    if (!this.available) {
      return { available: false, mode: 'unavailable', frameCount: 0, publicFrames: 0, privateFrames: 0, frames: [] };
    }
    return {
      available: true,
      mode: 'replay',
      schema: SCHEMA,
      frameCount: this.frames.length,
      publicFrames: this.publicFrames,
      privateFrames: this.privateFrames,
      frames: this.frames.slice(-RECENT_LIMIT),
    };
  }
}

module.exports = { CanReplay, loadCanReplay, CanReplayError, RECENT_LIMIT, MAX_BYTES, MAX_FRAMES };
