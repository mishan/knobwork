#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Adapted from checksummaster/mzd-packing-scripts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cmu_common.sh
. "${SCRIPT_DIR}/cmu_common.sh"

DEFAULT_SIGNATURE='b33fb33fb33fb33fb33fb33fb33fb33f'

usage() {
    echo "Usage: $0 UNPACKED_DIRECTORY OUTPUT.up [32_HEX_SIGNATURE]" >&2
}

if (( $# < 2 || $# > 3 )); then
    usage
    exit 2
fi

SOURCE_DIR="$(realpath "$1")"
OUTPUT_FILE="$(realpath -m "$2")"
SIGNATURE="${3:-$DEFAULT_SIGNATURE}"
if [[ ! -d "$SOURCE_DIR/root" ]]; then
    echo "[FIRMWARE] Missing extracted root directory: $SOURCE_DIR/root" >&2
    exit 2
fi
if [[ "${OUTPUT_FILE,,}" != *.up ]]; then
    echo "[FIRMWARE] Output must have a .up suffix: $OUTPUT_FILE" >&2
    exit 2
fi
if [[ -e "$OUTPUT_FILE" ]]; then
    echo "[FIRMWARE] Refusing to replace existing output: $OUTPUT_FILE" >&2
    exit 2
fi
if [[ ! "$SIGNATURE" =~ ^[0-9A-Fa-f]{32}$ ]]; then
    echo "[FIRMWARE] Signature must be exactly 32 hexadecimal characters" >&2
    exit 2
fi

OUTPUT_PARENT="$(dirname "$OUTPUT_FILE")"
mkdir -p "$OUTPUT_PARENT"
TEMP_PARENT="$(mktemp -d "${OUTPUT_PARENT}/.cmu-pack.tmp.XXXXXX")"
cleanup() {
    rm -rf -- "$TEMP_PARENT"
}
trap cleanup EXIT
WORK_DIR="$TEMP_PARENT/work"
cp -a -- "$SOURCE_DIR" "$WORK_DIR"

echo "[FIRMWARE] Rebuilding rootfs archive from a temporary copy"
rm -f -- "$WORK_DIR/rootfs1upd/e0000000001.dat"
tar -czf "$WORK_DIR/rootfs1upd/e0000000001.dat" -C "$WORK_DIR/root" .

if [[ -f "$WORK_DIR/rootfs1upd/e0000000003.dat" ]]; then
    MD5_FILE="$WORK_DIR/rootfs1upd/e0000000002.dat"
    : > "$MD5_FILE"
    while IFS= read -r -d '' filename; do
        relative="${filename#"$WORK_DIR/root"}"
        hash="$(md5sum "$filename")"
        printf '%s  /tmp/rootfs%s\n' "${hash%% *}" "$relative" >> "$MD5_FILE"
    done < <(find "$WORK_DIR/root" -type f -print0 | sort -z)
fi

while IFS= read -r -d '' filename; do
    gzip -- "$filename"
done < <(
    find "$WORK_DIR" -path "$WORK_DIR/root" -prune -o -type f \
        \( -name '*.dat' -o \( -name '*.ini' ! -name 'main_instructions.ini' \) \) \
        -print0
)

mapfile -d '' MANIFEST < <(
    find "$WORK_DIR" -mindepth 1 -maxdepth 1 \
        ! -name root ! -name dirdates.txt ! -name .source-sha256 \
        -printf '%f\0' | sort -z
)
if (( ${#MANIFEST[@]} == 0 )); then
    echo "[FIRMWARE] No package entries found in $SOURCE_DIR" >&2
    exit 3
fi

printf '%s\n.' "$SIGNATURE" > "$TEMP_PARENT/comment.txt"
(
    cd "$WORK_DIR"
    zip -q -P "$PASSWORD" -r "$OUTPUT_FILE" "${MANIFEST[@]}" -Z store -0 -z < "$TEMP_PARENT/comment.txt"
)
echo "[FIRMWARE] Created: $OUTPUT_FILE"
