# Knobwork

Research, emulation, and reversible-overlay tools for Mazda Connect Gen 6
infotainment head units (CMU).

> This is an unofficial community project. It is not affiliated with, endorsed
> by, or sponsored by Mazda Motor Corporation, Johnson Controls, Visteon, or
> their affiliates. Mazda and Mazda Connect names are used only to identify
> compatibility with the relevant owner-supplied system.

This repository records the analysis of the Mazda Connect Gen 6 CMU firmware and
the proposed development strategy for improving runtime performance, resilience,
and the user interface.

The working baseline is the North American `cmu150` firmware `74.00.324A`.
Earlier `55.00.750B`, `70.00.021B`, and `70.00.100A` packages are retained as
comparison points. Firmware is always user-supplied and is not committed here;
none of the patch concepts documented here have been installed on a CMU.

## Current conclusions

- Base future work on stock `74.00.324A`; do not assemble a hybrid firmware by
  copying arbitrary native binaries from 74 into 70.
- Use a reversible USB overlay installer for routine JavaScript, CSS, resource,
  configuration, and carefully scoped native-file changes.
- Firmware packages are signed and verified on the CMU. This project works
  through a reversible overlay and does not modify package signing or
  verification.
- The practical emulator should initially combine real ARM CMU services running
  under QEMU with a browser-rendered UI. Exact board emulation can be added only
  where it produces useful test coverage.

## Documents

- [Firmware inventory and comparison](docs/firmware-inventory.md)
- [Runtime and UI findings](docs/runtime-and-ui.md)
- [Emulation architecture](docs/emulation.md)
- [Emulator handoff review and verified baseline](docs/emulator-review.md)
- [Independent browser harness specification](docs/browser-harness-independent-spec.md)
- [Modification and recovery roadmap](docs/roadmap.md)
- [Reversible overlay manager](overlay/README.md)
- [Receive-only VIM CAN capture](can/README.md)
- [Evidence, hashes, and sources](docs/evidence.md)

## Confidence language

The documents use these terms deliberately:

- **Verified**: reproduced directly from the local package or with a local
  cryptographic/tooling check.
- **Strong inference**: supported by binary structure, strings, or multiple
  independent observations, but not yet exercised on hardware.
- **Open**: requires emulator work, a bench CMU, serial capture, or controlled
  hardware testing.

## Developer orientation

There are three development environments, with different fidelity and risk:

| Environment | Use it for | What it does not prove |
| --- | --- | --- |
| Browser UI harness | Fast HMI and application work | Native ARM services, hardware, or USB installation |
| Disposable overlay workspace | The real overlay shell logic, backups, rollback, and installed files | Actual CMU mount, watchdog, Opera, VIM, or USB behavior |
| Generic ARM system guest | Stock D-Bus, Service Manager, MMUI, AppSDK, and DBAPI integration | The Mazda board, Vivante display stack, or real vehicle buses |

Physical-CMU use is a separate, experimental step. Complete the browser and
overlay gates first; do not treat an emulator pass as hardware validation.

### 1. Set up the host

Run from the repository root. The basic browser and overlay workflow needs:

- Linux, Python 3.10 or newer, Bash, `unzip`, `gzip`, `tar`, and `sha256sum`;
- Node.js and npm for the HTTP/WebSocket harness;
- Chrome or Chromium for the headless 800x480 UI regression; and
- `qemu-arm` from QEMU user-mode emulation for the stock-shell overlay path.

The full-system guest additionally needs `qemu-system-arm`. The CAN listener
only needs an ARM cross-compiler when rebuilding the already checked-in target
binary; see [`can/README.md`](can/README.md#build-and-capture-on-a-bench-cmu).

Install the pinned JavaScript dependencies and inspect the local environment:

```sh
npm ci
python3 emulate.py status
```

Firmware is user-supplied and is never committed. Prepare the exact North
American `74.00.324A` package used by the current overlay manifest:

The package password is not included; see
[`tools/firmware/README.md`](tools/firmware/README.md) for where to put it.

```sh
python3 emulate.py unpack /path/to/cmu150_NA_74.00.324A_update.up
python3 emulate.py smoke
```

The unpacker writes an ignored `.firmware/<package>/root` tree and records the
source package hash. If exactly one prepared root exists, later commands find
it automatically. Alternatively, pass `--root /path/to/root`, pass
`--firmware /path/to/file.up`, or set `CMU_ROOTFS` explicitly.

### 2. Run the browser UI emulator

Start the stock HMI with the deterministic mock MMUI/AppSDK/DBAPI backend:

```sh
python3 emulate.py ui
```

Open `http://127.0.0.1:8080/`. In a second terminal, run the syntax, startup,
commander-navigation, rendering, and browser-runtime gate:

```sh
python3 emulate.py verify-ui --screenshot /tmp/mazda-ui.png
```

The first command remains running while the verifier connects to it. This is
the fastest loop for HMI code, but it serves the selected firmware root as-is;
use an overlay workspace when testing overlay payloads.

### 3. Exercise the overlay manager in emulation

The overlay workflow never modifies the prepared firmware. `init` verifies the
stock root against the manifest, copies it to an ignored workspace, snapshots
the current `overlay/usb` bundle, and creates disposable `/data`, NVRAM, mount,
and watchdog state:

```sh
python3 emulate.py overlay init
python3 emulate.py overlay status
python3 emulate.py overlay install
python3 emulate.py overlay verify --runtime
```

The default workspace is `scratch/overlay-workspace`. To keep multiple
experiments, pass the same `--workspace /another/path` to every overlay command.

By default, manager actions run through the stock ARM BusyBox `ash` under
`qemu-arm`. `--shell host` exists only for debugging the harness. The useful
actions are:

| Action | Meaning |
| --- | --- |
| `install` | Apply an entirely stock-to-overlay transition |
| `verify` | Verify the state recorded under emulated `/data` |
| `repair` | Reapply a known stock/payload mixture; reject unknown edits |
| `disable` | Restore stock targets while retaining backups |
| `restore` | Restore stock targets and record a restored state |
| `boot-attempt` / `boot-success` | Exercise the boot-health counter and acknowledgement |
| `status` | Inspect targets, journal, transaction, mount, and watchdog state |
| `reset` | Remove only a validated disposable workspace |

`--runtime` executes the read-only manager copy persisted under emulated
`/data`, which is how the boot hooks operate without the USB. To rehearse
interrupted-transaction recovery:

```sh
python3 emulate.py overlay install --crash-point mutation:2
python3 emulate.py overlay status
python3 emulate.py overlay verify
python3 emulate.py overlay status
```

The injected install exits with status 99. The next invocation must roll back
the incomplete transaction and restore the emulated mount and watchdog before
performing verification.

Run the installed Developer Diagnostics application from the workspace:

```sh
python3 emulate.py ui --root scratch/overlay-workspace/root
```

Open **Applications** and select **Developer Diagnostics**. In another
terminal, run its application-specific gate:

```sh
python3 emulate.py verify-ui --expect-overlay-app \
  --screenshot /tmp/mazda-overlay-diagnostics.png
```

To exercise Phase 3 optional-script recovery without deleting or corrupting an
installed file, restart the harness with its narrowly scoped fault switch:

```sh
python3 emulate.py ui --root scratch/overlay-workspace/root \
  --fail-overlay-app-script

python3 emulate.py verify-ui --expect-overlay-app-fallback
```

This deliberately fails only `developerdiagnosticsApp.js`. The verifier proves
that the load is reported once, the unusable entry is removed, no partial app or
queued retry remains, and the stock UI returns from Applications to HomeScreen.

To test the CAN diagnostics surface without hardware, add the strict synthetic
replay fixture when starting the UI, then require it in verification:

```sh
python3 emulate.py ui --root scratch/overlay-workspace/root \
  --can-replay emulation/fixtures/can/public-private-sample.jsonl

python3 emulate.py verify-ui --expect-overlay-app --expect-can-replay
```

`init` snapshots the bundle. After changing anything under `overlay/usb`, reset
and initialize the workspace again before judging the new payload:

```sh
python3 emulate.py overlay reset
python3 emulate.py overlay init
python3 emulate.py overlay install
```

### 4. Add an application to the overlay

The current Developer Diagnostics application is the reference implementation,
not yet a generic application registry. Its three relevant pieces are:

- [`developerdiagnosticsApp.js`](overlay/usb/payloads/developer-app/developerdiagnosticsApp.js),
  the stock `baseApp` application and context table;
- [`developerdiagnosticsApp.css`](overlay/usb/payloads/developer-app/developerdiagnosticsApp.css),
  optional application styles; and
- [`developer_mode_GuiConfig.js`](overlay/usb/payloads/developer-app/developer_mode_GuiConfig.js),
  the integration hook that loads the files, adds the Applications row, routes
  the context/focus messages, and handles Back navigation.

To add another application:

1. Choose a lowercase UIA ID, a unique context ID, and a display name. Keep the
   constructor name consistent with the stock loader convention:
   `<uiaId>App`.
2. Add the application JavaScript and optional CSS under
   `overlay/usb/payloads/developer-app`. Follow the reference app's
   `baseApp.init`, `appInit`, `_contextTable`, `_messageTable`, and stock
   template structure. Stay within the conservative ES5-style syntax used by
   the stock UI (`var`, functions, and prototypes); do not introduce modern
   syntax merely because current Node or Chrome accepts it.
3. Extend the integration hook for the new ID. It must load the new JS/CSS from
   `apps/system`, add one row to `system._masterApplicationDataList`, add the ID
   to the Applications context, route selection to the new context, and return
   `Global.GoBack` to Applications. For several apps, refactor the current
   single-app branches into a small definitions table rather than stacking
   unrelated prototype wrappers.
4. Add each installed file to [`overlay/usb/manifest.v1`](overlay/usb/manifest.v1).
   New files use stock state `absent`; replacements require the exact stock
   SHA-256. Use type `js` for JavaScript so both preflight and staged-copy
   syntax gates run. Target parent directories must already exist on the pinned
   firmware unless the manager is deliberately extended to create them.
5. Recompute the SHA-256 for every changed payload, update its manifest entry,
   bump `overlay_id`, then compute the new manifest SHA-256 and update
   `OVERLAY_MANIFEST_SHA256` in
   [`overlay/usb/install-patches.sh`](overlay/usb/install-patches.sh). Do the
   manifest pin last.
6. Add an automated UI check for the new Applications entry, context, Back
   behavior, and any application-specific state. The existing
   `--expect-overlay-app` option checks Developer Diagnostics specifically; it
   does not automatically prove a newly added app.

A manifest file entry has this format:

```text
file|/absolute/target|stock-sha256-or-absent|payloads/relative/file|payload-sha256|0755|sh
file|/absolute/target|stock-sha256-or-absent|payloads/relative/file|payload-sha256|0644|js
file|/absolute/target|stock-sha256-or-absent|payloads/relative/file|payload-sha256|0644|data
```

Useful hash and validation commands are:

```sh
sha256sum overlay/usb/payloads/developer-app/*
sha256sum overlay/usb/manifest.v1
python3 overlay/prepare_usb.py --check
python3 -m unittest discover -s overlay/tests -v
python3 -m unittest discover -s emulation/tests -v
```

Never skip the final browser gate for an application change. It proves the
harness-visible application lifecycle, while a target-compatible syntax gate
is still required for stock Opera. A payload hash proves file identity, not
parseability or safe context behavior.

### 5. Prepare a physical-CMU USB

The current manifest is pinned only to North American `74.00.324A`. Build a new
staging tree; the destination must not already exist:

```sh
python3 overlay/prepare_usb.py --check
python3 overlay/prepare_usb.py /tmp/mazda-overlay-usb
```

Format an otherwise empty USB drive as FAT32 and copy the *contents* of
`/tmp/mazda-overlay-usb` to the drive root. Do not copy the containing directory.
The generated command-named `.up` file invokes `install-patches.sh`; the manager
then performs the real exact-version, payload, stock-target, free-space, and
transaction checks.

#### Current real-hardware gate

The JavaScript-bearing bundle is not yet ready for unattended hardware use.
The manager requires a working syntax checker on the CMU, but stock v74 has no
`node` binary and this repository does not yet install
`/data/cmu-overlay/bin/js-check`. This is intentional: without an on-device
parser, the real preflight refuses JavaScript instead of risking a bootloop.

Before using the current application overlay on a CMU, provide and validate an
ARM-compatible, target-grammar checker at `/data/cmu-overlay/bin/js-check`.
Modern Node syntax acceptance is not sufficient for Opera 12.10. The checker's
interface is:

```text
js-check /path/to/file.js
```

It must return zero only when the complete file parses successfully. Supplying
that checker, and validating the v74 USB launcher on the specific Mazda3 CMU,
remain hardware tasks. Until then, use the disposable emulator workflow above.

#### Bench procedure once the gate is satisfied

Use stable power, recovery/serial access, the exact prepared media, and a bench
CMU before considering an in-vehicle run:

1. Insert the USB and wait for the native **CMU OVERLAY** dialog.
2. Choose **INSTALL**. The manager proceeds only if its exact firmware and
   stock-target preconditions pass; otherwise it reports failure without
   starting a transaction.
3. Do not remove the USB, power down, or press controls while the transaction
   is running.
4. Wait for the success dialog. Application files are picked up on the next
   normal HMI startup.
5. Inspect `overlay-manager.log` on the USB and
   `/data/cmu-overlay/journal.log`. Do not treat a visible app alone as proof of
   a clean transaction.
6. To remove the overlay, reinsert the same pinned media, choose **MANAGE**,
   then **DISABLE**. Wait for success before restarting the HMI. Disable,
   restore, safe mode, and rollback restore the manifest-declared stock state.

If power or the process is lost during a transaction, do not improvise file
repairs. The next invocation of the same pinned manager first inspects the
durable active transaction and either completes recovery or refuses further
mutation if its recovery metadata is invalid.

The optional CAN listener never starts at boot. On an enabled bench overlay,
`capture-can` starts or stops receive-only capture to that same mounted USB.
Do not remove the drive while capture is active. From an authenticated shell,
use the actual mounted path, for example:

```sh
sh /tmp/mnt/sda1/install-patches.sh capture-can
```

Run the same command again to stop, wait for confirmation, then `sync` before
removing the media. See [`can/README.md`](can/README.md) for the VIM ABI and
hardware caveats.

### 6. Run the generic ARM system guest

This is optional for normal application work. It exercises substantially more
stock native software but still does not emulate the Mazda board or Vivante
display hardware:

```sh
python3 emulate.py fetch-kernel
python3 emulate.py build-guest
python3 emulate.py verify-system
```

For native browser-to-guest verification, keep the system guest running and use
two additional terminals:

```sh
python3 emulate.py ui --proxy
python3 emulate.py verify-ui --expect-mode proxy
```

Proxy verification is fail-closed: it requires all three stock messaging
services and the ordered IntroAnimation, Disclaimer, and HomeScreen lifecycle;
it never substitutes mock MMUI responses. Detailed architecture and isolated
port configuration are in [`docs/emulation.md`](docs/emulation.md).

### 7. Run the complete local regression set

Before publishing an overlay change or preparing media, run:

```sh
python3 -m unittest discover -s can/tests -v
python3 -m unittest discover -s overlay/tests -v
python3 -m unittest discover -s emulation/tests -v
python3 overlay/prepare_usb.py --check
```

Run the browser verifier separately while its matching UI server is active.
For application work, include `--expect-overlay-app`; for CAN replay work, also
include `--expect-can-replay`.

Portable, non-overwriting package tools are available through
`python3 emulate.py unpack` / `python3 emulate.py pack` and directly under
[`tools/firmware`](tools/firmware). Repacking does not create a valid Mazda RSA
signature and is not, by itself, safe to flash.

## License

Unless a directory says otherwise, this repository is MIT-licensed; see
[LICENSE](LICENSE). The exceptions are:

| Path | License | Why |
|---|---|---|
| `overlay/` | GPL-3.0-or-later | Derived in part from TouchTune; see [overlay/NOTICE](overlay/NOTICE) |
| `tools/firmware/` | GPL-3.0-only | Adapted from GPL-3.0-only packing scripts; see [tools/firmware/COPYING](tools/firmware/COPYING) |

Dependencies keep their own licenses.
