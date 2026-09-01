#!/usr/bin/env python3
"""Tests for CMU VIM CAN capture validation."""

import json
from pathlib import Path
import tempfile
import unittest

from emulation.can_replay import CanReplayError, load_can_capture


REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLE = REPO_ROOT / "emulation/fixtures/can/public-private-sample.jsonl"


class CanReplayTests(unittest.TestCase):
    def test_loads_bounded_public_and_private_capture(self):
        capture = load_can_capture(SAMPLE)
        self.assertEqual(capture["frameCount"], 4)
        self.assertEqual(capture["channels"], {"public": 2, "private": 2})
        self.assertEqual(capture["frames"][-1]["data"], "DEADBEEF01020304")

    def test_rejects_mismatched_hex_data(self):
        frame = {
            "schema": "mazda-cmu-vim-can-v1",
            "sequence": 1,
            "channel": "public",
            "port": 1,
            "id": 0x123,
            "idHex": "0x123",
            "length": 2,
            "data": "AA",
        }
        with tempfile.TemporaryDirectory(prefix="cmu-can-replay-test-") as temp:
            capture_path = Path(temp) / "bad.jsonl"
            capture_path.write_text(json.dumps(frame) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(CanReplayError, "matching length"):
                load_can_capture(capture_path)

    def test_rejects_ready_message_and_wrong_channel_port(self):
        frame = {
            "schema": "mazda-cmu-vim-can-v1",
            "sequence": 1,
            "channel": "public",
            "port": 0,
            "id": 0x160,
            "idHex": "0x160",
            "length": 1,
            "data": "01",
        }
        with tempfile.TemporaryDirectory(prefix="cmu-can-replay-test-") as temp:
            capture_path = Path(temp) / "bad.jsonl"
            capture_path.write_text(json.dumps(frame) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(CanReplayError, "must use port"):
                load_can_capture(capture_path)


if __name__ == "__main__":
    unittest.main()
