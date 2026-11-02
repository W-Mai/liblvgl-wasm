"""Tests for validator build snapshots and generated data."""

import base64
import fcntl
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load("validator_build_data", ROOT / "validator/build-data.py")
generator = load("validator_generate_data", ROOT / "validator/generate-data.py")


def leb(value):
    result = []
    while True:
        byte = value & 0x7f
        value >>= 7
        result.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(result)


def section(identifier, payload):
    return bytes([identifier]) + leb(len(payload)) + payload


def name(value):
    encoded = value.encode()
    return leb(len(encoded)) + encoded


def helper_fixture():
    types = bytes([3, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 0, 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 1, 0x7f])
    functions = bytes([8, 0, 0, 1, 1, 1, 0, 2, 0])
    memory = bytes([1, 1, 32]) + leb(4096)
    exports = (bytes([9]) + name("memory") + bytes([2, 0])
               + name("lvw_reserve") + bytes([0, 0])
               + name("lvw_validate") + bytes([0, 1])
               + name("lvw_release") + bytes([0, 2])
               + name("lvw_policy_version") + bytes([0, 3])
               + name("lvw_feature_count") + bytes([0, 4])
               + name("lvw_feature_name_length") + bytes([0, 5])
               + name("lvw_feature_name_byte") + bytes([0, 6])
               + name("lvw_feature_mask") + bytes([0, 7]))
    argument = bytes([4, 0, 0x20, 0, 0x0b])
    constant = bytes([4, 0, 0x41, 0, 0x0b])
    bodies = bytes([8]) + argument * 2 + constant * 3 + argument * 3
    return b"\0asm\x01\0\0\0" + b"".join(section(identifier, payload) for identifier, payload in ((1, types), (3, functions), (5, memory), (7, exports), (10, bodies)))


class ValidatorDataTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lvw-build-data-test-")
        self.root = Path(self.temporary.name)
        self.source = self.root / "validator"
        for path in ("Cargo.toml", "Cargo.lock", "build.sh", "src/lib.rs", "src/bin/metadata.rs"):
            destination = self.source / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(path)
        self.output = self.root / "output/helper.json"
        self.output.parent.mkdir()
        self.helper = self.root / "helper.wasm"
        self.policy = self.root / "policy.json"
        self.helper.write_bytes(helper_fixture())
        self.policy.write_text(json.dumps({"policyVersion": 1, "features": [{"name": "bulk-memory", "mask": 1}]}))

    def tearDown(self):
        self.temporary.cleanup()

    def test_generation_uses_one_helper_snapshot(self):
        original = self.helper.read_bytes()
        inspected = []

        def validator(command, *, input, check):
            self.assertTrue(check)
            inspected.append(input)
            self.helper.write_bytes(b"changed after read")
            return subprocess.CompletedProcess(command, 0)

        with patch.object(generator.subprocess, "run", validator):
            generator.generate(self.helper, self.policy, self.output)
        result = json.loads(self.output.read_text())
        self.assertEqual(inspected, [original])
        self.assertEqual(base64.b64decode(result["helperBase64"], validate=True), original)
        self.assertEqual(result["helperSha256"], hashlib.sha256(original).hexdigest())

    def test_invalid_policy_and_invalid_helper_do_not_preserve_output(self):
        policies = [
            {"policyVersion": 2, "features": [{"name": "a", "mask": 1}]},
            {"policyVersion": 1, "features": [{"name": "a", "mask": 3}]},
            {"policyVersion": 1, "features": [{"name": "a", "mask": 1}, {"name": "a", "mask": 2}]},
            {"policyVersion": 1, "features": [{"name": "a", "mask": 1}, {"name": "b", "mask": 1}]},
        ]
        with patch.object(generator.subprocess, "run"):
            for policy in policies:
                self.policy.write_text(json.dumps(policy))
                self.output.write_text("stale")
                with self.assertRaises(ValueError):
                    generator.generate(self.helper, self.policy, self.output)
                self.assertFalse(self.output.exists())
        for data in (b"bad", b"\0asm\x01\0\0\0", b"\0asm\x01\0\0\0\x08\x01\x00"):
            self.helper.write_bytes(data)
            self.output.write_text("stale")
            with self.assertRaises(ValueError):
                generator.generate(self.helper, self.policy, self.output)
            self.assertFalse(self.output.exists())

        self.helper.write_bytes(helper_fixture())
        self.output.write_text("stale")
        with patch.object(generator.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "wasm-tools")):
            with self.assertRaises(subprocess.CalledProcessError):
                generator.generate(self.helper, self.policy, self.output)
        self.assertFalse(self.output.exists())

    def test_output_lock_rejects_competing_build_without_deleting_output(self):
        self.output.write_text("current")
        lock_path = self.output.with_name(f".{self.output.name}.lock")
        with lock_path.open("w") as lock, patch.object(builder, "ROOT", self.root):
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, "already active"):
                builder.build(self.output)
        self.assertEqual(self.output.read_text(), "current")

    def test_helper_and_metadata_use_one_source_snapshot(self):
        self.output.write_text("stale")
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            if command[0] == "sh":
                staged = Path(command[1]).parent
                self.assertEqual((staged / "src/lib.rs").read_text(), "src/lib.rs")
                (self.source / "src/lib.rs").write_text("changed")
            elif command[0] == "cargo":
                manifest = Path(command[command.index("--manifest-path") + 1])
                self.assertEqual(manifest.parent, Path(calls[0][1]).parent)
                self.assertEqual((manifest.parent / "src/lib.rs").read_text(), "src/lib.rs")
                kwargs["stdout"].write(b"{}")
            else:
                self.fail("data generation must not run after a source change")
            return subprocess.CompletedProcess(command, 0)

        with patch.object(builder, "ROOT", self.root), patch.object(builder.subprocess, "run", run):
            with self.assertRaisesRegex(ValueError, "source changed during build"):
                builder.build(self.output)
        self.assertEqual(len(calls), 2)
        self.assertFalse(self.output.exists())
        self.assertEqual(list((self.root / "target/validator").glob(".feature-data.*")), [])

    def test_source_snapshot_rejects_symbolic_links(self):
        (self.source / "src/link.rs").symlink_to(self.source / "Cargo.toml")
        with patch.object(builder, "ROOT", self.root):
            with self.assertRaises((OSError, ValueError)):
                builder.source_snapshot()


if __name__ == "__main__":
    unittest.main()
