#!/usr/bin/env python3
"""Validation for bounded, replayable CMU VIM CAN captures."""

from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
import re
from typing import Any


CAN_CAPTURE_SCHEMA = "mazda-cmu-vim-can-v1"
MAX_CAPTURE_BYTES = 16 * 1024 * 1024
MAX_CAPTURE_FRAMES = 100_000
MAX_FRAME_BYTES = 64
HEX_DATA = re.compile(r"^[0-9A-F]*$")
CHANNEL_RULES = {
    "public": {"port": 1, "first": 0x100, "last": 0x17F},
    "private": {"port": 0, "first": 0x180, "last": 0x1FF},
}


class CanReplayError(RuntimeError):
    """The requested VIM capture cannot be replayed safely."""


def _integer(record: dict[str, Any], field: str, line_number: int) -> int:
    value = record.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise CanReplayError(f"line {line_number}: {field} must be an integer")
    return value


def _validate_record(record: Any, line_number: int, previous_sequence: int) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise CanReplayError(f"line {line_number}: frame must be a JSON object")
    if record.get("schema") != CAN_CAPTURE_SCHEMA:
        raise CanReplayError(f"line {line_number}: unsupported CAN capture schema")

    sequence = _integer(record, "sequence", line_number)
    if sequence <= previous_sequence:
        raise CanReplayError(f"line {line_number}: sequence must increase")

    channel = record.get("channel")
    if channel not in CHANNEL_RULES:
        raise CanReplayError(f"line {line_number}: channel must be public or private")
    rule = CHANNEL_RULES[channel]

    port = _integer(record, "port", line_number)
    if port != rule["port"]:
        raise CanReplayError(f"line {line_number}: {channel} channel must use port {rule['port']}")

    frame_id = _integer(record, "id", line_number)
    if not rule["first"] <= frame_id <= rule["last"] or frame_id == 0x160:
        raise CanReplayError(f"line {line_number}: ID is outside the {channel} VIM range")
    expected_hex = f"0x{frame_id:03X}"
    if record.get("idHex") != expected_hex:
        raise CanReplayError(f"line {line_number}: idHex must be {expected_hex}")

    length = _integer(record, "length", line_number)
    if not 0 <= length <= MAX_FRAME_BYTES:
        raise CanReplayError(
            f"line {line_number}: length must be between 0 and {MAX_FRAME_BYTES}"
        )
    data = record.get("data")
    if not isinstance(data, str) or not HEX_DATA.fullmatch(data) or len(data) != length * 2:
        raise CanReplayError(f"line {line_number}: data must be uppercase hex matching length")

    return {
        "schema": CAN_CAPTURE_SCHEMA,
        "sequence": sequence,
        "channel": channel,
        "port": port,
        "id": frame_id,
        "idHex": expected_hex,
        "length": length,
        "data": data,
    }


def load_can_capture(capture_path: str | Path) -> dict[str, Any]:
    """Load and strictly validate one bounded JSONL capture."""

    path = Path(capture_path).expanduser().resolve()
    try:
        stat = path.stat()
    except OSError as error:
        raise CanReplayError(f"CAN capture is unavailable: {path}") from error
    if not path.is_file():
        raise CanReplayError(f"CAN capture is not a regular file: {path}")
    if stat.st_size > MAX_CAPTURE_BYTES:
        raise CanReplayError(f"CAN capture exceeds {MAX_CAPTURE_BYTES} bytes")

    frames: list[dict[str, Any]] = []
    previous_sequence = -1
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise CanReplayError(f"CAN capture is not readable UTF-8: {path}") from error

    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        if len(frames) >= MAX_CAPTURE_FRAMES:
            raise CanReplayError(f"CAN capture exceeds {MAX_CAPTURE_FRAMES} frames")
        try:
            decoded = json.loads(line)
        except json.JSONDecodeError as error:
            raise CanReplayError(f"line {line_number}: invalid JSON: {error.msg}") from error
        frame = _validate_record(decoded, line_number, previous_sequence)
        frames.append(frame)
        previous_sequence = frame["sequence"]

    if not frames:
        raise CanReplayError("CAN capture contains no frames")
    counts = Counter(frame["channel"] for frame in frames)
    return {
        "schema": CAN_CAPTURE_SCHEMA,
        "path": str(path),
        "frameCount": len(frames),
        "channels": {name: counts.get(name, 0) for name in CHANNEL_RULES},
        "frames": frames,
    }
