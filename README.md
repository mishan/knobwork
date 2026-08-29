# Mazda Gen 6 firmware improvement research

This directory records the analysis of the Mazda Connect Gen 6 CMU firmware and
the proposed development strategy for improving runtime performance, resilience,
and the user interface.

The working baseline is the North American `cmu150` firmware
`74.00.324A`. Earlier `55.00.750B`, `70.00.021B`, and `70.00.100A` packages are
retained as comparison points.

No firmware in `mzd_packing-scripts/FW` was modified during this analysis, and
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

The UI server and its regression run as separate commands:

```sh
python3 emulate.py ui
python3 emulate.py verify-ui --screenshot /tmp/mazda-ui.png
```

The ARM system guest uses a checksum-pinned generic kernel and a generated,
non-mutating initramfs:

```sh
python3 emulate.py fetch-kernel
python3 emulate.py build-guest
python3 emulate.py verify-system
```

The current full-system regression boots stock Mazda BusyBox and the stock
Mazda D-Bus daemon. It does not yet claim that the complete CMU service graph
or native renderer is running.
