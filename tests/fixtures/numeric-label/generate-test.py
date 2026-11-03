"""Check numeric label fixture publication and failure recovery."""

import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = Path(__file__).with_name("generate.py")
spec = importlib.util.spec_from_file_location("numeric_label_generate", SCRIPT)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PublicationTest(unittest.TestCase):
    def setUp(self):
        (ROOT / "target").mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="numeric-label-test-", dir=ROOT / "target")
        self.work = Path(self.directory.name)
        self.output = self.work / "output"

    def tearDown(self):
        key = hashlib.sha256(os.fsencode(self.output.resolve())).hexdigest()
        (ROOT / "target/.numeric-label-locks" / f"{key}.lock").unlink(missing_ok=True)
        self.directory.cleanup()

    def old_output(self):
        self.output.mkdir()
        (self.output / builder.MARKER).write_text(builder.MARKER_CONTENT)
        for name in builder.NAMES:
            (self.output / name).write_bytes(("old:" + name).encode())
        return self.contents()

    def contents(self):
        return {path.name: path.read_bytes() for path in self.output.iterdir()}

    def execute(self, run):
        with patch.object(sys, "argv", [str(SCRIPT), "--output", str(self.output)]), patch.object(builder, "run", side_effect=run):
            builder.main()

    @staticmethod
    def valid_build(command, *, source=None, lock_fd):
        if command[1] == "parse":
            Path(command[command.index("-o") + 1]).write_bytes(b"new fixture")

    def test_shared_core_template_resolves_every_marker(self):
        sources = builder.inputs()
        self.assertEqual({name + ".wasm" for name in sources}, builder.NAMES)
        for name, source in sources.items():
            self.assertNotRegex(source, r"@[A-Z_]+@", name)
        core = sources["core-missing-create"]
        self.assertIn('i32.const 52 call $trace )', core)
        self.assertIn('i32.const 53 call $trace  i32.const 0)', core)
        template = (ROOT / "validator/lvgl-label-negative-core.wat").read_text()
        with self.assertRaisesRegex(ValueError, "marker inventory"):
            builder.render_core(template + " @NEW_MARKER@")
        with self.assertRaisesRegex(ValueError, "marker inventory"):
            builder.render_core(template, {"NEW_MARKER": ""})

    def test_unowned_directory_and_same_named_user_file_are_preserved(self):
        self.output.mkdir()
        path = self.output / "core-bad-display.wasm"
        path.write_bytes(b"user data")
        with self.assertRaisesRegex(ValueError, "not owned"):
            self.execute(self.valid_build)
        self.assertEqual(path.read_bytes(), b"user data")
        self.assertEqual(list(self.output.iterdir()), [path])

    def test_empty_unowned_directory_is_not_adopted(self):
        self.output.mkdir()
        with self.assertRaisesRegex(ValueError, "not owned"):
            self.execute(self.valid_build)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_outside_target_and_symlink_output_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="numeric-label-external-") as external:
            path = Path(external) / "output"
            path.mkdir()
            (path / "core-bad-display.wasm").write_bytes(b"outside")
            with patch.object(sys, "argv", [str(SCRIPT), "--output", str(path)]):
                with self.assertRaises(SystemExit):
                    builder.main()
            self.assertEqual((path / "core-bad-display.wasm").read_bytes(), b"outside")
            self.output.symlink_to(path, target_is_directory=True)
            with self.assertRaises(SystemExit):
                self.execute(self.valid_build)
            self.assertEqual((path / "core-bad-display.wasm").read_bytes(), b"outside")

    def test_compile_and_validation_failures_preserve_previous_output(self):
        before = self.old_output()
        for failing in ("parse", "validate"):
            def fail(command, *, source=None, lock_fd):
                if command[1] == failing:
                    raise subprocess.CalledProcessError(42, command)
                self.valid_build(command, source=source, lock_fd=lock_fd)
            with self.assertRaises(subprocess.CalledProcessError):
                self.execute(fail)
            self.assertEqual(self.contents(), before)

    def test_publication_failure_restores_previous_output(self):
        before = self.old_output()
        replace = os.replace
        def inject(source, destination):
            if Path(source).name == "published":
                raise OSError("publication failure")
            return replace(source, destination)
        with patch.object(builder.os, "replace", side_effect=inject):
            with self.assertRaisesRegex(OSError, "publication failure"):
                self.execute(self.valid_build)
        self.assertEqual(self.contents(), before)

    def test_unknown_backup_is_never_overwritten(self):
        before = self.old_output()
        staged, backup = self.work / "staged", self.work / "backup"
        staged.mkdir(); backup.mkdir()
        (backup / "user").write_bytes(b"keep")
        with self.assertRaisesRegex(ValueError, "backup path already exists"):
            builder.publish_output(self.output, staged, backup)
        self.assertEqual(self.contents(), before)
        self.assertEqual((backup / "user").read_bytes(), b"keep")

    def test_failed_rollback_keeps_previous_output_in_staging(self):
        before = self.old_output()
        replace = os.replace
        def inject(source, destination):
            if Path(source).name in ("published", "previous"):
                raise OSError("publication or rollback failure")
            return replace(source, destination)
        with patch.object(builder.os, "replace", side_effect=inject):
            with self.assertRaisesRegex(RuntimeError, "previous output remains"):
                self.execute(self.valid_build)
        self.assertFalse(self.output.exists())
        backups = list(self.work.glob(".numeric-label-build-*/previous"))
        self.assertEqual(len(backups), 1)
        self.assertEqual({item.name: item.read_bytes() for item in backups[0].iterdir()}, before)

    def test_competing_writer_is_rejected(self):
        before = self.old_output()
        lock_dir = ROOT / "target/.numeric-label-locks"
        lock_dir.mkdir(exist_ok=True)
        key = hashlib.sha256(os.fsencode(self.output.resolve())).hexdigest()
        with (lock_dir / f"{key}.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, "already being built"):
                self.execute(self.valid_build)
        self.assertEqual(self.contents(), before)

    def test_success_replaces_only_owned_output_and_cleans_staging(self):
        self.old_output()
        self.execute(self.valid_build)
        self.assertEqual(set(self.contents()), builder.NAMES | {builder.MARKER})
        for name in builder.NAMES:
            self.assertEqual((self.output / name).read_bytes(), b"new fixture")
        self.assertEqual(list(self.work.iterdir()), [self.output])


if __name__ == "__main__":
    unittest.main()
