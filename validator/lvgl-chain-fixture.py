"""Build independent C library and app fixtures for an LVGL module graph."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
TARGET = (ROOT / "target").resolve()
FILES = {
    "middle.wasm": ("lvgl-chain-lib.c", False),
    "middle-fail-init.wasm": ("lvgl-chain-lib.c", True),
    "app.wasm": ("lvgl-chain-app.c", False),
    "app-fail-init.wasm": ("lvgl-chain-app.c", True),
}
MARKER = "manifest.json"


def build(ndk: Path, output: Path) -> None:
    ndk = ndk.resolve(strict=True)
    if output.is_symlink():
        raise ValueError("chain output must not be a symlink")
    output = output.resolve()
    if output == TARGET or not output.is_relative_to(TARGET):
        raise ValueError("chain output must be inside the project target directory")
    if output == ndk or output.is_relative_to(ndk) or ndk.is_relative_to(output):
        raise ValueError("chain output and NDK must not overlap")
    if output.exists():
        raise ValueError("chain output already exists")
    if not ndk.is_dir():
        raise ValueError("chain NDK must be a directory")
    if not output.parent.is_dir():
        raise ValueError("chain output parent must exist")

    sdk = Path(subprocess.check_output(["sh", str(ROOT / "scripts/resolve-wasi-sdk.sh"), str(ROOT)], text=True).strip())
    sdk = sdk.resolve(strict=True)
    if output == sdk or output.is_relative_to(sdk) or sdk.is_relative_to(output):
        raise ValueError("chain output and WASI SDK must not overlap")
    includes = [ndk / "include", ndk / "include/lvgl/config"]
    if not (includes[0] / "lvgl/lvgl.h").is_file() or not includes[1].is_dir():
        raise ValueError("chain NDK headers are missing")
    sources = {name: (ROOT / "validator" / name).read_bytes() for name in {item[0] for item in FILES.values()}}
    with tempfile.TemporaryDirectory(prefix=".lvgl-chain-", dir=output.parent) as directory:
        stage = Path(directory)
        for name, source in sources.items():
            (stage / name).write_bytes(source)
        files = {}
        for name, (source, fail_init) in FILES.items():
            path = stage / name
            subprocess.run([str(sdk / "bin/clang"), "--target=wasm32-wasip1", "-std=c11", "-O2", "-nostdlib",
                            "-Wall", "-Wextra", "-Werror", "-DLV_CONF_INCLUDE_SIMPLE=1", "-DLV_KCONFIG_IGNORE=1",
                            "-DLV_LVGL_H_INCLUDE_SIMPLE=1", *(f"-I{include}" for include in includes),
                            "-Wl,--no-entry", "-Wl,--export-memory", "-Wl,--max-memory=2097152",
                            *(["-DLVW_CHAIN_FAIL_INIT=1"] if fail_init else []), str(stage / source), "-o", str(path)],
                           check=True)
            subprocess.run(["wasm-tools", "validate", "--features=wasm1", str(path)], check=True)
            data = path.read_bytes()
            if len(data) > 64 * 1024 * 1024:
                raise ValueError("chain fixture Wasm exceeds limit")
            files[name] = hashlib.sha256(data).hexdigest()
        (stage / MARKER).write_text(json.dumps({"schema_version": 1, "kind": "lvgl-chain-fixtures", "files": files}) + "\n")
        output.mkdir(mode=0o700)
        descriptor = os.open(output, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            def check_output():
                actual = os.stat(output, follow_symlinks=False)
                opened = os.fstat(descriptor)
                if (actual.st_dev, actual.st_ino) != (opened.st_dev, opened.st_ino):
                    raise ValueError("chain output directory changed")

            check_output()
            for name in FILES:
                os.link(stage / name, name, dst_dir_fd=descriptor, follow_symlinks=False)
            check_output()
            os.link(stage / MARKER, MARKER, dst_dir_fd=descriptor, follow_symlinks=False)
            check_output()
        finally:
            os.close(descriptor)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ndk", type=Path, required=True, help="read LVGL headers from this NDK")
    parser.add_argument("--output", type=Path, default=TARGET / "validator/lvgl-chain", help="new output directory inside target")
    args = parser.parse_args()
    build(args.ndk, args.output)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
