# Reversible overlay manager

This is the phase-2 USB transaction manager from
[`docs/roadmap.md`](../docs/roadmap.md). The pinned bundle installs two inert
diagnostic files and a minimal boot-health bridge under `/jci/scripts`. It does
not patch the HMI framework, NVRAM, or native binaries.

## Safety contract

- `install-patches.sh` pins the complete manifest SHA-256.
- SHA-256 uses `sha256sum` when present and falls back to the stock v74
  `/usr/bin/openssl`; startup verifies the backend against the empty-string
  digest before trusting it.
- The manifest pins the exact North American `74.00.324A` `version.ini`, every
  stock target state, and every payload SHA-256.
- Every version, hash, free-space, and syntax check completes before `/` is
  remounted read-write.
- Install refuses mixed stock/payload state. Repair accepts a known mixture but
  refuses any unrecognized target content.
- First-install backups and absent-file markers live under
  `/data/cmu-overlay/backups/files` and are never replaced.
- Existing-file backups retain the original numeric mode in a separate
  read-only sidecar so restore does not inherit the hardened backup mode.
- Manifest-declared NVRAM keys use the stock `add`/`keys`/`commit` sequence,
  immutable first-value backups under `/data/cmu-overlay/backups/nvram`, exact
  readback verification, and the same reverse-order rollback as files.
- Replacements are copied into the target directory, verified, and atomically
  renamed. A reverse-order rollback stack is retained until final verification
  and transaction commit.
- Each transaction publishes a single active pointer only after its manifest,
  original safety state, metadata snapshot, and initial phase are durable.
  Every rollback record and previous file/value is synced under `/data` before
  the corresponding file or NVRAM mutation begins.
- On the next invocation, an uncommitted active transaction is rolled back
  idempotently before normal preflight. A transaction whose commit marker was
  synced is retained. Both paths restore the original root mount and watchdog
  state before clearing the active pointer; invalid recovery metadata blocks
  further mutation.
- The original root mount mode and watchdog value are captured, verified after
  restoration, and failures are returned to the caller.
- Identical journals are appended on the USB and under `/data/cmu-overlay`.

The accepted actions are `install`, `verify`, `repair`, `disable`, and
`restore`. `boot-attempt` increments the persistent counter and restores all
stock targets in safe mode on the third unacknowledged attempt. Install and
repair preserve a read-only runtime copy under
`/data/cmu-overlay/runtime/<manifest-sha256>` so boot actions remain available
after the USB is removed. Runtime actions mirror the persistent journal to
`/data/cmu-overlay/runtime-journal.log` because no USB is assumed to be present.

The boot bridge replaces the otherwise empty, exactly hash-pinned stock
`stage_1.sh` and `stage_3.sh` scripts. `stage_1.sh` records an attempt at the
earliest Service Manager dependency gate. `stage_3.sh`, which is released only
after `jciMMUI` starts, records success and resets the counter. Both scripts and
their helper are fail-open: bookkeeping damage is logged but always returns
success so it cannot block the stock service graph. Disable, restore, and safe
mode put the exact stock stage scripts back and remove the helper. Installation
orders the helper before `stage_1.sh`, so the persisted runtime can recover an
interrupted transaction as soon as the boot stage itself becomes active.

This is a native-service readiness signal, not proof that Opera or HomeScreen
JavaScript initialized successfully. A future HMI framework overlay must move
the success acknowledgement to a reviewed browser/UI readiness point before it
can rely on this counter for JavaScript bootloop recovery.

JavaScript entries use the manifest type `js`. They are rejected unless a
working syntax checker is available through `MZD_OVERLAY_JS_CHECKER`, `node`,
or `/data/cmu-overlay/bin/js-check`. The manager checks the USB payload during
preflight and the same-filesystem staged copy immediately before rename.

## Prepare media

Validate the bundle and build a new USB staging directory:

```sh
python3 overlay/prepare_usb.py --check
python3 overlay/prepare_usb.py /path/to/new-usb-tree
```

The builder refuses an existing destination. It copies `jci-autoupdate`, the
manager, manifest, and payloads, then creates the v74 command-filename launcher.
Copy the *contents* of the resulting directory to the root of a FAT32 USB
stick. The package metadata remains deliberately broad because the command
filename runs before normal validation; the shell preflight provides the real,
exact firmware gate.

With no arguments, the launcher opens a native, state-aware dialog: a stock or
disabled unit offers install/cancel, while an enabled unit offers
repair/disable/cancel. Explicit actions remain available from an authenticated
bench shell. Do not deploy it to a vehicle merely because the off-target tests
pass.

## Verification

The regression suite builds a fresh replica of the v74 paths for every test:

```sh
python3 -m unittest discover -s overlay/tests -v
```

It covers the full action lifecycle, firmware and manifest rejection, partial
and unexpected state, rollback at multiple failure points, safety-state
restoration, the installed boot bridge, third-attempt safe mode, fail-open
runtime corruption, transactional NVRAM, simulated process loss during file,
NVRAM, metadata, commit, and rollback boundaries, corrupted recovery records,
incomplete backup pairs, the no-argument dialog path, and JavaScript preflight
before remount.
