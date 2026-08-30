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
REQUIRED_MARKERS = (
    "CMU_INPUT_SHIM_READY",
    "CMU_NVRAM_SHIM_READY",
    "CMU_GPIO_SHIM_READY",
    "CMU_MTD_SHIM_READY",
    "CMU_ALSA_DATA_READY",
    "CMU_WATCHDOG_SHIM_READY",
    "CMU_MEDIA_SHIM_READY",
    "CMU_HARDWARE_SHIMS_READY",
    "CMU_NVRAM_CONSUMER_READY",
    "CMU_INPUT_CONSUMER_READY",
    "CMU_ALSA_CONFIG_CONSUMER_READY",
    "CMU_NATIVEGUICTRL_READY",
    "CMU_NETWORK_READY",
    "CMU_DBUS_READY",
    "CMU_SERVICE_DBUS_READY",
    "CMU_HMI_DBUS_READY",
    "CMU_SM_READY",
    "CMU_APPSDK_READY",
    "CMU_DBAPI_READY",
    "CMU_MMUI_READY",
    "CMU_EMULATOR_READY",
)

HOST_FORWARD_PORTS = (12700, 12766, 12800)


def occupied_host_forward_ports() -> list[int]:
    import socket

    occupied = []
    for port in HOST_FORWARD_PORTS:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.5)
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    occupied.append(port)
        except Exception:
            pass
    return occupied


def verify(kernel: pathlib.Path, initramfs: pathlib.Path, timeout: float) -> int:
    for label, path in (("kernel", kernel), ("initramfs", initramfs)):
        if not path.is_file():
            print(f"[VERIFY-SYSTEM] Missing {label}: {path}", file=sys.stderr)
            return 2

    occupied_ports = occupied_host_forward_ports()
    if occupied_ports:
        print(
            "[VERIFY-SYSTEM] Cannot run an owned boot verification because QEMU "
            "host-forward port(s) are occupied: "
            + ", ".join(str(port) for port in occupied_ports),
            file=sys.stderr,
        )
        print(
            "[VERIFY-SYSTEM] Stop the existing guest before verification. "
            "An unrelated listener must never count as a passing guest.",
            file=sys.stderr,
        )
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
        bufsize=0,
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
                chunk = os.read(key.fileobj.fileno(), 64 * 1024)
                if not chunk:
                    break
                output.append(chunk.decode("utf-8", errors="replace"))
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
        if "Mazda CMU generic ARM guest" in line or "Stock Mazda" in line or "CMU_" in line or "qemu-system" in line:
            print(line)

    missing = [marker for marker in REQUIRED_MARKERS if marker not in combined]
    if missing:
        print(
            "[VERIFY-SYSTEM] Missing readiness marker(s): " + ", ".join(missing),
            file=sys.stderr,
        )
        if combined.strip():
            print("[VERIFY-SYSTEM] QEMU output dump:", file=sys.stderr)
            print(combined, file=sys.stderr)
        return 1

    print(
        "[VERIFY-SYSTEM] PASS: owned qemu-system-arm boot reached all Stage 4 "
        "hardware/display-shim, D-Bus, and native MMUI/AppSDK/DBAPI readiness markers"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kernel", type=pathlib.Path, default=DEFAULT_KERNEL)
    parser.add_argument("--initramfs", type=pathlib.Path, default=DEFAULT_INITRAMFS)
    parser.add_argument("--timeout", type=float, default=45.0)
    args = parser.parse_args()
    return verify(args.kernel, args.initramfs, args.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
