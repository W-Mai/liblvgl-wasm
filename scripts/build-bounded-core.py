"""Build a fixed-table core without changing its validated baseline."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "generator"))
from bounded_core import MAX_API_BYTES, MAX_CORE_BYTES, check_proof, read, sections, table  # noqa: E402


def run(*args: str, lock_fd: int) -> None:
    subprocess.run(args, check=True, pass_fds=(lock_fd,))


def main(lock_fd: int) -> None:
    target = (ROOT / "target").resolve()
    build = Path(os.environ.get("LVW_BUILD_DIR", target / "wasm")).resolve()
    if build == target or not build.is_relative_to(target):
        raise ValueError(f"LVW_BUILD_DIR must be inside {target}")
    proof = build / "api-verification-bounded.json"
    api = build / "api.json"
    original = build / "liblvgl.wasm"
    original_proof = build / "api-verification.json"
    bounded = build / "liblvgl-bounded.wasm"
    api_bytes = read(api, MAX_API_BYTES)
    original_bytes = read(original, MAX_CORE_BYTES)
    proof_bytes = read(original_proof, 1024 * 1024)
    check_proof(api_bytes, original_bytes, proof_bytes)
    with tempfile.TemporaryDirectory(prefix=".bounded-core-", dir=build) as directory:
        work = Path(directory)
        snapshot_api = work / "api.json"
        snapshot_original = work / "baseline.wasm"
        snapshot_bounded = work / "bounded.wasm"
        snapshot_proof = work / "proof.json"
        snapshot_api.write_bytes(api_bytes)
        snapshot_original.write_bytes(original_bytes)
        run("wasm-tools", "validate", str(snapshot_original), lock_fd=lock_fd)
        run("cmake", "--build", str(build), "--target", "liblvgl_bounded", "--parallel", os.environ.get("CMAKE_BUILD_PARALLEL_LEVEL", "4"), lock_fd=lock_fd)
        bounded_bytes = read(bounded, MAX_CORE_BYTES)
        snapshot_bounded.write_bytes(bounded_bytes)
        run("wasm-tools", "validate", str(snapshot_bounded), lock_fd=lock_fd)
        original_sections, original_table = sections(original_bytes)
        bounded_sections, bounded_table = sections(bounded_bytes)
        if original_sections != bounded_sections or table(original_table, False) != table(bounded_table, True):
            raise ValueError("bounded core differs beyond its table maximum")
        run("python3", "-B", str(ROOT / "generator/signatures.py"), "--api", str(snapshot_api),
            "--wasm", str(snapshot_bounded), "--output", str(snapshot_proof), lock_fd=lock_fd)
        check_proof(api_bytes, bounded_bytes, read(snapshot_proof, 1024 * 1024))
        if (read(api, MAX_API_BYTES) != api_bytes or read(original, MAX_CORE_BYTES) != original_bytes
                or read(original_proof, 1024 * 1024) != proof_bytes or read(bounded, MAX_CORE_BYTES) != bounded_bytes):
            raise ValueError("build inputs or bounded artifact changed during verification")
        os.replace(snapshot_proof, proof)


if __name__ == "__main__":
    sys.exit("use scripts/build-bounded-core.sh")
