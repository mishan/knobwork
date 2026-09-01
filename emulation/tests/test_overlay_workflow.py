#!/usr/bin/env python3
"""End-to-end tests for the disposable overlay-manager emulator workflow."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from emulation.overlay_mode import (
    OverlayWorkflowError,
    initialize_workspace,
    reset_workspace,
    run_manager_action,
    workspace_status,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_BUNDLE = REPO_ROOT / "overlay" / "usb"
VERSION_TEXT = """[VersionInfo]
JCI_SW_PART_NUMBER="SWI10-26479-205R02"
JCI_SW_VER="MAZ_CMU-150_74.00.324"
JCI_SW_FLAVOR="cmu150_NA"
JCI_SW_VER_PATCH="A"
JCI_BUILD_START_TIME="Tue Aug 30 07:10:46 2022 GMT"
"""
STOCK_STAGE_1 = "#!/bin/sh\n\n"
STOCK_STAGE_3 = "#!/bin/sh\n"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class OverlayWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="cmu-overlay-workflow-test-")
        self.base = Path(self.temp.name)
        self.source = self.base / "source-root"
        self.bundle = self.base / "bundle"
        self.workspace = self.base / "workspace"
        scripts = self.source / "jci" / "scripts"
        scripts.mkdir(parents=True)
        (self.source / "jci/bin").mkdir()
        (self.source / "jci/gui/apps/system/js").mkdir(parents=True)
        (self.source / "jci/gui/apps/system/css").mkdir(parents=True)
        (self.source / "jci" / "mmui").mkdir()
        (self.source / "jci" / "version.ini").write_text(
            VERSION_TEXT, encoding="ascii"
        )
        (scripts / "stage_1.sh").write_text(STOCK_STAGE_1, encoding="ascii")
        (scripts / "stage_3.sh").write_text(STOCK_STAGE_3, encoding="ascii")
        (scripts / "stage_1.sh").chmod(0o775)
        (scripts / "stage_3.sh").chmod(0o775)
        shutil.copytree(SOURCE_BUNDLE, self.bundle)
        self.repin_bundle()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def repin_bundle(self) -> None:
        manifest = self.bundle / "manifest.v1"
        lines = [
            f"firmware_sha256|{sha256(self.source / 'jci/version.ini')}"
            if line.startswith("firmware_sha256|")
            else line
            for line in manifest.read_text(encoding="ascii").splitlines()
        ]
        manifest.write_text("\n".join(lines) + "\n", encoding="ascii")
        entry = self.bundle / "install-patches.sh"
        entry_text = entry.read_text(encoding="ascii")
        prefix = 'OVERLAY_MANIFEST_SHA256="'
        before, rest = entry_text.split(prefix, 1)
        _, after = rest.split('"', 1)
        entry.write_text(
            before + prefix + sha256(manifest) + '"' + after,
            encoding="ascii",
        )

    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(REPO_ROOT / "emulate.py"), "overlay", *arguments],
            cwd=REPO_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_cli_lifecycle_preserves_source_firmware(self) -> None:
        source_stage_hashes = {
            name: sha256(self.source / "jci/scripts" / name)
            for name in ("stage_1.sh", "stage_3.sh")
        }
        result = self.run_cli(
            "init",
            "--root",
            str(self.source),
            "--bundle",
            str(self.bundle),
            "--workspace",
            str(self.workspace),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.workspace / "root/data").is_symlink())
        self.assertEqual((self.workspace / "root/data").readlink(), Path("../data"))

        result = self.run_cli(
            "install",
            "--shell",
            "host",
            "--workspace",
            str(self.workspace),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        result = self.run_cli(
            "status", "--json", "--workspace", str(self.workspace)
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        status = json.loads(result.stdout)
        self.assertEqual(status["manager_state"], "enabled")
        self.assertEqual({item["state"] for item in status["targets"]}, {"payload"})
        self.assertTrue(
            (self.workspace / "data/integration/developer_mode_GuiConfig.js").is_file()
        )
        self.assertTrue(
            (
                self.workspace
                / "root/jci/gui/apps/system/js/developerdiagnosticsApp.js"
            ).is_file()
        )

        result = self.run_cli(
            "verify",
            "--runtime",
            "--shell",
            "host",
            "--workspace",
            str(self.workspace),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        result = self.run_cli(
            "disable",
            "--runtime",
            "--shell",
            "host",
            "--workspace",
            str(self.workspace),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(
            (self.workspace / "data/integration/developer_mode_GuiConfig.js").exists()
        )
        self.assertFalse(
            (
                self.workspace
                / "root/jci/gui/apps/system/js/developerdiagnosticsApp.js"
            ).exists()
        )

        for name, expected_hash in source_stage_hashes.items():
            self.assertEqual(sha256(self.source / "jci/scripts" / name), expected_hash)
        self.assertFalse(
            (self.source / "jci/scripts/cmu-overlay-boot-hook.sh").exists()
        )
        self.assertFalse(
            (self.source / "data/integration/developer_mode_GuiConfig.js").exists()
        )
        self.assertFalse(
            (
                self.source / "jci/gui/apps/system/js/developerdiagnosticsApp.js"
            ).exists()
        )

        result = self.run_cli("reset", "--workspace", str(self.workspace))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.workspace.exists())

    def test_interrupted_install_is_recovered_on_next_action(self) -> None:
        busybox = self.source / "bin" / "busybox"
        busybox.parent.mkdir()
        busybox.write_text("test fixture\n", encoding="ascii")
        fake_qemu = self.base / "qemu-arm"
        fake_qemu.write_text(
            '#!/bin/sh\nexec sh "$5" "$6"\n',
            encoding="ascii",
        )
        fake_qemu.chmod(0o755)
        initialize_workspace(self.workspace, self.source, self.bundle)
        with mock.patch(
            "emulation.overlay_mode.shutil.which", return_value=str(fake_qemu)
        ):
            interrupted = run_manager_action(
                self.workspace, "install", shell="stock", crash_point="mutation:2"
            )
        self.assertEqual(interrupted.returncode, 99)
        self.assertFalse((self.workspace / "emulated/manager.guard").exists())
        self.assertNotEqual(
            workspace_status(self.workspace)["active_transaction"], "none"
        )

        recovered = run_manager_action(self.workspace, "verify", shell="host")
        self.assertEqual(recovered.returncode, 0)
        status = workspace_status(self.workspace)
        self.assertEqual(status["active_transaction"], "none")
        self.assertEqual(status["manager_state"], "factory")
        self.assertEqual({item["state"] for item in status["targets"]}, {"stock"})

    def test_init_rejects_unsafe_manifest_target(self) -> None:
        manifest = self.bundle / "manifest.v1"
        text = manifest.read_text(encoding="ascii").replace(
            "file|/jci/scripts/stage_1.sh|", "file|/jci/../outside|", 1
        )
        manifest.write_text(text, encoding="ascii")
        entry = self.bundle / "install-patches.sh"
        entry_text = entry.read_text(encoding="ascii")
        entry.write_text(
            re.sub(
                r'(?m)^OVERLAY_MANIFEST_SHA256="[0-9a-f]{64}"$',
                f'OVERLAY_MANIFEST_SHA256="{sha256(manifest)}"',
                entry_text,
            ),
            encoding="ascii",
        )
        with self.assertRaisesRegex(OverlayWorkflowError, "unsafe target"):
            initialize_workspace(self.workspace, self.source, self.bundle)
        self.assertFalse(self.workspace.exists())

    def test_reset_requires_a_valid_workspace(self) -> None:
        self.workspace.mkdir()
        marker = self.workspace / "keep"
        marker.write_text("safe\n", encoding="ascii")
        with self.assertRaisesRegex(OverlayWorkflowError, "Not an overlay workspace"):
            reset_workspace(self.workspace)
        self.assertTrue(marker.is_file())


if __name__ == "__main__":
    unittest.main()
