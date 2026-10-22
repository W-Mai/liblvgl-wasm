"""Check cache ownership, archive containment, and offline publication contracts."""

import argparse
import fcntl
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "toolchains"))
import lvw


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        (ROOT / "target").mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="bootstrap test ", dir=ROOT / "target")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cache = self.root / "cache with spaces"

    def archive(self, entries):
        archive = self.root / "fixture.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            for name, kind, value in entries:
                item = tarfile.TarInfo(name)
                item.mode = 0o755
                if kind == "file":
                    item.size = len(value)
                    output.addfile(item, io.BytesIO(value))
                else:
                    item.type = {"dir": tarfile.DIRTYPE, "link": tarfile.SYMTYPE,
                                 "hard": tarfile.LNKTYPE, "fifo": tarfile.FIFOTYPE}[kind]
                    item.linkname = value
                    output.addfile(item)
        return archive

    def cached_tool(self):
        archive = self.archive([
            ("tool/wasm-tools", "file", b"#!/bin/sh\nprintf 'wasm-tools 1.246.2 (ee323ec1d 2026-04-03)\\n'\n"),
            ("tool/alias", "link", "wasm-tools"),
        ])
        asset = {"url": "https://example.invalid/fixture.tar.gz", "root": "tool",
                 "sha256": lvw.file_sha256(archive), "size": archive.stat().st_size}
        cached = lvw.archive_file(self.cache, asset)
        cached.parent.mkdir(parents=True)
        shutil.copyfile(archive, cached)
        spec = {"version": "1.246.2", "archives": {"test-host": asset}}
        return spec, cached

    def cli(self, *args, cwd=None, env=None, script=None):
        result = subprocess.run([sys.executable, "-B", str(script or ROOT / "toolchains/lvw.py"),
                                 *args, "--json"], cwd=cwd, env=env, capture_output=True, text=True)
        return result.returncode, json.loads(result.stdout)

    def source_checkout(self):
        project = self.root / "source checkout"
        (project / "scripts").mkdir(parents=True)
        (project / "package.json").write_text('{"name":"liblvgl-wasm","version":"0.1.0"}\n')
        (project / "scripts/build.sh").write_text("#!/bin/sh\nprintf 'source fixture\\n'\n")
        (project / "scripts/build.sh").chmod(0o755)
        (project / "input with spaces.txt").write_text("tracked source\n")
        (project / ".gitignore").write_text("/target/\n/.local/\n")
        environment = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        for arguments in (("init", "-q"),
                          ("add", "package.json", "scripts/build.sh", "input with spaces.txt", ".gitignore"),
                          ("-c", "user.name=Source fixture", "-c", "user.email=fixture@example.invalid",
                           "commit", "-q", "-m", "Source fixture")):
            subprocess.run(["git", "-C", str(project), *arguments], env=environment, check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        (project / "untracked.txt").write_text("untracked input")
        (project / ".local").mkdir()
        (project / ".local/private.txt").write_text("local input")
        return project

    def source_snapshot(self, project):
        output = self.root / "source snapshot"
        status, report = self.cli("export-source", "--project", str(project), "--output", str(output))
        self.assertEqual(status, 0, report)
        return output

    def test_source_snapshot_moves_readonly_and_initializes_without_git(self):
        project = self.source_checkout()
        (project / "input with spaces.txt").write_text("edited source\n")
        source = self.source_snapshot(project).rename(self.root / "relocated package")
        manifest = json.loads((source / "source.json").read_text())
        self.assertTrue(manifest["source"]["dirty"])
        self.assertEqual(set(manifest["files"]),
                         {"package.json", "scripts/build.sh", "input with spaces.txt", ".gitignore"})
        self.assertEqual(manifest["executables"], ["scripts/build.sh"])

        def writable():
            for path in [source, *source.rglob("*")]:
                path.chmod(0o755 if path.is_dir() else 0o644)

        self.addCleanup(writable)
        for path in [source, *source.rglob("*")]:
            path.chmod(0o555 if path.is_dir() or path.stat().st_mode & 0o111 else 0o444)
        output = self.root / "initialized project"
        status, report = self.cli("init", "--project", str(self.root), "--source", str(source),
                                  "--output", str(output), cwd=self.root)
        self.assertEqual(status, 0, report)
        self.assertFalse((output / ".git").exists())
        self.assertFalse((output / "source.json").exists())
        self.assertEqual((output / "input with spaces.txt").read_text(), "edited source\n")
        self.assertEqual(subprocess.check_output([str(output / "scripts/build.sh")], cwd=self.root),
                         b"source fixture\n")
        origin = json.loads((output / "target/source-origin.json").read_text())
        self.assertEqual(origin["manifest"], manifest)
        self.assertEqual(origin["source_sha256"], lvw.file_sha256(source / "source.json"))
        self.assertEqual(lvw.file_inventory(source)["source.json"], origin["source_sha256"])

    def test_source_initialization_rejects_modified_inputs_and_existing_outputs(self):
        source = self.source_snapshot(self.source_checkout())
        output = self.root / "project"
        for defect in ("bytes", "mode", "extra", "missing", "link", "schema"):
            altered = self.root / defect
            shutil.copytree(source, altered)
            file = altered / "input with spaces.txt"
            if defect == "bytes": file.write_text("modified")
            if defect == "mode": (altered / "scripts/build.sh").chmod(0o644)
            if defect == "extra": (altered / "extra").touch()
            if defect in ("missing", "link"): file.unlink()
            if defect == "link": file.symlink_to(source / "input with spaces.txt")
            if defect == "schema": (altered / "source.json").write_text("[]")
            status, report = self.cli("init", "--project", str(self.root), "--source", str(altered),
                                      "--output", str(output))
            self.assertNotEqual(status, 0, report)
            self.assertFalse(output.exists())
        output.mkdir()
        (output / "keep").write_text("user data")
        for destination in (output, source / "nested"):
            status, report = self.cli("init", "--project", str(self.root), "--source", str(source),
                                      "--output", str(destination))
            self.assertNotEqual(status, 0, report)
        self.assertEqual((output / "keep").read_text(), "user data")
        self.assertEqual(list(self.root.glob(".source-*")), [])

    def test_source_export_rejects_nonroot_and_linked_tracked_files(self):
        project = self.source_checkout()
        output = self.root / "rejected"
        status, report = self.cli("export-source", "--project", str(project / "scripts"),
                                  "--output", str(output))
        self.assertNotEqual(status, 0, report)
        file = project / "input with spaces.txt"
        file.unlink()
        file.symlink_to(project / "package.json")
        status, report = self.cli("export-source", "--project", str(project), "--output", str(output))
        self.assertNotEqual(status, 0, report)
        self.assertFalse(output.exists())
        self.assertEqual(list(self.root.glob(".source-*")), [])

    def test_ndk_output_is_never_replaced(self):
        output = self.root / "ndk"
        output.mkdir()
        (output / "keep").write_text("user data")
        link = self.root / "link"
        link.symlink_to(self.root / "missing")
        for command in ("export-ndk", "export-sdk"):
            for path in (output, link):
                status, report = self.cli(command, "--project", str(self.root), "--output", str(path))
                self.assertNotEqual(status, 0)
                self.assertFalse(report["ok"])
        self.assertEqual((output / "keep").read_text(), "user data")
        self.assertTrue(link.is_symlink())

    def test_sdk_rejects_modified_ndk_and_does_not_publish_failed_builds(self):
        import host_sdk

        ndk = self.root / "ndk"
        ndk.mkdir()
        (ndk / "input").write_text("verified")
        lock = json.loads((ROOT / "toolchains/tools.lock.json").read_text())
        native = {"schema_version": 1, "kind": "wasip1-native-sdk", "target": lock["target"],
                  "files": lvw.file_inventory(ndk)}
        (ndk / "ndk.json").write_text(json.dumps(native))
        args = argparse.Namespace(command="export-sdk", ndk="ndk", core="unused.wasm", output="target/sdk")
        (ndk / "input").write_text("modified")
        with patch.object(lvw, "tool_report", side_effect=AssertionError("must reject before running tools")):
            with self.assertRaisesRegex(ValueError, "integrity mismatch"):
                lvw.export_sdk(args, lock, "test-host", self.root, self.cache)
        (ndk / "input").write_text("verified")
        with self.assertRaisesRegex(ValueError, "overlaps an input"):
            host_sdk.build_host_sdk(self.root, ndk, self.root / "unused.wasm", ndk / "nested", "unused")

        def build(project, ndk, core, staged, validator):
            staged.mkdir()
            (staged / "partial").touch()
            raise ValueError("build failed")

        with patch.object(lvw, "tool_report", return_value={"wasm-tools": {"ok": True, "executable": "unused"}}), \
                patch.object(host_sdk, "build_host_sdk", side_effect=build):
            with self.assertRaisesRegex(ValueError, "build failed"):
                lvw.export_sdk(args, lock, "test-host", self.root, self.cache)
        self.assertEqual(list((self.root / "target").iterdir()), [])

    def test_ndk_failed_install_has_no_published_output(self):
        scripts = self.root / "scripts"
        scripts.mkdir()
        (scripts / "build.sh").touch()
        args = argparse.Namespace(command="export-ndk", output="target/ndk")
        reports = {"wasi-sdk": {"ok": True, "path": "/unused/sdk"},
                   "wasm-tools": {"ok": True, "executable": "/unused/validator"}}

        def command(arguments, **kwargs):
            if arguments[:2] == ["cmake", "--install"]:
                staged = Path(arguments[arguments.index("--prefix") + 1])
                staged.mkdir()
                (staged / "partial").touch()
                raise subprocess.CalledProcessError(1, arguments)

        with patch.object(lvw, "tool_report", return_value=reports), patch.object(lvw.subprocess, "run", side_effect=command):
            with self.assertRaises(subprocess.CalledProcessError):
                lvw.export_ndk(args, {}, "test-host", self.root, self.cache, None)
        self.assertEqual(list((self.root / "target").iterdir()), [])

    def test_archive_containment(self):
        invalid = [
            [("../outside", "file", b"x")],
            [("/absolute", "file", b"x")],
            [("other/file", "file", b"x")],
            [("tool/fifo", "fifo", "")],
            [("tool/link", "link", "../../outside")],
            [("tool/link", "link", "/absolute")],
            [("tool/link", "link", "missing")],
            [("tool/a", "link", "b"), ("tool/b", "link", "a")],
            [("tool/a", "link", "dir"), ("tool/a/file", "file", b"x")],
            [("tool/hard", "hard", "../outside")],
            [("tool/a", "file", b"x"), ("tool/a", "file", b"y")],
            [("tool/.lvw-install.json", "file", b"{}")],
            [("tool", "file", b"x")],
        ]
        sentinel = self.root / "outside"
        sentinel.write_bytes(b"unchanged")
        for index, entries in enumerate(invalid):
            with self.subTest(entries=entries):
                destination = self.root / str(index)
                destination.mkdir()
                with self.assertRaises((ValueError, RuntimeError, OSError)):
                    lvw.safe_extract(self.archive(entries), destination, "tool")
                self.assertEqual(sentinel.read_bytes(), b"unchanged")

    def test_relative_links_and_hard_links_are_preserved(self):
        archive = self.archive([
            ("tool/bin/real", "file", b"data"),
            ("tool/lib/alias", "link", "../bin/real"),
            ("tool/bin/alias", "link", "../lib/alias"),
            ("tool/hard", "hard", "tool/bin/real"),
        ])
        output = self.root / "unpack"
        output.mkdir()
        extracted = lvw.safe_extract(archive, output, "tool")
        self.assertTrue((extracted / "lib/alias").is_symlink())
        self.assertEqual((extracted / "bin/alias").read_bytes(), b"data")
        self.assertEqual((extracted / "hard").stat().st_ino, (extracted / "bin/real").stat().st_ino)

    def test_offline_publish_reuse_and_integrity(self):
        spec, archive = self.cached_tool()
        with patch.object(lvw, "urlopen", side_effect=AssertionError("offline network")):
            first = lvw.prepare_tool(self.cache, "wasm-tools", spec, "test-host", True)
            second = lvw.prepare_tool(self.cache, "wasm-tools", spec, "test-host", True)
            self.assertEqual(first, second)
            installed = Path(first["path"])
            self.assertTrue((installed / "alias").is_symlink())
            archive.unlink()
            self.assertEqual(first, lvw.prepare_tool(self.cache, "wasm-tools", spec, "test-host", True))
            (installed / "extra").write_text("changed")
            with self.assertRaisesRegex(ValueError, "integrity mismatch"):
                lvw.prepare_tool(self.cache, "wasm-tools", spec, "test-host", True)
            self.assertEqual((installed / "extra").read_text(), "changed")

    def test_archive_mismatch_and_partial_install_never_publish(self):
        spec, archive = self.cached_tool()
        original = archive.read_bytes()
        archive.write_bytes(bytes([original[0] ^ 255]) + original[1:])
        with self.assertRaisesRegex(ValueError, "size/SHA-256 mismatch"):
            lvw.prepare_tool(self.cache, "wasm-tools", spec, "test-host", True)
        installed = lvw.installation(self.cache, "wasm-tools", spec, "test-host")
        self.assertFalse(installed.exists())
        installed.mkdir(parents=True)
        sentinel = installed / "user-file"
        sentinel.write_text("keep")
        with self.assertRaisesRegex(ValueError, "missing or incomplete"):
            lvw.prepare_tool(self.cache, "wasm-tools", spec, "test-host", True)
        self.assertEqual(sentinel.read_text(), "keep")

    def test_receipt_covers_bytes_links_and_executable_bits(self):
        spec, _ = self.cached_tool()
        result = lvw.prepare_tool(self.cache, "wasm-tools", spec, "test-host", True)
        installed = Path(result["path"])
        tool = installed / "wasm-tools"
        original = tool.read_bytes()
        tool.write_bytes(original.replace(b"printf", b"PRINTf"))
        with self.assertRaisesRegex(ValueError, "integrity mismatch"):
            lvw.verify_installation(installed, spec["archives"]["test-host"])
        tool.write_bytes(original)
        tool.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "integrity mismatch"):
            lvw.verify_installation(installed, spec["archives"]["test-host"])
        tool.chmod(0o755)
        (installed / "alias").unlink()
        (installed / "alias").symlink_to("missing")
        with self.assertRaisesRegex(ValueError, "integrity mismatch"):
            lvw.verify_installation(installed, spec["archives"]["test-host"])
        (installed / lvw.RECEIPT).write_text("[]")
        with self.assertRaisesRegex(ValueError, "integrity mismatch"):
            lvw.verify_installation(installed, spec["archives"]["test-host"])

    def test_failed_validation_does_not_publish_or_leave_temporary_files(self):
        spec, archive = self.cached_tool()
        spec["version"] = "0.0.0"
        with self.assertRaisesRegex(ValueError, "expected 0.0.0"):
            lvw.prepare_tool(self.cache, "wasm-tools", spec, "test-host", True)
        self.assertEqual(list((self.cache / "tools").iterdir()), [])
        self.assertTrue(archive.exists())

    def test_offline_missing_and_download_integrity(self):
        asset = {"url": "https://example.invalid/tool.tar.gz", "size": 4,
                 "sha256": hashlib.sha256(b"good").hexdigest()}
        with patch.object(lvw, "urlopen", side_effect=AssertionError("offline network")):
            with self.assertRaisesRegex(ValueError, "offline archive missing"):
                lvw.fetch_archive(self.cache, asset, True)
        for payload in (b"bad!", b"short", b"no"):
            with self.subTest(payload=payload):
                response = io.BytesIO(payload)
                response.url = asset["url"]
                with patch.object(lvw, "urlopen", return_value=response):
                    with self.assertRaises(ValueError):
                        lvw.fetch_archive(self.cache, asset, False)
                self.assertEqual(list((self.cache / "archives").iterdir()), [])

    def test_readonly_doctor_project_paths_and_explicit_sdk_precedence(self):
        package = self.root / "readonly package"
        package.mkdir()
        for name in ("lvw.py", "tools.lock.json"):
            shutil.copyfile(ROOT / "toolchains" / name, package / name)
            (package / name).chmod(0o444)
        package.chmod(0o555)
        self.addCleanup(package.chmod, 0o755)
        project = self.root / "external project"
        project.mkdir()
        environment = {**os.environ, "WASI_SDK_PATH": "invalid env sdk"}
        code, report = self.cli("doctor", "--cache", "shared cache", "--sdk", "explicit sdk",
                                cwd=project, env=environment, script=package / "lvw.py")
        self.assertEqual(code, 1)
        self.assertEqual(report["cache"], str(project / "shared cache"))
        self.assertEqual(report["tools"]["wasi-sdk"]["source"], "user")
        self.assertIn(str(project / "explicit sdk"), report["tools"]["wasi-sdk"]["error"])
        self.assertEqual(list(project.iterdir()), [])
        self.assertEqual(sorted(p.name for p in package.iterdir()), ["lvw.py", "tools.lock.json"])
        self.assertEqual(lvw.resolve_path("relative", project), project / "relative")

    def test_alternate_download_keeps_the_same_integrity_requirement(self):
        asset = {"url": "https://example.invalid/primary", "fallback_url": "https://example.invalid/alternate",
                 "size": 4, "sha256": hashlib.sha256(b"good").hexdigest()}
        response = io.BytesIO(b"good")
        response.url = asset["fallback_url"]
        with patch.object(lvw, "urlopen", side_effect=[OSError("connection failed"), response]) as fetch:
            cached = lvw.fetch_archive(self.cache, asset, False)
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual(cached.read_bytes(), b"good")
        cached.unlink()
        response = io.BytesIO(b"bad!")
        response.url = asset["url"]
        with patch.object(lvw, "urlopen", return_value=response) as fetch:
            with self.assertRaisesRegex(ValueError, "size/SHA-256 mismatch"):
                lvw.fetch_archive(self.cache, asset, False)
            self.assertEqual(fetch.call_count, 1)

    def test_cache_lock_and_symlink_boundary(self):
        self.cache.mkdir()
        with (self.cache / ".prepare.lock").open("w") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            code, report = self.cli("prepare", "--project", str(self.root),
                                    "--cache", str(self.cache), "--offline")
            self.assertEqual(code, 1)
            self.assertIn("another prepare", report["error"])
        outside = self.root / "user data"
        outside.mkdir()
        (self.cache / "tools").symlink_to(outside, target_is_directory=True)
        args = argparse.Namespace(with_zig=False, command="prepare", offline=True)
        with self.assertRaisesRegex(ValueError, "invalid cache path"):
            lvw.tool_report(args, {}, "test-host", self.cache, None)
        self.assertEqual(list(outside.iterdir()), [])

    def test_unknown_host_is_rejected(self):
        with patch.object(lvw.platform, "machine", return_value="unknown"):
            with self.assertRaisesRegex(ValueError, "unsupported build host"):
                lvw.host_platform()

    def test_build_configuration_tracks_the_selected_sdk(self):
        project = self.root / "build project"
        scripts = project / "scripts"
        scripts.mkdir(parents=True)
        for name in ("build.sh", "resolve-wasi-sdk.sh"):
            shutil.copyfile(ROOT / "scripts" / name, scripts / name)
        sdk = self.root / "selected sdk"
        (sdk / "bin").mkdir(parents=True)
        (sdk / "bin/clang").write_text("#!/bin/sh\nexit 0\n")
        (sdk / "bin/clang").chmod(0o755)
        (sdk / "share/cmake").mkdir(parents=True)
        toolchain = sdk / "share/cmake/wasi-sdk-p1.cmake"
        toolchain.touch()
        source = self.root / "cached source"
        (source / "include/lvgl").mkdir(parents=True)
        (source / "include/lvgl/lvgl.h").touch()
        (source / "CMakeLists.txt").touch()
        build = project / "target/wasm"
        build.mkdir(parents=True)
        recorder = self.root / "cmake"
        recorder.write_text(f"#!{sys.executable}\nimport json, sys\nprint(json.dumps(sys.argv[1:]))\nsys.exit(37)\n")
        recorder.chmod(0o755)
        environment = {**os.environ, "WASI_SDK_PATH": str(sdk),
                       "PATH": str(self.root) + os.pathsep + os.environ["PATH"]}
        environment.pop("LVGL_SOURCE_DIR", None)
        # A legacy cache has no successful-configuration receipt. A changed
        # CMAKE_TOOLCHAIN_FILE alone does not change CMake's cached compiler.
        cases = [(None, str(toolchain), True), (str(sdk), str(toolchain), False),
                 ("old-sdk", str(toolchain), True), (str(sdk), "old-toolchain", True)]
        for recorded, cached, fresh in cases:
            with self.subTest(recorded=recorded, cached=cached):
                (build / "CMakeCache.txt").write_text(
                    f"CMAKE_TOOLCHAIN_FILE:FILEPATH={cached}\nFETCHCONTENT_SOURCE_DIR_LVGL:PATH={source}\n")
                if recorded is not None:
                    (build / ".wasi-sdk").write_text(recorded + "\n")
                result = subprocess.run(["sh", str(scripts / "build.sh")], cwd=self.root,
                                        env=environment, text=True, capture_output=True)
                self.assertEqual(result.returncode, 37, result.stderr)
                arguments = json.loads(result.stdout.splitlines()[-1])
                self.assertEqual("--fresh" in arguments, fresh)
                self.assertIn(f"-DCMAKE_TOOLCHAIN_FILE={toolchain}", arguments)
                self.assertIn(f"-DFETCHCONTENT_SOURCE_DIR_LVGL:PATH={source}", arguments)


if __name__ == "__main__":
    unittest.main()
