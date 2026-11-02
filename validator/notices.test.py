"""Architecture checks for feature-validator notice publication."""

import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("validator_notices", ROOT / "validator/notices.py")
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


class ValidatorNoticesTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lvw-notices-test-")
        self.root = Path(self.temporary.name)
        self.project = self.root / "project"
        self.materials = self.project / "third_party/validator"
        self.materials.parent.mkdir(parents=True)
        shutil.copytree(ROOT / "third_party/validator", self.materials)
        (self.project / "validator").mkdir()
        shutil.copyfile(ROOT / "validator/Cargo.lock", self.project / "validator/Cargo.lock")
        source = ROOT / "node_modules/@noble/hashes"
        dependency = self.project / "node_modules/@noble/hashes"
        dependency.mkdir(parents=True)
        for name in ("LICENSE", "package.json", "utils.js", "_md.js", "_u64.js", "sha2.js"):
            shutil.copyfile(source / name, dependency / name)
        self.sdk = self.root / "sdk"
        self.typescript = self.sdk / "typescript"
        self.typescript.mkdir(parents=True)
        self.license = self.typescript / "LICENSE-noble-hashes.txt"
        shutil.copyfile(source / "LICENSE", self.license)
        self.output = self.typescript / "licenses/validator"

    def tearDown(self):
        self.temporary.cleanup()

    def copy(self):
        return notices.copy_notices(self.project, self.license, self.output)

    def test_material_identity_and_sdk_relocation(self):
        result = self.copy()
        manifest_bytes = (self.output / "manifest.json").read_bytes()
        manifest = json.loads(manifest_bytes)
        self.assertEqual(result["manifest_sha256"], hashlib.sha256(manifest_bytes).hexdigest())
        self.assertEqual(result["files"], len(manifest["files"]))
        self.assertEqual(result["noble_license_sha256"], hashlib.sha256(self.license.read_bytes()).hexdigest())
        self.assertEqual(notices.contents(self.output), notices.contents(self.materials))
        self.assertFalse((self.output / "LICENSE-noble-hashes.txt").exists())
        relocated = self.root / "relocated"
        self.sdk.rename(relocated)
        self.assertEqual((relocated / manifest["noble"]["sdk_license_path"]).read_bytes(), (relocated / "typescript" / manifest["noble"]["package_license_path"]).read_bytes())
        self.assertEqual(notices.contents(relocated / "typescript/licenses/validator"), notices.contents(self.materials))

    def test_tampered_manifest_material_extra_file_and_symlink_are_rejected(self):
        manifest = self.materials / "manifest.json"
        original_manifest = manifest.read_bytes()
        manifest.write_bytes(original_manifest + b" ")
        with self.assertRaisesRegex(ValueError, "manifest identity mismatch"):
            self.copy()
        self.assertFalse(self.output.exists())
        manifest.write_bytes(original_manifest)

        source = self.materials / "dlmalloc-0.2.10/src/dlmalloc.rs"
        original = source.read_bytes()
        source.write_bytes(original + b"changed")
        with self.assertRaisesRegex(ValueError, "notice identity mismatch"):
            self.copy()
        self.assertFalse(self.output.exists())
        source.write_bytes(original)

        extra = self.materials / "unexpected"
        extra.write_bytes(b"extra")
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            self.copy()
        self.assertFalse(self.output.exists())
        extra.unlink()
        source.unlink()
        source.symlink_to(self.license)
        with self.assertRaises((OSError, ValueError)):
            self.copy()
        self.assertFalse(self.output.exists())

    def test_cargo_and_noble_drift_are_rejected(self):
        paths = [self.project / "validator/Cargo.lock", self.project / "node_modules/@noble/hashes/sha2.js",
                 self.project / "node_modules/@noble/hashes/LICENSE", self.license]
        for path in paths:
            original = path.read_bytes()
            path.write_bytes(original + b"changed")
            with self.assertRaises(ValueError):
                self.copy()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_inputs_changed_during_collection_are_rejected(self):
        real_contents = notices.contents

        def changed(path):
            result = real_contents(path)
            if Path(path) != self.materials:
                self.license.write_bytes(b"changed during collection")
            return result

        with patch.object(notices, "contents", changed):
            with self.assertRaisesRegex(ValueError, "inputs changed"):
                self.copy()
        self.assertFalse(self.output.exists())
        self.assertFalse(any(self.typescript.glob("licenses/.validator-notices-*")))

    def test_existing_or_incorrect_destination_is_preserved(self):
        self.output.mkdir(parents=True)
        existing = self.output / "keep"
        existing.write_text("current")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.copy()
        self.assertEqual(existing.read_text(), "current")
        wrong = self.typescript / "wrong/validator"
        with self.assertRaisesRegex(ValueError, "TypeScript licenses/validator"):
            notices.copy_notices(self.project, self.license, wrong)
        self.assertFalse(wrong.exists())


if __name__ == "__main__":
    unittest.main()
