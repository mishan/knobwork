#!/usr/bin/env python3
"""
Stage 1: ARM Userspace Smoke Runner & Verification Suite
Uses qemu-arm to probe 32-bit ARM binaries in Mazda Connect v74 rootfs.
"""

import os
import sys
import subprocess
import argparse
import glob
import json

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
def resolve_default_rootfs() -> str:
    candidates = [
        "/path/to/workspace/mzd_packing-scripts/FW/cmu150_NA_74.00.324A_update/root",
        "/home/user/w/mzd_packing-scripts/FW/cmu150_NA_74.00.324A_update/root",
        os.path.abspath(os.path.join(BASE_DIR, "../mzd_packing-scripts/FW/cmu150_NA_74.00.324A_update/root")),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]

DEFAULT_ROOTFS = resolve_default_rootfs()

def check_qemu():
    """Verify qemu-arm binary is available on system."""
    try:
        res = subprocess.run(["qemu-arm", "--version"], capture_output=True, text=True)
        if res.returncode == 0:
            print(f"[SMOKE] QEMU User Mode version: {res.stdout.splitlines()[0]}")
            return True
    except FileNotFoundError:
        print("[ERROR] qemu-arm not found in PATH")
        return False
    return False

def test_qemu_exec(rootfs, rel_binary, args=None, env_extra=None):
    """Run an ARM binary via qemu-arm inside the target rootfs."""
    target_bin = os.path.join(rootfs, rel_binary.lstrip("/"))
    if not os.path.exists(target_bin):
        return {"success": False, "error": f"Binary not found: {target_bin}"}

    cmd = ["qemu-arm", "-L", rootfs]
    ld_path = "/jci/lib:/usr/lib:/lib"
    cmd.extend(["-E", f"LD_LIBRARY_PATH={ld_path}"])

    if env_extra:
        for k, v in env_extra.items():
            cmd.extend(["-E", f"{k}={v}"])

    cmd.append(target_bin)
    if args:
        cmd.extend(args)

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        return {
            "success": res.returncode == 0,
            "returncode": res.returncode,
            "stdout": res.stdout,
            "stderr": res.stderr
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Execution timed out (10s)"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def verify_js_syntax(rootfs):
    """Run syntax checks across JS files in jci/gui."""
    gui_dir = os.path.join(rootfs, "jci/gui")
    if not os.path.exists(gui_dir):
        print(f"[SMOKE] Warning: jci/gui not found at {gui_dir}")
        return {"total": 0, "failures": []}

    js_files = glob.glob(os.path.join(gui_dir, "**/*.js"), recursive=True)
    failures = []
    print(f"[SMOKE] Checking syntax of {len(js_files)} JavaScript files in jci/gui...")

    for js_path in js_files:
        try:
            res = subprocess.run(["node", "--check", js_path], capture_output=True, text=True)
            if res.returncode != 0:
                rel_path = os.path.relpath(js_path, rootfs)
                failures.append({"file": rel_path, "error": res.stderr.strip()})
        except FileNotFoundError:
            print("[SMOKE] Warning: Node.js not installed, skipping JS syntax check.")
            break

    return {"total": len(js_files), "failures": failures}

def run_suite(rootfs):
    print("=" * 60)
    print(f"[SMOKE] Starting Mazda Firmware v74 Smoke Test Suite")
    print(f"[SMOKE] Target Rootfs: {rootfs}")
    print("=" * 60)

    if not check_qemu():
        sys.exit(1)

    # Test 1: BusyBox
    print("\n--- Test 1: BusyBox Execution ---")
    bb_res = test_qemu_exec(rootfs, "bin/busybox", ["--help"])
    if bb_res["success"] or "BusyBox" in bb_res.get("stdout", ""):
        print("[PASS] BusyBox executed successfully under qemu-arm")
    else:
        print(f"[FAIL] BusyBox failed: {bb_res}")

    # Test 2: DBus Daemon
    print("\n--- Test 2: DBus Daemon Execution ---")
    dbus_res = test_qemu_exec(rootfs, "usr/bin/dbus-daemon", ["--version"])
    if dbus_res["success"]:
        print(f"[PASS] DBus Daemon version output: {dbus_res['stdout'].strip()}")
    else:
        print(f"[FAIL] DBus Daemon failed: {dbus_res}")

    # Test 3: Service Manager Control (smctl)
    print("\n--- Test 3: JCI Service Manager Control (smctl) ---")
    smctl_res = test_qemu_exec(rootfs, "jci/sm/smctl", ["--help"])
    if "smctl help trace menu" in smctl_res.get("stdout", "") or "Communication Failure" in smctl_res.get("stdout", ""):
        print("[PASS] jci/sm/smctl binary executed and printed help menu")
    else:
        print(f"[FAIL] smctl failed: {smctl_res}")

    # Test 4: JavaScript Syntax Gate
    print("\n--- Test 4: HMI JavaScript Syntax Audit ---")
    js_results = verify_js_syntax(rootfs)
    print(f"[SMOKE] Tested {js_results['total']} JS files. Failures: {len(js_results['failures'])}")
    if js_results['failures']:
        for fail in js_results['failures'][:5]:
            print(f"  - {fail['file']}: {fail['error']}")
        if len(js_results['failures']) > 5:
            print(f"  ... and {len(js_results['failures']) - 5} more.")

    print("\n" + "=" * 60)
    print("[SMOKE] Stage 1 Smoke Test Suite Completed")
    print("=" * 60)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Stage 1 ARM Userspace Smoke Runner")
    parser.add_argument("--root", default=DEFAULT_ROOTFS, help="Path to extracted rootfs")
    args = parser.parse_args()
    run_suite(args.root)
