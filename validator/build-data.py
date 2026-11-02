"""Build and embed a private feature validator artifact."""

import fcntl
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent.parent
SOURCE_FILES = ("Cargo.toml", "Cargo.lock", "build.sh")
MAX_SOURCE_BYTES = 8 * 1024 * 1024


def source_snapshot():
    source = ROOT / "validator"
    if source.is_symlink():
        raise ValueError("validator source directory must not be a symbolic link")
    paths = [source / name for name in SOURCE_FILES]
    source_dir = source / "src"
    if source_dir.is_symlink() or not source_dir.is_dir():
        raise ValueError("validator source directory must not be a symbolic link")
    for directory, directories, files in os.walk(source_dir, followlinks=False):
        for name in directories:
            if (Path(directory) / name).is_symlink():
                raise ValueError("validator source contains a symbolic link")
        paths.extend(Path(directory) / name for name in files)
        if len(paths) > 4096:
            raise ValueError("validator source snapshot has too many files")
    result, total = {}, 0
    for path in sorted(paths):
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        fd = os.open(path, flags)
        with os.fdopen(fd, "rb") as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                raise ValueError(f"validator source must be a regular file: {path}")
            content = file.read(MAX_SOURCE_BYTES + 1)
        total += len(content)
        if total > MAX_SOURCE_BYTES:
            raise ValueError("validator source snapshot exceeds input limit")
        result[path.relative_to(source).as_posix()] = content
    return result


def build(output):
    output = output.absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    lock_path = output.with_name(f".{output.name}.lock")
    flags = os.O_CREAT | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(lock_path, flags, 0o600)
    with os.fdopen(fd, "w") as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise ValueError("validator data lock must be a regular file")
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError(f"validator data build is already active: {output}") from error
        output.unlink(missing_ok=True)
        directory = ROOT / "target/validator"
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".feature-data.", dir=directory) as temporary:
            staging = Path(temporary)
            source = source_snapshot()
            if source != source_snapshot():
                raise ValueError("validator source changed while taking snapshot")
            project = staging / "project"
            for name, content in source.items():
                path = project / "validator" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            environment = {**os.environ, "RUSTUP_TOOLCHAIN": "1.92.0", "LVW_VALIDATOR_TARGET_DIR": str(staging / "cargo")}
            helper, metadata = staging / "helper.wasm", staging / "policy.json"
            subprocess.run(["sh", project / "validator/build.sh", helper], env=environment, check=True)
            environment.update({"CARGO_TARGET_DIR": environment["LVW_VALIDATOR_TARGET_DIR"], "RUSTFLAGS": ""})
            with metadata.open("wb") as target:
                subprocess.run(["cargo", "run", "--manifest-path", project / "validator/Cargo.toml", "--locked", "--quiet", "--bin", "metadata"], env=environment, stdout=target, check=True)
            if source != source_snapshot():
                raise ValueError("validator source changed during build")
            subprocess.run([sys.executable, "-B", ROOT / "validator/generate-data.py", helper, metadata, output], env=environment, check=True)


if __name__ == "__main__":
    if len(sys.argv) > 2:
        raise SystemExit("usage: build-data.sh [output-json]")
    build(Path(sys.argv[1]) if len(sys.argv) == 2 else ROOT / "target/validator/generated/helper-data.json")
