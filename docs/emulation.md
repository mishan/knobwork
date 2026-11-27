# Emulation architecture

Stock QEMU cannot boot the CMU's kernel and root unchanged (see below), so the
emulator splits the system into three cooperating pieces:

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

This runs the real CMU message and service stack while avoiding a dependency
on exact Vivante GPU and Mazda board emulation.

## Components

- **Browser HMI:** serves the unmodified v74 `jci/gui` tree, translates the
  Opera CSS needed by modern browsers, preserves the stock WebSocket parser,
  and provides a stateful MMUI mock.
- **ARM user mode:** executes stock Mazda ARM BusyBox, D-Bus, and `smctl`
  binaries with `qemu-arm`; the syntax gate checks all 2,646 HMI JavaScript
  files.
- **Generic ARM system guest and real messaging backend:** boots a
  maintained Debian ARM kernel on QEMU `virt` with two ARMv7 CPUs and a
  generated initramfs containing stock Mazda BusyBox, three D-Bus daemons,
  Service Manager (`sm`), `settings`, `jciBLMSettings`, `jciMMUI` (port
  2700), `jciAppsdk` (port 2800), and `jciDbapi` (port 2766).
- **Strict backend provenance:** `verify-system` launches and owns
  QEMU and requires readiness markers for every D-Bus bus, SM, MMUI, AppSDK,
  and DBAPI. Native UI proxy mode is fail-closed, exposes per-service
  connection evidence, preserves WebSocket text/binary framing, and cannot use
  mock MMUI routing or synthetic browser startup state.
- **Hardware API shims:** the generated guest provides a writable
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
  source firmware. The installed Developer Diagnostics example is reachable
  from the stock Applications screen; `verify-ui --expect-overlay-app` drives
  it and validates manager logs, observed GUI input capture, navigation, and a
  clean browser runtime. See
  [`overlay/README.md`](../overlay/README.md#developer-emulator-workflow).
- **Receive-only VIM CAN workflow:** `can/cmu_can_listener.c` mirrors the stock
  factory plug-in's public/private receive callback without linking a transmit
  API. Its ARM EABI executable is a hash-pinned, stock-absent overlay payload;
  the USB manager starts and stops it only on request and directs JSONL output
  to the mounted removable drive. `emulate.py can` strictly validates that
  output, while `ui --can-replay` exposes a capture to Developer Diagnostics.
  Gateway IDs are kept distinct from decoded vehicle signals and are not yet
  claimed to be raw CAN arbitration IDs. See [`can/README.md`](../can/README.md).

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

Missing hardware can block startup or trigger its reboot path, so the emulator
does not run it as PID 1.

### Display/GPU

The stock compositor is `wayland-viv-compositor`. It uses `/dev/fb0`, Vivante
EGL/GLES libraries, a Vivante output plugin, and the `galcore` kernel driver.
Stock Opera links to EGL, GLESv2, Wayland, and proprietary IVI client libraries.
QEMU does not emulate the CMU's Vivante GPU/driver ABI.

Rendering stock Opera inside QEMU is therefore a later experiment. The browser
frontend is the reliable first renderer.

## Guest design

### ARM user-mode runner

Use `qemu-arm` user-mode emulation with the extracted root as its sysroot to run
individual binaries and small service subsets. Goals:

- verify loader and shared-library closure;
- run offline utilities and parsers;
- exercise update parsing without writing devices;
- inspect exit status, signals, file access, and syscalls;
- identify services that can start with only directories and DBus present.

This is faster than full-system QEMU and ideal for reverse engineering, but it
cannot emulate PID 1, kernel modules, or real `/sys` behavior.

### Generic ARM full-system guest

The guest boots a maintained ARM kernel under `qemu-system-arm` on the generic
`virt` machine rather than the Mazda kernel.

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

The emulator init builds the expected directory structure and starts services
in explicit phases. It does not launch stock `init_cmu` or an unmodified
`sm.conf`.

### Service bring-up

Services come up in dependency order:

1. system and HMI DBus daemons;
2. DBus trackers/bridges;
3. logging with output redirected to the host;
4. JCI base launcher/runtime;
5. settings and database services with seeded writable data;
6. `jciMMUI`, `jciAppsdk`, and `jciDbapi`;
7. the browser frontend, connected to the guest instead of the mock;
8. additional services one at a time.

The generated emulator `sm.conf`:

- turns every reset action into process failure and reporting;
- leaves hardware-only services disabled;
- uses generous startup and ping timeouts;
- keeps original names and dependencies for enabled services;
- is derived from the stock `jci/sm/sm.conf` on every build.

This gives high-fidelity UI and backend integration without stock GPU output.

### Hardware shims

The guest uses file-compatible shims wherever normal file semantics are enough:

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

Known gaps are tracked in the issue tracker.

## Required host tooling

The emulator uses:

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

## Running it

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
