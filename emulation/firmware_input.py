#!/usr/bin/env python3
"""Resolve or unpack firmware input without relying on a developer's workspace."""

from __future__ import annotations

import hashlib
import os
import pathlib
import subprocess


REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
PREPARED_FIRMWARE_DIR = REPO_ROOT / ".firmware"
UNPACK_SCRIPT = REPO_ROOT / "tools" / "firmware" / "unpack_cmu.sh"


class FirmwareInputError(ValueError):
    """The selected firmware input cannot provide a usable CMU rootfs."""


def _validate_rootfs(path: pathlib.Path) -> pathlib.Path:
    resolved = path.expanduser().resolve()
    required = (resolved / "jci" / "gui", resolved / "jci" / "mmui")
    if not resolved.is_dir() or not all(item.exists() for item in required):
        raise FirmwareInputError(
            f"Not a CMU rootfs: {resolved} (expected jci/gui and jci/mmui)"
        )
    return resolved


def _prepared_roots() -> list[pathlib.Path]:
    if not PREPARED_FIRMWARE_DIR.is_dir():
        return []
    return sorted(
        candidate
        for candidate in PREPARED_FIRMWARE_DIR.glob("*/root")
        if (candidate / "jci" / "gui").is_dir()
        and (candidate / "jci" / "mmui").is_dir()
    )


def discover_default_rootfs() -> pathlib.Path | None:
    """Return an unambiguous portable default, if one has been configured."""
    environment_root = os.environ.get("CMU_ROOTFS")
    if environment_root:
        return _validate_rootfs(pathlib.Path(environment_root))

    prepared = _prepared_roots()
    if len(prepared) == 1:
        return prepared[0].resolve()
    return None


def prepared_directory_for(up_file: pathlib.Path) -> pathlib.Path:
    name = up_file.name[:-3] if up_file.name.lower().endswith(".up") else up_file.stem
    return PREPARED_FIRMWARE_DIR / name


def _sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def unpack_firmware(up_file: str, output: str | None = None) -> pathlib.Path:
    source = pathlib.Path(up_file).expanduser().resolve()
    if not source.is_file():
        raise FirmwareInputError(f"Firmware update file does not exist: {source}")
    if source.suffix.lower() != ".up":
        raise FirmwareInputError(f"Firmware input must have a .up suffix: {source}")

    destination = (
        pathlib.Path(output).expanduser().resolve()
        if output
        else prepared_directory_for(source).resolve()
    )
    rootfs = destination / "root"
    if rootfs.exists():
        identity_file = destination / ".source-sha256"
        if not identity_file.is_file():
            raise FirmwareInputError(
                f"Prepared firmware has no source identity: {destination}"
            )
        expected = identity_file.read_text(encoding="ascii").strip()
        actual = _sha256(source)
        if actual != expected:
            raise FirmwareInputError(
                f"Prepared firmware does not match {source} (remove or choose "
                "a different --firmware-work-dir)"
            )
        return _validate_rootfs(rootfs)
    if destination.exists():
        raise FirmwareInputError(
            f"Refusing to replace incomplete firmware directory: {destination}"
        )

    subprocess.run(
        ["bash", str(UNPACK_SCRIPT), str(source), str(destination)],
        check=True,
    )
    return _validate_rootfs(rootfs)


def resolve_rootfs(
    *, root: str | None = None, firmware: str | None = None, work_dir: str | None = None
) -> pathlib.Path:
    if root and firmware:
        raise FirmwareInputError("Use either --root or --firmware, not both")
    if work_dir and not firmware:
        raise FirmwareInputError("--firmware-work-dir requires --firmware")
    if root:
        return _validate_rootfs(pathlib.Path(root))
    if firmware:
        return unpack_firmware(firmware, work_dir)

    discovered = discover_default_rootfs()
    if discovered:
        return discovered
    raise FirmwareInputError(
        "No CMU firmware selected. Pass --firmware FILE.up or --root DIR, "
        "or set CMU_ROOTFS."
    )
