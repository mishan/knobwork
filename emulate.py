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

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOTFS = "/home/user/w/mzd_packing-scripts/FW/cmu150_NA_74.00.324A_update/root"
DEFAULT_UPDATE = "/home/user/w/mzd_packing-scripts/FW/cmu150_NA_74.00.324A_update"

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
    return subprocess.run(["node", server_script], env=env).returncode

def cmd_build_guest(args):
    build_script = os.path.join(BASE_DIR, "emulation/system_mode/build_guest_root.py")
    cmd = [sys.executable, build_script, "--root", args.root, "--update", args.update]
    return subprocess.run(cmd).returncode

def cmd_system(args):
    run_script = os.path.join(BASE_DIR, "emulation/system_mode/run_qemu_system.sh")
    env = os.environ.copy()
    env["QEMU_MACHINE"] = args.machine
    env["ROOTFS_DIR"] = args.root
    return subprocess.run(["bash", run_script], env=env).returncode

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
    print(f"- Stock v74 Kernel Extracted: {os.path.exists(os.path.join(BASE_DIR, 'emulation/system_mode/zImage'))}")

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

    # build-guest
    p_bg = subparsers.add_parser("build-guest", help="Build Stage 2 QEMU guest kernel & sm_emulator.conf")
    p_bg.add_argument("--root", default=DEFAULT_ROOTFS, help="Rootfs path")
    p_bg.add_argument("--update", default=DEFAULT_UPDATE, help="Update dir path")
    p_bg.set_defaults(func=cmd_build_guest)

    # system
    p_sys = subparsers.add_parser("system", help="Boot Stage 2/3 QEMU Full-System Guest")
    p_sys.add_argument("--machine", choices=["sabrelite", "virt"], default="sabrelite", help="QEMU machine")
    p_sys.add_argument("--root", default=DEFAULT_ROOTFS, help="Rootfs path")
    p_sys.set_defaults(func=cmd_system)

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
    import shutil
    main()
