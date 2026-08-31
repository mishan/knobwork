#!/usr/bin/env python3
"""Off-target transaction tests for the v74 reversible overlay manager."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile


REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_USB = REPO_ROOT / "overlay" / "usb"
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
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


class OverlayReplica:
    """A disposable replica of the CMU paths and safety controls."""

    def __init__(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="cmu-overlay-test-")
        self.base = Path(self.temp.name)
        self.root = self.base / "root"
        self.usb = self.base / "usb"
        self.data = self.root / "data" / "cmu-overlay"
        self.mount_state = self.base / "mount-state"
        self.watchdog = self.root / "sys/class/gpio/Watchdog Disable/value"
        self.usb_log = self.base / "usb-journal.log"
        self.guard = self.base / "guard"
        shutil.copytree(SOURCE_USB, self.usb)
        (self.root / "jci/scripts").mkdir(parents=True)
        for path, content in zip(self.stage_targets, (STOCK_STAGE_1, STOCK_STAGE_3)):
            path.write_text(content, encoding="ascii")
            path.chmod(0o775)
        self.watchdog.parent.mkdir(parents=True)
        self.watchdog.write_text("0\n", encoding="ascii")
        self.mount_state.write_text("ro\n", encoding="ascii")
        self.version_file = self.root / "jci/version.ini"
        self.version_file.write_text(VERSION_TEXT, encoding="ascii")
        self.repin()

    def close(self) -> None:
        self.temp.cleanup()

    def repin(self) -> None:
        manifest = self.usb / "manifest.v1"
        lines = manifest.read_text(encoding="ascii").splitlines()
        lines = [
            f"firmware_sha256|{sha256(self.version_file)}"
            if line.startswith("firmware_sha256|")
            else line
            for line in lines
        ]
        manifest.write_text("\n".join(lines) + "\n", encoding="ascii")
        entry = self.usb / "install-patches.sh"
        entry_text = entry.read_text(encoding="ascii")
        start = 'OVERLAY_MANIFEST_SHA256="'
        before, remainder = entry_text.split(start, 1)
        _, after = remainder.split('"', 1)
        entry.write_text(
            before + start + sha256(manifest) + '"' + after,
            encoding="ascii",
        )

    def run(
        self,
        action: str | None,
        *,
        fail_point: str | None = None,
        runtime: bool = False,
        hash_tool: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update(
            {
                "MZD_OVERLAY_TEST_MODE": "1",
                "MZD_OVERLAY_ROOT_PREFIX": str(self.root),
                "MZD_OVERLAY_DATA_DIR": str(self.data),
                "MZD_OVERLAY_USB_LOG": str(self.usb_log),
                "MZD_OVERLAY_MOUNT_STATE_FILE": str(self.mount_state),
                "MZD_OVERLAY_GUARD_DIR": str(self.guard),
            }
        )
        if runtime:
            env.pop("MZD_OVERLAY_USB_LOG", None)
        if fail_point:
            env["MZD_OVERLAY_FAIL_POINT"] = fail_point
        if hash_tool:
            env["MZD_OVERLAY_TEST_HASH_TOOL"] = hash_tool
        entry = self.usb / "install-patches.sh"
        if runtime:
            runtime_id = (self.data / "runtime-current").read_text().strip()
            entry = self.data / "runtime" / runtime_id / "install-patches.sh"
        command = ["sh", str(entry)]
        if action is not None:
            command.append(action)
        return subprocess.run(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            check=False,
        )

    def run_boot_hook(self, action: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update(
            {
                "MZD_OVERLAY_TEST_MODE": "1",
                "MZD_OVERLAY_ROOT_PREFIX": str(self.root),
                "MZD_OVERLAY_DATA_DIR": str(self.data),
                "MZD_OVERLAY_MOUNT_STATE_FILE": str(self.mount_state),
                "MZD_OVERLAY_GUARD_DIR": str(self.guard),
            }
        )
        return subprocess.run(
            ["sh", str(self.boot_hook), action],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            check=False,
        )

    def add_nvram_entry(self, key: str, stock: str, payload: str) -> Path:
        nvram_dir = self.root / "sys/class/nvram/nv-config"
        (nvram_dir / "keys").mkdir(parents=True, exist_ok=True)
        (nvram_dir / "add").write_text("", encoding="ascii")
        (nvram_dir / "commit").write_text("", encoding="ascii")
        key_file = nvram_dir / "keys" / key
        key_file.write_text(stock + "\n", encoding="ascii")
        stock_hash = hashlib.sha256((stock + "\n").encode("ascii")).hexdigest()
        payload_hash = hashlib.sha256((payload + "\n").encode("ascii")).hexdigest()
        manifest = self.usb / "manifest.v1"
        with manifest.open("a", encoding="ascii") as output:
            output.write(
                f"nvram|{key}|{stock_hash}|{stock}|{payload_hash}|{payload}\n"
            )
        self.repin()
        return key_file

    @property
    def targets(self) -> tuple[Path, Path]:
        scripts = self.root / "jci/scripts"
        return (
            scripts / "cmu-overlay-diagnostic.sh",
            scripts / "cmu-overlay-diagnostic.conf",
        )

    @property
    def stage_targets(self) -> tuple[Path, Path]:
        scripts = self.root / "jci/scripts"
        return scripts / "stage_1.sh", scripts / "stage_3.sh"

    @property
    def boot_hook(self) -> Path:
        return self.root / "jci/scripts/cmu-overlay-boot-hook.sh"

    def assert_stock_boot_files(self, case: unittest.TestCase) -> None:
        stage_1, stage_3 = self.stage_targets
        case.assertEqual(stage_1.read_text(encoding="ascii"), STOCK_STAGE_1)
        case.assertEqual(stage_3.read_text(encoding="ascii"), STOCK_STAGE_3)
        case.assertEqual(stage_1.stat().st_mode & 0o777, 0o775)
        case.assertEqual(stage_3.stat().st_mode & 0o777, 0o775)
        case.assertFalse(self.boot_hook.exists())

    def assert_safe(self, case: unittest.TestCase) -> None:
        case.assertEqual(self.mount_state.read_text(encoding="ascii"), "ro\n")
        case.assertEqual(self.watchdog.read_text(encoding="ascii"), "0\n")


class OverlayManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.replica = OverlayReplica()

    def tearDown(self) -> None:
        self.replica.close()

    def assert_ok(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_failed(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_install_verify_disable_repair_and_restore(self) -> None:
        self.assert_ok(self.replica.run("verify"))
        self.assert_ok(self.replica.run("install"))
        self.assertIn("boot-hook.sh attempt", self.replica.stage_targets[0].read_text())
        self.assertIn("boot-hook.sh success", self.replica.stage_targets[1].read_text())
        self.assertTrue(self.replica.boot_hook.is_file())
        for target in self.replica.stage_targets:
            mode_backup = (
                self.replica.data / "backups/files" / target.relative_to(self.replica.root)
            ).with_suffix(target.suffix + ".mode")
            self.assertEqual(mode_backup.read_text().strip(), "775")
            self.assertEqual(mode_backup.stat().st_mode & 0o222, 0)
        for target in self.replica.targets:
            self.assertTrue(target.is_file())
            marker = self.replica.data / "backups/files" / target.relative_to(self.replica.root)
            self.assertTrue(Path(str(marker) + ".absent").is_file())
        self.assertEqual((self.replica.data / "state").read_text().strip(), "enabled")
        runtime_id = (self.replica.data / "runtime-current").read_text().strip()
        self.assertTrue(
            (self.replica.data / "runtime" / runtime_id / "install-patches.sh").is_file()
        )
        self.assert_ok(self.replica.run("verify"))

        self.assert_ok(self.replica.run("disable"))
        self.assertTrue(all(not target.exists() for target in self.replica.targets))
        self.replica.assert_stock_boot_files(self)
        self.assertEqual((self.replica.data / "state").read_text().strip(), "factory")
        self.assert_ok(self.replica.run("verify"))

        self.assert_ok(self.replica.run("repair"))
        self.assertTrue(all(target.is_file() for target in self.replica.targets))
        self.assert_ok(self.replica.run("restore"))
        self.assertTrue(all(not target.exists() for target in self.replica.targets))
        self.replica.assert_stock_boot_files(self)
        self.assertEqual((self.replica.data / "state").read_text().strip(), "restored")
        self.replica.assert_safe(self)

        data_log = (self.replica.data / "journal.log").read_text(encoding="utf-8")
        self.assertEqual(data_log, self.replica.usb_log.read_text(encoding="utf-8"))
        self.assertIn("transaction=committed", data_log)

    def test_no_argument_launcher_uses_state_aware_action(self) -> None:
        self.assert_ok(self.replica.run(None))
        self.assertTrue(all(target.exists() for target in self.replica.targets))
        env_action = os.environ.get("MZD_OVERLAY_TEST_ACTION")
        os.environ["MZD_OVERLAY_TEST_ACTION"] = "disable"
        try:
            self.assert_ok(self.replica.run(None))
        finally:
            if env_action is None:
                os.environ.pop("MZD_OVERLAY_TEST_ACTION", None)
            else:
                os.environ["MZD_OVERLAY_TEST_ACTION"] = env_action
        self.assertTrue(all(not target.exists() for target in self.replica.targets))

    def test_exact_firmware_metadata_is_required_before_mutation(self) -> None:
        self.replica.version_file.write_text(VERSION_TEXT.replace("74.00.324", "74.00.331"))
        result = self.replica.run("install")
        self.assert_failed(result)
        self.assertTrue(all(not target.exists() for target in self.replica.targets))
        self.replica.assert_safe(self)

    def test_openssl_hash_backend_matches_stock_cmu_capability(self) -> None:
        self.assert_ok(self.replica.run("install", hash_tool="openssl"))
        self.assert_ok(self.replica.run("verify", hash_tool="openssl"))
        self.assertTrue(all(target.exists() for target in self.replica.targets))

    def test_manifest_pin_rejects_tampering(self) -> None:
        manifest = self.replica.usb / "manifest.v1"
        manifest.write_text(manifest.read_text() + "\n")
        result = self.replica.run("install")
        self.assert_failed(result)
        self.assertIn("manifest_pin_mismatch", result.stdout)
        self.assertTrue(all(not target.exists() for target in self.replica.targets))

    def test_install_rejects_partial_known_state(self) -> None:
        first, second = self.replica.targets
        shutil.copy2(
            self.replica.usb / "payloads/diagnostic/cmu-overlay-diagnostic.sh",
            first,
        )
        result = self.replica.run("install")
        self.assert_failed(result)
        self.assertTrue(first.exists())
        self.assertFalse(second.exists())
        self.replica.assert_safe(self)

    def test_repair_accepts_only_known_partial_state(self) -> None:
        self.assert_ok(self.replica.run("install"))
        self.replica.targets[1].unlink()
        self.assert_ok(self.replica.run("repair"))
        self.assertTrue(all(target.is_file() for target in self.replica.targets))

        self.replica.targets[0].write_text("unexpected local edit\n")
        result = self.replica.run("repair")
        self.assert_failed(result)
        self.assertEqual(self.replica.targets[0].read_text(), "unexpected local edit\n")
        self.replica.assert_safe(self)

    def test_verify_checks_payload_mode_and_repair_corrects_it(self) -> None:
        self.assert_ok(self.replica.run("install"))
        self.replica.targets[0].chmod(0o644)
        self.assert_failed(self.replica.run("verify"))
        self.assert_ok(self.replica.run("repair"))
        self.assertEqual(self.replica.targets[0].stat().st_mode & 0o777, 0o755)

    def test_failure_rolls_back_in_reverse_and_restores_safety_state(self) -> None:
        result = self.replica.run("install", fail_point="replace:2")
        self.assert_failed(result)
        self.assertTrue(all(not target.exists() for target in self.replica.targets))
        self.assertFalse((self.replica.data / "state").exists())
        self.assertIn("transaction=rollback count=2", result.stdout)
        self.replica.assert_safe(self)

    def test_nvram_writes_backup_restore_and_propagate_failure(self) -> None:
        key_file = self.replica.add_nvram_entry(
            "diagnostic_overlay_state", "factory", "enabled"
        )
        failed = self.replica.run(
            "install", fail_point="nvram:diagnostic_overlay_state"
        )
        self.assert_failed(failed)
        self.assertEqual(key_file.read_text(), "factory\n")
        self.assertTrue(all(not target.exists() for target in self.replica.targets))
        self.replica.assert_safe(self)

        self.assert_ok(self.replica.run("install"))
        self.assertEqual(key_file.read_text(), "enabled\n")
        backup = self.replica.data / "backups/nvram/diagnostic_overlay_state"
        self.assertEqual(backup.read_text(), "factory\n")
        self.assertEqual(backup.stat().st_mode & 0o222, 0)
        self.assert_ok(self.replica.run("restore"))
        self.assertEqual(key_file.read_text(), "factory\n")

    def test_final_verification_failure_rolls_back(self) -> None:
        result = self.replica.run("install", fail_point="final-verify")
        self.assert_failed(result)
        self.assertTrue(all(not target.exists() for target in self.replica.targets))
        self.assertFalse((self.replica.data / "state").exists())
        self.replica.assert_safe(self)

    def test_boot_counter_enters_safe_mode_at_manifest_limit(self) -> None:
        self.assert_ok(self.replica.run("install"))
        self.assert_ok(self.replica.run("boot-attempt", runtime=True))
        self.assert_ok(self.replica.run("boot-attempt", runtime=True))
        self.assertTrue(all(target.exists() for target in self.replica.targets))
        self.assert_ok(self.replica.run("boot-attempt", runtime=True))
        self.assertTrue(all(not target.exists() for target in self.replica.targets))
        self.assertEqual((self.replica.data / "state").read_text().strip(), "safe-mode")
        self.assertEqual((self.replica.data / "boot-attempts").read_text().strip(), "0")
        self.assertIn(
            "safe_mode=restored",
            (self.replica.data / "runtime-journal.log").read_text(),
        )
        self.replica.assert_safe(self)

    def test_installed_boot_hook_acknowledges_or_rolls_back_startup(self) -> None:
        self.assert_ok(self.replica.run("install"))

        self.assert_ok(self.replica.run_boot_hook("attempt"))
        self.assertEqual((self.replica.data / "boot-attempts").read_text().strip(), "1")
        self.assert_ok(self.replica.run_boot_hook("success"))
        self.assertEqual((self.replica.data / "boot-attempts").read_text().strip(), "0")

        self.assert_ok(self.replica.run_boot_hook("attempt"))
        self.assert_ok(self.replica.run_boot_hook("attempt"))
        self.assert_ok(self.replica.run_boot_hook("attempt"))
        self.assertEqual((self.replica.data / "state").read_text().strip(), "safe-mode")
        self.assertTrue(all(not target.exists() for target in self.replica.targets))
        self.replica.assert_stock_boot_files(self)
        self.assertIn(
            "action=boot-attempt|result=ok",
            (self.replica.data / "boot-hook-status").read_text(),
        )
        self.replica.assert_safe(self)

    def test_boot_hook_fails_open_when_runtime_pointer_is_invalid(self) -> None:
        self.assert_ok(self.replica.run("install"))
        (self.replica.data / "runtime-current").write_text("../invalid\n")

        result = self.replica.run_boot_hook("attempt")

        self.assert_ok(result)
        self.assertEqual((self.replica.data / "boot-attempts").read_text().strip(), "0")
        self.assertIn(
            "action=boot-attempt|result=skipped|reason=runtime-id-length",
            (self.replica.data / "boot-hook-status").read_text(),
        )
        self.assertTrue(all(target.exists() for target in self.replica.targets))

    def test_boot_success_resets_counter(self) -> None:
        self.assert_ok(self.replica.run("install"))
        self.assert_ok(self.replica.run("boot-attempt"))
        self.assert_ok(self.replica.run("boot-success"))
        self.assertEqual((self.replica.data / "boot-attempts").read_text().strip(), "0")

    def test_cleanup_failure_is_propagated(self) -> None:
        result = self.replica.run("install", fail_point="watchdog-restore")
        self.assert_failed(result)
        self.assertEqual(self.replica.mount_state.read_text(), "ro\n")
        self.assertIn("failed", result.stdout)

    def test_root_remount_failures_are_propagated(self) -> None:
        enter = self.replica.run("install", fail_point="remount-rw")
        self.assert_failed(enter)
        self.assertTrue(all(not target.exists() for target in self.replica.targets))
        self.replica.assert_safe(self)

        leave = self.replica.run("install", fail_point="remount-ro")
        self.assert_failed(leave)
        self.assertEqual(self.replica.mount_state.read_text(), "rw\n")
        self.assertEqual(self.replica.watchdog.read_text(), "0\n")
        self.assertTrue(all(target.exists() for target in self.replica.targets))

    def test_initial_read_write_mount_state_is_preserved(self) -> None:
        self.replica.mount_state.write_text("rw\n")
        self.assert_ok(self.replica.run("install"))
        self.assertEqual(self.replica.mount_state.read_text(), "rw\n")
        self.assertEqual(self.replica.watchdog.read_text(), "0\n")

    def test_javascript_syntax_failure_happens_before_remount(self) -> None:
        payload = self.replica.usb / "payloads/diagnostic/cmu-overlay-diagnostic.conf"
        payload.write_text("function broken( {\n", encoding="ascii")
        manifest = self.replica.usb / "manifest.v1"
        text = manifest.read_text(encoding="ascii")
        old_line = next(line for line in text.splitlines() if line.endswith("|0644|data"))
        fields = old_line.split("|")
        fields[4] = sha256(payload)
        fields[6] = "js"
        manifest.write_text(text.replace(old_line, "|".join(fields)), encoding="ascii")
        self.replica.repin()

        result = self.replica.run("install")
        self.assert_failed(result)
        self.assertTrue(all(not target.exists() for target in self.replica.targets))
        self.replica.assert_safe(self)

    def test_usb_builder_validates_and_creates_command_launcher(self) -> None:
        check = subprocess.run(
            ["python3", str(REPO_ROOT / "overlay/prepare_usb.py"), "--check"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assert_ok(check)
        destination = self.replica.base / "prepared-usb"
        build = subprocess.run(
            ["python3", str(REPO_ROOT / "overlay/prepare_usb.py"), str(destination)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assert_ok(build)
        launchers = list(destination.glob("*.up"))
        self.assertEqual(len(launchers), 1)
        self.assertIn("install-patches.sh", launchers[0].name)
        with zipfile.ZipFile(launchers[0]) as archive:
            self.assertEqual(
                set(archive.namelist()),
                {"main_instructions.ini", "versions.ini"},
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
