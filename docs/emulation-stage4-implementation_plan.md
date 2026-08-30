# Stage 4: Hardware API Shims

Status: implemented and verified on 2026-08-30.

## Outcome

Stage 4 replaces the preliminary open-only device stubs with an explicit,
testable hardware compatibility layer. The stock `jciBLMSettings` and
`jciMMUI` services remain unmodified.

| Interface | Implementation | Verification |
|---|---|---|
| NVRAM | Writable sysfs-compatible tree with 27 declarative keys | Tree and control files present; former BLMSettings directory/read errors absent |
| GPIO | Writable CMU150 board, reset, power, and day/night files | Required values and output paths checked in guest |
| MTD | Deterministic config/data partition metadata | Names and sizes included in seed manifest; names checked in guest |
| ALSA data | Stock `/usr/share/alsa` tree | `alsa.conf` and `pcm/default.conf` present; former missing-config error absent |
| Input | QEMU PCI virtio keyboard/tablet plus pinned ARM input modules | Real evdev character devices mapped to Mazda names; MMUI ioctl/read errors absent |
| Watchdog | FIFO with recording reader | Endpoint type and log destination checked in guest |
| Removable media | Empty JCI mount points | All three mount points checked in guest |
| Native display lifecycle | Headless `nativeguictrl`/`splashplayer` adapters with stock binaries preserved | Strict ordered MMUI trace reaches Home and exposes a populated menu icon |

`verify-system` owns QEMU and requires the individual shim markers, the
aggregate `CMU_HARDWARE_SHIMS_READY` marker, native consumer-level markers, and
the existing D-Bus/SM/MMUI/AppSDK/DBAPI markers. A missing or nonfunctional
Stage 4 dependency therefore fails the regression.

## Design details

### Declarative NVRAM

`emulation/shims/nvram_defaults.json` is shared by the host SQLite helper and
the initramfs builder. Its inventory combines mock state with keys recovered
from stock binaries and scripts, including LVDS brightness/contrast/mode,
camera detection, tuning, backup-camera brightness, language, region, vehicle
model, and speed-restriction settings.

The builder materializes the tree beneath `/etc/cmu-emulator/sys-class`. The
guest copies it to writable initramfs storage and merges the Mazda-only classes
with the real QEMU `/sys/class` entries. Source firmware files are never
modified. `mock_nvram.py` adds new defaults with `INSERT OR IGNORE`, preserving
existing user values, and rejects unsafe key names during sysfs export.

### Real input rather than null devices

The initial `/dev/null` aliases let MMUI start but failed its evdev ioctls and
terminated every reader loop. Stage 4 adds QEMU virtio keyboard and tablet
devices and extracts the exact matching `virtio_input.ko` and `evdev.ko` from
the checksum-pinned Debian installer initrd. The guest discovers them by their
kernel-reported names and maps their event nodes to:

- `/dev/input/filtered-keyboard0`
- `/dev/input/filtered-mouse0`
- `/dev/input/filtered-touchscreen0`

The generic 32-bit ARM kernel cannot probe QEMU's high-memory PCI window, so
the launcher uses `virt,highmem=off`. This allows the PCI virtio devices to bind
without introducing a custom guest helper or an unpinned kernel module.

### Native display lifecycle

The proprietary display binaries cannot run unchanged in the generic guest:
stock `svcjcinativeguictrl` needs the CMU Wayland compositor, while stock
`splashplayer` needs `/dev/mxc_vpu`. The builder preserves both originals under
`/jci/emulator/stock` and installs narrow headless adapters for their observable
contract.

The splash adapter validates its IVF input, publishes the stock ready flag,
models one-shot or looping lifetime, and sends a completion token to the host.
The native-GUI adapter owns a real PID and creates the separate
`tranlogoend.pid` companion that stock MMUI later terminates. Completion tokens
are durable when they arrive before the browser socket: the proxy delivers
`FinishIntroAnimation` exactly once after `InitializeGuiComplete`, supplies the
missing BLM System `ShowDisclaimer` response, and lets stock JS drive disposal
and timeout. No browser context is rewritten or synthesized.

### Narrow browser compatibility response

The unpacked v74 update includes `audiosettings` and `tutorial` JavaScript but
not their optional application stylesheets. Native startup requests both as
more backend state becomes available. The HTTP harness returns empty CSS only
for those exact allowlisted paths and records the responses in
`/__emu/health`; arbitrary missing CSS remains an error.

## Verified evidence

The final build records the installer-initrd checksum, each network/input
module checksum, NVRAM defaults checksum, key count, GPIO inventory, MTD
metadata, native ELF closure, and initramfs checksum in
`emulation/system_mode/build/manifest.json`.

The following regressions pass:

```sh
python3 emulate.py build-guest
python3 emulate.py verify-system --timeout 40

# With `emulate.py system` and `emulate.py ui --proxy` running:
python3 emulate.py verify-ui --expect-mode proxy \
  --screenshot /tmp/mazda-ui-stage4-proxy.png

# Deterministic full browser UI regression:
python3 emulate.py ui
python3 emulate.py verify-ui --expect-mode mock \
  --screenshot /tmp/mazda-ui-stage4-mock.png
```

Native proxy verification remains honest: it proves the real messaging path and
ordered `system.IntroAnimation` -> `system.Disclaimer` -> `system.HomeScreen`
contexts with no mock fallback. It also requires the stock UI to populate a
main-menu icon and rejects missing, duplicated, or reordered display events.

## Remaining hardware gaps

- GPIO files provide stable values but not kernel sysfs poll/change semantics;
  the day/night watcher therefore still cannot receive edge notifications.
- ALSA configuration is present, but no mixer or audio device is emulated.
- NVRAM is writable for a guest run but is not persisted across QEMU boots.
- VIP/CAN scenario playback is not connected to the ARM guest.
- Removable-media insertion is not yet driven through a control socket.
- Deterministic time and fault injection remain future work.
- IVF pixels and Wayland surfaces are not rendered; the display adapters model
  lifecycle semantics only.
