"""Serialize operations that change one configured core build tree."""

from contextlib import contextmanager
import fcntl
import importlib.util
import os
from pathlib import Path
import subprocess
import sys


@contextmanager
def core_build_lock(build: Path, project: Path):
    target = (project / "target").resolve()
    build = build.resolve()
    if build == target or not build.is_relative_to(target):
        raise ValueError(f"LVW_BUILD_DIR must be inside {target}")
    build.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(build / ".lvw-core-build.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError(f"core build already running: {build}") from error
        (build / "api-verification-bounded.json").unlink(missing_ok=True)
        yield lock.fileno()


def check_fd(build: Path, descriptor: int) -> None:
    held = os.fstat(descriptor)
    expected = os.stat(build / ".lvw-core-build.lock", follow_symlinks=False)
    if (held.st_dev, held.st_ino) != (expected.st_dev, expected.st_ino):
        raise ValueError("invalid core build lock descriptor")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise ValueError(f"core build already running: {build}") from error


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ("core", "bounded", "check-fd"):
        raise ValueError("expected core or bounded")
    project = Path(__file__).resolve().parents[1]
    build = Path(os.environ.get("LVW_BUILD_DIR", project / "target/wasm")).resolve()
    if sys.argv[1] == "check-fd":
        check_fd(build, int(os.environ["LVW_CORE_LOCK_FD"]))
        return 0
    with core_build_lock(build, project) as descriptor:
        env = dict(os.environ, LVW_BUILD_DIR=str(build), LVW_CORE_LOCK_FD=str(descriptor))
        if sys.argv[1] == "core":
            return subprocess.run(["sh", str(project / "scripts/build-core-impl.sh")], env=env, pass_fds=(descriptor,)).returncode
        spec = importlib.util.spec_from_file_location("lvw_bounded_build", project / "scripts/build-bounded-core.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.main(descriptor)
        return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"core build failed: {error}", file=sys.stderr)
        sys.exit(1)
