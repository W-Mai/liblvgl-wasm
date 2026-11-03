"""Build the independent C application used by LVGL label adapter tests."""

import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
TARGET = (ROOT / "target").resolve()
FILES = ("lvgl-label-app.wasm", "lvgl-label-app-fail-init.wasm")


def include_paths(ndk: Path | None) -> list[Path]:
    if ndk is not None:
        root = ndk.resolve() / "include"
        return [root, root / "lvgl/config"]
    build = TARGET / "wasm"
    cache = (build / "CMakeCache.txt").read_text().splitlines()
    def value(name: str) -> str:
        matches = [line.partition("=")[2] for line in cache if line.startswith(name + ":") and "=" in line]
        if len(matches) != 1:
            raise ValueError(f"missing or duplicate {name} in CMake cache")
        return matches[0]
    source = Path(value("FETCHCONTENT_SOURCE_DIR_LVGL") or build / "_deps/lvgl-src")
    config = Path(value("LVW_CONF_PATH"))
    if not source.is_dir() or not config.is_file():
        raise ValueError("selected LVGL source or configuration is missing")
    return [build / "include", source / "include", source, config.parent]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=TARGET / "validator", help="output directory inside target")
    parser.add_argument("--ndk", type=Path, help="use headers from this relocated NDK")
    args = parser.parse_args()
    output = args.output.resolve()
    if output == TARGET or not output.is_relative_to(TARGET):
        parser.error("--output must be a directory inside the project target directory")
    if args.ndk is not None:
        ndk = args.ndk.resolve()
        if output == ndk or output.is_relative_to(ndk) or ndk.is_relative_to(output):
            parser.error("--output and --ndk must not overlap")
    TARGET.mkdir(parents=True, exist_ok=True)
    lock_dir = TARGET / ".lvgl-label-fixture-locks"
    lock_dir.mkdir(exist_ok=True)
    key = hashlib.sha256(os.fsencode(output)).hexdigest()
    descriptor = os.open(lock_dir / f"{key}.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError(f"LVGL label fixture output is already being built: {output}") from error
        output.mkdir(parents=True, exist_ok=True)
        for name in FILES:
            (output / name).unlink(missing_ok=True)
        try:
            sdk = Path(subprocess.check_output(["sh", str(ROOT / "scripts/resolve-wasi-sdk.sh"), str(ROOT)], text=True).strip())
            includes = include_paths(args.ndk)
            with tempfile.TemporaryDirectory(prefix=".lvgl-label-app-", dir=output) as directory:
                work = Path(directory)
                source = work / "app.c"
                source.write_bytes((ROOT / "validator/lvgl-label-app.c").read_bytes())
                for name, defines in zip(FILES, ([], ["-DLVW_TEST_INIT_FAILURE=1"])):
                    staged = work / name
                    subprocess.run([str(sdk / "bin/clang"), "--target=wasm32-wasip1", "-std=c11", "-O2", "-nostdlib",
                                    "-Wall", "-Wextra", "-Werror", "-DLV_CONF_INCLUDE_SIMPLE=1", "-DLV_KCONFIG_IGNORE=1",
                                    "-DLV_LVGL_H_INCLUDE_SIMPLE=1", *(f"-I{path}" for path in includes),
                                    "-Wl,--no-entry", "-Wl,--export-memory", "-Wl,--max-memory=2097152", *defines,
                                    str(source), "-o", str(staged)], check=True, pass_fds=(descriptor,))
                    subprocess.run(["wasm-tools", "validate", "--features=wasm1,bulk-memory", str(staged)], check=True, pass_fds=(descriptor,))
                for name in FILES:
                    os.replace(work / name, output / name)
        except BaseException:
            for name in FILES:
                (output / name).unlink(missing_ok=True)
            raise


if __name__ == "__main__":
    main()
