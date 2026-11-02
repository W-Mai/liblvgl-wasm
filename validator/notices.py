"""Copy pinned feature-validator attribution into a staged TypeScript SDK."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile


MANIFEST_SHA256 = "c119bcba3b5b4e7c1ef945ae17801561a5378ef735a9cb9d16d999c544ad87e6"
MAX_MATERIAL_BYTES = 16 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular_file(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError(f"notice material must be a regular file: {path}")
        data = source.read(MAX_MATERIAL_BYTES + 1)
    if len(data) > MAX_MATERIAL_BYTES:
        raise ValueError(f"notice material exceeds size limit: {path}")
    return data


def contents(root):
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f"notice material directory must not be a symbolic link: {root}")
    files, total = {}, 0
    def fail(error):
        raise error
    for directory, directories, names in os.walk(root, onerror=fail, followlinks=False):
        directories.sort()
        names.sort()
        for name in directories:
            if (Path(directory) / name).is_symlink():
                raise ValueError("notice material contains a symbolic link")
        for name in names:
            path = Path(directory) / name
            data = regular_file(path)
            total += len(data)
            if total > MAX_MATERIAL_BYTES or len(files) >= 4096:
                raise ValueError("notice material inventory exceeds size limit")
            files[path.relative_to(root).as_posix()] = data
    return files


def parse_manifest(data):
    if digest(data) != MANIFEST_SHA256:
        raise ValueError("validator notice manifest identity mismatch")
    manifest = json.loads(data)
    if manifest.get("schema_version") != 1 or manifest.get("kind") != "lvw-feature-validator-notices":
        raise ValueError("unsupported validator notice manifest")
    return manifest


def verify_noble(project):
    """Verify the pinned noble package inputs and return its recorded identity."""
    project = Path(project).resolve(strict=True)
    materials = project / "third_party/validator"
    if materials.is_symlink() or not materials.is_dir():
        raise ValueError("validator notice material directory must not be a symbolic link")
    noble = parse_manifest(regular_file(materials / "manifest.json"))["noble"]
    dependency = project / "node_modules"
    for name, sha256 in noble["inputs"].items():
        if digest(regular_file(dependency / name)) != sha256:
            raise ValueError(f"noble bundle input identity mismatch: {name}")
    if digest(regular_file(dependency / "@noble/hashes/LICENSE")) != noble["license_sha256"]:
        raise ValueError("noble source license identity mismatch")
    return noble


def copy_notices(project, noble_license, destination):
    """Validate and atomically copy notices beside the existing TypeScript SDK license."""
    project = Path(project).resolve(strict=True)
    noble_license = Path(noble_license)
    destination = Path(destination)
    materials = project / "third_party/validator"
    if destination.is_symlink() or destination.exists():
        raise ValueError(f"notice output already exists: {destination}")
    if noble_license.name != "LICENSE-noble-hashes.txt" or destination.name != "validator" or destination.parent.name != "licenses":
        raise ValueError("notice output must be TypeScript licenses/validator beside LICENSE-noble-hashes.txt")
    if destination.parent.parent.resolve() != noble_license.parent.resolve():
        raise ValueError("notice output and noble license must belong to the same TypeScript SDK")
    if destination.parent.is_symlink():
        raise ValueError("notice output parent must not be a symbolic link")
    target = destination.resolve()
    source = materials.resolve(strict=True)
    if target.is_relative_to(source) or source.is_relative_to(target):
        raise ValueError("notice output overlaps material source")

    snapshot = contents(materials)
    manifest_bytes = snapshot.pop("manifest.json", b"")
    manifest = parse_manifest(manifest_bytes)
    expected = manifest["files"]
    if set(snapshot) != set(expected):
        raise ValueError("validator notice inventory mismatch")
    for name, data in snapshot.items():
        if digest(data) != expected[name]["sha256"]:
            raise ValueError(f"validator notice identity mismatch: {name}")
    cargo_lock = regular_file(project / "validator/Cargo.lock")
    if digest(cargo_lock) != manifest["validator_cargo_lock_sha256"]:
        raise ValueError("validator Cargo.lock does not match notice materials")
    noble = verify_noble(project)
    sdk_license = regular_file(noble_license)
    if digest(sdk_license) != noble["license_sha256"]:
        raise ValueError("TypeScript SDK noble license identity mismatch")

    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".validator-notices-", dir=destination.parent) as temporary:
        staged = Path(temporary) / "validator"
        staged.mkdir()
        for name, data in snapshot.items():
            path = staged / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (staged / "manifest.json").write_bytes(manifest_bytes)
        if contents(staged) != {**snapshot, "manifest.json": manifest_bytes}:
            raise ValueError("staged validator notices differ from the verified snapshot")
        if regular_file(noble_license) != sdk_license or regular_file(project / "validator/Cargo.lock") != cargo_lock:
            raise ValueError("validator notice inputs changed during collection")
        if verify_noble(project) != noble:
            raise ValueError("noble bundle inputs changed during collection")
        if destination.is_symlink() or destination.exists():
            raise ValueError(f"notice output appeared during collection: {destination}")
        staged.rename(destination)
    return {"kind": manifest["kind"], "manifest_sha256": MANIFEST_SHA256,
            "noble_license_sha256": noble["license_sha256"], "files": len(snapshot)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--noble-license", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(copy_notices(args.project, args.noble_license, args.output)))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(str(error))
