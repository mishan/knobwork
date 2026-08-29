# Emulator handoff review

This records the 2026-08-29 review of the Gemini-created emulator work and the
subsequent verified baseline. The central acceptance criterion was visible,
interactive stock CMU UI behavior—not merely a server process that stayed
alive or speculative patches that did not affect execution.

## What was present at handoff

The WIP had four useful starting points:

- a Node HTTP/WebSocket harness around the v74 `jci/gui` tree;
- a `qemu-arm` smoke runner for individual stock ARM binaries;
- a proposed `qemu-system-arm` launcher and guest builder;
- simple NVRAM and VIP/CAN experiments.

The saved `scratch/hmi_rendered.png` showed that stock Mazda markup could
render, but it was 780x493 rather than the CMU's 800x480 display and there was
no automated proof of framework state or navigation.

## WIP changes classified by observed effect

| WIP change | Observed result | Disposition |
|---|---|---|
| Replace the MMUI WebSocket message handler | It happened to work around an Opera-versus-modern-browser `ArrayBuffer.length` difference, but replaced too much stock logic. | Removed. A narrow `ArrayBuffer.length` compatibility alias now preserves the stock parser. |
| Poll every 10 ms to patch `MainMenuCtrl.init` | The instance had already been created; the initial Communication selection came from stock code. The polling continued indefinitely. | Removed as a no-op. |
| Add a second keyboard/commander handler | It called nonexistent `framework.common.handleMulticontrollerEvent`; stock keyboard handling already worked. | Removed as a no-op. |
| Poll every 100 ms for `CustomApplicationsProxy` | The harness loaded no such proxy, so the condition never became true. | Removed. CASDK integration is now an explicit future fixture. |
| Flush the framework queue every 100 ms | There was no demonstrated queue fault; the stock queue drains after valid protocol messages. | Removed. Queue length is asserted by the verifier. |
| Enable the debug panel unconditionally | This added DOM work and log noise to every run. | Disabled by default; opt in with `?emuDebug=1`. |
| Patch WebSocket `_isStack` and `_delStack` calls | v74 defines both as globals but invokes them as methods, which fails in a standards browser. | Retained narrowly by binding the existing Mazda helpers to the prototype. |
| Return a large guessed MMUI message sequence | Reordering caused the stock transition/stack branch to fail. | Replaced with a minimal, stateful `ctxtChg`, `focusStack`, `transition:false` sequence. |
| Boot the Mazda `zImage` directly in QEMU | The image depends on an out-of-tree JCI i.MX6 board and proprietary FlashFX/RelFS storage; there was no bootable root block device. | Replaced with a maintained generic ARM kernel plus an emulator-owned initramfs. |
| Build files inside the extracted stock root | This risked contaminating the analysis baseline. | Replaced with a read-only source and ignored `emulation/system_mode/build` output. |

## Verified browser result

The current harness serves the unmodified v74 GUI, translates required Opera
CSS, and supplies stateful mock MMUI/AppSDK/DBAPI sockets. A headless Chrome
regression uses a clean profile and an exact 800x480 viewport. It proves:

1. the framework reaches idle `system/HomeScreen`;
2. all three WebSockets are open and the message queue is empty;
3. two native commander counter-clockwise events move the carousel from
   Communication to Applications;
4. Enter opens the stock Applications UI, including Fuel Economy Monitor;
5. Back returns to HomeScreen;
6. no browser runtime errors occur; and
7. the captured PNG is 800x480.

This path uses the firmware's own controller and input handling. It does not
replace the menu with emulator code.

## Verified native ARM result

The user-mode smoke runner executes stock Mazda BusyBox 1.19.2, D-Bus 1.6.4,
and `smctl` under `qemu-arm`, then syntax-checks all 2,646 HMI JavaScript files.

The full-system guest now boots Linux 6.12.38 armv7l on QEMU `virt` with two
Cortex-A15 CPUs. Its initramfs contains stock Mazda BusyBox, the stock Mazda
D-Bus daemon, and only their required stock libraries. The regression requires
both `CMU_DBUS_READY` and `CMU_EMULATOR_READY`, proving the daemon process and
system-bus socket are live before declaring success.

This is deliberately not described as a full CMU yet. MMUI, AppSDK, DBAPI,
service management, persistent stores, and hardware-facing services remain to
be introduced incrementally.

## Custom Application SDK assessment

The local `/home/user/w/mazda-custom-application-sdk` checkout is useful as a
protocol and application-architecture reference. It includes lifecycle,
controller, persistent-storage, vehicle-data, AppDrive/resource loading, and a
port-9700 Node bridge. It is an alpha-era 2016 codebase, however, and is not a
drop-in v74 runtime.

There are also two incompatible integration surfaces in the local material:
the SDK source uses `window.CMU`/`CMU.proxy`, while the older prebuilt proxy in
`mazda_emulation` exports `window.CustomApplicationsProxy`. A future CASDK
fixture must select and load one explicitly. The browser compatibility layer
does support the legacy Opera `AfterEvent.load` hook when that fixture is
added.

## Next integration boundary

The safest next native increment is an emulator-specific service launch plan:

1. add a second HMI D-Bus instance and the minimum JCI base runtime;
2. run one stock service in isolation with reset/watchdog actions disabled;
3. capture its files, sockets, D-Bus names, timing, and failure behavior;
4. only then attempt `jciMMUI`, `jciAppsdk`, and `jciDbapi`; and
5. switch the browser harness from mock sockets to explicit guest proxy mode.

Each addition should get a readiness assertion and a fault case before the
next service is enabled. That keeps failures attributable and protects the
firmware source tree from experimental writes.
