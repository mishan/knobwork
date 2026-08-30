# Stage 4: Hardware API Shims

## Background

Stage 3 launches the real services (`SM`, `settings`, `jciBLMSettings`,
`jciMMUI`, `jciAppsdk`, and `jciDbapi`) inside QEMU. Stage 3.5 adds strict
verification of the three native WebSocket paths; mock-assisted UI success is
not accepted as evidence for the native proxy.

The QEMU boot logs reveal non-fatal errors from missing hardware interfaces that Stage 4 will resolve. The doc spec (emulation.md lines 243-257) says: *"Prefer user-space shims before QEMU device models."*

## Observed Errors to Fix

From the live QEMU syslog, these are the hardware-related failures:

| Error | Service | Impact |
|-------|---------|--------|
| `Failed to open directory "/sys/class/nvram"` | jciBLMSettings | NVRAM keys unreadable; display settings degraded |
| `NVRAM read exception [39] for node 'lvds_bright_mode'` | jciBLMSettings | Day/night mode defaults to VBS fallback |
| `ALSA lib conf.c: Cannot access file /usr/share/alsa/alsa.conf` | jciBLMSettings | Audio mixer unavailable |
| `Mixer attach <default> error: No such file or directory` | jciBLMSettings | Audio settings non-functional |
| `TUI_OpenReader2: IOCTL error: Inappropriate ioctl for device` | jciMMUI | Input devices are `/dev/null` stubs, no real evdev |
| `TUI reader thread: error in reading` | jciMMUI | Input reader threads start but read-loop fails |

## Proposed Changes

### 1. NVRAM Sysfs Shim (P0)

The firmware reads/writes NVRAM via `/sys/class/nvram/nv-config/keys/<key>`, `/sys/class/nvram/nv-config/add`, and `/sys/class/nvram/nv-config/commit`. The `jciBLMSettings` service opens `/sys/class/nvram` as a directory and reads key files.

#### [MODIFY] [build_guest_root.py](file:///path/to/workspace/mazda-cmu-tools/emulation/system_mode/build_guest_root.py)

Add to `INIT_SCRIPT` (before SM launch):
- Create `/sys/class/nvram/nv-config/keys/` directory tree using bind-mounted tmpfs (since real sysfs is read-only)
- Seed default key files: `lvds_bright_mode`, `lvds_hdcp_mode`, `bus_bcm_speed_restriction`, `lvds_display_type`, `lvds_speed_restriction`, `vehicle_type`, `region`, `language`
- Create writable `add` and `commit` files

Implementation: Mount a tmpfs at `/tmp/nvram_shim`, populate it with key files, then bind-mount it to `/sys/class/nvram/nv-config`. This avoids fighting with the real sysfs mount.

---

### 2. GPIO Sysfs Stubs (P1)

Scripts like `get_board_type.sh` read `/sys/class/gpio/DI_TP1056/value` and `/sys/class/gpio/DI_TP1029/value`. The `resetvip` script writes to `/sys/class/gpio/Reset VIP/value`.

#### [MODIFY] [build_guest_root.py](file:///path/to/workspace/mazda-cmu-tools/emulation/system_mode/build_guest_root.py)

Add to `INIT_SCRIPT`:
- Create `/tmp/gpio_shim/` with subdirectories for each GPIO pin
- Seed `value` and `direction` files with safe defaults (board type = CMU150)
- Bind-mount to `/sys/class/gpio/`

---

### 3. ALSA Stub Configuration (P1)

`jciBLMSettings` tries to open ALSA mixer via `/usr/share/alsa/alsa.conf`. The error is non-fatal but generates noise.

#### [MODIFY] [build_guest_root.py](file:///path/to/workspace/mazda-cmu-tools/emulation/system_mode/build_guest_root.py)

Add `/usr/share/alsa/` to the copied data directories, including:
- `alsa.conf` from the firmware rootfs
- `pcm/` directory with default configs

This won't make ALSA functional (no kernel sound device), but suppresses the file-not-found error path and lets `jciBLMSettings` continue with a cleaner startup.

---

### 4. Watchdog/Reset Recording Endpoint (P2)

Already disabled via sm.conf patching (`watchdog_enable="false"`, `reset_board="no"`). For completeness:

#### [MODIFY] [build_guest_root.py](file:///path/to/workspace/mazda-cmu-tools/emulation/system_mode/build_guest_root.py)

Add to `INIT_SCRIPT`:
- Create `/dev/watchdog` as a writable file that logs all writes to `/tmp/watchdog.log`
- Simple FIFO + background reader approach

---

### 5. Input Device Improvement (P2)

Currently `/dev/input/keyboard0` etc. are `mknod c 1 3` (null device). The TUI reader opens them successfully but IOCTL calls fail. These errors are non-fatal — `jciMMUI` continues running — but proper evdev stubs would enable future input injection testing.

#### [MODIFY] [build_guest_root.py](file:///path/to/workspace/mazda-cmu-tools/emulation/system_mode/build_guest_root.py)

For now, keep the current null-device approach (it works — `jciMMUI` stays alive). Note: Proper uinput-based input injection is a future enhancement that requires a guest helper binary.

---

### 6. Removable Media Mount Points (P2)

#### [MODIFY] [build_guest_root.py](file:///path/to/workspace/mazda-cmu-tools/emulation/system_mode/build_guest_root.py)

Add to `INIT_SCRIPT`:
- `mkdir -p /mnt/jmsa1 /mnt/jmsb1 /mnt/sda1`
- These are just empty mount points; actual media insertion can be tested later via `mount --bind`

---

### 7. Update `mock_nvram.py` to Support Sysfs Seeding (P1)

#### [MODIFY] [mock_nvram.py](file:///path/to/workspace/mazda-cmu-tools/emulation/shims/mock_nvram.py)

Add a `--seed-sysfs <directory>` mode that writes all NVRAM keys as individual files into a directory tree matching the sysfs layout (`keys/<name>`, `add`, `commit`). This will be called by `build_guest_root.py` to populate the initramfs NVRAM shim.

---

### 8. Update Documentation

#### [MODIFY] [emulation.md](file:///path/to/workspace/mazda-cmu-tools/docs/emulation.md)

Update the "Implemented and verified baseline" section to reflect:
- Stage 3 is complete: real SM, settings, jciBLMSettings, jciMMUI, jciAppsdk, jciDbapi all running
- Stage 4 NVRAM/GPIO/ALSA shims implemented
- List the non-fatal errors that remain

## Open Questions

> [!IMPORTANT]
> **NVRAM key inventory**: The seed defaults should cover keys that `jciBLMSettings` reads on startup. The observed error is for `lvds_bright_mode`. Are there additional keys we should seed beyond what's in the existing `mock_nvram.py` defaults and the script-referenced keys (`lvds_hdcp_mode`, `bus_bcm_speed_restriction`, `lvds_display_type`, `lvds_speed_restriction`)? I'll use a union of both sets plus any keys found by grepping the firmware binaries.

> [!NOTE]
> **Input device injection**: The spec calls for "input devices via uinput or Unix sockets." The current null-device stubs keep jciMMUI alive. Real uinput injection requires compiling a small ARM helper binary — should this be part of this iteration or deferred?

## Verification Plan

### Automated Tests
```bash
# Rebuild guest with new shims
python3 emulate.py build-guest

# Verify system boots cleanly
python3 emulate.py verify-system

# Verify native startup transport through the real services. Stage 3.5's
# expected endpoint is system.IntroAnimation, not Home/menu navigation.
python3 emulate.py ui --proxy &
python3 emulate.py verify-ui --expect-mode proxy --url http://127.0.0.1:8080/

# Check that NVRAM errors are gone from syslog
# (inspect QEMU serial output for "Failed to open directory /sys/class/nvram")
```

### Manual Verification
- Boot QEMU and confirm `jciBLMSettings` no longer logs NVRAM directory errors
- Confirm GPIO stubs don't cause new service failures
- Verify ALSA conf file suppresses the "Cannot access" error
