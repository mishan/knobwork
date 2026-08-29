#!/usr/bin/env python3
"""Boot the generic ARM guest and verify its native readiness markers."""

from __future__ import annotations

import argparse
import os
import pathlib
import selectors
import subprocess
import sys
import time


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
DEFAULT_KERNEL = SCRIPT_DIR / "cache/vmlinuz-armmp"
DEFAULT_INITRAMFS = SCRIPT_DIR / "build/initramfs.cpio.gz"
REQUIRED_MARKERS = ("CMU_DBUS_READY", "CMU_EMULATOR_READY")


def verify(kernel: pathlib.Path, initramfs: pathlib.Path, timeout: float) -> int:
    for label, path in (("kernel", kernel), ("initramfs", initramfs)):
        if not path.is_file():
            print(f"[VERIFY-SYSTEM] Missing {label}: {path}", file=sys.stderr)
            return 2

    environment = os.environ.copy()
    environment["QEMU_KERNEL"] = str(kernel)
    environment["QEMU_INITRAMFS"] = str(initramfs)
    environment["QEMU_KERNEL_ARGS"] = "quiet"

    process = subprocess.Popen(
        ["bash", str(SCRIPT_DIR / "run_qemu_system.sh")],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=environment,
    )
    assert process.stdout is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    output: list[str] = []
    deadline = time.monotonic() + timeout

    try:
        while time.monotonic() < deadline:
            for key, _ in selector.select(timeout=0.2):
                line = key.fileobj.readline()
                if not line:
                    break
                output.append(line)
                if all(marker in "".join(output) for marker in REQUIRED_MARKERS):
                    break
            combined = "".join(output)
            if all(marker in combined for marker in REQUIRED_MARKERS):
                break
            if process.poll() is not None:
                break
    finally:
        selector.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    combined = "".join(output)
    for line in combined.splitlines():
        if "Mazda CMU generic ARM guest" in line or "Stock Mazda" in line or "CMU_" in line:
            print(line)

    missing = [marker for marker in REQUIRED_MARKERS if marker not in combined]
    if missing:
        print(
            "[VERIFY-SYSTEM] Missing readiness marker(s): " + ", ".join(missing),
            file=sys.stderr,
        )
        return 1

    print("[VERIFY-SYSTEM] PASS: stock BusyBox and D-Bus are live under qemu-system-arm")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kernel", type=pathlib.Path, default=DEFAULT_KERNEL)
    parser.add_argument("--initramfs", type=pathlib.Path, default=DEFAULT_INITRAMFS)
    parser.add_argument("--timeout", type=float, default=12.0)
    args = parser.parse_args()
    return verify(args.kernel, args.initramfs, args.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
