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

## Implemented and verified baseline

As of 2026-08-30, the repository has working implementations for the first
four stages:

- **Browser HMI:** serves the unmodified v74 `jci/gui` tree, translates the
  Opera CSS needed by modern browsers, preserves the stock WebSocket parser,
  and provides a stateful MMUI mock.
- **ARM user mode:** executes stock Mazda ARM BusyBox, D-Bus, and `smctl`
  binaries with `qemu-arm`; the syntax gate checks all 2,646 HMI JavaScript
  files.
- **Generic ARM system mode and real messaging backend (Stage 3):** boots a
  maintained Debian ARM kernel on QEMU `virt` with two ARMv7 CPUs and a
  generated initramfs containing stock Mazda BusyBox, three D-Bus daemons,
  Service Manager (`sm`), `settings`, `jciBLMSettings`, `jciMMUI` (port
  2700), `jciAppsdk` (port 2800), and `jciDbapi` (port 2766).
- **Strict backend provenance (Stage 3.5):** `verify-system` launches and owns
  QEMU and requires readiness markers for every D-Bus bus, SM, MMUI, AppSDK,
  and DBAPI. Native UI proxy mode is fail-closed, exposes per-service
  connection evidence, preserves WebSocket text/binary framing, and cannot use
  mock MMUI routing or synthetic browser startup state.
- **Hardware API shims (Stage 4):** the generated guest provides a writable
  27-key NVRAM tree, GPIO and MTD metadata, a recording watchdog endpoint,
  removable-media mount points, stock ALSA configuration data, and real QEMU
  virtio keyboard/tablet devices exposed under MMUI's expected path names.
  `verify-system` requires each shim and additionally rejects the old
  jciBLMSettings NVRAM/ALSA-config and MMUI input error paths.
- **Headless native-display lifecycle:** the guest preserves the original
  `splashplayer` and `svcjcinativeguictrl` binaries under
  `/jci/emulator/stock`, while narrow adapters reproduce their ready flags,
  process ownership, `TRANLOGOEND_SURFACE` PID, and one-shot completion. The
  host bridges the unavailable BLM System HMI-ready response with the stock
  `ShowDisclaimer` event. Stock MMUI and stock `systemApp.js` then perform
  `DisposeIntroVideo`, `Timeout`, and `NotifyDisclaimerEnd` themselves. Strict
  proxy verification requires the ordered `IntroAnimation` -> `Disclaimer` ->
  `HomeScreen` trace and a populated main-menu icon.
- **Reversible overlay workflow:** `emulate.py overlay` verifies an exact stock
  root, clones it into an ignored disposable workspace, and runs the real USB
  transaction manager through `qemu-arm` and stock ARM BusyBox `ash`. The
  persistent workspace exposes install/repair/disable/restore, boot-health,
  handled-failure, and abrupt-process-loss recovery paths without touching the
  source firmware. See [`overlay/README.md`](../overlay/README.md#developer-emulator-workflow).

## Existing `mazda_emulation` repository

The sibling `mazda_emulation` repository reviewed for this project is a UI
emulator, not a machine emulator.

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

### Custom Application SDK (CASDK)

The `mazda-custom-application-sdk` checkout is useful as reference material
rather than a drop-in current runtime:

- its latest local commit is from 2016-09-22;
- the top-level package is version 0.0.4 and explicitly alpha;
- it contains the application lifecycle, controller, persistent-storage,
  vehicle-data, AppDrive, resource-loader, and port-9700 Node bridge designs;
- its newer source uses `window.CMU` and `CMU.proxy`;
- the older prebuilt file in `mazda_emulation/sdcard/CustomApplicationsProxy.js`
  instead exports `window.CustomApplicationsProxy`.

The previous WIP harness polled forever for the older
`CustomApplicationsProxy` symbol even though it did not load that file. That
hook never ran. The new Opera compatibility object correctly maps
`AfterEvent.load` to the browser load event, so an explicitly loaded legacy
proxy can bootstrap itself in its original way. Proper CASDK integration should
be a separately configured fixture that selects either the legacy proxy or the
newer CMU/AppDrive runtime; the two should not be conflated.

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

Stage 4 uses file-compatible shims wherever normal file semantics are enough:

- `emulation/shims/nvram_defaults.json` is the single source for 27 startup
  keys found in stock binaries and scripts. The guest exports them under
  `/sys/class/nvram/nv-config`, including writable `add` and `commit` files.
  `mock_nvram.py` uses the same defaults and can export an identical sysfs tree.
- GPIO paths include the CMU150 board straps, power/reset outputs, and
  `CAN_Day_Mode`; MTD exposes deterministic config/data partition metadata.
- `/dev/watchdog` records writes through a FIFO instead of resetting the guest.
- `/mnt/jmsa1`, `/mnt/jmsb1`, and `/mnt/sda1` exist for later media insertion.
- Stock ALSA configuration is copied intact. No mixer device is emulated yet,
  so mixer-attach failures remain expected and audio control is not functional.

Input is the measured exception to the user-space-first rule. Regular files and
`/dev/null` accept `open(2)` but fail MMUI's evdev ioctls. QEMU therefore uses
PCI virtio keyboard/tablet devices with the exact `virtio_input` and `evdev`
modules extracted from the checksum-pinned Debian installer initrd. The guest
maps their real event nodes to `filtered-keyboard0`, `filtered-mouse0`, and
`filtered-touchscreen0`; MMUI's former ioctl/read-loop errors are now absent.
The ARM `virt` machine uses `highmem=off` because this 32-bit kernel could not
probe the high-memory PCI window.

The headless display adapters deliberately do not decode IVF video or create
Wayland surfaces. Stock `nativeguictrl` still requires the CMU compositor, and
stock `splashplayer` still requires `/dev/mxc_vpu`; both original binaries are
kept in the guest for continued reverse engineering. The adapters model the
observable lifecycle required by MMUI, including the `tranlogoend.pid` process
that MMUI must successfully terminate before leaving the intro.

Remaining hardware work includes pollable GPIO change notification, an ALSA
device/loopback, persistent NVRAM across guest boots, VIP/CAN wiring into the
guest, deterministic clock/fault injection, and native pixel rendering. Use
`LD_PRELOAD` only for narrow, measured boundaries.

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

The current host has QEMU 11.1.0, Google Chrome, Node, Python, CPIO/gzip, and
ext filesystem tools. The working baseline uses:

- QEMU system ARM and user-mode ARM;
- the pinned and SHA-256-checked Debian ARM installer kernel and matching
  installer initrd fetched by `emulation/system_mode/fetch_kernel.py`;
- ext4 image tools;
- CPIO/gzip (already present);
- Node/browser automation for the UI side;
- optionally an ARM cross-toolchain for small guest helpers.

The Debian `current` installer URL is mutable. The fetcher deliberately fails
if its content no longer matches the tested SHA-256; a new checksum must not be
accepted until the new kernel has passed the system-mode regression.

## Running the verified baseline

From this repository:

```sh
# Once per firmware package; the .up can live anywhere.
python3 emulate.py unpack /path/to/cmu150_NA_74.00.324A_update.up

# Terminal 1: stock browser HMI plus stateful mock backend
python3 emulate.py ui

# Terminal 2: real UI navigation and screenshot regression
python3 emulate.py verify-ui --screenshot emulation/harness/artifacts/ui.png

# ARM user-mode binaries and all-JavaScript syntax gate
python3 emulate.py smoke

# Generic ARM full-system proof
python3 emulate.py fetch-kernel
python3 emulate.py build-guest
python3 emulate.py verify-system
```

To verify the browser against the native guest, keep `emulate.py system`
running and use two additional terminals:

```sh
python3 emulate.py ui --proxy
python3 emulate.py verify-ui --expect-mode proxy \
  --screenshot emulation/harness/artifacts/ui-native.png
```

The mock and proxy regressions are intentionally distinct. Mock mode permits
deterministic synthetic startup and menu routing, and verifies HomeScreen,
commander navigation into Applications, and return to Home. Proxy mode requires
live connections to all three QEMU-forwarded stock services, bidirectional MMUI
text traffic, zero mock fallback, exactly one headless splash completion, and
the ordered stock MMUI lifecycle through native `HomeScreen`. The transition is
not fabricated in browser state: the bridge supplies only the missing native
display/BLM edges, then requires stock MMUI context messages and a populated
stock `.MainMenuCtrlIconName` element.

Proxy startup is gated on the guest's `UIAM_Run: success` log marker, not merely
an open port. Messages sent by an early browser are bounded and queued until a
guest heartbeat reaches the display-control listener. For concurrent runs, set
the same isolated service and control ports for both processes:

```sh
MMUI_PORT=5700 DBAPI_PORT=5766 APPSDK_PORT=5800 DISPLAY_CONTROL_PORT=5990 \
  python3 emulate.py system
MMUI_PORT=5700 DBAPI_PORT=5766 APPSDK_PORT=5800 DISPLAY_CONTROL_PORT=5990 \
  python3 emulate.py ui --proxy
```

The regression can force the timing window with
`EMU_MMUI_READINESS_HOLD_MS=3000` on the proxy and
`EMU_REQUIRE_QUEUED_STARTUP=true` on `verify_ui.js`. Both are test controls;
normal startup uses no artificial hold.

Only applications backed by running guest services become available, so proxy
mode still has fewer optional entries than the all-enabled mock menu. The core
Home icons are now present; absent optional entries remain a service-coverage
limitation rather than a missing-resource or CSS regression.

The build output, downloaded kernel, and matching Debian installer initrd are
ignored. `build-guest` treats the extracted firmware tree as read-only input,
always derives its generated `sm.conf` from the stock `jci/sm/sm.conf`, extracts
only the exact network and input module closure, records all input, shim, and
module SHA-256 values, and fails when a required service binary, shared library,
kernel module, or hardware seed is missing.

The v74 update tree contains `audiosettings` and `tutorial` apps without their
optional app stylesheets. The harness returns allowlisted empty CSS responses
for those two exact paths and records every use in `/__emu/health`; other
missing stylesheets still surface as browser errors.
