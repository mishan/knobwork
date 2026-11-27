// Mutation testing per module group: each group runs only the tests that
// exercise it. Usage: STRYKER_GROUP=<name> npx stryker run emulation/ui_harness/stryker.config.mjs
import os from 'node:os';
import path from 'node:path';

const T = 'emulation/ui_harness/test';
const seed = 'PROP_SEED=1 PROP_RUNS=120';
const groups = {
  boundaries: {
    mutate: ['emulation/ui_harness/lib/css.js', 'emulation/ui_harness/lib/rootfs.js'],
    command: `node --test ${T}/unit.test.js && ${seed} node --test --test-name-pattern='P1|P2' ${T}/properties.test.js && node --test --test-name-pattern='^http' ${T}/integration.test.js`,
  },
  frames: {
    mutate: ['emulation/ui_harness/lib/frames.js'],
    command: `node --test ${T}/unit.test.js ${T}/scenario.test.js && node --test --test-name-pattern='^(mock|proxy)' ${T}/integration.test.js && ${seed} node --test --test-name-pattern='P3' ${T}/properties.test.js && node --test ${T}/abuse.test.js`,
  },
  scenario: {
    mutate: ['emulation/ui_harness/lib/scenario.js'],
    command: `node --test ${T}/scenario.test.js && node --test --test-name-pattern='^mock' ${T}/integration.test.js && node --test ${T}/abuse.test.js`,
  },
  lifecycle: {
    mutate: ['emulation/ui_harness/lib/readiness.js', 'emulation/ui_harness/lib/display.js'],
    command: `node --test ${T}/unit.test.js && node --test --test-name-pattern='^proxy' ${T}/integration.test.js && node --test ${T}/abuse.test.js`,
  },
  proxy: {
    mutate: ['emulation/ui_harness/lib/proxy.js'],
    command: `node --test --test-name-pattern='^proxy' ${T}/integration.test.js && ${seed} node --test --test-name-pattern='P3' ${T}/properties.test.js && node --test ${T}/abuse.test.js`,
  },
};
const group = groups[process.env.STRYKER_GROUP];
if (!group) throw new Error(`STRYKER_GROUP must be one of ${Object.keys(groups).join(', ')}`);
const out = path.join(process.env.TMPDIR || os.tmpdir(), 'stryker');

export default {
  testRunner: 'command',
  commandRunner: { command: group.command },
  mutate: group.mutate,
  ignorePatterns: ['scratch', 'docs', 'contract', '__pycache__', 'emulation/tests'],
  tempDirName: path.join(out, `tmp-${process.env.STRYKER_GROUP}`),
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: { fileName: path.join(out, `${process.env.STRYKER_GROUP}.json`) },
  concurrency: 6,
  timeoutMS: 20000,
  cleanTempDir: 'always',
};
