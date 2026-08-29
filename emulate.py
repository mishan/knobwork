#!/usr/bin/env python3
"""
Unified Emulation CLI Entry Point for Mazda Connect Gen 6 Firmware
Provides commands to run Stage 0 UI harness, Stage 1 User-Mode smoke runner,
Stage 2/3 Full-System QEMU guest, and Stage 4 Shims/Injectors.
"""

import os
import sys
import subprocess
import argparse
import shutil

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

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
SYSTEM_MODE_DIR = os.path.join(BASE_DIR, "emulation/system_mode")
DEFAULT_KERNEL = os.path.join(SYSTEM_MODE_DIR, "cache/vmlinuz-armmp")
DEFAULT_INITRAMFS = os.path.join(SYSTEM_MODE_DIR, "build/initramfs.cpio.gz")
DEFAULT_GUEST_OUTPUT = os.path.join(SYSTEM_MODE_DIR, "build")

def cmd_smoke(args):
    smoke_script = os.path.join(BASE_DIR, "emulation/user_mode/run_smoke.py")
    cmd = [sys.executable, smoke_script, "--root", args.root]
    return subprocess.run(cmd).returncode

def cmd_ui(args):
    server_script = os.path.join(BASE_DIR, "emulation/harness/server.js")
    env = os.environ.copy()
    env["HTTP_PORT"] = str(args.port)
    env["ROOTFS_PATH"] = args.root
    if args.proxy:
        env["PROXY_MODE"] = "true"

    print(f"[EMU] Launching HMI Browser Harness on http://localhost:{args.port}")
    try:
        return subprocess.run(["node", server_script], env=env).returncode
    except KeyboardInterrupt:
        return 130

def cmd_fetch_kernel(args):
    fetch_script = os.path.join(SYSTEM_MODE_DIR, "fetch_kernel.py")
    cmd = [sys.executable, fetch_script, "--output", args.output]
    return subprocess.run(cmd).returncode

def cmd_verify_ui(args):
    verifier = os.path.join(BASE_DIR, "emulation/harness/verify_ui.js")
    env = os.environ.copy()
    env["EMU_URL"] = args.url
    if args.screenshot:
        env["EMU_SCREENSHOT"] = args.screenshot
    return subprocess.run(["node", verifier], env=env).returncode

def cmd_build_guest(args):
    build_script = os.path.join(BASE_DIR, "emulation/system_mode/build_guest_root.py")
    cmd = [sys.executable, build_script, "--root", args.root, "--output", args.output]
    return subprocess.run(cmd).returncode

def cmd_system(args):
    run_script = os.path.join(BASE_DIR, "emulation/system_mode/run_qemu_system.sh")
    env = os.environ.copy()
    env["QEMU_KERNEL"] = args.kernel
    env["QEMU_INITRAMFS"] = args.initramfs
    return subprocess.run(["bash", run_script], env=env).returncode

def cmd_verify_system(args):
    verifier = os.path.join(SYSTEM_MODE_DIR, "verify_system.py")
    cmd = [
        sys.executable,
        verifier,
        "--kernel", args.kernel,
        "--initramfs", args.initramfs,
        "--timeout", str(args.timeout),
    ]
    return subprocess.run(cmd).returncode

def cmd_nvram(args):
    nvram_script = os.path.join(BASE_DIR, "emulation/shims/mock_nvram.py")
    cmd = [sys.executable, nvram_script]
    if args.get:
        cmd.extend(["--get", args.get])
    elif args.set:
        cmd.extend(["--set", args.set[0], args.set[1]])
    elif args.dump:
        cmd.append("--dump")
    return subprocess.run(cmd).returncode

def cmd_inject(args):
    injector_script = os.path.join(BASE_DIR, "emulation/shims/vip_can_injector.py")
    cmd = [sys.executable, injector_script, "--scenario", args.scenario, "--url", args.url]
    return subprocess.run(cmd).returncode

def cmd_status(args):
    print("=" * 60)
    print(" Mazda CMU Firmware Emulation Environment Status")
    print("=" * 60)

    print(f"- Base Directory: {BASE_DIR}")
    print(f"- Stock v74 Rootfs Exists: {os.path.exists(DEFAULT_ROOTFS)}")
    print(f"- Generic ARM Kernel Cached: {os.path.exists(DEFAULT_KERNEL)}")
    print(f"- Minimal Guest Initramfs Built: {os.path.exists(DEFAULT_INITRAMFS)}")

    # Check qemu-arm & qemu-system-arm
    for tool in ["qemu-arm", "qemu-system-arm", "node", "python3"]:
        path = shutil.which(tool)
        print(f"- Tool '{tool}': {'FOUND (' + path + ')' if path else 'NOT FOUND'}")

    print("=" * 60)
    return 0

def main():
    parser = argparse.ArgumentParser(prog="emulate.py", description="Mazda CMU Firmware Emulation Suite")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # smoke
    p_smoke = subparsers.add_parser("smoke", help="Run Stage 1 ARM userspace smoke runner & JS audit")
    p_smoke.add_argument("--root", default=DEFAULT_ROOTFS, help="Rootfs path")
    p_smoke.set_defaults(func=cmd_smoke)

    # ui
    p_ui = subparsers.add_parser("ui", help="Run Stage 0 HMI Web UI Harness")
    p_ui.add_argument("--port", type=int, default=8080, help="HTTP server port")
    p_ui.add_argument("--root", default=DEFAULT_ROOTFS, help="Rootfs path")
    p_ui.add_argument("--proxy", action="store_true", help="Proxy WebSockets to QEMU guest")
    p_ui.set_defaults(func=cmd_ui)

    # verify-ui
    p_verify = subparsers.add_parser("verify-ui", help="Run the headless 800x480 HMI regression")
    p_verify.add_argument("--url", default="http://127.0.0.1:8080/", help="Running harness URL")
    p_verify.add_argument("--screenshot", help="Optional PNG output path")
    p_verify.set_defaults(func=cmd_verify_ui)

    # fetch-kernel
    p_fk = subparsers.add_parser("fetch-kernel", help="Fetch and verify the tested generic ARM kernel")
    p_fk.add_argument("--output", default=DEFAULT_KERNEL, help="Kernel output path")
    p_fk.set_defaults(func=cmd_fetch_kernel)

    # build-guest
    p_bg = subparsers.add_parser("build-guest", help="Build the non-mutating minimal ARM initramfs")
    p_bg.add_argument("--root", default=DEFAULT_ROOTFS, help="Rootfs path")
    p_bg.add_argument("--output", default=DEFAULT_GUEST_OUTPUT, help="Build output directory")
    p_bg.set_defaults(func=cmd_build_guest)

    # system
    p_sys = subparsers.add_parser("system", help="Boot the generic ARM full-system guest")
    p_sys.add_argument("--kernel", default=DEFAULT_KERNEL, help="QEMU-compatible ARM kernel")
    p_sys.add_argument("--initramfs", default=DEFAULT_INITRAMFS, help="Emulator initramfs")
    p_sys.set_defaults(func=cmd_system)

    # verify-system
    p_vsys = subparsers.add_parser(
        "verify-system",
        help="Boot and verify the generic ARM guest and stock D-Bus",
    )
    p_vsys.add_argument("--kernel", default=DEFAULT_KERNEL, help="QEMU-compatible ARM kernel")
    p_vsys.add_argument("--initramfs", default=DEFAULT_INITRAMFS, help="Emulator initramfs")
    p_vsys.add_argument("--timeout", type=float, default=12.0, help="Boot timeout in seconds")
    p_vsys.set_defaults(func=cmd_verify_system)

    # nvram
    p_nv = subparsers.add_parser("nvram", help="Manage Stage 4 Mock NVRAM Key-Value Store")
    p_nv.add_argument("--get", help="Get key")
    p_nv.add_argument("--set", nargs=2, metavar=("KEY", "VAL"), help="Set key value")
    p_nv.add_argument("--dump", action="store_true", help="Dump all key-value pairs")
    p_nv.set_defaults(func=cmd_nvram)

    # inject
    p_inj = subparsers.add_parser("inject", help="Inject VIP/CAN scenarios into HMI")
    p_inj.add_argument("--scenario", choices=["startup", "drive_mode", "commander_nav"], default="startup", help="Scenario")
    p_inj.add_argument("--url", default="ws://127.0.0.1:2700", help="WebSocket URL")
    p_inj.set_defaults(func=cmd_inject)

    # status
    p_st = subparsers.add_parser("status", help="Display emulation environment status")
    p_st.set_defaults(func=cmd_status)

    args = parser.parse_args()
    sys.exit(args.func(args))

if __name__ == "__main__":
    main()
