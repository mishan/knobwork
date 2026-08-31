# Mazda Gen 6 firmware improvement research

This directory records the analysis of the Mazda Connect Gen 6 CMU firmware and
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
- [Modification and recovery roadmap](docs/roadmap.md)
- [Reversible overlay manager](overlay/README.md)
- [Evidence, hashes, and sources](docs/evidence.md)

## Confidence language

The documents use these terms deliberately:

- **Verified**: reproduced directly from the local package or with a local
  cryptographic/tooling check.
- **Strong inference**: supported by binary structure, strings, or multiple
  independent observations, but not yet exercised on hardware.
- **Open**: requires emulator work, a bench CMU, serial capture, or controlled
  hardware testing.

## Emulator quick start

Prepare a user-supplied update package. By default the transactional extractor
caches it under ignored `.firmware/<package>` and verifies its source SHA-256
before reuse:

```sh
python3 emulate.py unpack /path/to/cmu150_NA_74.00.324A_update.up
```

Once exactly one package is prepared, it becomes the portable default. Every
firmware-consuming command also accepts the `.up` directly or an existing
rootfs explicitly:

```sh
python3 emulate.py smoke --firmware /path/to/firmware.up
python3 emulate.py ui --root /path/to/extracted/root
CMU_ROOTFS=/path/to/extracted/root python3 emulate.py build-guest
```

The reversible overlay manager has its own persistent, disposable emulator
workspace. It verifies and copies the stock root, snapshots the USB bundle, and
runs the real manager with emulated `/data`, mount, watchdog, and NVRAM state:

```sh
python3 emulate.py overlay init --root /path/to/extracted/root
python3 emulate.py overlay install
python3 emulate.py overlay verify --runtime
python3 emulate.py overlay status
```

The source firmware remains untouched. The default action shell is the stock
ARM BusyBox `ash` under `qemu-arm`. Lifecycle, boot-health, failure injection,
and interrupted-transaction recovery examples are in the
[overlay developer workflow](overlay/README.md#developer-emulator-workflow).

The UI server and its regression run as separate commands:

```sh
python3 emulate.py ui
python3 emulate.py verify-ui --screenshot /tmp/mazda-ui.png
```

The ARM system guest uses a checksum-pinned generic kernel, its matching Debian
installer initrd as the source of QEMU network modules, and a generated,
non-mutating Mazda initramfs:

```sh
python3 emulate.py fetch-kernel
python3 emulate.py build-guest
python3 emulate.py verify-system
```

The full-system regression owns the QEMU process and requires readiness from
the Stage 4 NVRAM/GPIO/MTD/watchdog/media/ALSA-data/virtio-input layer, all three
stock D-Bus daemons, Service Manager, MMUI, AppSDK, and DBAPI. It also verifies
that MMUI and jciBLMSettings avoided their former input, NVRAM, and missing-ALSA
configuration error paths. Occupied QEMU host-forward ports fail verification
rather than allowing an unrelated listener to count as a passing guest.

For native browser-to-guest verification, leave the system guest running and
use two additional terminals:

```sh
python3 emulate.py ui --proxy
python3 emulate.py verify-ui --expect-mode proxy
```

Proxy verification is fail-closed: it never substitutes mock MMUI responses
when a native guest connection is unavailable. It proves bidirectional text
traffic through all three stock services and the ordered native display
lifecycle from `system.IntroAnimation` through `Disclaimer` to `HomeScreen`.
Frontend startup messages are held until stock MMUI reports `UIAM_Run: success`;
this removes the former race where a listening port was mistaken for
an initialized UI service. `DISPLAY_CONTROL_PORT` can be set alongside the
three service ports when running isolated emulator instances.
The generated guest preserves the stock display binaries for analysis but uses
headless `splashplayer`/`nativeguictrl` adapters because QEMU does not implement
the CMU's Vivante VPU/Wayland stack. The strict regression now requires a real
MMUI Home context and a populated stock menu icon; the deterministic mock
regression remains the broader commander/navigation test.

Portable, non-overwriting package tools are also available through
`python3 emulate.py unpack` / `python3 emulate.py pack` and directly under
[`tools/firmware`](tools/firmware). Repacking does not create a valid Mazda RSA
signature and is not, by itself, safe to flash.
