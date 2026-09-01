# Reversible overlay manager

This is the phase-2 USB transaction manager from
[`docs/roadmap.md`](../docs/roadmap.md). The pinned bundle installs diagnostic
scripts, a minimal boot-health bridge, and a Developer Diagnostics proof-of-
concept under the stock CMU Applications menu. It does not replace stock HMI
framework files, change NVRAM, or patch native binaries.

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
- The native CAN listener is installed as a stock-absent, hash-pinned file. It
  has no boot hook; capture is explicit, receive-only, and writes only to the
  currently mounted overlay USB. Disable, restore, and safe mode stop it before
  removing the executable.

The accepted actions are `install`, `verify`, `repair`, `disable`, and
`restore`, plus the USB-only `capture-can` start/stop toggle. `boot-attempt`
increments the persistent counter and restores all
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
JavaScript initialized successfully. The example application deliberately does
not change that acknowledgement. A production HMI overlay must move success to
a reviewed browser/UI readiness point before relying on this counter for
JavaScript bootloop recovery.

JavaScript entries use the manifest type `js`. They are rejected unless a
working syntax checker is available through `MZD_OVERLAY_JS_CHECKER`, `node`,
or `/data/cmu-overlay/bin/js-check`. The manager checks the USB payload during
preflight and the same-filesystem staged copy immediately before rename.

## Developer Diagnostics example

The example uses the existing `/data/integration/developer_mode_GuiConfig.js`
hook to register `Developer Diagnostics` under **Applications** without editing
stock `systemApp.js` or framework files. Its JavaScript and CSS live in the
existing `apps/system` directories so installation never has to create a new
root-filesystem directory. Disable, restore, safe mode, and transaction rollback
remove all three files and put the exact stock absent state back.

The integration also wraps the stock script loader at runtime without replacing
`Utility.js`. It preserves the normal success path and keeps the latest 80 load
records in `window.__cmuScriptLoaderDiagnostics`. The example app is marked
optional: an immediate script error records the URL, classification, and elapsed
time, removes the now-unusable menu entry, drops only queued messages for that
app, and returns to **Applications** with the framework idle. Required stock
scripts retain the factory timeout/restart behavior. No new timeout is imposed
until real-CMU load times have been measured.

The app displays manager state, active transaction, boot counter, emulated mount
and watchdog state, backend and socket health, loaded UI applications, recent
manager journal entries, a bounded **Script Loader** trace, and a **Vehicle
Inputs** section. The input section
records shared framework data and keeps the latest 80 messages per incoming
MMUI, AppSDK, and DBAPI channel. The UI shows shared values and the latest 12
messages from each channel; the complete bounded capture is available to browser
developer tools as `window.__developerDiagnosticsInputs`.

When the emulator is launched with `--can-replay`, the app also displays the
latest validated public/private VIM gateway records in a separate
**Gateway CAN (receive-only)** section. These records are not presented as
decoded vehicle signals or confirmed raw CAN arbitration IDs. Capture format,
bench constraints, and the receive-only native collector are documented in
[`can/README.md`](../can/README.md).

Steering angle is detected by field name anywhere in observed input. The stock
v74 application JavaScript does not name or consume a steering-angle signal
(`SteeringWheelLoc` is left/right-hand-drive configuration, not an angle), so
the app reports `not exposed or observed` until such a field actually reaches
the GUI. This distinguishes a missing GUI surface from a synthetic value.

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
CAN capture/manage/cancel; the manage dialog then offers
repair/disable/cancel. Capture creates timestamped JSONL and stderr files on
that USB. Invoke `capture-can` again and wait for the stopped message before
removing the drive. Explicit actions remain available from an authenticated
bench shell. Do not deploy it to a vehicle merely because the off-target tests
pass.

## Developer emulator workflow

`emulate.py overlay` runs the actual USB manager against a persistent,
disposable copy of the firmware tree. Initialization verifies that the source
is the exact stock image pinned by the manifest, clones it with reflinks when
the filesystem supports them, snapshots the current USB bundle, and creates
emulated `/data`, root-mount, watchdog, and NVRAM state. It never points the
manager at the source firmware.

Create the default ignored workspace and inspect its initial state:

```sh
python3 emulate.py overlay init --root /path/to/extracted/root
python3 emulate.py overlay status
```

If exactly one firmware package has already been prepared with
`emulate.py unpack`, `--root` can be omitted. The default workspace is
`scratch/overlay-workspace`; use `--workspace /another/path` on every command
to keep multiple experiments.

Run the normal lifecycle through `qemu-arm` and the stock firmware's ARM
BusyBox `ash`:

```sh
python3 emulate.py overlay install
python3 emulate.py overlay verify --runtime
python3 emulate.py overlay boot-attempt --runtime
python3 emulate.py overlay status
python3 emulate.py overlay boot-success --runtime
python3 emulate.py overlay disable --runtime
python3 emulate.py overlay verify --runtime
```

The `--runtime` calls execute the manager copy persisted under the emulated
`/data`, just as boot hooks must when the USB is absent. Stock-shell mode is
the default and requires `qemu-arm` plus `root/bin/busybox`; external utilities
and device behavior remain host-backed test shims. `--shell host` is available
only for debugging the harness itself.

The emulator does not run the real VIM listener because it has no `vim_app` or
VIP hardware. Use `ui --can-replay` for the complete developer UI workflow;
the off-target overlay suite separately proves installation/removal and the
USB capture process lifecycle with a fake receive-only producer.

To rehearse restart recovery, interrupt an install after its second durable
mutation, inspect the live transaction pointer, then invoke the manager again:

```sh
python3 emulate.py overlay install --crash-point mutation:2
python3 emulate.py overlay status
python3 emulate.py overlay verify
python3 emulate.py overlay status
```

The injected command exits with status 99 by design. The following action must
first roll the incomplete transaction back, restore the emulated mount and
watchdog state, clear the pointer, and only then perform verification. Other
supported crash points include `metadata` and `committed`; handled failure
paths can be selected with `--fail-point`.

The modified working root can be passed directly to other emulator stages:

```sh
python3 emulate.py ui --root scratch/overlay-workspace/root
python3 emulate.py build-guest --root scratch/overlay-workspace/root
```

To try the installed example, leave the UI command running in one terminal:

```sh
python3 emulate.py ui --root scratch/overlay-workspace/root
```

Open `http://127.0.0.1:8080/`, choose **Applications**, then
**Developer Diagnostics**. A second terminal can run the automated commander,
render, diagnostics, input-capture, back-navigation, and runtime-error gate:

```sh
python3 emulate.py verify-ui --expect-overlay-app \
  --screenshot /tmp/mazda-overlay-diagnostics.png
```

The safe fallback has a deterministic emulator drill. Start a fresh harness
that returns an injected error only for the optional application script, then
run the matching verifier from another terminal:

```sh
python3 emulate.py ui --root scratch/overlay-workspace/root \
  --fail-overlay-app-script

python3 emulate.py verify-ui --expect-overlay-app-fallback
```

The verifier requires exactly one injected request, a structured optional-load
failure, no partial app instance or retry loop, removal of the broken entry, an
empty framework queue, and successful navigation back to HomeScreen. The fault
switch is emulator-only and is never included in the USB payload.

To exercise the receive-only gateway-data surface with the synthetic replay
fixture:

```sh
python3 emulate.py ui --root scratch/overlay-workspace/root \
  --can-replay emulation/fixtures/can/public-private-sample.jsonl

python3 emulate.py verify-ui --expect-overlay-app --expect-can-replay
```

The harness serves manager state through `/__emu/overlay` only when its root is
inside a validated overlay workspace. A normal stock root continues to receive
the empty developer-mode hook. Status is also available as machine-readable
JSON with `--json`. When the experiment is finished, remove only the validated
disposable workspace:

```sh
python3 emulate.py overlay reset
```

Because `init` snapshots both inputs, reset and initialize again after changing
the bundle or selecting a different firmware root.

## Verification

The regression suite builds a fresh replica of the v74 paths for every test:

```sh
python3 -m unittest discover -s overlay/tests -v
python3 -m unittest discover -s emulation/tests -v
```

It covers the full action lifecycle, firmware and manifest rejection, partial
and unexpected state, rollback at multiple failure points, safety-state
restoration, the installed boot bridge, third-attempt safe mode, fail-open
runtime corruption, transactional NVRAM, simulated process loss during file,
NVRAM, metadata, commit, and rollback boundaries, corrupted recovery records,
incomplete backup pairs, the no-argument dialog path, and JavaScript preflight
before remount. It also verifies that the native listener installs and removes
transactionally and that capture starts, writes JSONL to the USB, stops, and
does not leave a second process. The emulator-workflow suite additionally
exercises the public
CLI, source-tree preservation, `/data` mount modeling, application payload
installation/removal, persisted-runtime execution, guarded cleanup, and restart
recovery after an injected process loss. `verify-ui --expect-overlay-app` then
drives the visible application in the stock 800x480 HMI and fails on browser
syntax or runtime errors. The `--expect-overlay-app-fallback` variant verifies
immediate recovery from a missing optional application script.
