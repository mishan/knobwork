#!/usr/bin/env python3
"""Host-side gates for the receive-only VIM collector."""

import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


CAN_DIR = Path(__file__).resolve().parents[1]
SOURCE = CAN_DIR / "cmu_can_listener.c"
PAYLOAD = CAN_DIR.parent / "overlay/usb/payloads/can/cmu-can-listener"


class ReceiveOnlyListenerTests(unittest.TestCase):
    def test_self_test_emits_public_and_private_jsonl(self):
        compiler = shutil.which("cc")
        self.assertIsNotNone(compiler)
        with tempfile.TemporaryDirectory(prefix="cmu-can-listener-test-") as temp:
            binary = Path(temp) / "cmu-can-listener-test"
            subprocess.run(
                [
                    compiler,
                    "-DCMU_CAN_FAKE_VIM",
                    "-D_POSIX_C_SOURCE=200809L",
                    "-std=c99",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    str(SOURCE),
                    "-o",
                    str(binary),
                ],
                check=True,
            )
            result = subprocess.run(
                [str(binary), "--self-test"],
                check=True,
                capture_output=True,
                text=True,
            )
            records = [json.loads(line) for line in result.stdout.splitlines()]

        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["channel"], "public")
        self.assertEqual(records[0]["port"], 1)
        self.assertEqual(records[0]["idHex"], "0x123")
        self.assertEqual(records[0]["data"], "112233")
        self.assertEqual(records[1]["channel"], "private")
        self.assertEqual(records[1]["port"], 0)
        self.assertEqual(records[1]["idHex"], "0x1AB")
        self.assertEqual(records[1]["data"], "DEADBEEF01020304")

    def test_source_has_no_transmit_api(self):
        source = SOURCE.read_text(encoding="utf-8")
        forbidden_symbol = "VIMC_" + "SendMessage"
        self.assertNotIn(forbidden_symbol, source)

    def test_overlay_payload_is_target_compatible_and_receive_only(self):
        readelf = shutil.which("readelf")
        self.assertIsNotNone(readelf)
        self.assertTrue(PAYLOAD.is_file())
        self.assertFalse(PAYLOAD.is_symlink())
        result = subprocess.run(
            [readelf, "-h", "-l", "-d", "-V", "-Ws", str(PAYLOAD)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        self.assertIn("Machine:                           ARM", result)
        self.assertIn("/lib/ld-linux.so.3", result)
        for symbol in (
            "IPCAPI_MakeApiHandle",
            "VIMC_Open",
            "VIMC_AddClient",
            "VIMC_DeleteClient",
            "VIMC_Close",
        ):
            self.assertIn(symbol, result)
        self.assertNotIn("VIMC_" + "SendMessage", result)
        versions = {
            tuple(map(int, match))
            for match in re.findall(r"GLIBC_(\d+)\.(\d+)", result)
        }
        self.assertTrue(versions)
        self.assertLessEqual(max(versions), (2, 11))


if __name__ == "__main__":
    unittest.main()
