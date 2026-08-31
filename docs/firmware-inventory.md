# Firmware inventory and comparison

## Local firmware set

The source packages were reviewed from a separate firmware workspace. The
tools now accept packages from any path; all `.up` files are immutable,
user-supplied inputs.

| Firmware | Package form | Package size | SHA-256 |
| --- | --- | ---: | --- |
| 55.00.750B | reinstall | 900,684,882 | `b1e90115f03cd6d6084f0e6173ad40bde0b07feb655334a979dfbaac6276162f` |
| 70.00.021B | failsafe | 7,089,899 | `8835f4444cb0d05d2ad6c973e95fdf62ec1be28946a5f32121ac19b9ff830ee1` |
| 70.00.021B | reinstall | 925,588,170 | `021399f73c245ca3106674e1870c306f0c8b55654db3a2b5b73b560ab3e22b1c` |
| 70.00.100A | failsafe | 7,088,769 | `ef9964509d81d47c1fcae35748096fe7021a9ea15b670acf5675a48679ddbccf` |
| 70.00.100A | reinstall | 925,592,239 | `5938019df7e333447c7bf60aa8f6a7e7f9cd50d6eeb7b6e33605800b85bd4ad0` |
| 74.00.324A | unified update | 1,003,179,676 | `ffd04e2c8cfaf77388aacde0f9c1cddc17cb6b7f02d7caa2fe6ad39c0f40e787` |

The 74 hash matches the Mazda-hosted package analyzed for this project.

## Platform continuity

The platform remained old and substantially continuous across the releases:

- 32-bit little-endian ARM EABI5 userspace.
- ARMv7-A, Thumb-2, VFPv3, and NEON instructions.
- Soft-float procedure-call convention with hardware floating-point use.
- Linux 3.0.35.
- glibc 2.11.1, built with GCC 4.5.2 prerelease.
- Opera for Devices 12.10-era browser runtime.
- Wayland with a Vivante-specific compositor and EGL/GLES stack.
- JCI proprietary PID 1, service manager, DBus services, and vehicle interfaces.

The firmware therefore does not gain performance from a newer kernel, libc, or
browser engine. Improvements in later releases are application, integration,
configuration, and native-service changes on the same basic platform.

## Extracted-root measurements

Counts below use regular files and top-level directories under
`jci/gui/apps`. The service count is the number of `<service ...>` entries in
`jci/sm/sm.conf`.

| Measurement | 55.00.750B | 70.00.021B | 70.00.100A | 74.00.324A |
| --- | ---: | ---: | ---: | ---: |
| Extracted root size | 379 MiB | 416 MiB | 416 MiB | 428 MiB |
| Regular files | 7,870 | 8,344 | 8,344 | 8,443 |
| Top-level GUI app directories | 37 | 42 | 42 | 42 |
| JavaScript files | 2,621 | 2,640 | 2,640 | 2,646 |
| JavaScript bytes | 14,998,883 | 19,939,671 | 19,946,904 | 20,726,751 |
| `node --check` failures | 42 | 0 | 0 | 0 |
| Service entries | 104 | 117 | 117 | 117 |
| Services declaring `reset_board="yes"` | 66 | 91 | 91 | 91 |

The JavaScript syntax check is a parser gate, not proof that the code is valid
for Opera 12.10 or semantically correct. It is nevertheless useful because a
syntax failure in a boot-critical resource can make the HMI fail repeatedly.

## 55.00.750B to 70 series

The main visible expansion is Android Auto/CarPlay support and its supporting
services. The 70 series also contains a significantly larger UI tree and more
services whose failure policy permits a board reset.

The 42 parse failures in the 55 tree are stock resources, primarily a useful
warning that a generic modern-JavaScript parser is not sufficient by itself:
some may be dormant locale/model resources, generated fragments, or code that
the old runtime loads differently. Every deployable change still needs an
Opera-compatible parser/test path and an actual load-path test.

## 70.00.021B to 70.00.100A

The two extracted roots have the same regular-file count and size. Only 17
regular files changed content:

1. `jci/gracenote/gracenote_server`
2. `jci/gui/apps/schedmaint/js/schedmaintApp.js`
3. `jci/gui/apps/system/js/systemApp.js`
4. `jci/gui/common/controls/List2/js/List2Ctrl.js`
5. `jci/lds/svcjcilds.so`
6. `jci/mmui/uia/libjciuiaandroidauto.so`
7. `jci/mmui/uia/libjciuiasystem.so`
8. `jci/scripts/data-save.conf`
9. `jci/settings/configurations/blm_vwm-system.xml`
10. `jci/settings/svcjciblmsettings.so`
11. `jci/sm/sm.conf`
12. `jci/version.ini`
13. `jci/vui/plugins/vui_plugin_system.so`
14. `jci/vwm/svcjcivwm.so`
15. `usr/lib/libCarPlayPlatformAudio.so`
16. `usr/lib/libCarPlayPlatformCpAudio.so`
17. `usr/lib/libCarPlayPlatformScreen.so`

Notable JavaScript changes:

- `systemApp.js` adds a health-check counter request/response path between the
  UI and MMUI.
- `schedmaintApp.js` adds model/region-specific oil-maintenance behavior and
  consolidates disabled-list handling.
- `List2Ctrl.js` adds special disabled-item styling behavior for the scheduled
  maintenance oil-change screen.

This small delta is a useful source of Mazda-authored fixes, but the native
changes should be consumed as a unit rather than cherry-picked without their
matching schemas and configuration.

## 70.00.100A to 74.00.324A

Comparing regular files by path and SHA-256:

- 108 files were added.
- 9 files were removed.
- 1,665 common regular files changed content.

This is too broad for a safe binary-by-binary backport into 70. The appropriate
base is the complete stock 74 firmware.

The service list has the same size and reset policy as 70.00.100A, but its
dependency and timeout behavior changed. Observed changes include:

- `stage_navi` no longer waits for the eMMC mount stage.
- `stage_vr` gains a five-second argument, ready flag, and CarPlay ordering.
- network and Wi-Fi startup receive a `UCP` argument.
- mDNS is moved earlier and no longer waits for device manager.
- CarPlay arguments change.
- `jciLDS` no longer depends on the navigation stage.
- NMS services gain shutdown-save behavior.
- VDT gains an explicit 30-second ping timeout.

These changes reinforce that service configuration, scripts, and native
components form a coupled release.

## 74 unified package

`74.00.324A` uses a single `NewPackage=1`, `UPType=Reinstall`,
`SubUPType=Mass` package. Its extended instruction set includes:

1. failsafe start
2. IBC2, failsafe image, and checksum-option update
3. failsafe end
4. reinstall start
5. IBC1, kernel, rootfs, resources, settings, and other payloads
6. reinstall end

The build metadata reports:

- `JCI_SW_VER="MAZ_CMU-150_74.00.324"`
- `JCI_SW_VER_PATCH="A"`
- build time `Tue Aug 30 07:10:46 2022 GMT`
- target `xse-cmu-01.01.255_armv7le`
