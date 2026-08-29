#!/usr/bin/env python3
"""Fetch the QEMU-compatible ARM kernel used by the CMU generic guest."""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import sys
import urllib.request


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
DEFAULT_OUTPUT = SCRIPT_DIR / "cache" / "vmlinuz-armmp"
DEFAULT_URL = (
    "https://deb.debian.org/debian/dists/testing/main/installer-armhf/"
    "current/images/netboot/vmlinuz"
)
TESTED_SHA256 = "6d55423515e1e27d5724be7de9d54963c3a3f8a5a9827bf2665bdb2f7ab0a605"


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(url: str, output: pathlib.Path, expected_sha256: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix(output.suffix + ".partial")

    print(f"[EMU-KERNEL] Downloading {url}")
    try:
        with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as target:
            while block := response.read(1024 * 1024):
                target.write(block)

        actual = sha256(partial)
        if actual != expected_sha256:
            raise RuntimeError(
                "kernel checksum mismatch: "
                f"expected {expected_sha256}, received {actual}. "
                "The mutable Debian installer URL may have advanced; review and "
                "test the new kernel before updating the pinned checksum."
            )

        partial.replace(output)
        print(f"[EMU-KERNEL] Verified {output}")
        print(f"[EMU-KERNEL] SHA-256 {actual}")
    except Exception:
        partial.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--sha256", default=TESTED_SHA256)
    args = parser.parse_args()

    if args.output.exists() and sha256(args.output) == args.sha256:
        print(f"[EMU-KERNEL] Existing verified kernel: {args.output}")
        return 0

    try:
        fetch(args.url, args.output, args.sha256)
    except Exception as error:
        print(f"[EMU-KERNEL] ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
