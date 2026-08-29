#!/usr/bin/env python3
"""
Stage 2: Guest Rootfs & Service Manager Configuration Builder
Prepares the extracted Mazda v74 rootfs for QEMU full-system emulation.
"""

import os
import sys
import shutil
import subprocess
import argparse

DEFAULT_ROOTFS = "/home/user/w/mzd_packing-scripts/FW/cmu150_NA_74.00.324A_update/root"
UPDATE_DIR = "/home/user/w/mzd_packing-scripts/FW/cmu150_NA_74.00.324A_update"
OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))

def extract_zimage(update_dir, out_zimage):
    """Extract stock Mazda ARM zImage kernel from linux1/e0000000001.dat."""
    dat_path = os.path.join(update_dir, "linux1/e0000000001.dat")
    if not os.path.exists(dat_path):
        print(f"[BUILD-GUEST] Warning: Kernel payload missing at {dat_path}")
        return False

    print(f"[BUILD-GUEST] Extracting stock zImage kernel to {out_zimage}...")
    with open(dat_path, "rb") as fin:
        fin.seek(512) # Skip 512-byte TOOB header
        kernel_data = fin.read()

    with open(out_zimage, "wb") as fout:
        fout.write(kernel_data)

    print(f"[BUILD-GUEST] Stock zImage extracted successfully ({len(kernel_data)} bytes).")
    return True

def generate_emulator_sm_conf(rootfs):
    """Create jci/sm/sm_emulator.conf with safe reset policies and relaxed timeouts."""
    sm_conf_path = os.path.join(rootfs, "jci/sm/sm.conf")
    out_conf_path = os.path.join(rootfs, "jci/sm/sm_emulator.conf")

    if not os.path.exists(sm_conf_path):
        print(f"[BUILD-GUEST] Warning: sm.conf not found at {sm_conf_path}")
        return False

    print(f"[BUILD-GUEST] Generating emulator sm.conf -> {out_conf_path}...")
    with open(sm_conf_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    # Disable board resets on service crash
    content_mod = content.replace('reset_board="yes"', 'reset_board="no"')
    # Extend startup/ping timeouts for QEMU environment
    content_mod = content_mod.replace('ping_timeout="5"', 'ping_timeout="60"')
    content_mod = content_mod.replace('ping_timeout="10"', 'ping_timeout="60"')
    content_mod = content_mod.replace('ping_timeout="30"', 'ping_timeout="120"')

    with open(out_conf_path, "w", encoding="utf-8") as f:
        f.write(content_mod)

    print("[BUILD-GUEST] jci/sm/sm_emulator.conf created with reset_board='no'.")
    return True

def generate_init_script(rootfs):
    """Create /sbin/init_emulator PID 1 script."""
    init_path = os.path.join(rootfs, "sbin/init_emulator")
    script = """#!/bin/sh
echo "=========================================================="
echo " Starting Mazda Connect CMU QEMU Guest Init (PID 1) "
echo "=========================================================="

mount -t proc proc /proc 2>/dev/null
mount -t sysfs sysfs /sys 2>/dev/null
mount -t devtmpfs devtmpfs /dev 2>/dev/null

mkdir -p /dev/pts /tmp /data /data_persist /var/log /var/run /var/tmp
mount -t devpts devpts /dev/pts 2>/dev/null
mount -t tmpfs tmpfs /tmp
mount -t tmpfs tmpfs /var/log
mount -t tmpfs tmpfs /var/run

ifconfig lo 127.0.0.1 up 2>/dev/null

mkdir -p /var/run/dbus /tmp/dbus
export LD_LIBRARY_PATH=/jci/lib:/usr/lib:/lib

echo "[INIT] Launching DBus System Daemon..."
/usr/bin/dbus-daemon --system --fork --config-file=/etc/dbus-1/system.conf 2>/dev/null || true

echo "[INIT] Launching JCI Service Manager in Emulation Mode..."
if [ -f /jci/sm/sm_emulator.conf ]; then
    /jci/sm/sm /jci/sm/sm_emulator.conf &
else
    /jci/sm/sm /jci/sm/sm.conf &
fi

echo "[INIT] System startup initialized. Spawning root shell..."
exec /bin/sh
"""
    with open(init_path, "w") as f:
        f.write(script)
    os.chmod(init_path, 0o755)
    print(f"[BUILD-GUEST] Created executable init script at {init_path}")
    return True

def build(rootfs, update_dir):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_zimage = os.path.join(OUTPUT_DIR, "zImage")

    extract_zimage(update_dir, out_zimage)
    generate_emulator_sm_conf(rootfs)
    generate_init_script(rootfs)
    print("[BUILD-GUEST] Stage 2 guest build completed successfully.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Stage 2 Guest Rootfs Builder")
    parser.add_argument("--root", default=DEFAULT_ROOTFS, help="Path to extracted rootfs")
    parser.add_argument("--update", default=UPDATE_DIR, help="Path to unpacked update directory")
    args = parser.parse_args()
    build(args.root, args.update)
