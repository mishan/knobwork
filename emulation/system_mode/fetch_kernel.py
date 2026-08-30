#!/usr/bin/env python3
"""Fetch the tested ARM kernel and matching module-bearing installer initrd."""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import sys
import urllib.request


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
DEFAULT_OUTPUT = SCRIPT_DIR / "cache" / "vmlinuz-armmp"
DEFAULT_INITRD_OUTPUT = SCRIPT_DIR / "cache" / "debian-installer-initrd.gz"
DEFAULT_URL = (
    "https://deb.debian.org/debian/dists/testing/main/installer-armhf/"
    "current/images/netboot/vmlinuz"
)
DEFAULT_INITRD_URL = (
    "https://deb.debian.org/debian/dists/testing/main/installer-armhf/"
    "current/images/netboot/initrd.gz"
)
TESTED_SHA256 = "6d55423515e1e27d5724be7de9d54963c3a3f8a5a9827bf2665bdb2f7ab0a605"
TESTED_INITRD_SHA256 = "a0b62016b1b4e6591b7546fbfaaf9bd681aab1872c468cd04e792b4bbdeb5d07"


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(url: str, output: pathlib.Path, expected_sha256: str, label: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix(output.suffix + ".partial")

    print(f"[EMU-KERNEL] Downloading {label}: {url}")
    try:
        with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as target:
            while block := response.read(1024 * 1024):
                target.write(block)

        actual = sha256(partial)
        if actual != expected_sha256:
            raise RuntimeError(
                f"{label} checksum mismatch: "
                f"expected {expected_sha256}, received {actual}. "
                "The mutable Debian installer URL may have advanced; review and "
                "test the new kernel before updating the pinned checksum."
            )

        partial.replace(output)
        print(f"[EMU-KERNEL] Verified {label}: {output}")
        print(f"[EMU-KERNEL] {label} SHA-256 {actual}")
    except Exception:
        partial.unlink(missing_ok=True)
        raise


def ensure_fetched(
    url: str,
    output: pathlib.Path,
    expected_sha256: str,
    label: str,
) -> None:
    if output.exists() and sha256(output) == expected_sha256:
        print(f"[EMU-KERNEL] Existing verified {label}: {output}")
        return
    fetch(url, output, expected_sha256, label)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--sha256", default=TESTED_SHA256)
    parser.add_argument("--initrd-url", default=DEFAULT_INITRD_URL)
    parser.add_argument(
        "--initrd-output", type=pathlib.Path, default=DEFAULT_INITRD_OUTPUT
    )
    parser.add_argument("--initrd-sha256", default=TESTED_INITRD_SHA256)
    args = parser.parse_args()

    try:
        ensure_fetched(args.url, args.output, args.sha256, "kernel")
        ensure_fetched(
            args.initrd_url,
            args.initrd_output,
            args.initrd_sha256,
            "matching installer initrd",
        )
    except Exception as error:
        print(f"[EMU-KERNEL] ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
