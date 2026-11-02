"""Build a bounded feature validator with remapped compiler source paths."""

import fcntl
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent.parent
SEPARATOR = "\x1f"


def path_prefixes(environment):
    home = Path(environment.get("HOME") or Path.home()).expanduser().absolute()
    cargo = Path(environment.get("CARGO_HOME") or home / ".cargo").expanduser().absolute()
    rustup = Path(environment.get("RUSTUP_HOME") or home / ".rustup").expanduser().absolute()
    temporary = Path(environment.get("TMPDIR") or tempfile.gettempdir()).expanduser().absolute()
    target = Path(environment.get("LVW_VALIDATOR_TARGET_DIR") or ROOT / "target/validator/build").expanduser().absolute()
    prefixes = set()
    for path in (ROOT, cargo, rustup, temporary, target, home):
        for value in (str(path), str(path.resolve())):
            if SEPARATOR in value:
                raise ValueError("unit separator is not allowed in build paths")
            if value == os.path.sep:
                raise ValueError("build path cannot be the filesystem root")
            prefixes.add(value.rstrip(os.path.sep))
    return sorted(prefixes, key=lambda value: (len(value), value))


def build(output):
    output = Path(output).expanduser().absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    lock_path = output.with_name(f".{output.name}.lock")
    descriptor = os.open(lock_path, os.O_CREAT | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "w") as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise ValueError("feature helper lock must be a regular file")
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError(f"feature helper build is already active: {output}") from error
        output.unlink(missing_ok=True)
        environment = dict(os.environ)
        environment["RUSTUP_TOOLCHAIN"] = "1.92.0"
        compiler = environment.get("RUSTC") or "rustc"
        version = subprocess.check_output([compiler, "--version"], env=environment, text=True).strip()
        if not version.startswith("rustc 1.92.0 "):
            raise ValueError(f"feature validator requires Rust 1.92.0; found {version}")
        prefixes = path_prefixes(environment)
        flags = ["-C", "link-arg=--initial-memory=2097152", "-C", "link-arg=--max-memory=268435456"]
        flags.extend(f"--remap-path-prefix={prefix}=/lvw-source" for prefix in prefixes)
        environment.pop("RUSTFLAGS", None)
        environment["CARGO_ENCODED_RUSTFLAGS"] = SEPARATOR.join(flags)
        target = Path(environment.get("LVW_VALIDATOR_TARGET_DIR") or ROOT / "target/validator/build").expanduser().absolute()
        environment["CARGO_TARGET_DIR"] = str(target)
        subprocess.run(["cargo", "build", "--manifest-path", ROOT / "validator/Cargo.toml", "--locked",
                        "--lib", "--release", "--target", "wasm32-unknown-unknown"], env=environment, check=True)
        artifact = (target / "wasm32-unknown-unknown/release/lvw_feature_validator.wasm").read_bytes()
        for prefix in prefixes:
            if os.fsencode(prefix) in artifact:
                raise ValueError(f"feature helper contains an unremapped build path: {prefix}")
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix=".feature-validator.", delete=False) as staged:
            temporary = Path(staged.name)
            try:
                staged.write(artifact)
                staged.close()
                os.replace(temporary, output)
            finally:
                temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) > 2:
        raise SystemExit("usage: build.sh [output-file]")
    build(Path(sys.argv[1]) if len(sys.argv) == 2 else ROOT / "target/validator/feature-validator.wasm")
