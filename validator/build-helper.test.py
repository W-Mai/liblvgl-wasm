"""Check path remapping and helper build isolation."""

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("validator_build_helper", ROOT / "validator/build-helper.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class HelperBuildTest(unittest.TestCase):
    def test_path_prefixes_cover_aliases_and_reject_unrepresentable_values(self):
        with tempfile.TemporaryDirectory(prefix="lvw remap=", dir=ROOT / "target/validator") as directory:
            root = Path(directory)
            actual = root / "cargo= with space"
            actual.mkdir()
            alias = root / "cargo alias"
            alias.symlink_to(actual, target_is_directory=True)
            environment = {"HOME": str(root / "home"), "CARGO_HOME": str(alias),
                           "RUSTUP_HOME": str(root / "rustup"), "TMPDIR": str(root / "tmp"),
                           "LVW_VALIDATOR_TARGET_DIR": str(root / "target")}
            prefixes = helper.path_prefixes(environment)
            self.assertIn(str(alias), prefixes)
            self.assertIn(str(actual), prefixes)
            self.assertIn(str(root / "home"), prefixes)
            nested = helper.path_prefixes({**environment, "HOME": str(root)})
            self.assertLess(nested.index(str(root)), nested.index(str(alias)))
            with self.assertRaisesRegex(ValueError, "unit separator"):
                helper.path_prefixes({**environment, "CARGO_HOME": str(root / "bad\x1fpath")})
            with self.assertRaisesRegex(ValueError, "filesystem root"):
                helper.path_prefixes({**environment, "CARGO_HOME": "/"})

    def test_build_replaces_inherited_rust_flags_only_in_child(self):
        with tempfile.TemporaryDirectory(prefix="lvw helper ", dir=ROOT / "target/validator") as directory:
            root = Path(directory)
            target = root / "target"
            artifact = target / "wasm32-unknown-unknown/release/lvw_feature_validator.wasm"
            artifact.parent.mkdir(parents=True)
            artifact.write_bytes(b"\0asm\x01\0\0\0")
            output = root / "result.wasm"
            environment = {"LVW_VALIDATOR_TARGET_DIR": str(target), "RUSTFLAGS": "parent-flags",
                           "CARGO_ENCODED_RUSTFLAGS": "parent-encoded-flags"}
            calls = []

            def run(command, *, env, check):
                calls.append((command, env, check))

            with patch.dict(os.environ, environment), patch.object(helper.subprocess, "run", run), \
                    patch.object(helper.subprocess, "check_output", return_value="rustc 1.92.0 (ded5c06cf 2025-12-08)\n"):
                helper.build(output)
                self.assertEqual(os.environ["RUSTFLAGS"], "parent-flags")
                self.assertEqual(os.environ["CARGO_ENCODED_RUSTFLAGS"], "parent-encoded-flags")
            self.assertEqual(output.read_bytes(), artifact.read_bytes())
            self.assertEqual(len(calls), 1)
            child = calls[0][1]
            self.assertNotIn("RUSTFLAGS", child)
            flags = child["CARGO_ENCODED_RUSTFLAGS"].split(helper.SEPARATOR)
            self.assertIn("-C", flags)
            self.assertIn(f"--remap-path-prefix={target}=/lvw-source", flags)

    def test_unremapped_artifact_is_not_published(self):
        with tempfile.TemporaryDirectory(prefix="lvw leak ", dir=ROOT / "target/validator") as directory:
            root = Path(directory)
            target = root / "target"
            artifact = target / "wasm32-unknown-unknown/release/lvw_feature_validator.wasm"
            artifact.parent.mkdir(parents=True)
            artifact.write_bytes(b"\0asm\x01\0\0\0" + os.fsencode(target))
            output = root / "result.wasm"
            output.write_bytes(b"stale")
            environment = {"LVW_VALIDATOR_TARGET_DIR": str(target)}
            with patch.dict(os.environ, environment), patch.object(helper.subprocess, "run"), \
                    patch.object(helper.subprocess, "check_output", return_value="rustc 1.92.0 (ded5c06cf 2025-12-08)\n"):
                with self.assertRaisesRegex(ValueError, "unremapped build path"):
                    helper.build(output)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
