#!/usr/bin/env python3
"""Prepare locked compiler tools, build projects, and export LVGL development files."""

import argparse
import ctypes
import hashlib
import http.client
import json
import os
import platform
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from urllib.request import Request, urlopen


RECEIPT = ".lvw-install.json"


def host_platform():
    host = (sys.platform, platform.machine().lower())
    supported = {("darwin", "arm64"): "macos-arm64",
                 ("linux", "x86_64"): "linux-x86_64"}
    if host not in supported:
        raise ValueError(f"unsupported build host: {host[0]}/{host[1]}")
    return supported[host]


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_sha256(root):
    """Hash content, paths, link targets, and executable bits without following links."""
    digest = hashlib.sha256()
    paths = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        paths.extend(Path(directory) / name for name in dirs + files)
    for path in sorted(paths):
        relative = path.relative_to(root).as_posix()
        if relative == RECEIPT:
            continue
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            record = [relative, "link", os.readlink(path)]
        elif stat.S_ISREG(mode):
            record = [relative, "file", mode & 0o111, file_sha256(path)]
        elif stat.S_ISDIR(mode):
            record = [relative, "directory"]
        else:
            raise ValueError(f"unsupported installed file: {path}")
        digest.update((json.dumps(record, ensure_ascii=True) + "\n").encode())
    return digest.hexdigest()


def safe_extract(archive, destination, root_name):
    """Write ordinary files before links; never write through an archive link."""
    root = PurePosixPath(root_name)
    if len(root.parts) != 1 or root_name in ("", ".", ".."):
        raise ValueError("invalid archive root")
    with tarfile.open(archive, "r:*") as source:
        members = {}
        for member in source.getmembers():
            path = PurePosixPath(member.name)
            if (path.is_absolute() or ".." in path.parts or "\\" in member.name
                    or not path.parts or path.parts[0] != root_name):
                raise ValueError(f"unsafe archive path: {member.name}")
            if path in members or path == root / RECEIPT:
                raise ValueError(f"duplicate or reserved archive path: {member.name}")
            if not (member.isdir() or member.isreg() or member.issym() or member.islnk()):
                raise ValueError(f"unsupported archive entry: {member.name}")
            members[path] = member
        if not members:
            raise ValueError("empty archive")
        for path, member in members.items():
            if path == root and not member.isdir():
                raise ValueError("archive root must be a directory")
            for parent in path.parents:
                if parent in members and not members[parent].isdir():
                    raise ValueError(f"archive entry has a non-directory parent: {path}")
            if member.issym() or member.islnk():
                link = PurePosixPath(member.linkname)
                if link.is_absolute() or "\\" in member.linkname or not member.linkname:
                    raise ValueError(f"unsafe archive link: {path}")
                target = (path.parent / link) if member.issym() else link
                target = PurePosixPath(posixpath.normpath(str(target)))
                if not target.parts or target.parts[0] != root_name:
                    raise ValueError(f"archive link escapes its root: {path}")
                if member.islnk() and (target not in members or not members[target].isreg()):
                    raise ValueError(f"hard link must name a regular archive file: {path}")
        # destination is a fresh private temporary directory supplied by prepare.
        for path, member in members.items():
            output = destination / str(path)
            output.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                output.mkdir(exist_ok=True)
            elif member.isreg():
                with source.extractfile(member) as reader, output.open("xb") as writer:
                    shutil.copyfileobj(reader, writer)
                output.chmod(0o755 if member.mode & 0o111 else 0o644)
        for path, member in members.items():
            if member.islnk():
                os.link(destination / posixpath.normpath(member.linkname), destination / str(path))
            elif member.issym():
                os.symlink(member.linkname, destination / str(path))
        installed = destination / root_name
        for path, member in members.items():
            if member.issym():
                resolved = (destination / str(path)).resolve(strict=True)
                if not resolved.is_relative_to(installed):
                    raise ValueError(f"archive link escapes its root: {path}")
        return installed


def ordinary_path(path, directory=False):
    if path.is_symlink() or (path.exists() and not
                            (path.is_dir() if directory else path.is_file())):
        raise ValueError(f"invalid cache path: {path}")


def cache_directory(path):
    ordinary_path(path, directory=True)
    path.mkdir(parents=True, exist_ok=True)
    return path


def archive_file(cache, asset):
    return cache / "archives" / (asset["sha256"] + "-" + asset["url"].rsplit("/", 1)[1])


def verify_archive(path, asset):
    ordinary_path(path)
    if path.stat().st_size != asset["size"] or file_sha256(path) != asset["sha256"]:
        raise ValueError(f"archive size/SHA-256 mismatch: {path}; remove it before retrying")


def fetch_archive(cache, asset, offline):
    path = archive_file(cache, asset)
    if path.exists() or path.is_symlink():
        verify_archive(path, asset)
        return path
    if offline:
        raise ValueError(f"offline archive missing: {path}")
    urls = [asset["url"]] + ([asset["fallback_url"]] if "fallback_url" in asset else [])
    if any(not url.startswith("https://") for url in urls):
        raise ValueError("tool downloads require HTTPS")
    cache_directory(path.parent)
    descriptor, temporary = tempfile.mkstemp(prefix=".download-", dir=path.parent)
    os.close(descriptor)
    temporary = Path(temporary)
    try:
        for url in urls:
            print(f"Downloading {url}", file=sys.stderr)
            request = Request(url, headers={"User-Agent": "liblvgl-wasm-toolchains",
                                            "Accept": "application/octet-stream"})
            try:
                with temporary.open("wb") as output, urlopen(request, timeout=60) as response:
                    if not response.url.startswith("https://"):
                        raise ValueError("tool download redirected outside HTTPS")
                    size = 0
                    for chunk in iter(lambda: response.read(1024 * 1024), b""):
                        size += len(chunk)
                        if size > asset["size"]:
                            raise ValueError("tool download exceeds its locked size")
                        output.write(chunk)
            except (OSError, http.client.HTTPException) as error:
                if url == urls[-1]:
                    raise ValueError(f"download failed: {url}: {error}") from error
                print(f"Download failed: {error}; trying the locked alternate URL", file=sys.stderr)
                continue
            verify_archive(temporary, asset)
            os.replace(temporary, path)
            break
    finally:
        temporary.unlink(missing_ok=True)
    return path


def run_version(command):
    result = subprocess.run([str(item) for item in command], capture_output=True,
                            text=True, timeout=20, check=False)
    if result.returncode:
        raise ValueError(f"{command[0]} failed: {(result.stderr or result.stdout).strip()[:1000]}")
    if not result.stdout.strip():
        raise ValueError(f"{command[0]} returned no version output")
    return result.stdout.strip()


def require_files(root, files, executables=()):
    missing = [name for name in files if not (root / name).is_file()]
    missing += [name for name in executables if not
                ((root / name).is_file() and os.access(root / name, os.X_OK))]
    if missing:
        raise ValueError(f"incomplete tool at {root}: {', '.join(missing)}")


def check_tool(name, root, spec, host):
    if name == "wasi-sdk":
        runtime = "share/wasi-sysroot/lib/wasm32-wasip1/"
        library = "lib/libclang.dylib" if host == "macos-arm64" else "lib/libclang.so"
        require_files(root, ["VERSION", "share/cmake/wasi-sdk-p1.cmake", library,
                            "share/wasi-sysroot/include/wasm32-wasip1/stdlib.h",
                            "lib/clang/23/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a",
                            *[runtime + item for item in ("libc.a", "libsetjmp.a", "crt1-reactor.o",
                              "eh/libc++.a", "eh/libc++abi.a", "eh/libunwind.a")]],
                      ["bin/clang", "bin/clang++", "bin/wasm-ld", "bin/llvm-ar"])
        version = (root / "VERSION").read_text().partition("\n")[0]
        compiler = run_version([root / "bin/clang", "--version"]).splitlines()[0]
        if not compiler.startswith(f"clang version {spec['clang_version']}-wasi-sdk "):
            raise ValueError(f"unexpected SDK compiler: {compiler}")
        if run_version([root / "bin/clang", "-dumpmachine"]) != "wasm32-unknown-wasip1":
            raise ValueError("SDK compiler default target must be wasm32-unknown-wasip1")
        # Loading libclang also diagnoses missing Linux shared-library dependencies.
        ctypes.CDLL(str(root / library))
        executable = root / "bin/clang"
    else:
        executable = root / name
        require_files(root, ["lib/std/std.zig"] if name == "zig" else [], [name])
        output = run_version([executable, "version" if name == "zig" else "--version"])
        if name == "zig":
            version = output
        else:
            match = re.fullmatch(r"wasm-tools (\d+\.\d+\.\d+)(?: \([0-9a-f]+ \d{4}-\d{2}-\d{2}\))?", output)
            if not match:
                raise ValueError(f"unexpected wasm-tools version output: {output}")
            version = match[1]
    if version != spec["version"]:
        raise ValueError(f"{name}: expected {spec['version']}, found {version}")
    return {"version": version, "path": str(root), "executable": str(executable)}


def installation(cache, name, spec, host):
    return cache / "tools" / f"{name}-{spec['version']}-{host}"


def verify_installation(path, asset):
    ordinary_path(path, directory=True)
    receipt = path / RECEIPT
    ordinary_path(receipt)
    if not receipt.is_file():
        raise ValueError(f"installation missing or incomplete: {path}; run prepare")
    identity = json.loads(receipt.read_text())
    if (not isinstance(identity, dict) or identity.get("schema_version") != 1
            or identity.get("archive_sha256") != asset["sha256"]
            or identity.get("tree_sha256") != tree_sha256(path)):
        raise ValueError(f"installation integrity mismatch: {path}; move it aside before prepare")


def prepare_tool(cache, name, spec, host, offline):
    path = installation(cache, name, spec, host)
    asset = spec["archives"][host]
    if path.exists() or path.is_symlink():
        verify_installation(path, asset)
        cached_archive = archive_file(cache, asset)
        if cached_archive.exists() or cached_archive.is_symlink():
            verify_archive(cached_archive, asset)
        return check_tool(name, path, spec, host)
    archive = fetch_archive(cache, asset, offline)
    tools = cache_directory(cache / "tools")
    with tempfile.TemporaryDirectory(prefix=".install-", dir=tools) as temporary:
        extracted = safe_extract(archive, Path(temporary), asset["root"])
        check_tool(name, extracted, spec, host)
        receipt = {"schema_version": 1, "archive_sha256": asset["sha256"],
                   "tree_sha256": tree_sha256(extracted)}
        (extracted / RECEIPT).write_text(json.dumps(receipt, indent=2) + "\n")
        extracted.rename(path)
    return check_tool(name, path, spec, host)


def prerequisite(name, minimum):
    path = shutil.which(name)
    if not path:
        return {"ok": False, "error": f"{name} not found on PATH"}
    try:
        output = run_version([path, "--version"]).splitlines()[0]
        match = re.search(r"\b(\d+)\.(\d+)(?:\.(\d+))?", output)
        if not match or tuple(int(part or 0) for part in match.groups()) < minimum:
            raise ValueError(f"{name} requires {'.'.join(map(str, minimum))}+, found {output}")
        return {"ok": True, "path": path, "version": output}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {"ok": False, "path": path, "error": str(error)}


def tool_report(args, lock, host, cache, sdk, names=None):
    for child in ("archives", "tools"):
        ordinary_path(cache / child, directory=True)
    reports = {}
    for name in names or ["wasi-sdk", "wasm-tools"] + (["zig"] if getattr(args, "with_zig", False) else []):
        spec = lock["tools"][name]
        explicit = name == "wasi-sdk" and sdk is not None
        report = {"source": "user" if explicit else "managed", "ok": False}
        try:
            if explicit:
                result = check_tool(name, sdk, spec, host)
            elif args.command == "prepare":
                result = prepare_tool(cache, name, spec, host, args.offline)
            else:
                path = installation(cache, name, spec, host)
                verify_installation(path, spec["archives"][host])
                result = check_tool(name, path, spec, host)
            report.update(result, ok=True)
            if not explicit:
                report["archive_sha256"] = spec["archives"][host]["sha256"]
        except (OSError, ValueError, RuntimeError, tarfile.TarError,
                subprocess.SubprocessError) as error:
            report["error"] = str(error)
        reports[name] = report
    return reports


def resolve_path(value, project):
    path = Path(value).expanduser()
    return (path if path.is_absolute() else project / path).resolve()


def new_output(value, project):
    requested = Path(value).expanduser()
    requested = requested if requested.is_absolute() else project / requested
    if requested.is_symlink():
        raise ValueError(f"output must not be a symbolic link: {requested}")
    output = resolve_path(value, project)
    if output.exists():
        raise ValueError(f"output already exists: {output}; choose a new directory")
    return output


def file_inventory(root):
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"package contains a symbolic link: {path}")
        if path.is_file():
            files[path.relative_to(root).as_posix()] = file_sha256(path)
        elif not path.is_dir():
            raise ValueError(f"unsupported package entry: {path}")
    return files


def package_member(root, value):
    if not isinstance(value, str) or not value:
        raise ValueError("package manifest path must be a non-empty string")
    relative = PurePosixPath(value)
    if relative.is_absolute() or ".." in relative.parts or "\\" in value:
        raise ValueError(f"package manifest path escapes its root: {value}")
    path = (root / Path(*relative.parts)).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"package manifest path escapes its root: {value}")
    return path


def verify_nested_package(root, entry, expected_kind):
    if not isinstance(entry, dict):
        raise ValueError(f"invalid {expected_kind} package entry")
    package = package_member(root, entry.get("path"))
    manifest_path = package_member(root, entry.get("manifest"))
    if not package.is_dir() or not manifest_path.is_file():
        raise ValueError(f"missing {expected_kind} package: {package}")
    if not manifest_path.is_relative_to(package):
        raise ValueError(f"{expected_kind} manifest is outside its package: {manifest_path}")
    inventory = file_inventory(package)
    manifest_name = manifest_path.relative_to(package).as_posix()
    manifest_digest = inventory.pop(manifest_name, None)
    if manifest_digest is None:
        raise ValueError(f"missing {expected_kind} manifest: {manifest_path}")
    if entry.get("sha256") is not None and entry["sha256"] != manifest_digest:
        raise ValueError(f"{expected_kind} manifest hash mismatch: {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError) as error:
        raise ValueError(f"invalid {expected_kind} manifest: {manifest_path}") from error
    if (not isinstance(manifest, dict) or manifest.get("schema_version") != 1
            or manifest.get("kind") != expected_kind or manifest.get("files") != inventory):
        raise ValueError(f"{expected_kind} manifest or file inventory mismatch: {package}")
    return manifest


def verify_package(package, allow_dirty=False):
    """Verify a complete relocatable source/NDK/host SDK package."""
    package = Path(package).expanduser().resolve(strict=True)
    if not package.is_dir():
        raise ValueError(f"package must be an existing directory: {package}")
    inventory = file_inventory(package)
    inventory.pop("manifest.json", None)
    manifest_path = package / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError(f"missing package manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text())
    if (not isinstance(manifest, dict) or manifest.get("schema_version") != 1
            or manifest.get("kind") != "liblvgl-wasm-development-package"
            or manifest.get("files") != inventory):
        raise ValueError(f"package manifest or file inventory mismatch: {package}")
    packages = manifest.get("packages")
    if not isinstance(packages, dict) or set(packages) != {"source", "ndk", "host_sdk"}:
        raise ValueError("package manifest must contain source, ndk, and host_sdk packages")
    source_entry = packages["source"]
    ndk_entry = packages["ndk"]
    sdk_entry = packages["host_sdk"]
    source = verify_nested_package(package, source_entry, "liblvgl-wasm-source")
    ndk = verify_nested_package(package, ndk_entry, "wasip1-native-sdk")
    sdk = verify_nested_package(package, sdk_entry, "wasip1-host-sdk")
    source_path = package_member(package, source_entry.get("path"))
    executables = sorted(name for name in source["files"]
                         if (source_path / name).stat().st_mode & 0o111)
    if source.get("executables") != executables:
        raise ValueError("source executable inventory mismatch")
    source_package = json.loads((source_path / "package.json").read_text())
    if (not isinstance(source_package, dict)
            or source_package.get("name") != "liblvgl-wasm"
            or source_package.get("version") != source.get("version")):
        raise ValueError("source package identity does not agree")
    if (manifest.get("version") != source.get("version")
            or manifest.get("target") != ndk.get("target")
            or ndk.get("target") != sdk.get("target")
            or manifest.get("core") != ndk.get("reference")
            or manifest.get("core") != sdk.get("identity")):
        raise ValueError("package identity fields do not agree")
    source_state = manifest.get("source")
    source_origin = source.get("source")
    if (not isinstance(source_state, dict) or not isinstance(source_origin, dict)
            or source_state.get("path") != source_entry.get("path")
            or source_state.get("manifest") != source_entry.get("manifest")
            or source_state.get("revision") != source_origin.get("revision")
            or source_state.get("dirty") != source_origin.get("dirty")):
        raise ValueError("source identity fields do not agree")
    if source_state.get("dirty") and not allow_dirty:
        raise ValueError("release package must contain a clean source snapshot")
    if (ndk_entry.get("manifest") != "ndk/ndk.json"
            or sdk_entry.get("manifest") != "host-sdk/sdk.json"):
        raise ValueError("package manifest paths are inconsistent")
    return {"output": str(package), "identity": manifest["core"], "files": len(inventory)}


def publish_package(staged, output, name, manifest):
    if (staged / name).exists():
        raise ValueError(f"package manifest already exists: {name}")
    (staged / name).write_text(json.dumps(manifest, indent=2) + "\n")
    if output.exists() or output.is_symlink():
        raise ValueError(f"output appeared during export: {output}")
    staged.rename(output)


def export_ndk(args, lock, host, project, cache, sdk):
    output = new_output(args.output, project)
    builder = project / "scripts/build-core.sh"
    if not builder.is_file():
        raise ValueError(f"export-ndk requires a source checkout at --project: {project}")
    reports = tool_report(args, lock, host, cache, sdk)
    failures = [item["error"] for item in reports.values() if not item["ok"]]
    if failures:
        raise ValueError("; ".join(failures))
    environment = {**os.environ, "WASI_SDK_PATH": reports["wasi-sdk"]["path"]}
    build = resolve_path(getattr(args, "build_dir", None) or "target/wasm", project)
    environment["LVW_BUILD_DIR"] = str(build)
    for option, variable in (("source", "LVGL_SOURCE_DIR"), ("config", "LVGL_CONFIG_PATH")):
        value = getattr(args, option, None)
        if value is not None:
            environment[variable] = str(resolve_path(value, project))
    if getattr(args, "bridge_features", None) is not None:
        environment["LVW_BRIDGE_FEATURES"] = args.bridge_features

    def run(command):
        subprocess.run([str(item) for item in command], cwd=project, env=environment,
                       stdout=sys.stderr, check=True)

    # Rebuild through the same generator/configuration path before exporting.
    run(["sh", builder])
    core = build / "liblvgl.wasm"
    run([reports["wasm-tools"]["executable"], "validate", core])
    run(["cmake", "--build", build, "--target", "lvw_ndk", "-j", "4"])
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".ndk-", dir=output.parent) as temporary:
        staged = Path(temporary) / "package"
        run(["cmake", "--install", build, "--prefix", staged, "--component", "ndk"])
        data = staged / "share/liblvgl-wasm"
        # Reject missing or source-tree-only configuration includes before publication.
        subprocess.run([sys.executable, "-B", str(data / "generator/lvgl.py"), "--source", str(staged),
                        "--config", str(staged / "include/lvgl/config/lv_conf.h"),
                        "--sdk", reports["wasi-sdk"]["path"], "--contained"],
                       cwd=project, env=environment, stdout=subprocess.DEVNULL, check=True)
        proof = data / "metadata/reference-verification.json"
        run([sys.executable, "-B", data / "generator/signatures.py",
             "--api", data / "metadata/api.json", "--wasm", core, "--output", proof])
        reference = json.loads(proof.read_text())
        files = file_inventory(staged)
        manifest = {
            "schema_version": 1, "kind": "wasip1-native-sdk", "target": lock["target"],
            "reference": reference,
            "toolchain": {"wasi-sdk": lock["tools"]["wasi-sdk"]["version"],
                          "clang": lock["tools"]["wasi-sdk"]["clang_version"]},
            "libraries": {Path(path).stem.removeprefix("lib"): {"path": path, "sha256": digest}
                          for path, digest in files.items() if path.startswith("lib/lib") and path.endswith(".a")},
            "files": files,
        }
        publish_package(staged, output, "ndk.json", manifest)
    return {"output": str(output), "reference": reference, "files": len(files)}


def export_sdk(args, lock, host, project, cache):
    from host_sdk import build_host_sdk

    output = new_output(args.output, project)
    ndk = resolve_path(args.ndk, project)
    files = file_inventory(ndk)
    if "ndk.json" not in files:
        raise ValueError(f"missing ndk.json at {ndk}; run export-ndk")
    ndk_sha256 = files.pop("ndk.json")
    native = json.loads((ndk / "ndk.json").read_text())
    if (not isinstance(native, dict) or native.get("schema_version") != 1
            or native.get("kind") != "wasip1-native-sdk" or native.get("target") != lock["target"]
            or native.get("files") != files):
        raise ValueError(f"NDK schema or file integrity mismatch: {ndk}")
    tools = tool_report(args, lock, host, cache, None, names=["wasm-tools"])
    if not tools["wasm-tools"]["ok"]:
        raise ValueError(tools["wasm-tools"]["error"])
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".sdk-", dir=output.parent) as temporary:
        staged = Path(temporary) / "package"
        metadata = build_host_sdk(project, ndk, resolve_path(args.core, project), staged,
                                  tools["wasm-tools"]["executable"])
        files = file_inventory(staged)
        manifest = {"schema_version": 1, "kind": "wasip1-host-sdk", "target": native["target"],
                    "ndk_sha256": ndk_sha256, **metadata, "files": files}
        publish_package(staged, output, "sdk.json", manifest)
    return {"output": str(output), "identity": metadata["identity"], "files": len(files)}


def export_package(args, lock, host, project, cache, sdk):
    """Export one relocatable package containing source, NDK, and host SDK manifests."""
    from source_package import build_source

    output = new_output(args.output, project)
    builder = project / "scripts/build.sh"
    if not builder.is_file():
        raise ValueError(f"export-package requires a source checkout at --project: {project}")
    reports = tool_report(args, lock, host, cache, sdk)
    failures = [item["error"] for item in reports.values() if not item["ok"]]
    if failures:
        raise ValueError("; ".join(failures))

    # A release package must identify one clean source revision. The source
    # export command remains available for intentionally dirty development snapshots.
    dirty = subprocess.run(["git", "-C", str(project), "diff", "--quiet", "HEAD", "--"])
    if dirty.returncode not in (0, 1):
        dirty.check_returncode()
    if dirty.returncode and not args.allow_dirty:
        raise ValueError("export-package requires a clean source checkout")

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".package-", dir=output.parent) as temporary:
        temporary = Path(temporary)
        source = temporary / "source"
        ndk = temporary / "ndk"
        sdk_package = temporary / "host-sdk"
        source_manifest = build_source(project, source)
        source_manifest["files"] = file_inventory(source)
        (source / "source.json").write_text(json.dumps(source_manifest, indent=2) + "\n")

        ndk_args = argparse.Namespace(command="export-ndk", output=str(ndk),
                                      with_zig=False, sdk=args.sdk)
        ndk_result = export_ndk(ndk_args, lock, host, project, cache, sdk)
        sdk_args = argparse.Namespace(command="export-sdk", output=str(sdk_package),
                                      ndk=str(ndk), core="target/wasm/liblvgl.wasm",
                                      with_zig=False)
        sdk_result = export_sdk(sdk_args, lock, host, project, cache)

        staged = temporary / "package"
        staged.mkdir()
        for name, package in (("source", source), ("ndk", ndk), ("host-sdk", sdk_package)):
            shutil.copytree(package, staged / name)
        files = file_inventory(staged)
        source_data = json.loads((staged / "source/source.json").read_text())
        ndk_data = json.loads((staged / "ndk/ndk.json").read_text())
        sdk_data = json.loads((staged / "host-sdk/sdk.json").read_text())
        toolchain = {
            name: {key: report[key] for key in ("source", "version", "archive_sha256") if key in report}
            for name, report in reports.items()
        }
        manifest = {
            "schema_version": 1,
            "kind": "liblvgl-wasm-development-package",
            "version": source_data["version"],
            "target": lock["target"],
            "compatibility": {
                "wasi-sdk": lock["tools"]["wasi-sdk"]["version"],
                "clang": lock["tools"]["wasi-sdk"]["clang_version"],
                "wasm-tools": lock["tools"]["wasm-tools"]["version"],
                "ndk_schema": ndk_data["schema_version"],
                "sdk_schema": sdk_data["schema_version"],
            },
            "source": {
                "path": "source",
                "revision": source_data["source"]["revision"],
                "dirty": source_data["source"]["dirty"],
                "manifest": "source/source.json",
            },
            "core": sdk_data["identity"],
            "packages": {
                "source": {"path": "source", "manifest": "source/source.json"},
                "ndk": {"path": "ndk", "manifest": "ndk/ndk.json",
                        "sha256": file_sha256(staged / "ndk/ndk.json")},
                "host_sdk": {"path": "host-sdk", "manifest": "host-sdk/sdk.json",
                             "sha256": file_sha256(staged / "host-sdk/sdk.json")},
            },
            "toolchain": toolchain,
            "files": files,
        }
        publish_package(staged, output, "manifest.json", manifest)
    return {"output": str(output), "identity": manifest["core"], "files": len(files)}


def source_project(args, project):
    from source_package import build_project, build_source, read_source

    output = new_output(args.output, project)
    if args.command == "init":
        source = resolve_path(args.source, project)
        if output.is_relative_to(source):
            raise ValueError(f"project output overlaps the source package: {source}")
        manifest, manifest_sha256 = read_source(source, file_inventory(source))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".source-", dir=output.parent) as temporary:
        staged = Path(temporary) / "project"
        if args.command == "export-source":
            manifest = build_source(project, staged)
            manifest["files"] = file_inventory(staged)
            publish_package(staged, output, "source.json", manifest)
        else:
            build_project(source, staged, manifest)
            if file_inventory(staged) != manifest["files"]:
                raise ValueError("source files changed during initialization")
            publish_package(staged, output, "target/source-origin.json",
                            {"source_sha256": manifest_sha256, "manifest": manifest})
    return {"output": str(output), "version": manifest["version"], "files": len(manifest["files"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    outputs = {"export-ndk": "target/ndk", "export-sdk": "target/host-sdk",
               "export-source": "target/source", "init": "target/project",
               "export-package": "target/package"}
    for name in ("doctor", "prepare", "inspect-lvgl", "verify-package", *outputs):
        command = commands.add_parser(name)
        command.add_argument("--project", default=".", help="project directory (default: cwd)")
        if name not in ("export-source", "init", "verify-package"):
            command.add_argument("--cache", help="tool cache, relative to project or absolute")
        if name in ("doctor", "prepare", "inspect-lvgl", "export-ndk", "export-package"):
            command.add_argument("--sdk", help="existing wasi-sdk; overrides WASI_SDK_PATH")
        if name in ("doctor", "prepare"):
            command.add_argument("--with-zig", action="store_true", help="include locked Zig tools")
        elif name in outputs:
            command.add_argument("--output", default=outputs[name],
                                 help="new output directory, relative to project or absolute")
        if name == "verify-package":
            command.add_argument("--package", default="target/package",
                                 help="package directory to verify, relative to project or absolute")
            command.add_argument("--allow-dirty", action="store_true",
                                 help="accept a package whose source snapshot is marked dirty")
        if name == "init":
            command.add_argument("--source", required=True, help="verified source package directory")
        if name == "inspect-lvgl":
            command.add_argument("--source", required=True, help="LVGL source directory")
            command.add_argument("--config", required=True, help="lv_conf.h file or its directory")
        if name == "export-ndk":
            command.add_argument("--build-dir", default="target/wasm", help="isolated core build directory inside project/target")
            command.add_argument("--source", help="LVGL source directory")
            command.add_argument("--config", help="lv_conf.h file")
            command.add_argument("--bridge-features", help="semicolon-separated managed callbacks; empty selects the base bridge")
        if name == "export-package":
            command.add_argument("--allow-dirty", action="store_true",
                                 help="allow a development package from a dirty checkout")
        if name == "export-sdk":
            command.add_argument("--ndk", default="target/ndk", help="verified NDK directory")
            command.add_argument("--core", default="target/wasm/liblvgl.wasm", help="core linked with the selected NDK")
        command.add_argument("--json", action="store_true", help="print machine-readable results")
        if name == "prepare":
            command.add_argument("--offline", action="store_true", help="never download tools")
    args = parser.parse_args()
    result = {"schema_version": 1, "command": args.command, "ok": False}
    try:
        if sys.version_info < (3, 9):
            raise ValueError("Python 3.9+ is required")
        host = host_platform()
        lock = json.loads(Path(__file__).with_name("tools.lock.json").read_text())
        if lock["schema_version"] != 1:
            raise ValueError("unsupported tool lock schema")
        project = Path(args.project).expanduser().resolve(strict=True)
        if not project.is_dir():
            raise ValueError(f"project must be an existing directory: {project}")
        cache = resolve_path(getattr(args, "cache", None) or "target/toolchains", project)
        sdk_value = getattr(args, "sdk", None) or os.environ.get("WASI_SDK_PATH")
        sdk = resolve_path(sdk_value, project) if sdk_value else None
        result.update(host=host, target=lock["target"], project=str(project), cache=str(cache))
        if args.command == "inspect-lvgl":
            library = Path(__file__).resolve().parents[1] / "generator"
            if not (library / "lvgl.py").is_file():
                raise ValueError("inspect-lvgl requires generator/ beside toolchains/ in the source package")
            sys.dont_write_bytecode = True
            sys.path.insert(0, str(library))
            from lvgl import inspect_source

            result["tools"] = tool_report(args, lock, host, cache, sdk, names=["wasi-sdk"])
            selected = result["tools"]["wasi-sdk"]
            if selected["ok"]:
                result["lvgl"] = inspect_source(resolve_path(args.source, project),
                                                resolve_path(args.config, project),
                                                Path(selected["path"]))
        elif args.command == "verify-package":
            result.update(verify_package(resolve_path(args.package, project), args.allow_dirty))
        elif args.command == "export-ndk":
            result.update(export_ndk(args, lock, host, project, cache, sdk))
        elif args.command == "export-package":
            result.update(export_package(args, lock, host, project, cache, sdk))
        elif args.command == "export-sdk":
            result.update(export_sdk(args, lock, host, project, cache))
        elif args.command in ("export-source", "init"):
            result.update(source_project(args, project))
        elif args.command == "prepare":
            import fcntl
            cache_directory(cache)
            # Nonblocking: a second process must not publish into the same cache.
            descriptor = os.open(cache / ".prepare.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "a") as handle:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as error:
                    raise ValueError(f"another prepare is using cache: {cache}") from error
                result["tools"] = tool_report(args, lock, host, cache, sdk)
        else:
            result["tools"] = tool_report(args, lock, host, cache, sdk)
            result["prerequisites"] = {
                "python": {"ok": True, "path": sys.executable, "version": platform.python_version()},
                "cmake": prerequisite("cmake", (3, 25, 0)),
                "ninja": prerequisite("ninja", (1, 0, 0)),
            }
        result["ok"] = all(item["ok"] for section in ("tools", "prerequisites")
                           for item in result.get(section, {}).values())
    except (OSError, ValueError, KeyError, ImportError, RuntimeError, subprocess.SubprocessError) as error:
        result["error"] = str(error)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if "lvgl" in result:
            report = result["lvgl"]
            version = report["version"]
            print(f"LVGL: {version['major']}.{version['minor']}.{version['patch']}"
                  f"{version['info']}  {report['source']} ({report['layout']})")
            print(f"Configuration: {report['config']}")
            print("Header inspection only; build and runtime verification have not run.")
        if "output" in result:
            label = {"export-ndk": "NDK", "export-sdk": "SDK", "export-source": "Source",
                     "init": "Project", "export-package": "Package", "verify-package": "Package"}
            if "output" in result:
                print(f"{label[args.command]}: {result['output']}")
        for section in ("tools", "prerequisites"):
            for name, report in result.get(section, {}).items():
                detail = (f"{report['version']}  {report['path']}" if report["ok"] else report["error"])
                print(f"{name}: {detail}")
        if "error" in result:
            print(result["error"], file=sys.stderr)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
