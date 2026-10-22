"""Create source snapshots and initialize writable build projects."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def git(project, *arguments):
    return subprocess.check_output(["git", "-C", str(project), *arguments])


def executable_files(root, paths):
    return sorted(name for name in paths if (root / name).stat().st_mode & 0o111)


def copy_files(source, output, paths, executables):
    for name in paths:
        path = source / name
        for parent in (path, *path.parents):
            if parent == source:
                break
            if parent.is_symlink():
                raise ValueError(f"source contains a symbolic link: {parent}")
        if not path.is_file():
            raise ValueError(f"source must be a regular file: {path}")
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
        destination.chmod(0o755 if name in executables else 0o644)


def build_source(project, output):
    top = Path(git(project, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    if top != project:
        raise ValueError(f"export-source requires the checkout root: {top}")
    paths = sorted(git(project, "ls-files", "-z").decode().rstrip("\0").split("\0"))
    for name in paths:
        path = Path(name)
        if (not name or path.is_absolute() or ".." in path.parts
                or any(part in (".git", ".local", "target", "node_modules") for part in path.parts)):
            raise ValueError(f"tracked local or build files cannot be exported: {name}")
    executables = executable_files(project, paths)
    copy_files(project, output, paths, executables)
    package = json.loads((output / "package.json").read_text())
    if (not isinstance(package, dict) or package.get("name") != "liblvgl-wasm" or not isinstance(package.get("version"), str)
            or not package["version"]):
        raise ValueError("export-source requires the liblvgl-wasm source checkout")
    revision = git(project, "rev-parse", "HEAD").decode().strip()
    dirty = subprocess.run(["git", "-C", str(project), "diff", "--quiet", "HEAD", "--"])
    if dirty.returncode not in (0, 1):
        dirty.check_returncode()
    return {"schema_version": 1, "kind": "liblvgl-wasm-source", "version": package["version"],
            "source": {"revision": revision, "dirty": dirty.returncode == 1},
            "executables": executables}


def read_source(source, inventory):
    if "source.json" not in inventory:
        raise ValueError(f"missing source.json at {source}; run export-source")
    manifest_sha256 = inventory.pop("source.json")
    raw = (source / "source.json").read_bytes()
    manifest = json.loads(raw)
    if (hashlib.sha256(raw).hexdigest() != manifest_sha256 or not isinstance(manifest, dict)
            or manifest.get("schema_version") != 1 or manifest.get("kind") != "liblvgl-wasm-source"
            or not isinstance(manifest.get("version"), str) or not manifest["version"]
            or not inventory or manifest.get("files") != inventory
            or manifest.get("executables") != executable_files(source, inventory)):
        raise ValueError(f"source schema or file integrity mismatch: {source}")
    package = json.loads((source / "package.json").read_text())
    if (not isinstance(package, dict) or package.get("name") != "liblvgl-wasm"
            or package.get("version") != manifest["version"]):
        raise ValueError(f"source package version mismatch: {source}")
    return manifest, manifest_sha256


def build_project(source, output, manifest):
    if output.resolve().is_relative_to(source.resolve()):
        raise ValueError(f"project output overlaps the source package: {source}")
    copy_files(source, output, manifest["files"], manifest["executables"])
    (output / "target").mkdir()
