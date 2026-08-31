# Reversible overlay manager

This is the phase-2 USB transaction manager from
[`docs/roadmap.md`](../docs/roadmap.md). The first pinned bundle installs only
two inert diagnostic files under `/jci/scripts`; it does not patch the HMI,
service manager, boot configuration, NVRAM, or native binaries.

## Safety contract

- `install-patches.sh` pins the complete manifest SHA-256.
- SHA-256 uses `sha256sum` when present and falls back to the stock v74
  `/usr/bin/openssl`; startup verifies the backend against the empty-string
  digest before trusting it.
- The manifest pins the exact North American `74.00.324A` `version.ini`, every
  stock target state, and every payload SHA-256.
- Every version, hash, free-space, and syntax check completes before `/` is
  remounted read-write.
- Install refuses mixed stock/payload state. Repair accepts a known mixture but
  refuses any unrecognized target content.
- First-install backups and absent-file markers live under
  `/data/cmu-overlay/backups/files` and are never replaced.
- Manifest-declared NVRAM keys use the stock `add`/`keys`/`commit` sequence,
  immutable first-value backups under `/data/cmu-overlay/backups/nvram`, exact
  readback verification, and the same reverse-order rollback as files.
- Replacements are copied into the target directory, verified, and atomically
  renamed. A reverse-order rollback stack is retained until final verification
  and transaction commit.
- The original root mount mode and watchdog value are captured, verified after
  restoration, and failures are returned to the caller.
- Identical journals are appended on the USB and under `/data/cmu-overlay`.

The accepted actions are `install`, `verify`, `repair`, `disable`, and
`restore`. `boot-attempt` increments the persistent counter and restores all
stock targets in safe mode on the third unacknowledged attempt. A healthy HMI
startup calls `boot-success`. Install and repair preserve a read-only runtime
copy under `/data/cmu-overlay/runtime/<manifest-sha256>` so those actions remain
available after the USB is removed. Runtime actions mirror the persistent
journal to `/data/cmu-overlay/runtime-journal.log` because no USB is assumed to
be present. The diagnostic overlay deliberately does not add a boot hook; a
later HMI overlay must add both calls as reviewed, hash-pinned targets so the
counter measures the actual modified startup path.

JavaScript entries use the manifest type `js`. They are rejected unless a
working syntax checker is available through `MZD_OVERLAY_JS_CHECKER`, `node`,
or `/data/cmu-overlay/bin/js-check`. The manager checks the USB payload during
preflight and the same-filesystem staged copy immediately before rename.

## Prepare media

Validate the bundle and build a new USB staging directory:

```sh
python3 overlay/prepare_usb.py --check
python3 overlay/prepare_usb.py /path/to/new-usb-tree
```

The builder refuses an existing destination. It copies `jci-autoupdate`, the
manager, manifest, and payloads, then creates the v74 command-filename launcher.
Copy the *contents* of the resulting directory to the root of a FAT32 USB
stick. The package metadata remains deliberately broad because the command
filename runs before normal validation; the shell preflight provides the real,
exact firmware gate.

With no arguments, the launcher opens a native, state-aware dialog: a stock or
disabled unit offers install/cancel, while an enabled unit offers
repair/disable/cancel. Explicit actions remain available from an authenticated
bench shell. Do not deploy it to a vehicle merely because the off-target tests
pass.

## Verification

The regression suite builds a fresh replica of the v74 paths for every test:

```sh
python3 -m unittest discover -s overlay/tests -v
```

It covers the full action lifecycle, firmware and manifest rejection, partial
and unexpected state, rollback at multiple failure points, safety-state
restoration, persistent-runtime boot-attempt safe mode, transactional NVRAM,
the no-argument dialog path, and JavaScript preflight before remount.
