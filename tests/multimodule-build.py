"""Check multi-module example publication and failure recovery."""

import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "examples/c/multimodule/build.py"
spec = importlib.util.spec_from_file_location("multimodule_build", SCRIPT)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ExamplePublicationTest(unittest.TestCase):
    def setUp(self):
        (ROOT / "target").mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="multimodule-test-", dir=ROOT / "target")
        self.work = Path(self.temporary.name)
        self.output = self.work / "output"
        self.output.mkdir()
        (self.output / builder.MARKER).write_text(builder.MARKER_CONTENT)
        (self.output / "lv_provider.wasm").write_bytes(b"old provider")
        (self.output / "lv_app.wasm").write_bytes(b"old app")

    def tearDown(self):
        self.temporary.cleanup()

    def old_contents(self):
        return {path.name: path.read_bytes() for path in self.output.iterdir()}

    def test_invalid_ndk_preserves_previous_outputs(self):
        before = self.old_contents()
        result = subprocess.run([sys.executable, "-B", SCRIPT, "--ndk", self.work / "missing", "--output", self.output], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.old_contents(), before)

    def test_failed_compile_preserves_previous_outputs(self):
        before = self.old_contents()
        tools = self.work / "tools"
        tools.mkdir()
        cmake = tools / "cmake"
        cmake.write_text("#!/bin/sh\nexit 42\n")
        cmake.chmod(0o755)
        ndk = self.work / "ndk"
        ndk.mkdir()
        env = {**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"]}
        result = subprocess.run([sys.executable, "-B", SCRIPT, "--ndk", ndk, "--output", self.output], env=env, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"exit status 42", result.stderr)
        self.assertEqual(self.old_contents(), before)

    def test_ndk_and_output_cannot_overlap(self):
        before = self.old_contents()
        result = subprocess.run([sys.executable, "-B", SCRIPT, "--ndk", self.work, "--output", self.output], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"overlap", result.stderr)
        self.assertEqual(self.old_contents(), before)
        parent = self.work / "parent"
        ndk = parent / "ndk"
        ndk.mkdir(parents=True)
        (ndk / "input").write_bytes(b"keep")
        result = subprocess.run([sys.executable, "-B", SCRIPT, "--ndk", ndk, "--output", parent], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"overlap", result.stderr)
        alias = self.work / "ndk-link"
        alias.symlink_to(ndk, target_is_directory=True)
        result = subprocess.run([sys.executable, "-B", SCRIPT, "--ndk", ndk, "--output", alias / "generated"], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"overlap", result.stderr)
        self.assertEqual((ndk / "input").read_bytes(), b"keep")
        self.assertFalse((ndk / "generated").exists())

    def test_unknown_output_contents_are_not_removed(self):
        (self.output / "unrelated").write_bytes(b"keep")
        before = self.old_contents()
        with self.assertRaisesRegex(ValueError, "not owned"):
            builder.check_output(self.output)
        self.assertEqual(self.old_contents(), before)

    def test_publication_failure_restores_previous_output(self):
        before = self.old_contents()
        publish, backup = self.work / "candidate", self.work / "backup"
        publish.mkdir()
        (publish / "value").write_bytes(b"new")
        replace = os.replace
        def inject(source, destination):
            if Path(source) == publish:
                raise OSError("publication failure")
            return replace(source, destination)
        with patch.object(builder.os, "replace", side_effect=inject):
            with self.assertRaisesRegex(OSError, "publication failure"):
                builder.publish_output(self.output, publish, backup)
        self.assertEqual(self.old_contents(), before)
        self.assertFalse(backup.exists())

    def test_cleanup_failure_reports_published_result(self):
        ndk = self.work / "ndk"
        ndk.mkdir()
        def execute(command):
            if command[:2] == ["cmake", "--build"]:
                build = Path(command[2])
                build.mkdir(parents=True, exist_ok=True)
                (build / "lv_provider.wasm").write_bytes(b"new provider")
            elif "-o" in command:
                Path(command[command.index("-o") + 1]).write_bytes(b"new app")
        stderr = io.StringIO()
        with patch.object(sys, "argv", [str(SCRIPT), "--ndk", str(ndk), "--output", str(self.output)]), \
             patch.object(builder.subprocess, "check_output", return_value="/sdk\n"), \
             patch.object(builder.shutil, "which", return_value="/wasm-tools"), \
             patch.object(builder, "run", side_effect=execute), \
             patch.object(builder.shutil, "rmtree", side_effect=OSError("cleanup failure")), \
             patch.object(sys, "stderr", stderr):
            builder.main()
        self.assertEqual((self.output / "lv_provider.wasm").read_bytes(), b"new provider")
        self.assertEqual((self.output / "lv_app.wasm").read_bytes(), b"new app")
        self.assertIn("could not remove temporary directory", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
