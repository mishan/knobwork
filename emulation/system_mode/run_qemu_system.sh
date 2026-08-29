#!/usr/bin/env bash
# Stage 2/3 QEMU Full-System Guest Launcher for Mazda CMU
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMU_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOTFS_DIR="${ROOTFS_DIR:-/home/user/w/mzd_packing-scripts/FW/cmu150_NA_74.00.324A_update/root}"
ZIMAGE="${SCRIPT_DIR}/zImage"
MACHINE="${QEMU_MACHINE:-sabrelite}"
MEMORY="${QEMU_MEM:-512M}"

if [ ! -f "$ZIMAGE" ]; then
    echo "[EMU-SYS] Kernel zImage not found at $ZIMAGE. Building guest root first..."
    python3 "$SCRIPT_DIR/build_guest_root.py" --root "$ROOTFS_DIR"
fi

echo "=========================================================="
echo " Starting Mazda CMU QEMU Full-System Emulation "
echo " Machine: ${MACHINE}"
echo " Kernel: ${ZIMAGE}"
echo " Rootfs: ${ROOTFS_DIR}"
echo " WebSockets Forwarded: 2700 (MMUI), 2766 (DBAPI), 2800 (APPSDK)"
echo "=========================================================="

# Ports: 2700 (MMUI/guiifm), 2766 (DBAPI), 2800 (AppSDK), 2222 (SSH)
NET_OPTS="-netdev user,id=net0,hostfwd=tcp::2700-:2700,hostfwd=tcp::2766-:2766,hostfwd=tcp::2800-:2800,hostfwd=tcp::2222-:22 -device virtio-net-device,netdev=net0"

if [ "$MACHINE" = "sabrelite" ]; then
    exec qemu-system-arm \
        -machine sabrelite \
        -m "$MEMORY" \
        -smp 2 \
        -kernel "$ZIMAGE" \
        -append "console=ttymxc0,115200 root=/dev/ram0 rw init=/sbin/init_emulator ip=dhcp" \
        -nographic \
        "$@"
else
    exec qemu-system-arm \
        -machine virt \
        -cpu cortex-a9 \
        -m "$MEMORY" \
        -smp 2 \
        -kernel "$ZIMAGE" \
        -append "console=ttyAMA0,115200 root=/dev/vda rw init=/sbin/init_emulator ip=dhcp" \
        $NET_OPTS \
        -nographic \
        "$@"
fi
