#!/usr/bin/env python3
"""Validate the pinned overlay bundle and prepare a v74 launcher USB tree."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re
import shutil
import stat
import zipfile


OVERLAY_DIR = Path(__file__).resolve().parent
USB_SOURCE = OVERLAY_DIR / "usb"
LAUNCHER_NAME = "$(S=${HOME%root};for d in sda1 sdb1 sdc1 sdd1;do f=${S}tmp${S}mnt${S}$d${S}install-patches.sh;[ -f $f ]&&sh $f&&break;done).up"
MAIN_INSTRUCTIONS = """[Settings]
PackageID        = 1661843768
CompressionType  = NONE
TotalStepsCount  = 1

[Instructions]
Count = 1
1 = Execute, "bootstrap", "execute.ini", 1

[Instructions_Ext]
Count = 1
1 = Execute, "bootstrap", "execute.ini", 1

[DataStorage]
Count = 5
UPType = "Reinstall"
SubUPType = "Mass"
ReTransmit = "1"
NewPackage = "1"
CMUBoardType = "3"
"""
VERSIONS = """[Settings]
CheckCompatibility = 1,"Compat_Section"
Labels = 2,"JCI_SW_VER","DisplayVersion"

[Compat_Section]
Count = 1
1 = CheckLabel,"JCI_SW_VER",1,"[>='MAZ_CMU-140_31.00.000']"

[JCI_SW_VER]
LabelName = "JCI_SW_VER"
LoadLocation = Custom

[DisplayVersion]
LabelName = "DisplayVersion"
LoadLocation = UP
LabelValue = "74.00.324"
"""


class BundleError(ValueError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_bundle() -> str:
    manifest = USB_SOURCE / "manifest.v1"
    entry = USB_SOURCE / "install-patches.sh"
    if not manifest.is_file() or not entry.is_file():
        raise BundleError("overlay USB bundle is incomplete")

    entry_text = entry.read_text(encoding="ascii")
    match = re.search(r'^OVERLAY_MANIFEST_SHA256="([0-9a-f]{64})"$', entry_text, re.M)
    if not match:
        raise BundleError("entry point has no pinned manifest SHA-256")
    actual_manifest_hash = sha256(manifest)
    if match.group(1) != actual_manifest_hash:
        raise BundleError(
            f"manifest pin mismatch: entry has {match.group(1)}, actual is {actual_manifest_hash}"
        )

    seen_targets: set[str] = set()
    seen_nvram: set[str] = set()
    metadata: dict[str, str] = {}
    metadata_names = {
        "manifest_version",
        "overlay_id",
        "firmware_file",
        "firmware_sha256",
        "firmware_version",
        "firmware_patch",
        "boot_limit",
    }
    target_count = 0
    for line_number, line in enumerate(manifest.read_text(encoding="ascii").splitlines(), 1):
        fields = line.split("|")
        if fields[0] in metadata_names:
            if len(fields) != 2 or fields[0] in metadata or not fields[1]:
                raise BundleError(f"manifest line {line_number}: invalid or duplicate metadata")
            metadata[fields[0]] = fields[1]
            continue
        if fields[0] == "nvram":
            if len(fields) != 6:
                raise BundleError(f"manifest line {line_number}: expected six NVRAM fields")
            _, key, stock_hash, stock_value, payload_hash, payload_value = fields
            if key in seen_nvram:
                raise BundleError(f"manifest line {line_number}: duplicate NVRAM key {key}")
            seen_nvram.add(key)
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", key):
                raise BundleError(f"manifest line {line_number}: unsafe NVRAM key")
            for label, value, expected_hash in (
                ("stock", stock_value, stock_hash),
                ("payload", payload_value, payload_hash),
            ):
                if not re.fullmatch(r"[A-Za-z0-9_.:+/-]+", value):
                    raise BundleError(f"manifest line {line_number}: unsafe {label} NVRAM value")
                actual_hash = hashlib.sha256((value + "\n").encode("ascii")).hexdigest()
                if actual_hash != expected_hash:
                    raise BundleError(f"manifest line {line_number}: {label} NVRAM hash mismatch")
            target_count += 1
            continue
        if fields[0] != "file":
            raise BundleError(f"manifest line {line_number}: unknown record {fields[0]!r}")
        if len(fields) != 7:
            raise BundleError(f"manifest line {line_number}: expected seven fields")
        _, target, stock_hash, payload_name, payload_hash, mode, syntax = fields
        if target in seen_targets:
            raise BundleError(f"manifest line {line_number}: duplicate target {target}")
        seen_targets.add(target)
        if not target.startswith("/") or ".." in target or "//" in target:
            raise BundleError(f"manifest line {line_number}: unsafe target {target}")
        if stock_hash != "absent" and not re.fullmatch(r"[0-9a-f]{64}", stock_hash):
            raise BundleError(f"manifest line {line_number}: invalid stock hash")
        if payload_name.startswith("/") or ".." in payload_name or "//" in payload_name:
            raise BundleError(f"manifest line {line_number}: unsafe payload path")
        payload = USB_SOURCE / payload_name
        if not payload.is_file() or sha256(payload) != payload_hash:
            raise BundleError(f"manifest line {line_number}: payload hash mismatch for {payload_name}")
        if not re.fullmatch(r"0[0-7]{3}", mode) or syntax not in {"sh", "js", "data"}:
            raise BundleError(f"manifest line {line_number}: invalid mode or syntax gate")
        target_count += 1
    if not target_count:
        raise BundleError("manifest contains no overlay targets")
    if set(metadata) != metadata_names:
        missing = ", ".join(sorted(metadata_names - set(metadata)))
        raise BundleError(f"manifest metadata is incomplete: {missing}")
    if metadata["manifest_version"] != "1":
        raise BundleError("unsupported manifest version")
    if not re.fullmatch(r"[0-9a-f]{64}", metadata["firmware_sha256"]):
        raise BundleError("invalid firmware metadata hash")
    if not metadata["firmware_file"].startswith("/") or ".." in metadata["firmware_file"]:
        raise BundleError("unsafe firmware metadata path")
    if not metadata["boot_limit"].isdigit() or int(metadata["boot_limit"]) < 1:
        raise BundleError("invalid boot-attempt limit")
    return actual_manifest_hash


def write_launcher(destination: Path) -> Path:
    launcher = destination / LAUNCHER_NAME
    with zipfile.ZipFile(launcher, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, text in (
            ("main_instructions.ini", MAIN_INSTRUCTIONS),
            ("versions.ini", VERSIONS),
        ):
            info = zipfile.ZipInfo(name, date_time=(2026, 8, 30, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, text.encode("ascii"))
    return launcher


def prepare(destination: Path) -> Path:
    validate_bundle()
    destination = destination.expanduser().resolve()
    if destination.exists():
        raise BundleError(f"destination already exists: {destination}")
    shutil.copytree(USB_SOURCE, destination)
    entry = destination / "install-patches.sh"
    entry.chmod(entry.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return write_launcher(destination)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", type=Path, help="new USB staging directory")
    parser.add_argument("--check", action="store_true", help="validate without writing output")
    args = parser.parse_args()
    if args.check:
        manifest_hash = validate_bundle()
        print(f"overlay bundle valid: manifest sha256 {manifest_hash}")
        return 0
    if args.output is None:
        parser.error("output is required unless --check is used")
    launcher = prepare(args.output)
    print(f"prepared USB tree: {launcher.parent}")
    print(f"launcher: {launcher.name}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BundleError as error:
        raise SystemExit(f"error: {error}")
