#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Adapted from checksummaster/mzd-packing-scripts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cmu_common.sh
. "${SCRIPT_DIR}/cmu_common.sh"

usage() {
    echo "Usage: $0 UPDATE.up [OUTPUT_DIRECTORY]" >&2
}

if (( $# < 1 || $# > 2 )); then
    usage
    exit 2
fi

UP_FILE="$(realpath "$1")"
if [[ ! -f "$UP_FILE" || "${UP_FILE,,}" != *.up ]]; then
    echo "[FIRMWARE] Expected an existing .up file: $1" >&2
    exit 2
fi

if (( $# == 2 )); then
    OUTPUT_DIR="$(realpath -m "$2")"
else
    OUTPUT_DIR="$(pwd)/$(basename "${UP_FILE%.up}")"
fi
if [[ -e "$OUTPUT_DIR" ]]; then
    echo "[FIRMWARE] Refusing to replace existing output: $OUTPUT_DIR" >&2
    exit 2
fi

OUTPUT_PARENT="$(dirname "$OUTPUT_DIR")"
mkdir -p "$OUTPUT_PARENT"
TEMP_DIR="$(mktemp -d "${OUTPUT_PARENT}/.$(basename "$OUTPUT_DIR").tmp.XXXXXX")"
cleanup() {
    if [[ -d "$TEMP_DIR" ]]; then
        rm -rf -- "$TEMP_DIR"
    fi
}
trap cleanup EXIT

echo "[FIRMWARE] Unpacking $(basename "$UP_FILE")"
unzip -q -P "$PASSWORD" -- "$UP_FILE" -d "$TEMP_DIR"

while IFS= read -r -d '' filename; do
    gzip -d -- "$filename"
done < <(find "$TEMP_DIR" -type f -name '*.gz' -print0)

ROOT_ARCHIVE="$TEMP_DIR/rootfs1upd/e0000000001.dat"
if [[ ! -f "$ROOT_ARCHIVE" ]]; then
    echo "[FIRMWARE] Missing root filesystem archive: rootfs1upd/e0000000001.dat" >&2
    exit 3
fi
mkdir "$TEMP_DIR/root"
tar -xzf "$ROOT_ARCHIVE" -C "$TEMP_DIR/root"

if [[ ! -d "$TEMP_DIR/root/jci/gui" ]]; then
    echo "[FIRMWARE] Extracted archive is not a supported CMU rootfs" >&2
    exit 3
fi

sha256sum "$UP_FILE" | awk '{print $1}' > "$TEMP_DIR/.source-sha256"

mv -- "$TEMP_DIR" "$OUTPUT_DIR"
trap - EXIT
echo "[FIRMWARE] Rootfs ready: $OUTPUT_DIR/root"
