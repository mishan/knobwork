'use strict';

// Read-only overlay workspace diagnostics (format 2). Every value is read from
// its own path without following a symlink at that path; failures fall back to
// the documented defaults.

const path = require('path');
const { readSmallRegular } = require('./rootfs');

const JOURNAL_LINES = 40;

function readValue(file, fallback) {
  const buffer = readSmallRegular(file);
  if (!buffer) return fallback;
  const text = buffer.toString('utf8').trim();
  return text === '' ? fallback : text;
}

function readJournal(file) {
  const buffer = readSmallRegular(file);
  if (!buffer) return [];
  const lines = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.slice(-JOURNAL_LINES);
}

function overlayStatus(workspace) {
  if (!workspace) {
    return { status: 404, body: { available: false, error: 'selected root is not a validated overlay workspace' } };
  }
  const W = workspace.workspace;
  const manager = path.join(W, 'data', 'cmu-overlay');
  return {
    status: 200,
    body: {
      available: true,
      overlayId: workspace.overlayId || 'unknown',
      managerState: readValue(path.join(manager, 'state'), 'factory'),
      activeTransaction: readValue(path.join(manager, 'active-transaction'), 'none'),
      bootAttempts: readValue(path.join(manager, 'boot-attempts'), '0'),
      mountState: readValue(path.join(W, 'emulated', 'mount-state'), 'unknown'),
      watchdog: readValue(path.join(W, 'emulated', 'watchdog'), 'unknown'),
      journal: readJournal(path.join(manager, 'journal.log')),
    },
  };
}

function integrationOverridePath(workspace) {
  return workspace ? path.join(workspace.workspace, 'data', 'integration', 'developer_mode_GuiConfig.js') : null;
}

module.exports = { overlayStatus, integrationOverridePath, JOURNAL_LINES };
