# Evidence, hashes, and sources

## Local paths

Firmware workspace:

```text
/home/user/w/mzd_packing-scripts/FW
```

Unpacked trees currently retained there:

```text
cmu150_NA_55.00.750B_reinstall/
cmu150_NA_74.00.324A_update/
```

The 70 roots were extracted to temporary storage for comparison. The original
failsafe and reinstall packages remain in `FW` and are identified by hashes in
[firmware-inventory.md](firmware-inventory.md).

Existing UI emulator:

```text
/home/user/w/mazda_emulation
```

Local Custom Application SDK checkout:

```text
/home/user/w/mazda-custom-application-sdk
```

Local TouchTune checkout:

```text
/home/user/w/TouchTune
commit fb0cfd7211a0c5b55115fd5485d814b7f8338748
release 1.1.0
```

## Key local artifacts

```text
74 package manifest:
  cmu150_NA_74.00.324A_update/main_instructions.ini

normal Linux TOOB image:
  cmu150_NA_74.00.324A_update/linux1/e0000000001.dat

failsafe TOOB image:
  cmu150_NA_74.00.324A_update/fail-safe/00000000.dat

normal verifier:
  cmu150_NA_74.00.324A_update/root/jci/lib/libjcisecurity.so

update service:
  cmu150_NA_74.00.324A_update/root/jci/reflash/svcjciupdates.so

service configuration:
  cmu150_NA_74.00.324A_update/root/jci/sm/sm.conf

script loader:
  cmu150_NA_74.00.324A_update/root/jci/gui/framework/js/Utility.js

WebSocket framework:
  cmu150_NA_74.00.324A_update/root/jci/gui/framework/js/Websockets.js

v74 recovery cleanup:
  cmu150_NA_74.00.324A_update/neutralizeid7/e0000000001.dat
```

## Reproducible checks

Package hashes:

```sh
sha256sum /home/user/w/mzd_packing-scripts/FW/*.up
```

Root and UI inventory:

```sh
find ROOT -type f | wc -l
find ROOT/jci/gui -type f -name '*.js' | wc -l
find ROOT/jci/gui -type f -name '*.js' -printf '%s\n' |
  awk '{sum += $1} END {print sum}'
find ROOT/jci/gui/apps -mindepth 1 -maxdepth 1 -type d | wc -l
```

JavaScript syntax gate used for the inventory:

```sh
find ROOT/jci/gui -type f -name '*.js' -print0 |
  while IFS= read -r -d '' file; do node --check "$file"; done
```

Emulator regressions:

```sh
# Terminal 1: stock v74 HMI plus stateful protocol mock
python3 emulate.py ui

# Terminal 2: exact 800x480 UI, native commander navigation, runtime errors
python3 emulate.py verify-ui --screenshot /tmp/mazda-ui.png

# qemu-arm stock binaries plus all 2,646 HMI JavaScript files
python3 emulate.py smoke

# Non-mutating initramfs and qemu-system-arm native service proof
python3 emulate.py build-guest
python3 emulate.py verify-system
```

The system regression was also run against the reviewed Debian ARM kernel with
SHA-256:

```text
6d55423515e1e27d5724be7de9d54963c3a3f8a5a9827bf2665bdb2f7ab0a605
```

It observed stock BusyBox 1.19.2 and stock D-Bus 1.6.4, a live system bus
socket, `CMU_DBUS_READY`, and `CMU_EMULATOR_READY` under Linux 6.12.38 armv7l.

Service counts:

```sh
rg -c '<service ' ROOT/jci/sm/sm.conf
rg '<service ' ROOT/jci/sm/sm.conf | rg -c 'reset_board="yes"'
```

Verifier comparison:

```sh
cmp -l ROOT_70/jci/lib/libjcisecurity.so \
  ROOT_74/jci/lib/libjcisecurity.so
readelf -S ROOT_70/jci/lib/libjcisecurity.so
readelf -S ROOT_74/jci/lib/libjcisecurity.so
readelf -Ws ROOT_74/jci/lib/libjcisecurity.so |
  rg 'SECURITY_VerifySigOnFile|SECURITY_VerifyCertificate'
```

Certificate metadata:

```sh
openssl x509 -in publisher_cert.pem \
  -noout -subject -issuer -dates -serial -fingerprint -sha256
openssl x509 -in jci_subord_cert.pem \
  -noout -subject -issuer -dates -serial -fingerprint -sha256
openssl x509 -in root/jci/certificates/jci_root_cert.pem \
  -noout -subject -issuer -dates -serial -fingerprint -sha256
```

## External primary/community sources

- Mazda-hosted 74.00.324A package:
  <https://s3.amazonaws.com/tsd.mazdausa.com/MAZDA_CONNECT/cmu150_NA_74.00.324A_update.up>
- Mazda/NHTSA service bulletin referring to the 74 update family:
  <https://static.nhtsa.gov/odi/tsbs/2022/MC-10226834-0001.pdf>
- Community firmware-version research:
  <https://miatafy.com/firmware/versions/>
- Update package and signature format:
  <https://github.com/silverchris/mazda-cmu-documentation/blob/gh-pages/update-files.md>
- Failsafe/TOOB boot documentation:
  <https://github.com/silverchris/mazda-cmu-documentation/blob/gh-pages/failsafe-boot.md>
- General CMU hardware/software documentation:
  <https://silverchris.github.io/mazda-cmu-documentation/>
- v74 USB launcher and reversible installer example:
  <https://github.com/Miatafy/TouchTune>
- Historical Mazda ADB build:
  <https://github.com/checksummaster/mazda_adb>
- Mazda ARM cross-toolchain and extracted kernel config:
  <https://github.com/rpendleton/mazda-toolchain>
- Mazda IVI reverse-engineering knowledge base:
  <https://github.com/GrayHatter/Mazda-IVI-Knowledgebase>
- QEMU SABRE Lite machine documentation:
  <https://qemu-project.gitlab.io/qemu/system/arm/sabrelite.html>

## Open questions requiring evidence

- Exact Mazda/JCI i.MX6 board machine ID and out-of-tree kernel source changes.
- Exact CPU/RAM/GPU part variants for the user's Mazda3 CMU hardware revision.
- Serial Downloader electrical selection, framing, and accepted image format.
- Whether any boot ROM/IBC stage authenticates rebuilt TOOB content beyond the
  updater's CRC checks.
- Which native services can run under QEMU without binary interception.
- Whether stock Opera can use a software EGL/Wayland compatibility layer.
- Real v74 WebSocket sequencing traces around context/focus/transition events.
- Watchdog/reset behavior and a reliable safe-mode trigger on the physical CMU.
- Mazda3-specific validation of the v74 USB filename launcher.
