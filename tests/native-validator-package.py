"""Verify native validator SDK identity and downgrade boundaries."""

import hashlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "toolchains"))
from host_sdk import native_host_inputs, native_validator_inputs, validator_notices, verify_rust_validator


class NativeValidatorPackageTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lvw-native-validator-test-")
        self.root = Path(self.temporary.name)
        self.sdk = self.root / "sdk"
        rust = self.sdk / "rust"
        rust.mkdir(parents=True)
        shutil.copytree(ROOT / "bindings/rust/src", rust / "src", ignore=shutil.ignore_patterns("main.rs"))
        shutil.copyfile(ROOT / "bindings/rust/build.rs", rust / "build.rs")
        manifest = (ROOT / "bindings/rust/Cargo.toml").read_text().replace(
            'lvw-feature-validator = { path = "../../validator" }',
            'lvw-feature-validator = { path = "../validator" }')
        (rust / "Cargo.toml").write_text(manifest.replace('default = []\nbundled-bindings = []',
                                                           'default = ["bundled-bindings"]\nbundled-bindings = []'))
        shutil.copyfile(ROOT / "bindings/rust/Cargo.lock", rust / "Cargo.lock")
        self.inputs = native_validator_inputs(ROOT)
        for name, data in self.inputs.items():
            path = self.sdk / "validator" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        notices = validator_notices(ROOT)
        notice = notices.copy_rust_notices(ROOT, rust / "Cargo.lock", rust / "licenses/validator")
        self.identity = {"source_files": {name: hashlib.sha256(data).hexdigest() for name, data in self.inputs.items()},
                         "host_files": {name: hashlib.sha256(data).hexdigest() for name, data in native_host_inputs(ROOT).items()},
                         "notices": notice, "rust_lock_sha256": hashlib.sha256((rust / "Cargo.lock").read_bytes()).hexdigest()}

    def tearDown(self):
        self.temporary.cleanup()

    def test_read_only_relocation_and_source_identity(self):
        verify_rust_validator(self.sdk, self.identity, ROOT)
        moved = self.root / "moved sdk"
        self.sdk.rename(moved)
        for path in [moved, *moved.rglob("*")]:
            path.chmod(0o555 if path.is_dir() else 0o444)
        try:
            verify_rust_validator(moved, self.identity, ROOT)
        finally:
            for path in [moved, *moved.rglob("*")]:
                path.chmod(0o755 if path.is_dir() else 0o644)

    def test_cargo_manifest_rejects_build_and_target_injection(self):
        path = self.sdk / "validator/Cargo.toml"
        original = path.read_bytes()
        for old, new in ((b'publish = false', b'publish = false\nbuild = "build.rs"'),
                         (b'[lib]', b'[lib]\npath = "alternate.rs"'),
                         (b'rust-version = "1.92"', b'rust-version = "1.91"')):
            path.write_bytes(original.replace(old, new))
            self.identity["source_files"]["Cargo.toml"] = hashlib.sha256(path.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, "Cargo manifest differs"):
                verify_rust_validator(self.sdk, self.identity)
        path.write_bytes(original)

    def test_notice_lock_and_source_tampering_rejected(self):
        checks = (self.sdk / "validator/src/lib.rs", self.sdk / "rust/licenses/validator/wasmparser-0.246.2/LICENSE-MIT",
                  self.sdk / "rust/Cargo.lock")
        for path in checks:
            original = path.read_bytes()
            path.write_bytes(original + b"tampered")
            with self.assertRaises(ValueError):
                verify_rust_validator(self.sdk, self.identity)
            path.write_bytes(original)

    def test_host_dependency_marker_in_comment_does_not_authorize_package(self):
        path = self.sdk / "rust/Cargo.toml"
        marker = 'lvw-feature-validator = { path = "../validator" }'
        path.write_text(path.read_text().replace(marker, "# " + marker))
        with self.assertRaisesRegex(ValueError, "host manifest differs"):
            verify_rust_validator(self.sdk, self.identity)

    def test_host_source_links_and_recomputed_identity_do_not_hide_drift(self):
        project = self.root / "source"
        (project / "bindings/rust/src").mkdir(parents=True)
        (project / "bindings/rust/build.rs").write_text("fn main() {}")
        (project / "bindings/rust/src/lib.rs").symlink_to(ROOT / "bindings/rust/src/lib.rs")
        with self.assertRaises((OSError, ValueError)):
            native_host_inputs(project)
        path = self.sdk / "rust/src/lib.rs"
        path.write_bytes(path.read_bytes() + b"\n// drift\n")
        self.identity["host_files"]["src/lib.rs"] = hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "Rust SDK differs"):
            verify_rust_validator(self.sdk, self.identity, ROOT)

    def test_legacy_downgrade_rejects_semantically_equivalent_dependency(self):
        rust = self.sdk / "rust"
        shutil.rmtree(self.sdk / "validator")
        shutil.rmtree(rust / "licenses")
        lock = (rust / "Cargo.lock").read_bytes().replace(b"lvw-feature-validator", b"legacy-no-validator")
        (rust / "Cargo.lock").write_bytes(lock)
        baseline = (ROOT / "bindings/rust/Cargo.toml").read_text().replace(
            'lvw-feature-validator = { path = "../../validator" }\n', "").replace(
            'default = []', 'default = ["bundled-bindings"]')
        (rust / "Cargo.toml").write_text(baseline)
        shutil.rmtree(rust / "src")
        (rust / "src").mkdir()
        (rust / "src/lib.rs").write_text("pub fn legacy() {}\n")
        verify_rust_validator(self.sdk, None)
        for dependency in ("lvw-feature-validator={path='../validator'}", 'alias={package="lvw-feature-validator",path="../validator"}',
                           r'alias={package="\u006cvw-feature-validator",path="../validator"}'):
            (rust / "Cargo.toml").write_text(baseline.replace("[dependencies]\n", "[dependencies]\n" + dependency + "\n"))
            with self.assertRaisesRegex(ValueError, "metadata is missing"):
                verify_rust_validator(self.sdk, None)
        (rust / "Cargo.toml").write_text(baseline)
        (rust / "Cargo.lock").write_bytes(lock.replace(b'legacy-no-validator', b'\\u006cvw-feature-validator'))
        with self.assertRaisesRegex(ValueError, "legacy Cargo.lock is unsupported"):
            verify_rust_validator(self.sdk, None)
        (rust / "Cargo.lock").write_bytes(lock)
        shutil.rmtree(rust / "src")
        (rust / "src").mkdir()
        (rust / "src/lib.rs").write_text("use lvw_feature_validator::validate;\n")
        with self.assertRaisesRegex(ValueError, "metadata is missing"):
            verify_rust_validator(self.sdk, None)


if __name__ == "__main__":
    unittest.main()
