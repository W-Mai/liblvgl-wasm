#!/usr/bin/env python3
"""Copy the browser runtime artifacts required by Pages."""

import json
import shutil
import sys
from pathlib import Path


ASSETS = (
    "studio/main.js",
    "studio/worker.js",
    "browser/main.js",
    "wasm/liblvgl.wasm",
    "wasm/examples/c/liblvgl-c-demo.wasm",
    "apps/c/app.wasm",
    "apps/cpp/app.wasm",
    "apps/rust/app.wasm",
    "apps/ts/app.js",
    "apps/ts/samples/png.js",
    "apps/ts/samples/gif.js",
    "apps/ts/samples/freetype.js",
    "apps/ts/samples/tinyttf.js",
    "apps/ts/samples/svg.js",
    "apps/ts/samples/lottie.js",
)


def module_assets():
    notices = Path(__file__).resolve().parents[1] / "third_party/validator/manifest.json"
    names = ["app.wasm", "events.wasm", "liblvgl.wasm", "worker.js", "controller.js",
             "project.json", "verification.json", "source/app.c", "source/events.c", "source/build.sh",
             "LICENSE-noble-hashes.txt", "licenses/validator/manifest.json"]
    names.extend("licenses/validator/" + name for name in json.loads(notices.read_bytes())["files"])
    return tuple("studio/modules/" + name for name in names)


def main(source, destination):
    source = Path(source) / "target"
    destination = Path(destination) / "target"
    if destination.exists():
        raise ValueError(f"Pages target already exists: {destination}")
    if source.is_symlink():
        raise ValueError(f"Pages artifact contains a symlink: {source}")
    assets = ASSETS + module_assets()
    for asset in assets:
        path = source
        for part in Path(asset).parts:
            path = path / part
            if path.is_symlink():
                raise ValueError(f"Pages artifact contains a symlink: {path}")
        if not path.is_file():
            raise FileNotFoundError(f"missing Pages artifact: {path}")
    for asset in assets:
        output = destination / asset
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / asset, output)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: assemble-pages-target.py SOURCE_ROOT SITE_ROOT")
    main(sys.argv[1], sys.argv[2])
