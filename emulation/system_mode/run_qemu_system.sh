#!/usr/bin/env bash
# Boot the generic ARM CMU guest. This intentionally does not use the
# board-specific Mazda zImage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KERNEL="${QEMU_KERNEL:-${SCRIPT_DIR}/cache/vmlinuz-armmp}"
INITRAMFS="${QEMU_INITRAMFS:-${SCRIPT_DIR}/build/initramfs.cpio.gz}"
MEMORY="${QEMU_MEM:-512M}"
CPUS="${QEMU_CPUS:-2}"
MMUI_PORT="${MMUI_PORT:-2700}"
DBAPI_PORT="${DBAPI_PORT:-2766}"
APPSDK_PORT="${APPSDK_PORT:-2800}"
DISPLAY_CONTROL_PORT="${DISPLAY_CONTROL_PORT:-2990}"

for port in "$MMUI_PORT" "$DBAPI_PORT" "$APPSDK_PORT"; do
    if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 55535 )); then
        echo "[EMU-SYS] Invalid proxy port: $port" >&2
        exit 2
    fi
done

if [[ ! "$DISPLAY_CONTROL_PORT" =~ ^[0-9]+$ ]] \
        || (( DISPLAY_CONTROL_PORT < 1 || DISPLAY_CONTROL_PORT > 65535 )); then
    echo "[EMU-SYS] Invalid display-control port: $DISPLAY_CONTROL_PORT" >&2
    exit 2
fi

MMUI_HOST_PORT=$((MMUI_PORT + 10000))
DBAPI_HOST_PORT=$((DBAPI_PORT + 10000))
APPSDK_HOST_PORT=$((APPSDK_PORT + 10000))

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
echo " Host forwards: ${MMUI_HOST_PORT}->2700 ${DBAPI_HOST_PORT}->2766 ${APPSDK_HOST_PORT}->2800"
echo "=========================================================="

NETWORK=(
    -netdev user,id=net0,hostfwd=tcp::${MMUI_HOST_PORT}-:2700,hostfwd=tcp::${DBAPI_HOST_PORT}-:2766,hostfwd=tcp::${APPSDK_HOST_PORT}-:2800
    -device virtio-net-device,netdev=net0
)

INPUT=(
    -device virtio-keyboard-pci
    -device virtio-tablet-pci
)

QEMU_ARGS=(
    -machine virt,highmem=off
    -cpu cortex-a15
    -m "$MEMORY"
    -smp "$CPUS"
    -kernel "$KERNEL"
    -initrd "$INITRAMFS"
    -append "console=ttyAMA0 rdinit=/init panic=-1 cmu_display_control_port=${DISPLAY_CONTROL_PORT} ${QEMU_KERNEL_ARGS:-}"
    "${NETWORK[@]}"
    "${INPUT[@]}"
    -nographic
    -no-reboot
)

exec qemu-system-arm "${QEMU_ARGS[@]}" "$@"
