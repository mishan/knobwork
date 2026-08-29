#!/usr/bin/env bash
# Boot the generic ARM CMU guest. This intentionally does not use the
# board-specific Mazda zImage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KERNEL="${QEMU_KERNEL:-${SCRIPT_DIR}/cache/vmlinuz-armmp}"
INITRAMFS="${QEMU_INITRAMFS:-${SCRIPT_DIR}/build/initramfs.cpio.gz}"
MEMORY="${QEMU_MEM:-512M}"
CPUS="${QEMU_CPUS:-2}"

if [[ ! -f "$KERNEL" ]]; then
    echo "[EMU-SYS] QEMU-compatible ARM kernel not found: $KERNEL" >&2
    echo "[EMU-SYS] Run: python3 $SCRIPT_DIR/fetch_kernel.py" >&2
    exit 2
fi

if [[ ! -f "$INITRAMFS" ]]; then
    echo "[EMU-SYS] Emulator initramfs not found: $INITRAMFS" >&2
    echo "[EMU-SYS] Run: python3 $SCRIPT_DIR/build_guest_root.py" >&2
    exit 2
fi

echo "=========================================================="
echo " Mazda CMU generic ARM full-system guest"
echo " Machine: QEMU virt / Cortex-A15"
echo " Kernel: $KERNEL"
echo " Initramfs: $INITRAMFS"
echo "=========================================================="

NETWORK=(
    -netdev user,id=net0,hostfwd=tcp::12700-:2700,hostfwd=tcp::12766-:2766,hostfwd=tcp::12800-:2800
    -device virtio-net-device,netdev=net0
)

QEMU_ARGS=(
    -machine virt
    -cpu cortex-a15
    -m "$MEMORY"
    -smp "$CPUS"
    -kernel "$KERNEL"
    -initrd "$INITRAMFS"
    -append "console=ttyAMA0 rdinit=/init panic=-1 ${QEMU_KERNEL_ARGS:-}"
    "${NETWORK[@]}"
    -nographic
    -no-reboot
)

exec qemu-system-arm "${QEMU_ARGS[@]}" "$@"
