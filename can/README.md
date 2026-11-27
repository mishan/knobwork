# Receive-only VIM CAN capture

This directory contains an experimental collector for the CMU's proprietary
Vehicle Interface Manager (VIM). A target-built copy is hash-pinned in the
reversible overlay, but it is not added to Service Manager and is never started
at boot. Capture is an explicit USB action. Use it only on a bench CMU with
recovery and serial access available.

## What the firmware establishes

The stock v74 firmware does not expose SocketCAN (`can0`). `vim_app` exchanges
messages with the external VIP over `/dev/spidev1.0`; `jciVBS` loads
`libjcimod_can.so` and turns selected public/private messages into vehicle
signals for the rest of the CMU.

The unstripped factory test plug-in `libjcitaplgcanl.so` establishes this ABI:

- client handle: `IPCAPI_MakeApiHandle(0x80000069, 0)`;
- `VIMC_Open(client, &server)`;
- `VIMC_AddClient(client, server, &callbacks)`;
- callback: `(uint64_t client, uint64_t server, const vim_message *message)`;
- message layout: 32-bit ID, 32-bit payload length, payload pointer;
- public gateway IDs: `0x100` through `0x17f`, reported as port 1;
- private gateway IDs: `0x180` through `0x1ff`, reported as port 0; and
- message `0x160` is a VBS/test readiness notification, not a captured frame.

The factory plug-in calls its reported ID `STDID` in `atcommands.xml`, while
its send path calls the same field an SPI message ID. Therefore this collector
calls these **VIM gateway IDs**, not confirmed raw CAN arbitration IDs. The
payloads are still useful for correlation, but hardware capture must establish
how each VIM ID maps to the underlying vehicle bus and signals.

## Safety boundary

`cmu_can_listener.c` imports only the VIM connection, registration, removal,
and close calls. It has no VIM transmit API dependency, does not send the
factory `0x144` ready message, does not change a bitrate, and has no frame
injection command. The Makefile rejects a linked output containing the stock
transmit symbol.

Registration still sends ordinary local IPC control traffic to `vim_app`. The
collector has not yet been run on a CMU, so callback delivery and coexistence
with normal VBS remain unverified. Do not run it alongside the factory test
application, which uses the same client API ID and includes active transmit
commands.

## Build and capture on a bench CMU

The firmware is ARM EABI5 soft-float, so use the `arm-linux-gnueabi` toolchain.
The build links against the extracted target's glibc ABI and rejects transmit
imports or a glibc requirement newer than the CMU supports:

```sh
make -C can \
  CMU_ROOT=/path/to/cmu150_NA_74.00.324A_update/root \
  CC=arm-linux-gnueabi-gcc
```

The overlay expects the executable at
`overlay/usb/payloads/can/cmu-can-listener`, with the SHA-256 pinned in
`overlay/usb/manifest.v1`. It is not tracked in Git: download it from the
release built from this source, or build it as above and install it there
with `install -D -m 0755 can/build/cmu-can-listener
overlay/usb/payloads/can/cmu-can-listener`. Building requires
`gcc-arm-linux-gnueabi`, `libc6-dev-armel-cross`, and the extracted v74 root.
Check the result with `sha256sum` against the manifest; the overlay refuses a
payload whose hash differs. A build from a different toolchain can differ, in
which case the manifest pin has to be updated deliberately.

## Interoperability and distribution

The listener is independently written. It links at run time against the
VIM and IPC libraries already on the CMU; none of those libraries, nor the
factory plug-in whose interface is described above, is distributed here. It
only receives messages, as described under the safety boundary above.

## Install and capture from removable media

Prepare and install the normal reversible overlay as described in
[`overlay/README.md`](../overlay/README.md#prepare-media). Installation puts the
pinned executable at `/jci/bin/cmu-can-listener` but does not run it. On an
enabled overlay, launch the USB entry point with no arguments and choose
**CAPTURE CAN**, or use an authenticated bench shell:

```sh
sh /mnt/jmsa1/install-patches.sh capture-can
```

The manager verifies the manifest, exact firmware, installed listener hash and
mode, enabled state, absence of an interrupted transaction, and a writable USB
mount before starting. It writes timestamped `cmu-vim-can-*.jsonl` and
`cmu-vim-can-*.stderr.log` files at the root of that same removable drive.
Starting from the persisted `/data` runtime is refused because no removable
output drive can be proven there.

Exercise vehicle controls one at a time and note each action and time
separately. Run the same `capture-can` action again to stop, wait for the success
message, and only then remove the USB. A second process is never started while
the recorded listener is alive. Disable, restore, and automatic safe mode stop
an active capture before removing the overlay binary.

An empty capture is a valid hardware result: it would show that client
registration alone is insufficient and that the omitted factory readiness
handshake gates delivery. Do not add that handshake until its behavior is
understood on a bench.

## Validate and replay

Each output line is a bounded JSON record using schema
`mazda-cmu-vim-can-v1`. Validate a capture before using it:

```sh
python3 emulate.py can /path/to/cmu-vim-can.jsonl
```

Install the overlay into a disposable workspace, then expose either a real
capture or the included synthetic sample to Developer Diagnostics:

```sh
python3 emulate.py ui \
  --root scratch/overlay-workspace/root \
  --can-replay /path/to/cmu-vim-can.jsonl
```

The diagnostics app displays the latest 200 validated gateway records without
claiming to decode them. The automated proof uses the bundled sample:

```sh
python3 emulate.py ui \
  --root scratch/overlay-workspace/root \
  --can-replay emulation/fixtures/can/public-private-sample.jsonl

python3 emulate.py verify-ui \
  --expect-overlay-app \
  --expect-can-replay
```

The replay path is intentionally a snapshot, not timed signal injection. A
later decoder can correlate changing payload bits with known actions and emit
named values such as steering angle only after the mapping is supported by
captures.

## License

The listener source, build files and tests in `can/` are MIT-licensed; see
[LICENSE](LICENSE).
