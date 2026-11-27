#!/usr/bin/env node
'use strict';

// Independent CMU browser harness entrypoint.

const { loadConfig, exposureWarning } = require('./lib/config');
const { Harness } = require('./lib/harness');

function log(message) {
  process.stdout.write(`[ui-harness] ${message}\n`);
}

async function main() {
  let config;
  let harness;
  try {
    config = loadConfig(process.env);
    harness = new Harness(config, { log });
  } catch (error) {
    process.stderr.write(`[ui-harness] configuration error: ${error.message}\n`);
    process.exit(2);
  }

  log(`mode: ${config.mode}`);
  log(`GUI path: ${config.guiPath}`);
  if (harness.workspace) log(`overlay workspace: ${harness.workspace.workspace}`);
  if (harness.can.available) log(`CAN replay: ${harness.can.frames.length} validated frames`);
  if (config.mode === 'proxy') {
    log(`guest host: ${config.qemuHost} (frontend port + 10000)`);
    if (config.readinessHoldMs > 0) log(`test-only MMUI readiness hold: ${config.readinessHoldMs} ms`);
  }
  if (config.failOverlayAppScript) log('test-only fault: overlay application script returns 503');
  const warning = exposureWarning(config);
  if (warning) process.stderr.write(`[ui-harness] ${warning}\n`);

  let listeners;
  try {
    listeners = await harness.start();
  } catch (error) {
    process.stderr.write(`[ui-harness] ${error.message}\n`);
    process.exit(1);
  }
  for (const l of listeners) log(`listening: ${l.name} on ${l.address}`);

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received; closing clients and listeners`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    harness.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
