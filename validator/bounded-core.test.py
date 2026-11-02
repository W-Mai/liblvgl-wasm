"""Check bounded-core build locking and failed-proof invalidation."""

import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "generator"))
from bounded_core import MAX_API_BYTES, MAX_CORE_BYTES, check_proof, read  # noqa: E402


def main() -> None:
    api = read(ROOT / "target/wasm/api.json", MAX_API_BYTES)
    core = read(ROOT / "target/wasm/liblvgl.wasm", MAX_CORE_BYTES)
    original = read(ROOT / "target/wasm/api-verification.json", 1024 * 1024)
    check_proof(api, core, original)
    forged = json.loads(original)
    forged["expected_functions"] = forged["verified_functions"] = 1
    try:
        check_proof(api, core, json.dumps(forged).encode())
    except ValueError:
        pass
    else:
        raise AssertionError("forged proof inventory was accepted")
    with tempfile.TemporaryDirectory(prefix="bounded-core-test-", dir=ROOT / "target") as directory:
        build = Path(directory)
        proof = build / "api-verification-bounded.json"
        proof.write_text("previous proof")
        env = dict(os.environ, LVW_BUILD_DIR=str(build))
        command = ["sh", str(ROOT / "scripts/build-bounded-core.sh")]
        with (build / ".lvw-core-build.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            assert result.returncode != 0 and "already running" in result.stderr
            assert proof.read_text() == "previous proof"
            result = subprocess.run(["sh", str(ROOT / "scripts/build-core.sh")], env=env, capture_output=True, text=True)
            assert result.returncode != 0 and "already running" in result.stderr
            assert proof.read_text() == "previous proof"
        result = subprocess.run(command, env=env, capture_output=True, text=True)
        assert result.returncode != 0 and not proof.exists()
        proof.write_text("previous proof")
        result = subprocess.run(["sh", str(ROOT / "scripts/build-core-impl.sh")], env=env, capture_output=True, text=True)
        assert result.returncode != 0 and proof.read_text() == "previous proof"
        result = subprocess.run(["python3", "-B", str(ROOT / "scripts/build-bounded-core.py")], env=env, capture_output=True, text=True)
        assert result.returncode != 0 and proof.read_text() == "previous proof"
        env["WASI_SDK_PATH"] = str(build / "missing-sdk")
        result = subprocess.run(["sh", str(ROOT / "scripts/build-core.sh")], env=env, capture_output=True, text=True)
        assert result.returncode != 0 and not proof.exists()
    print("bounded core locking and failure cleanup passed")


if __name__ == "__main__":
    main()
