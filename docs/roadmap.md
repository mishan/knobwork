# Modification and recovery roadmap

## Phase 1: safe research baseline

- Treat the official stock 74.00.324A package as immutable input.
- Record package and extracted-file hashes.
- Make all generated images and overlays disposable.
- Modernize the UI emulator and add parser/navigation/fault tests.
- Build the hybrid QEMU userspace environment described in
  [emulation.md](emulation.md).
- Capture real-CMU traces only through read-only or reversible instrumentation.

## Phase 2: reversible overlay manager

Adapt the v74 USB filename launcher pattern into a general overlay installer.
Required properties:

- accept only exact known firmware metadata;
- verify the SHA-256 of every target before changing it;
- reject partial or unexpected prior modifications;
- preserve immutable first-install backups under `/data`;
- stage replacements on the same filesystem;
- syntax-check JavaScript before rename;
- use atomic rename and `sync`;
- journal every action and result to USB and `/data`;
- always restore watchdog state and mount state;
- implement install, verify, repair, disable, and restore actions;
- support a boot-attempt counter and safe-mode rollback.

The local TouchTune 1.1.0 implementation supplies a concrete base for launcher
discovery, exact `.324A` gating, the `/tmp` single-run guard, dialogs, immutable
first backups, NVRAM restore, watchdog handling, USB logging, and reusable
install/repair/remove media. Preserve those tested mechanisms. Extend them for
larger patch sets with:

- a signed or review-pinned manifest of payload and expected target hashes;
- a preflight phase that performs every version/hash/space/syntax check before
  remounting the root filesystem read-write;
- same-filesystem staging plus atomic rename, never in-place `sed -i` edits;
- a transaction journal and immediate reverse-order rollback on any failure;
- failure propagation for NVRAM writes, watchdog restoration, remount, and
  final verification rather than warning-only completion; and
- off-target tests running against a disposable replica of the v74 paths.

Start with a harmless diagnostic overlay before any framework modification.

## Phase 3: runtime and UI improvements

Suggested order:

1. diagnostics and trace correlation;
2. script-loader failure reporting and safe fallback;
3. WebSocket state-machine tests and narrowly validated fixes;
4. measured logging reduction;
5. bounded cleanup of timers/listeners/queues;
6. interface changes implemented as isolated apps/resources;
7. service retry/reset-policy changes only after failure evidence.

Every change should have an emulator test, exact installation preconditions,
and a single-action restore path.

## Hardware recovery gate

No boot-critical experiment proceeds until all are true:

- full NOR read captured twice with matching hashes;
- backup includes boot-select, IBC1, IBC2, failsafe, config, and secure-sector
  boundaries as supported by the programmer;
- external programmer can erase/write/verify a noncritical test chip or spare
  CMU reliably;
- serial console output is captured;
- power supply and ignition behavior are controlled on the bench;
- rollback steps are written and rehearsed;
- the stock signed 74 package remains available.

Separately investigate IBC Serial Downloader mode. Treat it as unproven until a
kernel can be loaded into RAM without writing persistent storage.

## Decision rule

Use the least invasive layer that can deliver the desired result:

| Goal | Preferred layer |
| --- | --- |
| UI layout/behavior | browser tests + USB overlay |
| Framework resilience | hybrid emulator + guarded overlay |
| Native service behavior | QEMU ARM userspace/full-system guest |
| File/config transaction | overlay manager or normal-mode package |
| Kernel/driver experiment | spare CMU or board-focused QEMU work |
| Failsafe/bootloader experiment | verified hardware recovery first |
