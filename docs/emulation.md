# Emulation architecture

## Short answer

A useful full-CMU development environment is achievable, but not by simply
passing the Mazda 74 zImage and unpacked rootfs to stock QEMU.

The recommended architecture has three cooperating pieces:

```text
Browser UI
  Mazda HTML/CSS/JS + input automation
             |
             | WebSocket ports 2700, 2766, 2800
             v
ARM CMU userspace under QEMU
  real DBus, service launcher, MMUI/AppSDK/DBAPI, selected services
             |
             | Unix sockets, DBus, files, mocked device APIs
             v
Hardware simulation layer
  NVRAM, input, CAN/VIP scenarios, storage, watchdog, time, audio state
```

This runs substantially more real CMU software than the existing browser shim
while avoiding an early dependency on exact Vivante GPU and Mazda board
emulation.

## Existing `mazda_emulation` repository

The repository at `/home/user/w/mazda_emulation` is a UI emulator, not a
machine emulator.

It provides:

- extraction of `jci/gui` from a reinstall package;
- `boot.js`, which fakes Opera 12.10, changes startup localization, enables
  logging/debug UI, and overrides a main-menu transition path;
- a Node WebSocket server on ports 2700, 2766, and 2800;
- a small hard-coded MMUI event router for home, applications, settings, and a
  few vehicle/maintenance contexts;
- keyboard mappings for the commander controls.

Important limitations:

- no ARM execution;
- no native JCI services or service manager;
- no DBus, device state, storage, audio, CAN/VIP, or update process;
- old `ws` dependency (`^1.0.1`);
- many implicit JavaScript globals and little protocol validation;
- fixed, incomplete event behavior;
- no deterministic scenario/trace format;
- the extractor assumes a `_reinstall.up` filename and does not recognize the
  unified v74 package;
- its current `unzip | tar -z` pipeline fails against the local reinstall
  packages because the rootfs payload has two gzip layers; successful streaming
  extraction requires `unzip | gzip -dc | tar -z`;
- its tar glob also needs explicit wildcard handling with current GNU tar;
- it uses macOS `greadlink` and creates links to paths that are not present in
  the checked-out top level, so extraction must be made portable and tested.

It remains valuable as the frontend test harness and should be modernized,
not discarded.

### Custom Application SDK (CASDK) Compatibility

The harness includes explicit support hooks for applications built with [flyandi/mazda-custom-application-sdk](https://github.com/flyandi/mazda-custom-application-sdk). The browser bootstrapper (`boot.js`) automatically detects `CustomApplicationsProxy` and invokes `.bootstrap()`, enabling custom CASDK applications to be tested seamlessly in the emulator harness.

## Why the stock image will not boot unchanged

### Board support

The image is ARMv7 and contains i.MX6 strings, but it is a JCI-customized Linux
3.0.35 kernel. A community-extracted Mazda kernel config enables `ARCH_MX6`
while all standard Freescale machine selections, including `MX6Q_ARM2` and
`MX6Q_SABRELITE`, are disabled. This implies out-of-tree Mazda/JCI board support
that QEMU's standard `sabrelite` machine does not identify as.

QEMU's SABRE Lite model is still useful reference infrastructure: it emulates
the i.MX6 Cortex-A9 core, interrupt controller, timers, UART, Ethernet, I2C,
GPIO, SDHC, USB, FlexCAN, and SPI flash. It does not model the entire CMU board.

### Storage

The stock initramfs loads proprietary Datalight FlashFX and RelFS modules, then
mounts `/dev/ffx01p1` as `/newroot`. The normal extracted firmware is the
contents of that proprietary filesystem, not a directly bootable ext4 image.

### PID 1

`/sbin/init_cmu` is proprietary and performs parallel hardware setup. Its
embedded task graph includes:

- proprietary/JCI and i.MX kernel modules;
- GPIO watchdog/reset handling;
- SD/eMMC and MTD partitions;
- NVRAM sysfs keys;
- Vivante GPU setup;
- LVDS and native GUI control;
- touch/commander input devices;
- audio codecs and ASRC;
- Wi-Fi/Bluetooth and USB authorization;
- Wayland compositor and splash surfaces.

Missing hardware can block startup or trigger its reboot path. It should not be
PID 1 in the first emulator.

### Display/GPU

The stock compositor is `wayland-viv-compositor`. It uses `/dev/fb0`, Vivante
EGL/GLES libraries, a Vivante output plugin, and the `galcore` kernel driver.
Stock Opera links to EGL, GLESv2, Wayland, and proprietary IVI client libraries.
QEMU does not emulate the CMU's Vivante GPU/driver ABI.

Rendering stock Opera inside QEMU is therefore a later experiment. The browser
frontend is the reliable first renderer.

## Staged implementation

### Stage 0: deterministic UI harness

Modernize the current browser emulator:

- support 74 unified packages and explicit extracted-root paths;
- never modify the source firmware tree in place;
- serve files over HTTP instead of opening `file://` URLs;
- make localization/vehicle configuration scenario-driven;
- record and replay WebSocket traces;
- validate outbound and inbound message schemas;
- add Playwright-driven navigation and screenshots;
- add syntax and missing-resource gates;
- add fault injection for timeout, disconnect, reordering, duplication, and
  malformed payloads.

This stage directly protects against UI boot loops.

### Stage 1: ARM userspace smoke runner

Use `qemu-arm` user-mode emulation with the extracted root as its sysroot to run
individual binaries and small service subsets. Goals:

- verify loader and shared-library closure;
- run offline utilities and parsers;
- exercise update parsing without writing devices;
- inspect exit status, signals, file access, and syscalls;
- identify services that can start with only directories and DBus present.

This is faster than full-system QEMU and ideal for reverse engineering, but it
cannot emulate PID 1, kernel modules, or real `/sys` behavior.

### Stage 2: generic ARM full-system guest

Boot a maintained ARM kernel under `qemu-system-arm`, initially using a generic
machine such as `virt` rather than trying to boot the Mazda kernel.

Guest design:

- Cortex-A9-compatible 32-bit ARM configuration with at least two vCPUs because
  stock commands use CPU-affinity mask `0x02`/`taskset 2`;
- ext4 root image populated from the stock 74 extracted root;
- emulator-owned initramfs and PID 1;
- writable overlay plus separate `/data` and `/data_persist` images or tmpfs;
- proc, sysfs, devtmpfs, tmpfs, PTYs, and message queues;
- virtio block/network and serial console;
- host forwarding for SSH and ports 2700, 2766, and 2800;
- no real update/MTD/NOR device writes.

The emulator init should build the expected directory structure and start
services in explicit phases. Do not launch stock `init_cmu` or unmodified
`sm.conf` at first.

### Stage 3: real messaging backend

Bring up, in dependency order:

1. system and HMI DBus daemons;
2. DBus trackers/bridges;
3. logging with output redirected to the host;
4. JCI base launcher/runtime;
5. settings and database services with seeded writable data;
6. `jciMMUI`, `jciAppsdk`, and `jciDbapi`;
7. the browser frontend connected to the guest rather than the Node stubs;
8. additional services one at a time.

Create an emulator-specific `sm.conf` that:

- changes every reset action to process failure/reporting;
- disables hardware-only services;
- uses generous startup/ping timeouts under emulation;
- keeps original names and dependencies for enabled services;
- writes a machine-readable service timeline.

This should give high-fidelity UI/backend integration without stock GPU output.

### Stage 4: hardware API shims

Prefer user-space shims before QEMU device models:

- NVRAM key-value filesystem backed by a directory/SQLite file;
- input devices via uinput or Unix sockets;
- VIP/CAN trace playback and scenario scripting;
- fake ignition, speed, reverse, illumination, and vehicle configuration;
- harmless watchdog/reset endpoints that record requested actions;
- virtual removable media and update-package insertion;
- deterministic clock and fault injection;
- optional ALSA loopback for audio state testing.

Use `LD_PRELOAD` only for narrow, measured boundaries. File/socket-compatible
shims are easier to inspect and less sensitive to binary ABI details.

### Stage 5: native renderer experiment

Investigate whether stock Opera can run against a software EGL/Wayland stack:

- determine exact Wayland protocol and ABI versions;
- inventory required IVI and Vivante-specific symbols;
- try a compatible software compositor and framebuffer;
- provide adapter libraries only where standard ABI compatibility is possible.

If that becomes larger than the backend work, keep the browser frontend. For
our goals, actual message and state behavior is more valuable than reproducing
the proprietary GPU path.

### Stage 6: board-accurate QEMU only where justified

Add QEMU device models only for interfaces whose timing or kernel behavior
cannot be tested through shims. Candidates might include the NOR map,
boot-select behavior, a minimal NVRAM device, or serial downloader transport.

Exact LVDS, Vivante GPU, audio DSP, Bluetooth, and all vehicle buses would be a
large independent reverse-engineering project and are not prerequisites for
safe UI/runtime improvements.

## First proof-of-concept success criteria

The first full-system milestone should be considered successful when it can:

1. boot a generic ARM kernel to an emulator shell using the 74 root tree;
2. start the two CMU DBus domains;
3. run the JCI service launcher and at least one non-hardware service;
4. start real MMUI/AppSDK/DBAPI listeners or clearly identify their next missing
   dependency;
5. connect the browser UI to guest-forwarded ports;
6. replay a recorded startup/navigation scenario;
7. collect service, message, CPU, RSS, and file-access traces;
8. reboot or restore the guest after injected failures without touching source
   firmware artifacts.

## Required host tooling

The current host does not have `qemu-system-arm` or `qemu-arm` installed. The
implementation will need, at minimum:

- QEMU system ARM and user-mode ARM;
- an ARM kernel suitable for QEMU `virt` or a reproducible kernel build;
- ext4 image tools;
- CPIO/gzip (already present);
- Node/browser automation for the UI side;
- optionally an ARM cross-toolchain for small guest helpers.

Dependency installation should be explicit and reproducible, preferably through
a container/devcontainer or a documented package list rather than relying on
unrecorded host state.
