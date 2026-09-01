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
import json

from emulation.can_replay import CanReplayError, load_can_capture
from emulation.firmware_input import (
    FirmwareInputError,
    discover_default_rootfs,
    resolve_rootfs,
    unpack_firmware,
)
from emulation.overlay_mode import (
    DEFAULT_BUNDLE as DEFAULT_OVERLAY_BUNDLE,
    DEFAULT_WORKSPACE as DEFAULT_OVERLAY_WORKSPACE,
    MANAGER_ACTIONS as OVERLAY_MANAGER_ACTIONS,
    OverlayWorkflowError,
    format_status as format_overlay_status,
    initialize_workspace as initialize_overlay_workspace,
    reset_workspace as reset_overlay_workspace,
    run_manager_action as run_overlay_manager_action,
    workspace_status as overlay_workspace_status,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SYSTEM_MODE_DIR = os.path.join(BASE_DIR, "emulation/system_mode")
DEFAULT_KERNEL = os.path.join(SYSTEM_MODE_DIR, "cache/vmlinuz-armmp")
DEFAULT_INSTALLER_INITRD = os.path.join(SYSTEM_MODE_DIR, "cache/debian-installer-initrd.gz")
DEFAULT_INITRAMFS = os.path.join(SYSTEM_MODE_DIR, "build/initramfs.cpio.gz")
DEFAULT_GUEST_OUTPUT = os.path.join(SYSTEM_MODE_DIR, "build")


def selected_rootfs(args) -> str:
    return str(
        resolve_rootfs(
            root=args.root,
            firmware=args.firmware,
            work_dir=args.firmware_work_dir,
        )
    )


def add_firmware_input_arguments(parser):
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--root", help="Previously extracted CMU rootfs")
    group.add_argument("--firmware", metavar="FILE.up", help="Firmware package to unpack and use")
    parser.add_argument(
        "--firmware-work-dir",
        help="Extraction directory (default: repo-local .firmware/<package>)",
    )

def cmd_smoke(args):
    smoke_script = os.path.join(BASE_DIR, "emulation/user_mode/run_smoke.py")
    cmd = [sys.executable, smoke_script, "--root", selected_rootfs(args)]
    return subprocess.run(cmd).returncode

def cmd_ui(args):
    server_script = os.path.join(BASE_DIR, "emulation/harness/server.js")
    env = os.environ.copy()
    env["HTTP_PORT"] = str(args.port)
    env["ROOTFS_PATH"] = selected_rootfs(args)
    if args.proxy:
        env["PROXY_MODE"] = "true"
    if args.fail_overlay_app_script:
        env["EMU_FAIL_OVERLAY_APP_SCRIPT"] = "true"
    if args.can_replay:
        capture = load_can_capture(args.can_replay)
        env["CAN_REPLAY_PATH"] = capture["path"]
        print(
            "[EMU] Validated VIM CAN replay: "
            f"{capture['frameCount']} frames from {capture['path']}"
        )

    print(f"[EMU] Launching HMI Browser Harness on http://localhost:{args.port}")
    try:
        return subprocess.run(["node", server_script], env=env).returncode
    except KeyboardInterrupt:
        return 130

def cmd_fetch_kernel(args):
    fetch_script = os.path.join(SYSTEM_MODE_DIR, "fetch_kernel.py")
    cmd = [
        sys.executable,
        fetch_script,
        "--output", args.output,
        "--initrd-output", args.initrd_output,
    ]
    return subprocess.run(cmd).returncode

def cmd_verify_ui(args):
    verifier = os.path.join(BASE_DIR, "emulation/harness/verify_ui.js")
    env = os.environ.copy()
    env["EMU_URL"] = args.url
    env["EMU_EXPECT_MODE"] = args.expect_mode
    if args.screenshot:
        env["EMU_SCREENSHOT"] = args.screenshot
    if args.expect_overlay_app:
        env["EMU_EXPECT_OVERLAY_APP"] = "true"
    if args.expect_overlay_app_fallback:
        env["EMU_EXPECT_OVERLAY_APP_FALLBACK"] = "true"
    if args.expect_can_replay:
        env["EMU_EXPECT_CAN_REPLAY"] = "true"
    return subprocess.run(["node", verifier], env=env).returncode

def cmd_build_guest(args):
    build_script = os.path.join(BASE_DIR, "emulation/system_mode/build_guest_root.py")
    cmd = [
        sys.executable,
        build_script,
        "--root", selected_rootfs(args),
        "--output", args.output,
        "--installer-initrd", args.installer_initrd,
    ]
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


def cmd_can(args):
    capture = load_can_capture(args.capture)
    print(json.dumps(capture, indent=2, sort_keys=True))
    return 0


def cmd_overlay(args):
    workspace = os.path.abspath(os.path.expanduser(args.workspace))
    if args.action == "init":
        rootfs = selected_rootfs(args)
        initialized = initialize_overlay_workspace(
            workspace,
            rootfs,
            os.path.abspath(os.path.expanduser(args.bundle)),
        )
        print(f"[OVERLAY] Initialized disposable workspace: {initialized.path}")
        print(f"[OVERLAY] Source firmware remains unchanged: {rootfs}")
        print(f"[OVERLAY] Working root for UI/system tools: {initialized.root}")
        return 0
    if args.root or args.firmware or args.firmware_work_dir:
        raise OverlayWorkflowError("Firmware input arguments apply only to overlay init")
    if args.action == "status":
        status = overlay_workspace_status(workspace)
        if args.json:
            print(json.dumps(status, indent=2, sort_keys=True))
        else:
            print(format_overlay_status(status))
        return 0
    if args.action == "reset":
        reset_overlay_workspace(workspace)
        print(f"[OVERLAY] Removed disposable workspace: {workspace}")
        return 0
    result = run_overlay_manager_action(
        workspace,
        args.action,
        shell=args.shell,
        runtime=args.runtime,
        fail_point=args.fail_point,
        crash_point=args.crash_point,
    )
    if result.returncode == 99:
        print(
            "[OVERLAY] Simulated abrupt process loss. The workspace was intentionally left for recovery.",
            file=sys.stderr,
        )
    return result.returncode


def cmd_unpack(args):
    rootfs = unpack_firmware(args.firmware, args.output)
    print(f"[EMU] Use this rootfs with --root {rootfs}")
    return 0


def cmd_pack(args):
    pack_script = os.path.join(BASE_DIR, "tools/firmware/pack_cmu.sh")
    cmd = ["bash", pack_script, args.source, args.output]
    if args.signature:
        cmd.append(args.signature)
    return subprocess.run(cmd).returncode

def cmd_status(args):
    print("=" * 60)
    print(" Mazda CMU Firmware Emulation Environment Status")
    print("=" * 60)

    print(f"- Base Directory: {BASE_DIR}")
    try:
        default_rootfs = discover_default_rootfs()
    except FirmwareInputError as error:
        default_rootfs = None
        print(f"- Firmware selection error: {error}")
    print(f"- Selected rootfs: {default_rootfs or 'NONE'}")
    print(f"- Generic ARM Kernel Cached: {os.path.exists(DEFAULT_KERNEL)}")
    print(f"- Matching ARM Modules Cached: {os.path.exists(DEFAULT_INSTALLER_INITRD)}")
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
    add_firmware_input_arguments(p_smoke)
    p_smoke.set_defaults(func=cmd_smoke)

    # ui
    p_ui = subparsers.add_parser("ui", help="Run Stage 0 HMI Web UI Harness")
    p_ui.add_argument("--port", type=int, default=8080, help="HTTP server port")
    add_firmware_input_arguments(p_ui)
    p_ui.add_argument("--proxy", action="store_true", help="Proxy WebSockets to QEMU guest")
    p_ui.add_argument(
        "--fail-overlay-app-script",
        action="store_true",
        help="Test-only: return an error for the Developer Diagnostics app script",
    )
    p_ui.add_argument(
        "--can-replay",
        metavar="CAPTURE.jsonl",
        help="Validate and expose a receive-only VIM CAN capture to diagnostics",
    )
    p_ui.set_defaults(func=cmd_ui)

    # CAN capture validation
    p_can = subparsers.add_parser("can", help="Validate receive-only VIM CAN captures")
    p_can.add_argument("capture", help="JSONL capture produced by cmu-can-listener")
    p_can.set_defaults(func=cmd_can)

    # verify-ui
    p_verify = subparsers.add_parser("verify-ui", help="Run the headless 800x480 HMI regression")
    p_verify.add_argument("--url", default="http://127.0.0.1:8080/", help="Running harness URL")
    p_verify.add_argument(
        "--expect-mode",
        choices=("mock", "proxy"),
        default="mock",
        help="Require an explicit mock or native QEMU proxy backend",
    )
    p_verify.add_argument("--screenshot", help="Optional PNG output path")
    overlay_expectation = p_verify.add_mutually_exclusive_group()
    overlay_expectation.add_argument(
        "--expect-overlay-app",
        action="store_true",
        help="Navigate to and validate the installed Developer Diagnostics example",
    )
    overlay_expectation.add_argument(
        "--expect-overlay-app-fallback",
        action="store_true",
        help="Trigger the example app and verify optional-script failure recovery",
    )
    p_verify.add_argument(
        "--expect-can-replay",
        action="store_true",
        help="Require validated VIM CAN replay data in Developer Diagnostics",
    )
    p_verify.set_defaults(func=cmd_verify_ui)

    # fetch-kernel
    p_fk = subparsers.add_parser("fetch-kernel", help="Fetch and verify the tested generic ARM kernel")
    p_fk.add_argument("--output", default=DEFAULT_KERNEL, help="Kernel output path")
    p_fk.add_argument(
        "--initrd-output",
        default=DEFAULT_INSTALLER_INITRD,
        help="Matching Debian installer initrd output path",
    )
    p_fk.set_defaults(func=cmd_fetch_kernel)

    # build-guest
    p_bg = subparsers.add_parser("build-guest", help="Build the non-mutating minimal ARM initramfs")
    add_firmware_input_arguments(p_bg)
    p_bg.add_argument("--output", default=DEFAULT_GUEST_OUTPUT, help="Build output directory")
    p_bg.add_argument(
        "--installer-initrd",
        default=DEFAULT_INSTALLER_INITRD,
        help="Matching Debian installer initrd containing kernel modules",
    )
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
    p_vsys.add_argument("--timeout", type=float, default=45.0, help="Boot timeout in seconds")
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

    # reversible overlay manager
    p_overlay = subparsers.add_parser(
        "overlay",
        help="Exercise the reversible overlay manager in a disposable firmware workspace",
    )
    p_overlay.add_argument(
        "action",
        choices=("init", "status", "reset", *sorted(OVERLAY_MANAGER_ACTIONS)),
        help="Workspace or overlay-manager action",
    )
    p_overlay.add_argument(
        "--workspace",
        default=str(DEFAULT_OVERLAY_WORKSPACE),
        help="Persistent disposable workspace",
    )
    p_overlay.add_argument(
        "--bundle",
        default=str(DEFAULT_OVERLAY_BUNDLE),
        help="Overlay USB bundle snapshotted by init",
    )
    add_firmware_input_arguments(p_overlay)
    p_overlay.add_argument(
        "--shell",
        choices=("stock", "host"),
        default="stock",
        help="Run through qemu-arm plus stock BusyBox ash, or host sh for harness debugging",
    )
    p_overlay.add_argument(
        "--runtime",
        action="store_true",
        help="Run from the persisted /data runtime instead of the emulated USB",
    )
    p_overlay.add_argument("--fail-point", help="Inject a handled manager failure")
    p_overlay.add_argument(
        "--crash-point",
        help="Simulate abrupt process loss (for example mutation:2, metadata, or committed)",
    )
    p_overlay.add_argument("--json", action="store_true", help="JSON status output")
    p_overlay.set_defaults(func=cmd_overlay)

    # firmware package tools
    p_unpack = subparsers.add_parser("unpack", help="Unpack a user-supplied CMU .up package")
    p_unpack.add_argument("firmware", metavar="FILE.up", help="Firmware update package")
    p_unpack.add_argument("--output", help="Destination directory")
    p_unpack.set_defaults(func=cmd_unpack)

    p_pack = subparsers.add_parser("pack", help="Repack an extracted CMU firmware tree")
    p_pack.add_argument("source", help="Directory produced by the unpack command")
    p_pack.add_argument("output", metavar="OUTPUT.up", help="New update package")
    p_pack.add_argument("--signature", help="32-character hexadecimal package comment")
    p_pack.set_defaults(func=cmd_pack)

    # status
    p_st = subparsers.add_parser("status", help="Display emulation environment status")
    p_st.set_defaults(func=cmd_status)

    args = parser.parse_args()
    try:
        result = args.func(args)
    except (
        CanReplayError,
        FirmwareInputError,
        OverlayWorkflowError,
        subprocess.CalledProcessError,
    ) as error:
        parser.error(str(error))
    sys.exit(result)

if __name__ == "__main__":
    main()
