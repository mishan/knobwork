#!/usr/bin/env python3
"""Build a minimal QEMU initramfs from stock Mazda ARM userspace pieces.

The source firmware tree is read-only input. All generated files go beneath
emulation/system_mode/build (or --output).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import lzma
import os
import pathlib
import re
import shutil
import subprocess
import tempfile


def resolve_default_rootfs() -> pathlib.Path:
    candidates = (
        pathlib.Path("/path/to/workspace/mzd_packing-scripts/FW/cmu150_NA_74.00.324A_update/root"),
        pathlib.Path("/home/user/w/mzd_packing-scripts/FW/cmu150_NA_74.00.324A_update/root"),
        pathlib.Path(__file__).resolve().parent.parent.parent.parent / "mzd_packing-scripts/FW/cmu150_NA_74.00.324A_update/root",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


DEFAULT_ROOTFS = resolve_default_rootfs()
DEFAULT_OUTPUT = pathlib.Path(__file__).resolve().parent / "build"
DEFAULT_INSTALLER_INITRD = (
    pathlib.Path(__file__).resolve().parent / "cache" / "debian-installer-initrd.gz"
)
KERNEL_VERSION = "6.12.38+deb13-armmp"
NETWORK_KERNEL_MODULES = (
    (
        f"usr/lib/modules/{KERNEL_VERSION}/kernel/drivers/virtio/virtio_mmio.ko.xz",
        f"lib/modules/{KERNEL_VERSION}/kernel/drivers/virtio/virtio_mmio.ko",
    ),
    (
        f"usr/lib/modules/{KERNEL_VERSION}/kernel/net/core/failover.ko.xz",
        f"lib/modules/{KERNEL_VERSION}/kernel/net/core/failover.ko",
    ),
    (
        f"usr/lib/modules/{KERNEL_VERSION}/kernel/drivers/net/net_failover.ko.xz",
        f"lib/modules/{KERNEL_VERSION}/kernel/drivers/net/net_failover.ko",
    ),
    (
        f"usr/lib/modules/{KERNEL_VERSION}/kernel/drivers/net/virtio_net.ko.xz",
        f"lib/modules/{KERNEL_VERSION}/kernel/drivers/net/virtio_net.ko",
    ),
)
BUSYBOX_LIBRARIES = ("ld-linux.so.3", "libc.so.6", "libm.so.6")
LIBRARY_SEARCH_DIRECTORIES = ("jci/lib", "usr/lib", "lib")

NATIVE_SERVICE_FILES = (
    "usr/bin/dbus-daemon",
    "usr/bin/strace",
    "jci/sm/sm",
    "jci/sm/smctl",
    "jci/sm/sm_svclauncher",
    "jci/settings/settings",
    "jci/settings/settingsc",
    "jci/settings/svc-com-jci-cpp-settings.so",
    "jci/settings/svcjciblmsettings.so",
    "jci/appsdk/svcjciappsdk.so",
    "jci/appsdk/plugins/libjciplugincd.so",
    "jci/dbapi/svcjcidbapi.so",
    "jci/mmui/svcjcimmui.so",
)

NATIVE_DATA_DIRECTORIES = (
    "jci/appsdk",
    "jci/dbapi",
    "jci/mmui",
    "jci/settings",
    "jci/sm",
    "jci/lib",
    "jci/scripts",
    "config",
    "usr/share/alsa",
)

NATIVE_DATA_FILES = (
    "jci/version.ini",
    "config/common/log/settings.txt",
)

DBUS_CONFIG_TEMPLATE = """<!DOCTYPE busconfig PUBLIC
 "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>system</type>
  <listen>unix:path={socket_path}</listen>
  <policy context="default">
    <allow own="*"/>
    <allow send_destination="*"/>
    <allow receive_sender="*"/>
    <allow eavesdrop="true"/>
  </policy>
</busconfig>
"""

APPSDK_CONFIG = """<AppsdkLoadConfiguration>
  <Config serviceid="5" name="cd"
    libpath="/jci/appsdk/plugins/" lib="libjciplugincd.so"
    JSlib="libjciplugincd.js" api="APPL_OPEN" param="1"
    passvalue="0" failaction="continue" block="true" />
</AppsdkLoadConfiguration>
"""

INIT_SCRIPT = """#!/bin/busybox sh
/bin/busybox --install -s /bin

mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/mqueue /dev/shm /dev/input /run/dbus /tmp/dbus /var/run /data /data_persist /config/common/log /etc /home/cmu
mount -t mqueue mqueue /dev/mqueue 2>/dev/null || true
mount -t tmpfs tmpfs /dev/shm

CMU_NATIVE_READY=1
for module in \
    /lib/modules/6.12.38+deb13-armmp/kernel/drivers/virtio/virtio_mmio.ko \
    /lib/modules/6.12.38+deb13-armmp/kernel/net/core/failover.ko \
    /lib/modules/6.12.38+deb13-armmp/kernel/drivers/net/net_failover.ko \
    /lib/modules/6.12.38+deb13-armmp/kernel/drivers/net/virtio_net.ko; do
    if insmod "$module"; then
        echo "CMU_KERNEL_MODULE_READY module=${module##*/}"
    else
        echo "CMU_KERNEL_MODULE_FAILED module=${module##*/}" >&2
        CMU_NATIVE_READY=0
    fi
done

# --- Stage 4: /dev/input stubs (keep jciMMUI alive) ---
for dev in keyboard0 keyboard1 mouse0 mouse1 filtered-keyboard0 filtered-mouse0 filtered-touchscreen0 event0 event1 event2 event3; do
    mknod /dev/input/$dev c 1 3 2>/dev/null || touch /dev/input/$dev
    chmod 666 /dev/input/$dev
done

# --- Stage 4: Writable Mazda classes merged with the real QEMU classes ---
# Preserve QEMU's net/tty/input/etc. classes through a second bind mount. The
# synthetic tree overrides only the Mazda-specific class names below.
mkdir -p /tmp/sys_class_real /tmp/sys_class_shim
mount --bind /sys/class /tmp/sys_class_real
for class_path in /tmp/sys_class_real/*; do
    class_name=${class_path##*/}
    case "$class_name" in
        nvram|gpio|mtd) continue ;;
    esac
    ln -s "$class_path" "/tmp/sys_class_shim/$class_name"
done

mkdir -p /tmp/sys_class_shim/nvram/nv-config/keys
mkdir -p /tmp/sys_class_shim/gpio
mkdir -p /tmp/sys_class_shim/mtd/mtd0 /tmp/sys_class_shim/mtd/mtd1

# Populate NVRAM keys
for key in lvds_bright_mode lvds_bright_day lvds_bright_night lvds_contrast_day lvds_contrast_night lvds_hdcp_mode lvds_display_type lvds_speed_restriction bus_bcm_speed_restriction; do
    echo "disable" > /tmp/sys_class_shim/nvram/nv-config/keys/$key
done
echo "50" > /tmp/sys_class_shim/nvram/nv-config/keys/lvds_bright_day
echo "25" > /tmp/sys_class_shim/nvram/nv-config/keys/lvds_bright_night
echo "50" > /tmp/sys_class_shim/nvram/nv-config/keys/lvds_contrast_day
echo "50" > /tmp/sys_class_shim/nvram/nv-config/keys/lvds_contrast_night
echo "auto" > /tmp/sys_class_shim/nvram/nv-config/keys/lvds_bright_mode
echo "jci" > /tmp/sys_class_shim/nvram/nv-config/keys/lvds_display_type
touch /tmp/sys_class_shim/nvram/nv-config/add
touch /tmp/sys_class_shim/nvram/nv-config/commit

# Populate GPIO pins
for pin in DI_TP1056 DI_TP1029 "Reset VIP" DO_HOST1_PWR DO_OTG_PWR gpio0; do
    mkdir -p "/tmp/sys_class_shim/gpio/$pin"
    echo "0" > "/tmp/sys_class_shim/gpio/$pin/value"
    echo "in" > "/tmp/sys_class_shim/gpio/$pin/direction"
done

# Populate MTD partitions
echo "config" > /tmp/sys_class_shim/mtd/mtd0/name
echo "1048576" > /tmp/sys_class_shim/mtd/mtd0/size
echo "data" > /tmp/sys_class_shim/mtd/mtd1/name
echo "4194304" > /tmp/sys_class_shim/mtd/mtd1/size

mount --bind /tmp/sys_class_shim /sys/class

# --- Stage 4: Watchdog recording endpoint ---
mkdir -p /tmp/watchdog_shim
touch /tmp/watchdog_shim/watchdog.log
mkfifo /tmp/watchdog_fifo 2>/dev/null || true
(while cat /tmp/watchdog_fifo >> /tmp/watchdog_shim/watchdog.log 2>/dev/null; do :; done) &
ln -sf /tmp/watchdog_fifo /dev/watchdog 2>/dev/null || true

# --- Stage 4: Removable media mount points ---
mkdir -p /mnt/jmsa1 /mnt/jmsb1 /mnt/sda1

ifconfig lo 127.0.0.1 up 2>/dev/null || true
if ifconfig eth0 10.0.2.15 netmask 255.255.255.0 up 2>/dev/null; then
    echo "CMU_NETWORK_READY interface=eth0 address=10.0.2.15"
else
    echo "CMU_NETWORK_FAILED interface=eth0" >&2
    CMU_NATIVE_READY=0
fi

touch /etc/syslog.conf

syslogd -O /tmp/syslog.log
sleep 1

SYSTEM_DBUS_PID=$(/usr/bin/dbus-daemon \\
    --config-file=/etc/dbus-1/system.conf \\
    --fork --nopidfile --print-pid=1)
SERVICE_DBUS_PID=$(/usr/bin/dbus-daemon \\
    --config-file=/etc/dbus-1/service.conf \\
    --fork --nopidfile --print-pid=1)
HMI_DBUS_PID=$(/usr/bin/dbus-daemon \\
    --config-file=/etc/dbus-1/hmi.conf \\
    --fork --nopidfile --print-pid=1)

echo "=========================================================="
echo " Mazda CMU generic ARM guest"
echo "=========================================================="
uname -a
echo "Stock Mazda BusyBox: $(busybox | head -1)"
echo "PID 1 command: $(cat /proc/1/comm)"

if [ -S /run/dbus/system_bus_socket ] && kill -0 "$SYSTEM_DBUS_PID" 2>/dev/null; then
    echo "Stock Mazda D-Bus: $(/usr/bin/dbus-daemon --version | head -1)"
    echo "CMU_DBUS_READY pid=$SYSTEM_DBUS_PID"
else
    echo "CMU_DBUS_FAILED" >&2
    CMU_NATIVE_READY=0
fi

if [ -S /tmp/dbus_service_socket ] && kill -0 "$SERVICE_DBUS_PID" 2>/dev/null; then
    echo "CMU_SERVICE_DBUS_READY pid=$SERVICE_DBUS_PID"
else
    echo "CMU_SERVICE_DBUS_FAILED" >&2
    CMU_NATIVE_READY=0
fi

if [ -S /tmp/dbus_hmi_socket ] && kill -0 "$HMI_DBUS_PID" 2>/dev/null; then
    echo "CMU_HMI_DBUS_READY pid=$HMI_DBUS_PID"
else
    echo "CMU_HMI_DBUS_FAILED" >&2
    CMU_NATIVE_READY=0
fi

export LD_LIBRARY_PATH=/jci/lib:/usr/lib:/lib
export PATH=/bin:/usr/bin:/jci/sm:/jci/scripts
export DBUS_SYSTEM_BUS_ADDRESS="unix:path=/run/dbus/system_bus_socket"
export DBUS_SERVICE_BUS_ADDRESS="unix:path=/tmp/dbus_service_socket"
export DBUS_HMI_BUS_ADDRESS="unix:path=/tmp/dbus_hmi_socket"
export DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/dbus_service_socket"
export DBUS_STARTER_ADDRESS="unix:path=/tmp/dbus_service_socket"
export DBUS_STARTER_BUS_TYPE="service"
export JCI_SERVICE_BUS="unix:path=/tmp/dbus_service_socket"
export JCI_HMI_BUS="unix:path=/tmp/dbus_hmi_socket"

echo "$SERVICE_DBUS_PID" > /tmp/dbus_service.pid
echo "$HMI_DBUS_PID" > /tmp/dbus_hmi.pid
echo "$SYSTEM_DBUS_PID" > /tmp/lvds_service.pid
echo "$SYSTEM_DBUS_PID" > /var/run/nativeguictrl.pid
echo "$SYSTEM_DBUS_PID" > /tmp/vim_app.pid

/jci/sm/sm >/tmp/sm.log 2>&1 &
SM_PID=$!

sleep 5

if kill -0 "$SM_PID" 2>/dev/null; then
    echo "CMU_SM_READY pid=$SM_PID"
else
    echo "CMU_SM_FAILED pid=$SM_PID" >&2
    CMU_NATIVE_READY=0
fi

# Check services by listening port (SM launches them, we don't have their PIDs)
if grep -q ':0AF0 ' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
    echo "CMU_APPSDK_READY pid= port=2800"
else
    echo "CMU_APPSDK_FAILED" >&2
    CMU_NATIVE_READY=0
    cat /tmp/jciAppsdk.log >&2 2>/dev/null
fi

if grep -q ':0ACE ' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
    echo "CMU_DBAPI_READY pid= port=2766"
else
    echo "CMU_DBAPI_FAILED" >&2
    CMU_NATIVE_READY=0
    cat /tmp/jciDbapi.log >&2 2>/dev/null
fi

if grep -q ':0A8C ' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
    echo "CMU_MMUI_READY pid= port=2700"
else
    echo "CMU_MMUI_FAILED" >&2
    CMU_NATIVE_READY=0
    cat /tmp/jciMMUI.log >&2 2>/dev/null
fi

if [ "$CMU_NATIVE_READY" = "1" ]; then
    echo "CMU_EMULATOR_READY"
else
    echo "CMU_EMULATOR_FAILED" >&2
fi

echo "--- /tmp/sm.log ---" >&2
cat /tmp/sm.log >&2

echo "--- /tmp/syslog.log ---" >&2
cat /tmp/syslog.log >&2

exec sh
"""


def file_sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def copy_symlink_and_target(source: pathlib.Path, destination_dir: pathlib.Path) -> None:
    destination = destination_dir / source.name
    if source.is_symlink():
        link_target = os.readlink(source)
        destination.symlink_to(link_target)
        resolved = source.resolve(strict=True)
        shutil.copy2(resolved, destination_dir / resolved.name)
    else:
        shutil.copy2(source, destination)


def copy_rootfs_entry(
    rootfs: pathlib.Path,
    source: pathlib.Path,
    destination: pathlib.Path,
) -> None:
    relative = source.relative_to(rootfs)
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)

    if source.is_symlink():
        link_value = os.readlink(source)
        target.unlink(missing_ok=True)
        target.symlink_to(link_value)
        if os.path.isabs(link_value):
            resolved_source = rootfs / link_value.lstrip("/")
        else:
            resolved_source = (source.parent / link_value).resolve(strict=True)
        if resolved_source.exists():
            copy_rootfs_entry(rootfs, resolved_source, destination)
    else:
        shutil.copy2(source, target)


def copy_rootfs_dir(
    rootfs: pathlib.Path,
    source_dir: pathlib.Path,
    destination: pathlib.Path,
) -> None:
    if not source_dir.exists():
        return
    for item in source_dir.rglob("*"):
        if item.is_dir():
            relative = item.relative_to(rootfs)
            (destination / relative).mkdir(parents=True, exist_ok=True)
        else:
            copy_rootfs_entry(rootfs, item, destination)


def needed_libraries(binary: pathlib.Path) -> list[str]:
    try:
        result = subprocess.run(
            ["readelf", "-d", str(binary)],
            capture_output=True,
            text=True,
            check=True,
        )
        return re.findall(r"Shared library: \[([^]]+)]", result.stdout)
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError(f"failed to inspect ELF dependencies for {binary}: {error}") from error


def resolve_library(rootfs: pathlib.Path, library_name: str) -> pathlib.Path | None:
    for directory in LIBRARY_SEARCH_DIRECTORIES:
        candidate = rootfs / directory / library_name
        if candidate.exists():
            return candidate
    return None


def copy_elf_closure(
    rootfs: pathlib.Path,
    destination: pathlib.Path,
    relative_files: tuple[str, ...],
) -> list[str]:
    pending = [rootfs / relative_file for relative_file in relative_files]
    copied: set[str] = set()
    missing_libraries: list[str] = []

    while pending:
        source = pending.pop()
        if not source.exists():
            raise FileNotFoundError(f"required native file not found: {source}")

        copy_rootfs_entry(rootfs, source, destination)
        try:
            resolved_source = source.resolve(strict=True)
            relative_resolved = str(resolved_source.relative_to(rootfs))
        except (OSError, ValueError) as error:
            raise RuntimeError(
                f"required native file resolves outside source root: {source}"
            ) from error

        if relative_resolved in copied:
            continue
        copied.add(relative_resolved)

        for library_name in needed_libraries(resolved_source):
            library = resolve_library(rootfs, library_name)
            if not library:
                missing_libraries.append(f"{library_name} (required by {relative_resolved})")
                continue
            copy_rootfs_entry(rootfs, library, destination)
            resolved_library = library.resolve(strict=True)
            relative_library = str(resolved_library.relative_to(rootfs))
            if relative_library not in copied:
                pending.append(resolved_library)

    if missing_libraries:
        raise FileNotFoundError(
            "unresolved native libraries:\n  " + "\n  ".join(sorted(set(missing_libraries)))
        )

    return sorted(copied)


def generate_emulator_sm_conf(rootfs: pathlib.Path, destination: pathlib.Path) -> None:
    source_conf = rootfs / "jci/sm/sm.conf"
    if not source_conf.is_file():
        raise FileNotFoundError(f"stock Service Manager configuration not found: {source_conf}")

    content = source_conf.read_text(encoding="utf-8")
    content = content.replace('watchdog_enable="true"', 'watchdog_enable="false"')
    content = re.sub(r'reset_board="yes"', 'reset_board="no"', content)
    content = re.sub(r'user_account="cmu"', 'user_account="root"', content)

    enabled_services = {
        "dbus_service", "dbus_hmi", "lvds_service", "nativeguictrl",
        "stage_1", "stage_2", "stage_3",
        "settings", "jciBLMSettings", "jciDbapi", "jciAppsdk", "jciMMUI",
        "keepalive",
    }

    def disable_unneeded_services(match: re.Match) -> str:
        tag = match.group(0)
        name_match = re.search(r'name="([^"]+)"', tag)
        if name_match:
            svc_name = name_match.group(1)
            if svc_name not in enabled_services:
                if 'autorun="' in tag:
                    return re.sub(r'autorun="[^"]+"', 'autorun="no"', tag)
                elif tag.endswith('/>'):
                    return tag[:-2] + ' autorun="no"/>'
                elif tag.endswith('>'):
                    return tag[:-1] + ' autorun="no">'
        return tag

    content = re.sub(r'<service\s+[^>]+>', disable_unneeded_services, content)

    def filter_dependencies(match: re.Match) -> str:
        dep_tag = match.group(0)
        val_match = re.search(r'value="([^"]+)"', dep_tag)
        if val_match and val_match.group(1) not in enabled_services:
            return ""
        return dep_tag

    content = re.sub(r'<dependency\s+[^>]+/>', filter_dependencies, content)

    keepalive_service = '<service type="process" name="keepalive" path="/bin/sleep" args="999999" autorun="yes" reset_board="no"/>'
    content = content.replace('</services>', f'    {keepalive_service}\n    </services>')

    (destination / "jci/sm/sm.conf").write_text(content, encoding="utf-8")


def install_network_modules(
    installer_initrd: pathlib.Path,
    destination: pathlib.Path,
) -> dict[str, str]:
    """Extract the exact network module closure paired with the tested kernel."""
    installer_initrd = installer_initrd.resolve(strict=True)
    source_paths = [source for source, _target in NETWORK_KERNEL_MODULES]

    with tempfile.TemporaryDirectory(prefix="cmu-kernel-modules-") as temp_dir:
        extract_root = pathlib.Path(temp_dir)
        with subprocess.Popen(
            ["gzip", "-dc", str(installer_initrd)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as decompressor:
            if decompressor.stdout is None:
                raise RuntimeError("failed to capture gzip output")
            extracted = subprocess.run(
                ["cpio", "-id", "--quiet", *source_paths],
                cwd=extract_root,
                stdin=decompressor.stdout,
                capture_output=True,
            )
            decompressor.stdout.close()
            gzip_stderr = decompressor.stderr.read() if decompressor.stderr else b""
            gzip_status = decompressor.wait()

        if gzip_status or extracted.returncode:
            raise RuntimeError(
                "failed to extract kernel modules from matching installer initrd: "
                f"gzip={gzip_status} cpio={extracted.returncode} "
                f"gzip_stderr={gzip_stderr.decode(errors='replace').strip()} "
                f"cpio_stderr={extracted.stderr.decode(errors='replace').strip()}"
            )

        installed: dict[str, str] = {}
        for source_relative, target_relative in NETWORK_KERNEL_MODULES:
            source = extract_root / source_relative
            if not source.is_file():
                raise FileNotFoundError(
                    f"matching installer initrd lacks required module: {source_relative}"
                )
            target = destination / target_relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with lzma.open(source, "rb") as compressed, target.open("wb") as output:
                shutil.copyfileobj(compressed, output)
            installed[target_relative] = file_sha256(target)

    return installed


def build_tree(
    rootfs: pathlib.Path,
    installer_initrd: pathlib.Path,
    destination: pathlib.Path,
) -> tuple[list[str], dict[str, str]]:
    required_entries = (
        *NATIVE_SERVICE_FILES,
        *NATIVE_DATA_DIRECTORIES,
        *NATIVE_DATA_FILES,
        "jci/sm/sm.conf",
    )
    missing_entries = [
        relative for relative in required_entries
        if not (rootfs / relative).exists()
    ]
    if missing_entries:
        raise FileNotFoundError(
            "required stock firmware inputs are missing:\n  "
            + "\n  ".join(missing_entries)
        )

    for directory in (
        "bin", "lib", "usr/bin", "usr/lib", "jci/lib", "jci/appsdk/plugins",
        "jci/mmui/http_resources", "jci/sm", "config/common/log",
        "etc/dbus-1", "proc", "sys",
        "dev", "dev/mqueue", "dev/shm", "run/dbus", "tmp", "var/run",
        "data", "data_persist", "home/cmu",
    ):
        (destination / directory).mkdir(parents=True, exist_ok=True)

    busybox = rootfs / "bin" / "busybox"
    if not busybox.is_file():
        raise FileNotFoundError(f"stock BusyBox not found: {busybox}")
    shutil.copy2(busybox, destination / "bin" / "busybox")

    copy_rootfs_dir(rootfs, rootfs / "lib", destination)
    copy_rootfs_dir(rootfs, rootfs / "usr/lib", destination)
    if (rootfs / "etc/nsswitch.conf").exists():
        copy_rootfs_entry(rootfs, rootfs / "etc/nsswitch.conf", destination)

    for rel_dir in NATIVE_DATA_DIRECTORIES:
        copy_rootfs_dir(rootfs, rootfs / rel_dir, destination)

    native_files = copy_elf_closure(rootfs, destination, NATIVE_SERVICE_FILES)
    kernel_modules = install_network_modules(installer_initrd, destination)
    for relative_file in NATIVE_DATA_FILES:
        copy_rootfs_entry(rootfs, rootfs / relative_file, destination)

    (destination / "etc/passwd").write_text(
        "root:x:0:0:root:/root:/bin/sh\n"
        "cmu:x:1000:1000:cmu:/home/cmu:/bin/sh\n"
        "messagebus:x:500:500:messagebus:/var/run/dbus:/bin/false\n"
        "service:x:501:501:service:/var/run/dbus:/bin/false\n"
        "hmi:x:502:502:hmi:/var/run/dbus:/bin/false\n",
        encoding="utf-8",
    )
    (destination / "etc/group").write_text(
        "root:x:0:\n"
        "cmu:x:1000:\n"
        "messagebus:x:500:\n"
        "service:x:501:\n"
        "hmi:x:502:\n",
        encoding="utf-8",
    )

    generate_emulator_sm_conf(rootfs, destination)

    for config_name, socket_path in (
        ("system.conf", "/run/dbus/system_bus_socket"),
        ("service.conf", "/tmp/dbus_service_socket"),
        ("hmi.conf", "/tmp/dbus_hmi_socket"),
    ):
        (destination / "etc/dbus-1" / config_name).write_text(
            DBUS_CONFIG_TEMPLATE.format(socket_path=socket_path),
            encoding="utf-8",
        )

    (destination / "jci/appsdk/appsdk_plugin_config.xml").write_text(
        APPSDK_CONFIG,
        encoding="utf-8",
    )

    init = destination / "init"
    init.write_text(INIT_SCRIPT, encoding="utf-8")
    init.chmod(0o755)
    return native_files, kernel_modules


def build_archive(tree: pathlib.Path, output: pathlib.Path) -> None:
    paths = ["."]
    paths.extend(
        sorted(
            str(path.relative_to(tree))
            for path in tree.rglob("*")
        )
    )
    cpio_input = b"\0".join(path.encode("utf-8") for path in paths) + b"\0"
    result = subprocess.run(
        ["cpio", "--null", "-o", "--format=newc", "--quiet"],
        cwd=tree,
        input=cpio_input,
        capture_output=True,
        check=True,
    )
    with output.open("wb") as raw_output:
        with gzip.GzipFile(
            fileobj=raw_output,
            mode="wb",
            compresslevel=9,
            mtime=0,
        ) as compressed:
            compressed.write(result.stdout)


def build(
    rootfs: pathlib.Path,
    output_dir: pathlib.Path,
    installer_initrd: pathlib.Path = DEFAULT_INSTALLER_INITRD,
) -> pathlib.Path:
    rootfs = rootfs.resolve(strict=True)
    installer_initrd = installer_initrd.resolve(strict=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / "initramfs.cpio.gz"

    with tempfile.TemporaryDirectory(prefix="cmu-initramfs-", dir=output_dir) as temp_dir:
        tree = pathlib.Path(temp_dir)
        native_files, kernel_modules = build_tree(rootfs, installer_initrd, tree)
        build_archive(tree, archive)

    metadata = {
        "format": 1,
        "sourceRootfs": str(rootfs),
        "busyboxSha256": file_sha256(rootfs / "bin" / "busybox"),
        "stockSmConf": str(rootfs / "jci/sm/sm.conf"),
        "stockSmConfSha256": file_sha256(rootfs / "jci/sm/sm.conf"),
        "installerInitrd": str(installer_initrd),
        "installerInitrdSha256": file_sha256(installer_initrd),
        "kernelVersion": KERNEL_VERSION,
        "kernelModules": kernel_modules,
        "archive": str(archive),
        "archiveSha256": file_sha256(archive),
        "nativeFiles": native_files,
        "nativeServices": ["dbus-daemon:system", "dbus-daemon:service", "dbus-daemon:hmi", "sm", "jciAppsdk", "jciDbapi", "jciMMUI", "settings"],
        "purpose": "generic ARM full-system Stage 3 real messaging backend proof",
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(metadata, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"[BUILD-GUEST] Created {archive}")
    print(f"[BUILD-GUEST] SHA-256 {metadata['archiveSha256']}")
    print("[BUILD-GUEST] Source firmware tree was not modified")
    return archive


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=DEFAULT_ROOTFS)
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--installer-initrd",
        type=pathlib.Path,
        default=DEFAULT_INSTALLER_INITRD,
    )
    args = parser.parse_args()
    build(args.root, args.output, args.installer_initrd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
