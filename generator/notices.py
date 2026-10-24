"""Collect package attribution from the selected LVGL source and pinned runtimes."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile


NOTICE_NAME = re.compile(r"^(?:licen[cs]e|copying|copyrights?|ofl|ufl)(?:[._-]|$)", re.I)
NOTICE_TEXT = re.compile(rb"copyright|licen[cs]e|permission is hereby|redistribut|SPDX", re.I)
IGNORED = {".git", ".svn", ".local", "target", "build", "node_modules", "__pycache__"}


def source_files(root):
    def fail(error):
        raise error

    for directory, directories, filenames in os.walk(root, onerror=fail):
        directories[:] = sorted(name for name in directories if name not in IGNORED)
        for name in directories + sorted(filenames):
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError(f"source material must not be a symbolic link: {path}")
            if name in filenames:
                if not path.is_file():
                    raise ValueError(f"source material must be a regular file: {path}")
                yield path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inventory(root):
    return {path.relative_to(root).as_posix(): digest(path.read_bytes()) for path in source_files(root)}


def tree_digest(files):
    return digest(json.dumps(files, sort_keys=True, separators=(",", ":")).encode())


def copy(source, destination):
    data = source.read_bytes()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return digest(data)


def relative_path(name):
    path = Path(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or not name:
        raise ValueError(f"invalid material path: {name}")
    return path


def collect(source, materials, report, output):
    if Path(report["source"]).resolve() != source:
        raise ValueError("LVGL source report belongs to a different source directory")
    snapshot = materials / "runtime"
    pinned = json.loads((snapshot / "manifest.json").read_text())
    actual = inventory(snapshot)
    actual.pop("manifest.json")
    if actual != pinned["files"]:
        raise ValueError("pinned runtime materials differ from their manifest")
    runtime = output / "runtime"
    for name in pinned["files"]:
        if name.startswith(("wasi-libc/", "llvm/", "zig/")):
            if copy(snapshot / name, runtime / name) != pinned["files"][name]:
                raise ValueError(f"runtime material changed during collection: {name}")

    selected = {}
    for path in source_files(source):
        relative = path.relative_to(source)
        standalone = NOTICE_NAME.match(path.name) or "font_license" in relative.parts
        native = relative.parts[0] in {"src", "include"}
        if standalone or (native and NOTICE_TEXT.search(path.read_bytes())):
            name = relative.as_posix()
            selected[name] = copy(path, runtime / "lvgl" / name)
    if "LICENCE.txt" not in selected:
        raise ValueError("selected LVGL source is missing LICENCE.txt")
    copy(source / "LICENCE.txt", output / "lvgl/LICENCE.txt")

    supplements = []
    for font, entry in pinned["lvgl"]["font_inputs"].items():
        if relative_path(font).name != font:
            raise ValueError(f"font input must be a filename: {font}")
        notice = relative_path(entry["notice"])
        inputs = {}
        supplied_notice = False
        for directory in ("scripts/built_in_font", "scripts/generators/built_in_font"):
            local_notice = source / directory / "font_license" / notice.parent.name / notice.name
            supplied_notice |= local_notice.is_file()
            font_path = source / directory / font
            if font_path.is_file():
                inputs[font_path.relative_to(source).as_posix()] = entry["sha256"]
        if supplied_notice:
            continue
        if not inputs:
            inputs = {name: sha for name, sha in entry["generated_sources"].items()
                      if (source / relative_path(name)).is_file()}
        if not inputs:
            continue
        for name, sha in inputs.items():
            if digest((source / name).read_bytes()) != sha:
                raise ValueError(f"missing local notice for unverified font input: {source / name}")
        destination = "font-supplements/" + notice.parent.name + "/" + notice.name
        if copy(snapshot / "lvgl" / notice, runtime / destination) != pinned["files"]["lvgl/" + notice.as_posix()]:
            raise ValueError(f"font notice changed during collection: {notice}")
        supplements.append({"inputs": inputs, "path": destination,
                            "origin": pinned["lvgl"]["url"], "origin_path": notice.as_posix()})

    configuration = report["configuration"]
    def enabled(name):
        value = configuration.get(name)
        if value is None:
            return False
        if value.get("category") != "integer":
            raise ValueError(f"configuration must be an integer: {name}")
        return int(value["value"]) != 0
    components = {}
    if enabled("LV_USE_FREETYPE"):
        expected = inventory(materials / "freetype")
        shutil.copytree(materials / "freetype", output / "freetype")
        if inventory(output / "freetype") != expected:
            raise ValueError("FreeType materials changed during collection")
        components["freetype"] = {"files": expected}
    if enabled("LV_USE_THORVG") or enabled("LV_USE_THORVG_INTERNAL"):
        thorvg = pinned["thorvg"]
        thorvg_source = source / "src/libs/thorvg"
        if not thorvg_source.is_dir():
            raise ValueError("selected ThorVG source requires matching supplemental materials")
        thorvg_files = inventory(thorvg_source)
        source_identity = tree_digest(thorvg_files)
        embedded = pinned.get("thorvg_embedded", {}).get(source_identity)
        if embedded is not None:
            # These pinned trees carry their complete notices in native source files.
            shutil.copytree(thorvg_source, output / "thorvg")
            thorvg = {**embedded, "source_tree_sha256": source_identity, "files": thorvg_files}
        elif source_identity == thorvg["source_tree_sha256"]:
            if inventory(materials / "thorvg") != thorvg["files"]:
                raise ValueError("pinned ThorVG supplemental materials changed")
            shutil.copytree(materials / "thorvg", output / "thorvg")
        else:
            raise ValueError("selected ThorVG source requires matching supplemental materials")
        if inventory(output / "thorvg") != thorvg["files"]:
            raise ValueError("ThorVG materials changed during collection")
        components["thorvg"] = thorvg

    (runtime / "README.md").write_text(
        "# Runtime and selected-source notices\n\n"
        "The LVGL files are copied from the selected source. Complete native source files retain embedded copyright and license statements; this collection is broader than the linked code.\n\n"
        "WASI, LLVM, Zig, font supplements, and optional native dependencies retain their recorded origins. The manifest identifies source bytes and supplemental material separately. Component paths are relative to the parent licenses directory.\n\n"
        "This collection records supplied materials and verified font supplements; it does not establish license completeness for arbitrary modified source or custom fonts.\n")
    version = report["version"]
    manifest = {"schema_version": 2, "wasi_libc": pinned["wasi_libc"], "llvm": pinned["llvm"],
                "lvgl": {"version": ".".join(str(version[part]) for part in ("major", "minor", "patch")),
                         "files": selected, "font_supplements": supplements},
                "components": components, "files": inventory(runtime)}
    (runtime / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "materials", "report", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    source, materials = args.source.resolve(strict=True), args.materials.resolve(strict=True)
    if args.output.is_symlink():
        raise ValueError("material output must not be a symbolic link")
    output = args.output.resolve()
    if any(output.is_relative_to(path) or path.is_relative_to(output) for path in (source, materials)):
        raise ValueError("material output overlaps its inputs")
    if output.exists() and not (output / "runtime/manifest.json").is_file():
        raise ValueError("existing output is not a generated notice tree")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".lvw-notices-", dir=output.parent) as temporary:
        staged = Path(temporary) / "licenses"
        collect(source, materials, json.loads(args.report.read_text()), staged)
        if output.exists():
            shutil.rmtree(output)
        staged.rename(output)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit(str(error))
