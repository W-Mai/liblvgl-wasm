#!/usr/bin/env python3
"""Prepare locked compiler tools, build projects, and export LVGL development files."""

import argparse
import ctypes
import hashlib
import http.client
import importlib.util
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


CAPABILITY_SPECS = {
    "core": {"config": None, "imports": (), "exports": ()},
    "timer": {"config": None, "imports": ("timer", "timer_release"),
               "exports": ("lvw_timer_create", "lvw_timer_delete")},
    "animation": {"config": None, "imports": ("anim_exec", "anim_query", "anim_notify", "anim_release"),
                   "exports": ("lvw_anim_start", "lvw_anim_delete", "lvw_anim_exec")},
    "observer": {"config": None, "imports": ("observer", "observer_release"),
                 "exports": ("lvw_observer_create", "lvw_observer_delete")},
    "decoder": {"config": None, "imports": ("decoder_info", "decoder_open", "decoder_area", "decoder_close", "decoder_release"),
                "exports": ("lvw_decoder_create", "lvw_decoder_delete", "lvw_decoder_read", "lvw_decoder_write")},
    "png": {"config": "LV_USE_LODEPNG", "imports": (), "exports": ()},
    "bmp": {"config": "LV_USE_BMP", "imports": (), "exports": ()},
    "gif": {"config": "LV_USE_GIF", "imports": (), "exports": ()},
    "tinyttf": {"config": "LV_USE_TINY_TTF", "imports": (), "exports": ()},
    "freetype": {"config": "LV_USE_FREETYPE", "imports": (), "exports": ()},
    "vector": {"config": "LV_USE_VECTOR_GRAPHIC", "imports": (), "exports": ()},
    "thorvg": {"config": "LV_USE_THORVG", "imports": (), "exports": ()},
    "svg": {"config": "LV_USE_SVG", "imports": (), "exports": ()},
    "lottie": {"config": "LV_USE_LOTTIE", "imports": (), "exports": ()},
}

ADAPTER_SOURCES = {
    "timer": ("bridge/lvw.c", "cmake/timer.cmake"),
    "animation": ("bridge/lvw.c", "cmake/animation.cmake"),
    "observer": ("bridge/lvw.c", "cmake/observer.cmake"),
    "decoder": ("bridge/lvw.c", "cmake/decoder.cmake"),
}


def load_wasm_reader(path):
    """Load the source-matched Wasm reader without relying on the caller's cwd."""
    module_path = Path(path).resolve(strict=True)
    spec = importlib.util.spec_from_file_location("lvw_manifest_wasm", module_path)
    if spec is None or spec.loader is None:
        raise ValueError(f"cannot load Wasm reader: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.read_module


def capability_config(api):
    values = {}
    for entry in api.get("constants", []):
        name = entry.get("name")
        if not isinstance(name, str) or not name.startswith("LV_USE_"):
            continue
        category = entry.get("category")
        if category == "integer" and isinstance(entry.get("value"), str):
            try:
                value = int(entry["value"], 10)
            except ValueError:
                value = None
            values[name] = {"category": category, "value": value,
                            "status": ("enabled" if value is not None and value > 0
                                       else "disabled" if value == 0 else "unknown")}
        else:
            values[name] = {"category": category, "value": None, "status": "unknown"}
    return values


def capability_version(api):
    constants = {entry.get("name"): entry for entry in api.get("constants", [])}
    parts = {}
    for part in ("MAJOR", "MINOR", "PATCH"):
        entry = constants.get(f"LVGL_VERSION_{part}")
        value = entry.get("value") if isinstance(entry, dict) else None
        try:
            parts[part.lower()] = int(value, 10)
        except (TypeError, ValueError):
            parts[part.lower()] = None
    info = constants.get("LVGL_VERSION_INFO", {})
    parts["info"] = info.get("text") if isinstance(info, dict) and info.get("category") == "string" else None
    return parts


def capability_wasm(module):
    def item(entry):
        return {key: entry[key] for key in ("module", "name", "kind", "index", "signature")
                if key in entry}

    imports = [item(entry) for entry in module["imports"]]
    exports = {name: item(entry) for name, entry in sorted(module["exports"].items())}
    return {"imports": imports, "exports": exports, "memories": module["memories"]}


def capability_adapters(source_path):
    adapters = {}
    for name, paths in ADAPTER_SOURCES.items():
        sources = [{"path": path, "sha256": file_sha256(source_path / path)}
                   for path in paths if (source_path / path).is_file()]
        adapters[name] = {"id": f"lvw.{name}", "sources": sources}
    return adapters


def capability_statuses(api, module):
    config = capability_config(api)
    imports = {entry["name"] for entry in module["imports"] if entry["kind"] == "function"
               and entry["module"] == "lvw"}
    exports = set(module["exports"])
    result = {}
    for name, spec in CAPABILITY_SPECS.items():
        config_name = spec["config"]
        config_entry = config.get(config_name) if config_name else None
        declared = "yes" if name == "core" or not config_name or config_name in config else "unknown"
        required_imports = set(spec["imports"])
        required_exports = set(spec["exports"])
        found_imports = required_imports & imports
        found_exports = required_exports & exports
        required = len(required_imports) + len(required_exports)
        found = len(found_imports) + len(found_exports)
        adapted = "not-applicable" if not required else ("enabled" if found == required
                                                          else "unknown" if found else "disabled")
        enabled = ("enabled" if name == "core" else
                   config_entry["status"] if config_entry else
                   "enabled" if adapted == "enabled" else "unknown")
        result[name] = {
            "declared": declared,
            "enabled": enabled,
            "adapted": adapted,
            "runtime_verification": "not-run",
        }
    return result


def build_capability_manifest(package, wasm_reader):
    """Build a capability report entirely from the staged package bytes."""
    package = Path(package).resolve(strict=True)
    source_path = package / "source"
    ndk_path = package / "ndk"
    sdk_path = package / "host-sdk"
    source_manifest_path = source_path / "source.json"
    ndk_manifest_path = ndk_path / "ndk.json"
    sdk_manifest_path = sdk_path / "sdk.json"
    api_path = sdk_path / "metadata/api.json"
    ndk_api_path = ndk_path / "share/liblvgl-wasm/metadata/api.json"
    proof_path = sdk_path / "metadata/verification.json"
    core_path = sdk_path / "runtime/liblvgl.wasm"
    config_path = ndk_path / "share/liblvgl-wasm/config/lv_conf.h"
    required = (source_manifest_path, ndk_manifest_path, sdk_manifest_path,
                api_path, ndk_api_path, proof_path, core_path, config_path)
    for path in required:
        if not path.is_file():
            raise ValueError(f"capability manifest input is missing: {path}")
    source = json.loads(source_manifest_path.read_text())
    ndk = json.loads(ndk_manifest_path.read_text())
    sdk = json.loads(sdk_manifest_path.read_text())
    api_bytes = api_path.read_bytes()
    if ndk_api_path.read_bytes() != api_bytes:
        raise ValueError("NDK and host SDK API metadata differ")
    core_bytes = core_path.read_bytes()
    proof = json.loads(proof_path.read_text())
    api = json.loads(api_bytes)
    revision = source.get("source", {}).get("revision")
    if not isinstance(revision, str) or not revision:
        raise ValueError("capability source identity is missing")
    if not isinstance(api.get("constants"), list) or not isinstance(api.get("declarations"), list):
        raise ValueError("capability API metadata is incomplete")
    module = wasm_reader(core_bytes)
    api_sha256 = hashlib.sha256(api_bytes).hexdigest()
    wasm_sha256 = hashlib.sha256(core_bytes).hexdigest()
    if proof.get("api_sha256") != api_sha256 or proof.get("wasm_sha256") != wasm_sha256:
        raise ValueError("capability inputs disagree with the SDK verification proof")
    reference = ndk.get("reference")
    identity = sdk.get("identity")
    if not isinstance(reference, dict) or not isinstance(identity, dict) or reference != identity:
        raise ValueError("capability inputs disagree on core identity")
    if reference.get("api_sha256") != api_sha256 or reference.get("wasm_sha256") != wasm_sha256:
        raise ValueError("capability inputs disagree on API or core hash")
    declarations = api.get("declarations", [])
    expected = {entry.get("export_name"): entry for entry in declarations
                if entry.get("category") in ("direct_export", "abi_shim")}
    if (proof.get("expected_functions") != len(expected)
            or proof.get("verified_functions") != len(expected)
            or reference.get("expected_functions") != len(expected)
            or reference.get("verified_functions") != len(expected)):
        raise ValueError("capability API verification count does not match declarations")
    for name, entry in expected.items():
        actual = module["exports"].get(name)
        if (not name or not actual or actual.get("kind") != "function"
                or actual.get("signature") != entry.get("wasm_signature")):
            raise ValueError(f"capability API export mismatch: {name}")
    wasm = capability_wasm(module)
    config_values = capability_config(api)
    config_sha256 = hashlib.sha256(config_path.read_bytes()).hexdigest()
    return {
        "schema_version": 1,
        "kind": "liblvgl-wasm-capabilities",
        "identity": {
            "target": sdk.get("target"),
            "source_revision": revision,
            "source_manifest_sha256": file_sha256(source_manifest_path),
            "ndk_manifest_sha256": file_sha256(ndk_manifest_path),
            "sdk_manifest_sha256": file_sha256(sdk_manifest_path),
            "config_sha256": config_sha256,
            "api_sha256": api_sha256,
            "wasm_sha256": wasm_sha256,
        },
        "lvgl": {"version": capability_version(api), "api_functions": len(expected)},
        "toolchain": {"target": sdk.get("target"), "ndk": ndk.get("toolchain"),
                       "host": sdk.get("tools")},
        "api": {"path": "host-sdk/metadata/api.json", "sha256": api_sha256,
                "declarations": len(api.get("declarations", [])),
                "supported_functions": len(expected)},
        "core": {"path": "host-sdk/runtime/liblvgl.wasm", "sha256": wasm_sha256,
                 "imports": len(wasm["imports"]), "exports": len(wasm["exports"]),
                 "memories": len(wasm["memories"])},
        "abi": {"version_export": wasm["exports"].get("lvw_abi_version"),
                "runtime_verification": "not-run"},
        "configuration": {"path": "ndk/share/liblvgl-wasm/config/lv_conf.h",
                           "sha256": config_sha256, "values": config_values},
        "adapters": capability_adapters(source_path),
        "wasm": {"path": "host-sdk/runtime/liblvgl.wasm", **wasm},
        "capabilities": capability_statuses(api, module),
        "verification": {"build": "not-run", "runtime": "not-run"},
        "limitations": [
            "The capability report binds package bytes and metadata; it does not prove source authenticity.",
            "Runtime verification remains not-run until a host executes this exact core identity.",
            "Unknown configuration values remain unknown instead of being treated as disabled.",
        ],
    }


def verify_capability_manifest(package, manifest, source, ndk, sdk):
    entry = manifest.get("capabilities")
    if not isinstance(entry, dict) or entry.get("path") != "liblvgl.manifest.json":
        raise ValueError("package manifest must reference liblvgl.manifest.json")
    path = package_member(package, entry["path"])
    if not path.is_file() or file_sha256(path) != entry.get("sha256"):
        raise ValueError("capability manifest hash mismatch")
    source_reader = package_member(package, source.get("path")) / "generator/wasm.py"
    expected = build_capability_manifest(package, load_wasm_reader(source_reader))
    try:
        actual = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise ValueError("invalid capability manifest") from error
    if actual != expected:
        raise ValueError("capability manifest does not match packaged inputs")
    return actual


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
    capability = verify_capability_manifest(package, manifest, source_entry, ndk, sdk)
    return {"output": str(package), "identity": manifest["core"],
            "capabilities": len(capability["capabilities"]), "files": len(inventory)}


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
        source_data = json.loads((staged / "source/source.json").read_text())
        ndk_data = json.loads((staged / "ndk/ndk.json").read_text())
        sdk_data = json.loads((staged / "host-sdk/sdk.json").read_text())
        reader_path = project / "generator/wasm.py"
        capability = build_capability_manifest(staged, load_wasm_reader(reader_path))
        capability_path = staged / "liblvgl.manifest.json"
        capability_path.write_text(json.dumps(capability, indent=2) + "\n")
        files = file_inventory(staged)
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
            "capabilities": {"path": "liblvgl.manifest.json",
                             "sha256": file_sha256(capability_path)},
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
    return {"output": str(output), "identity": manifest["core"],
            "capabilities": len(capability["capabilities"]), "files": len(files)}


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
