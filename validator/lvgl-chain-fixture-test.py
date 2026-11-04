"""Check ownership and publication boundaries for the C chain fixtures."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("lvgl_chain_fixture", ROOT / "validator/lvgl-chain-fixture.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class ChainPublication(unittest.TestCase):
    def setUp(self):
        fixture.TARGET.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="lvw-chain-test-", dir=fixture.TARGET)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.ndk = self.root / "ndk"
        self.ndk.mkdir()
        (self.ndk / "include/lvgl/config").mkdir(parents=True)
        (self.ndk / "include/lvgl/lvgl.h").write_text("fixture")
        self.sdk = self.root / "sdk"
        self.sdk.mkdir()
        self.output = self.root / "output"

    def run_build(self, run, *, link=None):
        with patch.object(fixture.subprocess, "check_output", return_value=str(self.sdk)), \
                patch.object(fixture.subprocess, "run", side_effect=run):
            if link is None:
                fixture.build(self.ndk, self.output)
            else:
                with patch.object(fixture.os, "link", side_effect=link):
                    fixture.build(self.ndk, self.output)

    @staticmethod
    def successful(command, **_kwargs):
        if "-o" in command:
            Path(command[command.index("-o") + 1]).write_bytes(b"controlled wasm")

    def test_existing_output_is_preserved(self):
        self.output.mkdir()
        keep = self.output / "keep"
        keep.write_bytes(b"user data")
        with self.assertRaisesRegex(ValueError, "already exists"):
            fixture.build(self.ndk, self.output)
        self.assertEqual(keep.read_bytes(), b"user data")
        self.assertEqual({path.name for path in self.output.iterdir()}, {"keep"})

    def test_ndk_overlap_is_rejected_before_writing(self):
        with self.assertRaisesRegex(ValueError, "must not overlap"):
            fixture.build(self.ndk, self.ndk / "output")
        self.assertFalse((self.ndk / "output").exists())

    def test_failed_compiler_or_validator_publishes_nothing(self):
        for failing in ("clang", "validate"):
            with self.subTest(failing=failing):
                def run(command, **kwargs):
                    if (failing == "clang" and "-o" in command) or (failing == "validate" and "validate" in command):
                        raise subprocess.CalledProcessError(1, command)
                    self.successful(command, **kwargs)
                with self.assertRaises(subprocess.CalledProcessError):
                    self.run_build(run)
                self.assertFalse(self.output.exists())

    def test_competing_builds_publish_exactly_one_complete_set(self):
        barrier = threading.Barrier(2)
        state = threading.local()
        results = []
        def run(command, **kwargs):
            if "-o" in command and not getattr(state, "waited", False):
                state.waited = True
                barrier.wait(timeout=10)
            self.successful(command, **kwargs)
        def worker():
            try:
                fixture.build(self.ndk, self.output)
                results.append("ok")
            except (FileExistsError, ValueError):
                results.append("exists")
        with patch.object(fixture.subprocess, "check_output", return_value=str(self.sdk)), \
                patch.object(fixture.subprocess, "run", side_effect=run):
            threads = [threading.Thread(target=worker) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=15)
            self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertCountEqual(results, ["ok", "exists"])
        manifest = json.loads((self.output / fixture.MARKER).read_bytes())
        self.assertEqual(set(manifest["files"]), set(fixture.FILES))
        for name, digest in manifest["files"].items():
            self.assertEqual(hashlib.sha256((self.output / name).read_bytes()).hexdigest(), digest)

    def test_missing_marker_is_never_a_completed_publication(self):
        original = os.link
        def link(source, destination, **kwargs):
            if destination == fixture.MARKER:
                raise OSError("injected marker failure")
            return original(source, destination, **kwargs)
        with self.assertRaisesRegex(OSError, "injected marker failure"):
            self.run_build(self.successful, link=link)
        self.assertFalse((self.output / fixture.MARKER).exists())
        self.assertEqual({path.name for path in self.output.iterdir()}, set(fixture.FILES))
        with self.assertRaisesRegex(ValueError, "already exists"):
            fixture.build(self.ndk, self.output)

    def test_replaced_output_is_not_modified_or_deleted(self):
        original = os.link
        displaced = self.root / "displaced"
        def link(source, destination, **kwargs):
            if destination == "middle.wasm":
                self.output.rename(displaced)
                self.output.mkdir()
                (self.output / "keep").write_bytes(b"external data")
            return original(source, destination, **kwargs)
        with self.assertRaisesRegex(ValueError, "directory changed"):
            self.run_build(self.successful, link=link)
        self.assertEqual({path.name for path in self.output.iterdir()}, {"keep"})
        self.assertEqual((self.output / "keep").read_bytes(), b"external data")
        self.assertFalse((displaced / fixture.MARKER).exists())

    @unittest.skipUnless(shutil.which("bun"), "Bun is required for graph generation")
    def test_graph_rejects_uncommitted_fixtures_and_existing_output(self):
        fixtures = self.root / "incomplete"
        fixtures.mkdir()
        (fixtures / "middle.wasm").write_bytes(b"uncommitted")
        inputs = [self.root / name for name in ("core.wasm", "api.json", "proof.json")]
        for path in inputs:
            path.write_bytes(b"unused")
        output = self.root / "graph.json"
        command = ["bun", str(ROOT / "tests/fixtures/numeric-chain/generate.ts"),
                   "--fixtures", str(fixtures), "--core", str(inputs[0]), "--api", str(inputs[1]),
                   "--proof", str(inputs[2]), "--output", str(output)]
        result = subprocess.run(command, cwd=self.root, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("manifest.json", result.stderr)
        self.assertFalse(output.exists())
        output.write_bytes(b"user data")
        result = subprocess.run(command, cwd=self.root, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("output already exists", result.stderr)
        self.assertEqual(output.read_bytes(), b"user data")

    @unittest.skipUnless(shutil.which("bun"), "Bun is required for graph generation")
    def test_graph_rejects_changed_fixture_bytes(self):
        fixtures = self.root / "fixtures"
        fixtures.mkdir()
        digest = hashlib.sha256(b"fixture").hexdigest()
        for name in fixture.FILES:
            (fixtures / name).write_bytes(b"fixture")
        (fixtures / fixture.MARKER).write_text(json.dumps({"schema_version": 1, "kind": "lvgl-chain-fixtures",
                                                          "files": {name: digest for name in fixture.FILES}}))
        (fixtures / "app.wasm").write_bytes(b"changed")
        inputs = [self.root / name for name in ("core.wasm", "api.json", "proof.json")]
        for path in inputs:
            path.write_bytes(b"unused")
        output = self.root / "graph.json"
        result = subprocess.run(["bun", str(ROOT / "tests/fixtures/numeric-chain/generate.ts"),
                                 "--fixtures", str(fixtures), "--core", str(inputs[0]),
                                 "--api", str(inputs[1]), "--proof", str(inputs[2]), "--output", str(output)],
                                cwd=ROOT, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("chain fixture identity mismatch: app.wasm", result.stderr)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
