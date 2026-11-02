"""Build the scalar-only C app used by the LVGL core profile tests."""

from pathlib import Path
import argparse
import fcntl
import hashlib
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
TARGET = (ROOT / "target").resolve()
FILES = ("lvgl-core-app.wasm", "lvgl-core-app-fail-init.wasm")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=TARGET / "validator", help="output directory inside target")
    output = parser.parse_args().output.resolve()
    if output == TARGET or not output.is_relative_to(TARGET):
        parser.error("--output must be a directory inside the project target directory")
    TARGET.mkdir(parents=True, exist_ok=True)
    lock_dir = TARGET / ".lvgl-core-fixture-locks"
    lock_dir.mkdir(exist_ok=True)
    key = hashlib.sha256(os.fsencode(output)).hexdigest()
    descriptor = os.open(lock_dir / f"{key}.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError(f"LVGL fixture output is already being built: {output}") from error
        output.mkdir(parents=True, exist_ok=True)
        for name in FILES:
            (output / name).unlink(missing_ok=True)
        try:
            sdk = Path(subprocess.check_output(["sh", str(ROOT / "scripts/resolve-wasi-sdk.sh"), str(ROOT)], text=True).strip())
            with tempfile.TemporaryDirectory(prefix=".lvgl-core-app-", dir=output) as directory:
                work = Path(directory)
                source = work / "app.c"
                source.write_bytes((ROOT / "validator/lvgl-core-app.c").read_bytes())
                for name, defines in zip(FILES, ([], ["-DLVW_TEST_INIT_FAILURE=1"])):
                    staged = work / name
                    subprocess.run([str(sdk / "bin/clang"), "--target=wasm32-wasip1", "-std=c11", "-O2", "-nostdlib",
                                    "-Wl,--no-entry", "-Wl,--export-memory", "-Wl,--max-memory=2097152", *defines,
                                    str(source), "-o", str(staged)], check=True, pass_fds=(descriptor,))
                    subprocess.run(["wasm-tools", "validate", "--features=wasm1", str(staged)], check=True, pass_fds=(descriptor,))
                for name in FILES:
                    os.replace(work / name, output / name)
        except BaseException:
            for name in FILES:
                (output / name).unlink(missing_ok=True)
            raise


if __name__ == "__main__":
    main()
