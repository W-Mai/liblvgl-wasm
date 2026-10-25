import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "toolchains"))
import lvw  # noqa: E402


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def inventory(root):
    return lvw.file_inventory(root)


def make_package(root, dirty=False):
    source = root / "source"
    ndk = root / "ndk"
    sdk = root / "host-sdk"
    source.mkdir()
    ndk.mkdir()
    sdk.mkdir()
    (source / "package.json").write_text('{"name":"liblvgl-wasm","version":"0.1.0"}\n')
    (source / "run.sh").write_text("#!/bin/sh\n")
    (source / "run.sh").chmod(0o755)
    source_manifest = {
        "schema_version": 1,
        "kind": "liblvgl-wasm-source",
        "version": "0.1.0",
        "source": {"revision": "abc123", "dirty": dirty},
        "executables": ["run.sh"],
    }
    source_manifest["files"] = inventory(source)
    write_json(source / "source.json", source_manifest)

    reference = {"wasm_sha256": "core", "api_sha256": "api"}
    (ndk / "include.h").write_text("#define LV_TEST 1\n")
    ndk_manifest = {
        "schema_version": 1,
        "kind": "wasip1-native-sdk",
        "target": "wasm32-wasip1",
        "reference": reference,
    }
    ndk_manifest["files"] = inventory(ndk)
    write_json(ndk / "ndk.json", ndk_manifest)

    (sdk / "runtime.wasm").write_bytes(b"wasm")
    sdk_manifest = {
        "schema_version": 1,
        "kind": "wasip1-host-sdk",
        "target": "wasm32-wasip1",
        "identity": reference,
    }
    sdk_manifest["files"] = inventory(sdk)
    write_json(sdk / "sdk.json", sdk_manifest)

    entries = {
        "source": {"path": "source", "manifest": "source/source.json"},
        "ndk": {"path": "ndk", "manifest": "ndk/ndk.json",
                "sha256": lvw.file_sha256(ndk / "ndk.json")},
        "host_sdk": {"path": "host-sdk", "manifest": "host-sdk/sdk.json",
                     "sha256": lvw.file_sha256(sdk / "sdk.json")},
    }
    manifest = {
        "schema_version": 1,
        "kind": "liblvgl-wasm-development-package",
        "version": "0.1.0",
        "target": "wasm32-wasip1",
        "compatibility": {"wasi-sdk": "34.0", "clang": "18", "wasm-tools": "1.246.2",
                           "ndk_schema": 1, "sdk_schema": 1},
        "source": {"path": "source", "revision": "abc123", "dirty": dirty,
                    "manifest": "source/source.json"},
        "core": reference,
        "packages": entries,
        "toolchain": {},
    }
    manifest["files"] = inventory(root)
    write_json(root / "manifest.json", manifest)


class PackageManifestTests(unittest.TestCase):
    def test_valid_package_and_inventory_tamper(self):
        with tempfile.TemporaryDirectory(prefix="lvw-package-") as directory:
            root = Path(directory)
            make_package(root)
            result = lvw.verify_package(root)
            self.assertEqual(result["identity"]["wasm_sha256"], "core")
            (root / "host-sdk/runtime.wasm").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "file inventory mismatch"):
                lvw.verify_package(root)

    def test_dirty_package_requires_explicit_opt_in(self):
        with tempfile.TemporaryDirectory(prefix="lvw-package-") as directory:
            root = Path(directory)
            make_package(root, dirty=True)
            with self.assertRaisesRegex(ValueError, "clean source snapshot"):
                lvw.verify_package(root)
            self.assertEqual(lvw.verify_package(root, allow_dirty=True)["files"], 7)


if __name__ == "__main__":
    unittest.main()
