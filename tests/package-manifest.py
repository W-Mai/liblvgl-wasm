import json
import shutil
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


def u32(value):
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def wasm_section(kind, contents):
    return bytes([kind]) + u32(len(contents)) + contents


def wasm_module():
    memory = b"\x01\x00\x01"  # one defined memory, minimum one page
    export_name = b"\x06memory"
    exports = b"\x01" + export_name + b"\x02\x00"
    return b"\0asm\1\0\0\0" + wasm_section(5, memory) + wasm_section(7, exports)


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
    (source / "generator").mkdir()
    shutil.copyfile(Path(__file__).parents[1] / "generator/wasm.py", source / "generator/wasm.py")
    (source / "bridge").mkdir()
    (source / "cmake").mkdir()
    (source / "bridge/lvw.c").write_text("/* bridge input */\n")
    for name in ("timer", "animation", "observer", "decoder"):
        (source / f"cmake/{name}.cmake").write_text(f"# {name} input\n")
    source_manifest = {
        "schema_version": 1,
        "kind": "liblvgl-wasm-source",
        "version": "0.1.0",
        "source": {"revision": "abc123", "dirty": dirty},
        "executables": ["run.sh"],
    }
    source_manifest["files"] = inventory(source)
    write_json(source / "source.json", source_manifest)

    api = {
        "schema_version": 1,
        "constants": [
            {"name": "LVGL_VERSION_MAJOR", "category": "integer", "value": "9"},
            {"name": "LVGL_VERSION_MINOR", "category": "integer", "value": "6"},
            {"name": "LVGL_VERSION_PATCH", "category": "integer", "value": "0"},
            {"name": "LVGL_VERSION_INFO", "category": "string", "text": ""},
            {"name": "LV_USE_BMP", "category": "integer", "value": "0"},
        ],
        "declarations": [],
    }
    api_bytes = json.dumps(api, indent=2).encode() + b"\n"
    core_bytes = wasm_module()
    (ndk / "include.h").write_text("#define LV_TEST 1\n")
    config = ndk / "share/liblvgl-wasm/config/lv_conf.h"
    config.parent.mkdir(parents=True)
    config.write_text("#define LV_USE_BMP 0\n")
    ndk_api = ndk / "share/liblvgl-wasm/metadata/api.json"
    ndk_api.parent.mkdir(parents=True)
    ndk_api.write_bytes(api_bytes)
    ndk_manifest = {
        "schema_version": 1,
        "kind": "wasip1-native-sdk",
        "target": "wasm32-wasip1",
        "reference": {},
    }
    (sdk / "runtime/liblvgl.wasm").parent.mkdir(parents=True)
    (sdk / "metadata").mkdir()
    (sdk / "runtime/liblvgl.wasm").write_bytes(core_bytes)
    (sdk / "metadata/api.json").write_bytes(api_bytes)
    core_sha = lvw.file_sha256(sdk / "runtime/liblvgl.wasm")
    api_sha = lvw.file_sha256(sdk / "metadata/api.json")
    reference = {"schema_version": 1, "wasm_sha256": core_sha, "api_sha256": api_sha,
                 "expected_functions": 0, "verified_functions": 0}
    ndk_manifest["reference"] = reference
    ndk_manifest["files"] = inventory(ndk)
    write_json(ndk / "ndk.json", ndk_manifest)

    write_json(sdk / "metadata/verification.json", reference)
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
        "capabilities": {"path": "liblvgl.manifest.json"},
        "packages": entries,
        "toolchain": {},
    }
    capability = lvw.build_capability_manifest(root, lvw.load_wasm_reader(source / "generator/wasm.py"))
    capability_path = root / "liblvgl.manifest.json"
    write_json(capability_path, capability)
    manifest["capabilities"]["sha256"] = lvw.file_sha256(capability_path)
    manifest["files"] = inventory(root)
    write_json(root / "manifest.json", manifest)


class PackageManifestTests(unittest.TestCase):
    def test_valid_package_and_inventory_tamper(self):
        with tempfile.TemporaryDirectory(prefix="lvw-package-") as directory:
            root = Path(directory)
            make_package(root)
            result = lvw.verify_package(root)
            self.assertTrue(result["identity"]["wasm_sha256"])
            (root / "host-sdk/runtime/liblvgl.wasm").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "file inventory mismatch"):
                lvw.verify_package(root)

    def test_capability_report_is_recomputed_from_package_bytes(self):
        with tempfile.TemporaryDirectory(prefix="lvw-package-") as directory:
            root = Path(directory)
            make_package(root)
            capability = root / "liblvgl.manifest.json"
            data = json.loads(capability.read_text())
            data["wasm"]["memories"][0]["minimum_pages"] = 2
            write_json(capability, data)
            manifest = json.loads((root / "manifest.json").read_text())
            manifest["capabilities"]["sha256"] = lvw.file_sha256(capability)
            manifest["files"] = inventory(root)
            manifest["files"].pop("manifest.json")
            write_json(root / "manifest.json", manifest)
            with self.assertRaisesRegex(ValueError, "capability manifest does not match"):
                lvw.verify_package(root)

    def test_dirty_package_requires_explicit_opt_in(self):
        with tempfile.TemporaryDirectory(prefix="lvw-package-") as directory:
            root = Path(directory)
            make_package(root, dirty=True)
            with self.assertRaisesRegex(ValueError, "clean source snapshot"):
                lvw.verify_package(root)
            self.assertGreater(lvw.verify_package(root, allow_dirty=True)["files"], 7)


if __name__ == "__main__":
    unittest.main()
