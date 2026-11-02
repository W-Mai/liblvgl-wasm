"""Build a self-contained feature validator from a private helper data snapshot."""

import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent.parent
INPUTS = (
    "bindings/typescript/src/feature-validator-worker.ts",
    "bindings/typescript/src/feature-validator.ts",
    "bindings/typescript/src/feature-validator-policy.ts",
    "bindings/typescript/src/wasm-facts.ts",
    "validator/verify-policy.ts",
    "tsconfig.feature-worker.json",
    "tsconfig.feature-validator.json",
)

spec = importlib.util.spec_from_file_location("validator_generate_data", ROOT / "validator/generate-data.py")
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


def build(output):
    output = output.absolute()
    target = ROOT / "target/validator"
    target.mkdir(parents=True, exist_ok=True)
    if output.name != "feature-validator.js" or not output.parent.resolve().is_relative_to(target.resolve()):
        raise ValueError("feature worker output must be feature-validator.js under target/validator")
    output.parent.mkdir(parents=True, exist_ok=True)
    output = output.parent.resolve() / output.name
    lock_path = output.with_name(f".{output.name}.lock")
    descriptor = os.open(lock_path, os.O_CREAT | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "w") as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise ValueError("feature worker lock must be a regular file")
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError(f"feature worker build is already active: {output}") from error
        output.unlink(missing_ok=True)
        snapshots = {name: (ROOT / name).read_bytes() for name in INPUTS}
        with tempfile.TemporaryDirectory(prefix=".feature-worker.", dir=output.parent) as directory:
            stage = Path(directory)
            helper_data = stage / "helper-data.json"
            subprocess.run(["sh", ROOT / "validator/build-data.sh", helper_data], check=True)
            with helper_data.open("rb") as source:
                raw = source.read(24 * 1024 * 1024 + 1)
            if len(raw) > 24 * 1024 * 1024:
                raise ValueError("feature helper data exceeds size limit")
            data = json.loads(raw, object_pairs_hook=generator.object_without_duplicates)
            if not isinstance(data, dict) or set(data) != {"helperBase64", "helperSha256", "policyVersion", "features"}:
                raise ValueError("invalid feature helper data")
            encoded, digest = data["helperBase64"], data["helperSha256"]
            if not isinstance(encoded, str) or not isinstance(digest, str):
                raise ValueError("invalid feature helper identity")
            try:
                helper = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError) as error:
                raise ValueError("invalid feature helper encoding") from error
            if len(helper) > generator.MAX_HELPER_BYTES or hashlib.sha256(helper).hexdigest() != digest:
                raise ValueError("feature helper identity mismatch")
            generator.inspect_helper(helper)
            for name, contents in snapshots.items():
                destination = stage / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(contents)
            generated = stage / "target/validator/generated"
            generated.mkdir(parents=True)
            policy = generated / "policy.json"
            policy_source = json.dumps({"policyVersion": data["policyVersion"], "features": data["features"]})
            policy.write_text(policy_source)
            metadata = generator.policy_metadata(policy)
            helper_path = generated / "helper.wasm"
            helper_path.write_bytes(helper)
            subprocess.run(["bun", "validator/verify-policy.ts", helper_path, policy], cwd=stage, check=True, timeout=30)
            if helper_path.read_bytes() != helper or policy.read_text() != policy_source:
                raise ValueError("feature helper or policy changed during verification")
            entries = [[item["name"], item["mask"]] for item in metadata["features"]]
            helper_source = (
                f"export const HELPER_BASE64: string = {json.dumps(encoded)};\n"
                f"export const HELPER_SHA256: string = {json.dumps(digest)};\n"
                f"export const POLICY_VERSION: number = {metadata['policyVersion']};\n"
                f"export const FEATURE_MASKS: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries({json.dumps(entries)}));\n"
            )
            (generated / "helper-data.ts").write_text(helper_source)
            os.symlink(ROOT / "node_modules", stage / "node_modules", target_is_directory=True)
            tsc = ROOT / "node_modules/typescript/bin/tsc"
            subprocess.run(["bun", tsc, "--project", "tsconfig.feature-worker.json"], cwd=stage, check=True)
            worker = stage / "worker.js"
            subprocess.run(["bun", "build", "bindings/typescript/src/feature-validator-worker.ts", "--target", "browser", "--format", "iife", "--outfile", worker], cwd=stage, check=True)
            if (generated / "helper-data.ts").read_text() != helper_source:
                raise ValueError("feature helper data changed during worker build")
            worker_source = "export const FEATURE_WORKER_SOURCE = " + json.dumps(worker.read_text()) + ";\n"
            (generated / "worker-source.ts").write_text(worker_source)
            subprocess.run(["bun", tsc, "--project", "tsconfig.feature-validator.json"], cwd=stage, check=True)
            bundle = stage / "feature-validator.js"
            subprocess.run(["bun", "build", "bindings/typescript/src/feature-validator.ts", "--target", "browser", "--format", "esm", "--outfile", bundle], cwd=stage, check=True)
            if (generated / "helper-data.ts").read_text() != helper_source:
                raise ValueError("feature helper data changed during bundle build")
            if (generated / "worker-source.ts").read_text() != worker_source:
                raise ValueError("feature worker source changed during bundle build")
            for name, contents in snapshots.items():
                if (ROOT / name).read_bytes() != contents or (stage / name).read_bytes() != contents:
                    raise ValueError(f"feature worker input changed during build: {name}")
            os.replace(bundle, output)


if __name__ == "__main__":
    if len(sys.argv) > 2:
        raise SystemExit("usage: build-worker.sh [output-js]")
    build(Path(sys.argv[1]) if len(sys.argv) == 2 else ROOT / "target/validator/feature-validator.js")
