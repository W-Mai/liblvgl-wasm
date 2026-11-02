#!/usr/bin/env python3
"""Build the numeric LVGL provider and its C app into the project target directory."""

import argparse
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).resolve().parent
MARKER = ".lvw-multimodule-example"
MARKER_CONTENT = "liblvgl-wasm C multimodule example\n"
OUTPUT_FILES = {MARKER, "lv_provider.wasm", "lv_app.wasm"}


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def check_output(output: Path) -> None:
    if not output.exists():
        return
    if not output.is_dir():
        raise ValueError(f"output is not a directory: {output}")
    entries = {entry.name for entry in output.iterdir()}
    if not entries:
        return
    marker = output / MARKER
    if entries - OUTPUT_FILES or not marker.is_file() or marker.is_symlink() or marker.read_text() != MARKER_CONTENT:
        raise ValueError(f"output is not owned by this example: {output}")
    for entry in output.iterdir():
        if not entry.is_file() or entry.is_symlink():
            raise ValueError(f"unexpected output entry: {entry}")

def publish_output(output: Path, publish: Path, backup: Path) -> None:
    check_output(output)
    if backup.exists() or backup.is_symlink():
        raise ValueError(f"backup path already exists: {backup}")
    try:
        if output.exists():
            os.replace(output, backup)
        os.replace(publish, output)
    except BaseException as error:
        if backup.exists():
            try:
                os.replace(backup, output)
            except OSError as restore_error:
                raise RuntimeError(f"could not restore previous output; it remains at {backup}: {restore_error}") from error
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ndk", required=True, type=Path, help="path to the liblvgl-wasm NDK")
    parser.add_argument("--output", type=Path, default=ROOT / "target/examples/c/multimodule", help="output directory inside target")
    parser.add_argument("--jobs", type=int, default=2, help="maximum parallel build jobs (1-16)")
    args = parser.parse_args()
    if args.jobs < 1 or args.jobs > 16:
        parser.error("--jobs must be between 1 and 16")

    target = (ROOT / "target").resolve()
    output = args.output.resolve()
    ndk = args.ndk.resolve()
    if output == target or not output.is_relative_to(target):
        parser.error("--output must be a directory inside the project target directory")
    if output == ndk or output.is_relative_to(ndk) or ndk.is_relative_to(output):
        parser.error("--output and --ndk must not overlap")
    target.mkdir(parents=True, exist_ok=True)
    lock_path = target / ".multimodule-build.lock"
    descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError(f"output is already being built: {output}") from error
        check_output(output)
        if not ndk.is_dir():
            raise ValueError(f"NDK directory does not exist: {ndk}")
        sdk = Path(subprocess.check_output(["sh", str(ROOT / "scripts/resolve-wasi-sdk.sh"), str(ROOT)], text=True).strip())
        wasm_tools = shutil.which("wasm-tools")
        if not wasm_tools:
            raise ValueError("wasm-tools not found in PATH")
        output.parent.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix=".lvw-multimodule-", dir=output.parent))
        backup = work / "previous"
        published = False
        try:
            build = work / "build"
            publish = work / "output"
            publish.mkdir()
            run(["cmake", "-S", str(SOURCE), "-B", str(build), "-G", "Ninja",
                 f"-DCMAKE_TOOLCHAIN_FILE={sdk / 'share/cmake/wasi-sdk-p1.cmake'}", f"-DCMAKE_PREFIX_PATH={ndk}",
                 "-DCMAKE_BUILD_TYPE=Release"])
            run(["cmake", "--build", str(build), "--parallel", str(args.jobs)])
            shutil.copyfile(build / "lv_provider.wasm", publish / "lv_provider.wasm")
            run([str(sdk / "bin/clang"), "--target=wasm32-wasip1", "-std=c11", "-O2", "-nostdlib",
                 "-Wl,--no-entry", "-Wl,--max-memory=2097152", str(SOURCE / "app.c"), "-o", str(publish / "lv_app.wasm")])
            for name in ("lv_provider.wasm", "lv_app.wasm"):
                run([wasm_tools, "validate", str(publish / name)])
            (publish / MARKER).write_text(MARKER_CONTENT)
            publish_output(output, publish, backup)
            published = True
        finally:
            if published or not backup.exists():
                try:
                    shutil.rmtree(work)
                except OSError as error:
                    print(f"could not remove temporary directory {work}: {error}", file=sys.stderr)
        print(f"Built {output / 'lv_provider.wasm'} and {output / 'lv_app.wasm'}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"build failed: {error}", file=sys.stderr)
        print("Any existing output is not the result of this build.", file=sys.stderr)
        sys.exit(1)
