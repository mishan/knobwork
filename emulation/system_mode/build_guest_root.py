#!/usr/bin/env python3
"""Build a minimal QEMU initramfs from stock Mazda ARM userspace pieces.

The source firmware tree is read-only input. All generated files go beneath
emulation/system_mode/build (or --output).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tempfile


DEFAULT_ROOTFS = pathlib.Path(
    "/home/user/w/mzd_packing-scripts/FW/cmu150_NA_74.00.324A_update/root"
)
DEFAULT_OUTPUT = pathlib.Path(__file__).resolve().parent / "build"
BUSYBOX_LIBRARIES = ("ld-linux.so.3", "libc.so.6", "libm.so.6")
DBUS_LIBRARIES = {
    "libexpat.so.1": "usr/lib",
    "libgcc_s.so.1": "lib",
    "libpthread.so.0": "lib",
    "librt.so.1": "lib",
}

DBUS_CONFIG = """<!DOCTYPE busconfig PUBLIC
 "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>system</type>
  <listen>unix:path=/run/dbus/system_bus_socket</listen>
  <policy context="default">
    <allow own="*"/>
    <allow send_destination="*"/>
    <allow receive_sender="*"/>
    <allow eavesdrop="true"/>
  </policy>
</busconfig>
"""

INIT_SCRIPT = """#!/bin/busybox sh
/bin/busybox --install -s /bin

mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
mkdir -p /run/dbus

DBUS_PID=$(/usr/bin/dbus-daemon \
    --config-file=/etc/dbus-1/system.conf \
    --fork --nopidfile --print-pid=1)

echo "=========================================================="
echo " Mazda CMU generic ARM guest"
echo "=========================================================="
uname -a
echo "Stock Mazda BusyBox: $(busybox | head -1)"
echo "PID 1 command: $(cat /proc/1/comm)"
if [ -S /run/dbus/system_bus_socket ] && kill -0 "$DBUS_PID" 2>/dev/null; then
    echo "Stock Mazda D-Bus: $(/usr/bin/dbus-daemon --version | head -1)"
    echo "CMU_DBUS_READY pid=$DBUS_PID"
else
    echo "CMU_DBUS_FAILED" >&2
fi
echo "CMU_EMULATOR_READY"

exec sh
"""


def file_sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def copy_symlink_and_target(source: pathlib.Path, destination_dir: pathlib.Path) -> None:
    destination = destination_dir / source.name
    if source.is_symlink():
        link_target = os.readlink(source)
        destination.symlink_to(link_target)
        resolved = source.resolve(strict=True)
        shutil.copy2(resolved, destination_dir / resolved.name)
    else:
        shutil.copy2(source, destination)


def build_tree(rootfs: pathlib.Path, destination: pathlib.Path) -> None:
    for directory in (
        "bin", "lib", "usr/bin", "usr/lib", "etc/dbus-1", "proc", "sys",
        "dev", "run/dbus", "tmp",
    ):
        (destination / directory).mkdir(parents=True, exist_ok=True)

    busybox = rootfs / "bin" / "busybox"
    if not busybox.is_file():
        raise FileNotFoundError(f"stock BusyBox not found: {busybox}")
    shutil.copy2(busybox, destination / "bin" / "busybox")

    for library_name in BUSYBOX_LIBRARIES:
        library = rootfs / "lib" / library_name
        if not library.exists():
            raise FileNotFoundError(f"stock BusyBox dependency not found: {library}")
        copy_symlink_and_target(library, destination / "lib")

    dbus_daemon = rootfs / "usr/bin/dbus-daemon"
    if not dbus_daemon.is_file():
        raise FileNotFoundError(f"stock D-Bus daemon not found: {dbus_daemon}")
    shutil.copy2(dbus_daemon, destination / "usr/bin/dbus-daemon")

    for library_name, source_directory in DBUS_LIBRARIES.items():
        library = rootfs / source_directory / library_name
        if not library.exists():
            raise FileNotFoundError(f"stock D-Bus dependency not found: {library}")
        copy_symlink_and_target(library, destination / source_directory)

    (destination / "etc/dbus-1/system.conf").write_text(
        DBUS_CONFIG,
        encoding="utf-8",
    )

    init = destination / "init"
    init.write_text(INIT_SCRIPT, encoding="utf-8")
    init.chmod(0o755)


def build_archive(tree: pathlib.Path, output: pathlib.Path) -> None:
    paths = ["."]
    paths.extend(
        sorted(
            str(path.relative_to(tree))
            for path in tree.rglob("*")
        )
    )
    cpio_input = b"\0".join(path.encode("utf-8") for path in paths) + b"\0"
    result = subprocess.run(
        ["cpio", "--null", "-o", "--format=newc", "--quiet"],
        cwd=tree,
        input=cpio_input,
        capture_output=True,
        check=True,
    )
    with output.open("wb") as raw_output:
        with gzip.GzipFile(
            fileobj=raw_output,
            mode="wb",
            compresslevel=9,
            mtime=0,
        ) as compressed:
            compressed.write(result.stdout)


def build(rootfs: pathlib.Path, output_dir: pathlib.Path) -> pathlib.Path:
    rootfs = rootfs.resolve(strict=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / "initramfs.cpio.gz"

    with tempfile.TemporaryDirectory(prefix="cmu-initramfs-", dir=output_dir) as temp_dir:
        tree = pathlib.Path(temp_dir)
        build_tree(rootfs, tree)
        build_archive(tree, archive)

    metadata = {
        "format": 1,
        "sourceRootfs": str(rootfs),
        "busyboxSha256": file_sha256(rootfs / "bin" / "busybox"),
        "archive": str(archive),
        "archiveSha256": file_sha256(archive),
        "nativeServices": ["dbus-daemon"],
        "purpose": "generic ARM full-system boot and native D-Bus proof",
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(metadata, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"[BUILD-GUEST] Created {archive}")
    print(f"[BUILD-GUEST] SHA-256 {metadata['archiveSha256']}")
    print("[BUILD-GUEST] Source firmware tree was not modified")
    return archive


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=DEFAULT_ROOTFS)
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    build(args.root, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
