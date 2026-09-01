#!/usr/bin/env python3
"""Disposable developer workflow for the reversible overlay manager."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WORKSPACE = REPO_ROOT / "scratch" / "overlay-workspace"
DEFAULT_BUNDLE = REPO_ROOT / "overlay" / "usb"
WORKSPACE_METADATA = ".overlay-workspace.json"
WORKSPACE_FORMAT = 2
WORKSPACE_KIND = "mazda-cmu-overlay-workspace"
MANAGER_ACTIONS = {
    "install",
    "verify",
    "repair",
    "disable",
    "restore",
    "boot-attempt",
    "boot-success",
}


class OverlayWorkflowError(ValueError):
    """The disposable overlay workspace or requested action is unsafe."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _lexists(path: Path) -> bool:
    return os.path.lexists(path)


def _manifest_records(
    bundle: Path,
) -> tuple[dict[str, str], list[list[str]], list[list[str]]]:
    manifest = bundle / "manifest.v1"
    entry = bundle / "install-patches.sh"
    manager = bundle / "lib" / "overlay-manager.sh"
    if (
        not manifest.is_file()
        or manifest.is_symlink()
        or not entry.is_file()
        or entry.is_symlink()
        or not manager.is_file()
        or manager.is_symlink()
    ):
        raise OverlayWorkflowError(f"Incomplete overlay bundle: {bundle}")

    entry_match = re.search(
        r'^OVERLAY_MANIFEST_SHA256="([0-9a-f]{64})"$',
        entry.read_text(encoding="ascii"),
        re.MULTILINE,
    )
    if not entry_match:
        raise OverlayWorkflowError("Overlay entry point has no manifest pin")
    actual_manifest = sha256(manifest)
    if entry_match.group(1) != actual_manifest:
        raise OverlayWorkflowError(
            f"Manifest pin mismatch: entry={entry_match.group(1)} actual={actual_manifest}"
        )

    metadata_names = {
        "manifest_version",
        "overlay_id",
        "firmware_file",
        "firmware_sha256",
        "firmware_version",
        "firmware_patch",
        "boot_limit",
    }
    metadata: dict[str, str] = {}
    files: list[list[str]] = []
    nvram: list[list[str]] = []
    seen_targets: set[str] = set()
    seen_nvram: set[str] = set()
    for line_number, line in enumerate(
        manifest.read_text(encoding="ascii").splitlines(), 1
    ):
        fields = line.split("|")
        if fields[0] in metadata_names:
            if len(fields) != 2 or fields[0] in metadata or not fields[1]:
                raise OverlayWorkflowError(
                    f"Manifest line {line_number}: invalid or duplicate metadata"
                )
            metadata[fields[0]] = fields[1]
        elif fields[0] == "file":
            if len(fields) != 7:
                raise OverlayWorkflowError(
                    f"Manifest line {line_number}: expected seven file fields"
                )
            _, target, stock_hash, payload_name, payload_hash, mode, syntax = fields
            if target in seen_targets:
                raise OverlayWorkflowError(
                    f"Manifest line {line_number}: duplicate target {target}"
                )
            seen_targets.add(target)
            target_parts = target.split("/")
            if (
                not target.startswith("/")
                or any(part in {"", ".", ".."} for part in target_parts[1:])
            ):
                raise OverlayWorkflowError(
                    f"Manifest line {line_number}: unsafe target {target}"
                )
            if stock_hash != "absent" and not re.fullmatch(
                r"[0-9a-f]{64}", stock_hash
            ):
                raise OverlayWorkflowError(
                    f"Manifest line {line_number}: invalid stock hash"
                )
            if (
                payload_name.startswith("/")
                or any(
                    part in {"", ".", ".."} for part in payload_name.split("/")
                )
            ):
                raise OverlayWorkflowError(
                    f"Manifest line {line_number}: unsafe payload path"
                )
            if not re.fullmatch(r"[0-9a-f]{64}", payload_hash):
                raise OverlayWorkflowError(
                    f"Manifest line {line_number}: invalid payload hash"
                )
            payload = bundle / payload_name
            if (
                payload.is_symlink()
                or not payload.is_file()
                or sha256(payload) != payload_hash
            ):
                raise OverlayWorkflowError(
                    f"Manifest line {line_number}: payload hash mismatch for {payload_name}"
                )
            if not re.fullmatch(r"0[0-7]{3}", mode) or syntax not in {
                "sh",
                "js",
                "data",
            }:
                raise OverlayWorkflowError(
                    f"Manifest line {line_number}: invalid mode or syntax gate"
                )
            files.append(fields)
        elif fields[0] == "nvram":
            if len(fields) != 6:
                raise OverlayWorkflowError(
                    f"Manifest line {line_number}: expected six NVRAM fields"
                )
            _, key, stock_hash, stock_value, payload_hash, payload_value = fields
            if key in seen_nvram or not re.fullmatch(r"[A-Za-z0-9_.-]+", key):
                raise OverlayWorkflowError(
                    f"Manifest line {line_number}: duplicate or unsafe NVRAM key"
                )
            seen_nvram.add(key)
            for label, value, expected_hash in (
                ("stock", stock_value, stock_hash),
                ("payload", payload_value, payload_hash),
            ):
                if not re.fullmatch(r"[A-Za-z0-9_.:+/-]+", value):
                    raise OverlayWorkflowError(
                        f"Manifest line {line_number}: unsafe {label} NVRAM value"
                    )
                actual_hash = hashlib.sha256((value + "\n").encode("ascii")).hexdigest()
                if actual_hash != expected_hash:
                    raise OverlayWorkflowError(
                        f"Manifest line {line_number}: {label} NVRAM hash mismatch"
                    )
            nvram.append(fields)
        else:
            raise OverlayWorkflowError(f"Manifest line {line_number}: invalid record")
    if (
        set(metadata) != metadata_names
        or metadata["manifest_version"] != "1"
        or not (files or nvram)
    ):
        raise OverlayWorkflowError("Overlay manifest metadata is incomplete")
    if not re.fullmatch(r"[0-9a-f]{64}", metadata["firmware_sha256"]):
        raise OverlayWorkflowError("Overlay manifest has an invalid firmware hash")
    firmware_file = metadata["firmware_file"]
    firmware_parts = firmware_file.split("/")
    if not firmware_file.startswith("/") or any(
        part in {"", ".", ".."} for part in firmware_parts[1:]
    ):
        raise OverlayWorkflowError("Overlay manifest has an unsafe firmware path")
    if not metadata["boot_limit"].isdigit() or int(metadata["boot_limit"]) < 1:
        raise OverlayWorkflowError("Overlay manifest has an invalid boot-attempt limit")
    return metadata, files, nvram


def _safe_root_target(root: Path, target: str) -> Path:
    live = root / target.lstrip("/")
    relative = live.relative_to(root)
    current = root
    for part in relative.parts[:-1]:
        current /= part
        if current.is_symlink():
            raise OverlayWorkflowError(f"Selected root has a symlinked target path: {target}")
    if live.is_symlink():
        raise OverlayWorkflowError(f"Selected root has a symlinked target: {target}")
    return live


def _validate_stock_root(
    root: Path, metadata: dict[str, str], files: list[list[str]]
) -> None:
    firmware_file = _safe_root_target(root, metadata["firmware_file"])
    if (
        not firmware_file.is_file()
        or sha256(firmware_file) != metadata["firmware_sha256"]
    ):
        raise OverlayWorkflowError(
            f"Selected root does not match the pinned firmware: {firmware_file}"
        )
    for _, target, stock_hash, _, _, _, _ in files:
        if target.startswith("/data/"):
            if stock_hash != "absent":
                raise OverlayWorkflowError(
                    "Firmware workspaces support only absent-state /data targets"
                )
            continue
        live = _safe_root_target(root, target)
        if stock_hash == "absent":
            if _lexists(live):
                raise OverlayWorkflowError(f"Selected root is not stock: {target} exists")
        elif not live.is_file() or sha256(live) != stock_hash:
            raise OverlayWorkflowError(f"Selected root has an unexpected target: {target}")


def _copy_root(source: Path, destination: Path) -> None:
    destination.mkdir()
    cp = shutil.which("cp")
    if cp:
        result = subprocess.run(
            [cp, "-a", "--reflink=auto", f"{source}/.", str(destination)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            return
        raise OverlayWorkflowError(
            f"Unable to clone firmware root: {result.stderr.strip()}"
        )
    shutil.copytree(source, destination, dirs_exist_ok=True, symlinks=True)


def _safe_workspace(workspace: Path, source_root: Path | None = None) -> Path:
    resolved = workspace.expanduser().resolve()
    forbidden = {
        Path("/"),
        Path.home().resolve(),
        REPO_ROOT.resolve(),
        REPO_ROOT.parent.resolve(),
    }
    if resolved in forbidden or REPO_ROOT.resolve().is_relative_to(resolved):
        raise OverlayWorkflowError(f"Unsafe overlay workspace: {resolved}")
    if source_root:
        source = source_root.resolve()
        if resolved.is_relative_to(source) or source.is_relative_to(resolved):
            raise OverlayWorkflowError(
                "Workspace and source firmware must not contain each other"
            )
    return resolved


@dataclass(frozen=True)
class OverlayWorkspace:
    path: Path
    root: Path
    bundle: Path
    data: Path
    emulated: Path
    metadata: dict[str, object]

    @property
    def data_volume(self) -> Path:
        return self.path / "data"

    @property
    def mount_state(self) -> Path:
        return self.emulated / "mount-state"

    @property
    def watchdog(self) -> Path:
        return self.emulated / "watchdog"

    @property
    def nvram(self) -> Path:
        return self.emulated / "nvram"

    @property
    def guard(self) -> Path:
        return self.emulated / "manager.guard"

    @property
    def usb_log(self) -> Path:
        return self.emulated / "usb-journal.log"


def load_workspace(workspace: str | Path) -> OverlayWorkspace:
    path = _safe_workspace(Path(workspace))
    metadata_file = path / WORKSPACE_METADATA
    if metadata_file.is_symlink():
        raise OverlayWorkflowError(f"Not an overlay workspace: {path}")
    try:
        metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise OverlayWorkflowError(f"Not an overlay workspace: {path}") from error
    if metadata.get("kind") != WORKSPACE_KIND:
        raise OverlayWorkflowError(f"Not an overlay workspace: {path}")
    if metadata.get("format") != WORKSPACE_FORMAT:
        raise OverlayWorkflowError(f"Unsupported overlay workspace format: {path}")
    result = OverlayWorkspace(
        path=path,
        root=path / "root",
        bundle=path / "usb",
        data=path / "data" / "cmu-overlay",
        emulated=path / "emulated",
        metadata=metadata,
    )
    required_files = (
        result.root / "jci/version.ini",
        result.bundle / "manifest.v1",
    )
    if (
        not all(item.is_file() for item in required_files)
        or not (result.data_volume / "integration").is_dir()
        or not (result.root / "data").is_symlink()
        or os.readlink(result.root / "data") != "../data"
    ):
        raise OverlayWorkflowError(f"Incomplete overlay workspace: {path}")
    return result


def initialize_workspace(
    workspace: str | Path,
    source_root: str | Path,
    bundle: str | Path = DEFAULT_BUNDLE,
) -> OverlayWorkspace:
    source = Path(source_root).expanduser().resolve()
    bundle_path = Path(bundle).expanduser().resolve()
    path = _safe_workspace(Path(workspace), source)
    if path.exists() or path.is_symlink():
        raise OverlayWorkflowError(f"Workspace already exists: {path}")
    metadata, files, nvram = _manifest_records(bundle_path)
    _validate_stock_root(source, metadata, files)

    path.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".overlay-workspace-", dir=path.parent))
    try:
        _copy_root(source, staging / "root")
        shutil.copytree(bundle_path, staging / "usb", symlinks=False)
        data_volume = staging / "data"
        emulated = staging / "emulated"
        data_volume.mkdir()
        (data_volume / "integration").mkdir()
        data = data_volume / "cmu-overlay"
        data.mkdir()
        root_data = staging / "root" / "data"
        if root_data.is_symlink():
            root_data.unlink()
        elif root_data.is_dir():
            try:
                root_data.rmdir()
            except OSError as error:
                raise OverlayWorkflowError(
                    "The source root has a non-empty /data directory; expected a mount-point symlink"
                ) from error
        elif root_data.exists():
            raise OverlayWorkflowError(
                "The source root has an unexpected non-directory /data entry"
            )
        root_data.symlink_to("../data", target_is_directory=True)
        emulated.mkdir()
        (emulated / "mount-state").write_text("ro\n", encoding="ascii")
        (emulated / "watchdog").write_text("0\n", encoding="ascii")
        nvram_root = emulated / "nvram"
        (nvram_root / "keys").mkdir(parents=True)
        (nvram_root / "add").write_text("", encoding="ascii")
        (nvram_root / "commit").write_text("", encoding="ascii")
        for _, key, _, stock_value, _, _ in nvram:
            (nvram_root / "keys" / key).write_text(
                stock_value + "\n", encoding="ascii"
            )
        workspace_metadata = {
            "kind": WORKSPACE_KIND,
            "format": WORKSPACE_FORMAT,
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "source_root": str(source),
            "source_version_sha256": sha256(
                source / metadata["firmware_file"].lstrip("/")
            ),
            "manifest_sha256": sha256(bundle_path / "manifest.v1"),
            "overlay_id": metadata["overlay_id"],
        }
        (staging / WORKSPACE_METADATA).write_text(
            json.dumps(workspace_metadata, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(staging, path)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return load_workspace(path)


def _manager_environment(workspace: OverlayWorkspace) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "MZD_OVERLAY_TEST_MODE": "1",
            "MZD_OVERLAY_ROOT_PREFIX": str(workspace.root),
            "MZD_OVERLAY_DATA_DIR": str(workspace.data),
            "MZD_OVERLAY_USB_LOG": str(workspace.usb_log),
            "MZD_OVERLAY_MOUNT_STATE_FILE": str(workspace.mount_state),
            "MZD_OVERLAY_WATCHDOG_PATH": str(workspace.watchdog),
            "MZD_OVERLAY_NVRAM_DIR": str(workspace.nvram),
            "MZD_OVERLAY_GUARD_DIR": str(workspace.guard),
        }
    )
    return env


def _release_finished_process_guard(workspace: OverlayWorkspace, pid: int) -> None:
    """Remove only the guard proven to belong to the manager that just exited."""
    guard = workspace.guard
    pid_file = guard / "pid"
    if guard.is_symlink() or pid_file.is_symlink() or not pid_file.is_file():
        return
    try:
        recorded_pid = pid_file.read_text(encoding="ascii").strip()
    except OSError:
        return
    if recorded_pid != str(pid):
        return
    try:
        pid_file.unlink()
        guard.rmdir()
    except OSError:
        return


def run_manager_action(
    workspace: str | Path,
    action: str,
    *,
    shell: str = "stock",
    runtime: bool = False,
    fail_point: str | None = None,
    crash_point: str | None = None,
) -> subprocess.CompletedProcess[str]:
    if action not in MANAGER_ACTIONS:
        raise OverlayWorkflowError(f"Unsupported overlay action: {action}")
    current = load_workspace(workspace)
    entry = current.bundle / "install-patches.sh"
    if runtime:
        pointer = current.data / "runtime-current"
        if not pointer.is_file():
            raise OverlayWorkflowError("No persisted overlay runtime is installed")
        runtime_id = pointer.read_text(encoding="ascii").strip()
        if not re.fullmatch(r"[0-9a-f]{64}", runtime_id):
            raise OverlayWorkflowError("Persisted runtime pointer is invalid")
        entry = current.data / "runtime" / runtime_id / "install-patches.sh"
        if not entry.is_file():
            raise OverlayWorkflowError("Persisted overlay runtime is incomplete")

    env = _manager_environment(current)
    if fail_point:
        env["MZD_OVERLAY_FAIL_POINT"] = fail_point
    if crash_point:
        env["MZD_OVERLAY_CRASH_POINT"] = crash_point
    if shell == "host":
        command = ["sh", str(entry), action]
    elif shell == "stock":
        qemu = shutil.which("qemu-arm")
        busybox = current.root / "bin/busybox"
        if not qemu or not busybox.is_file():
            raise OverlayWorkflowError(
                "Stock shell mode requires qemu-arm and root/bin/busybox; "
                "use --shell host only for harness debugging"
            )
        command = [
            qemu,
            "-L",
            str(current.root),
            str(busybox),
            "ash",
            str(entry),
            action,
        ]
    else:
        raise OverlayWorkflowError(f"Unknown shell mode: {shell}")
    process = subprocess.Popen(command, env=env, text=True)
    try:
        returncode = process.wait()
    finally:
        if process.poll() is not None:
            _release_finished_process_guard(current, process.pid)
    return subprocess.CompletedProcess(command, returncode)


def workspace_status(workspace: str | Path) -> dict[str, object]:
    current = load_workspace(workspace)
    metadata, files, nvram = _manifest_records(current.bundle)
    targets: list[dict[str, object]] = []
    for _, target, stock_hash, _, payload_hash, expected_mode, _ in files:
        live = current.root / target.lstrip("/")
        if live.is_file():
            actual_hash = sha256(live)
            if actual_hash == stock_hash:
                state = "stock"
            elif actual_hash == payload_hash:
                state = "payload"
            else:
                state = "unknown"
            mode = f"{live.stat().st_mode & 0o777:03o}"
        elif not _lexists(live) and stock_hash == "absent":
            actual_hash = "absent"
            state = "stock"
            mode = None
        else:
            actual_hash = "unexpected-type"
            state = "unknown"
            mode = None
        targets.append(
            {
                "target": target,
                "state": state,
                "mode": mode,
                "expected_payload_mode": expected_mode,
                "sha256": actual_hash,
            }
        )
    nvram_state = {
        key: (current.nvram / "keys" / key).read_text(encoding="ascii").strip()
        for _, key, _, _, _, _ in nvram
        if (current.nvram / "keys" / key).is_file()
    }

    def read_optional(path: Path, default: str) -> str:
        return path.read_text(encoding="ascii").strip() if path.is_file() else default

    return {
        "workspace": str(current.path),
        "working_root": str(current.root),
        "source_root": current.metadata["source_root"],
        "overlay_id": metadata["overlay_id"],
        "manifest_sha256": sha256(current.bundle / "manifest.v1"),
        "manager_state": read_optional(current.data / "state", "factory"),
        "boot_attempts": read_optional(current.data / "boot-attempts", "0"),
        "active_transaction": read_optional(
            current.data / "active-transaction", "none"
        ),
        "mount_state": read_optional(current.mount_state, "missing"),
        "watchdog": read_optional(current.watchdog, "missing"),
        "targets": targets,
        "nvram": nvram_state,
        "data_journal": str(current.data / "journal.log"),
        "usb_journal": str(current.usb_log),
    }


def format_status(status: dict[str, object]) -> str:
    lines = [
        f"Overlay workspace: {status['workspace']}",
        f"Working root:     {status['working_root']}",
        f"Source root:      {status['source_root']}",
        f"Overlay:          {status['overlay_id']}",
        f"Manager state:    {status['manager_state']}",
        f"Boot attempts:    {status['boot_attempts']}",
        f"Active txn:       {status['active_transaction']}",
        f"Mount/watchdog:   {status['mount_state']} / {status['watchdog']}",
        "Targets:",
    ]
    for target in status["targets"]:  # type: ignore[assignment]
        lines.append(
            f"  {target['state']:7} mode={target['mode'] or '-':>3} {target['target']}"
        )
    lines.extend(
        [
            f"Data journal:     {status['data_journal']}",
            f"USB journal:      {status['usb_journal']}",
        ]
    )
    return "\n".join(lines)


def reset_workspace(workspace: str | Path) -> None:
    current = load_workspace(workspace)
    for directory, subdirectories, filenames in os.walk(current.path):
        directory_path = Path(directory)
        directory_path.chmod(directory_path.stat().st_mode | stat.S_IRWXU)
        for name in subdirectories:
            path = directory_path / name
            if not path.is_symlink():
                path.chmod(path.stat().st_mode | stat.S_IRWXU)
        for name in filenames:
            path = directory_path / name
            if not path.is_symlink():
                path.chmod(path.stat().st_mode | stat.S_IRUSR | stat.S_IWUSR)
    shutil.rmtree(current.path)
