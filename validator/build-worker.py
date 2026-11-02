"""Build a self-contained feature validator from a private helper data snapshot."""

import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
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
    "bindings/typescript/src/module-graph.ts",
    "bindings/typescript/src/module-manifest.ts",
    "bindings/typescript/src/isolated-resources.ts",
    "bindings/typescript/src/wasi-preview1.ts",
    "generator/wasm.py",
    "validator/build-worker.py",
    "validator/build-worker.sh",
    "validator/build-data.py",
    "validator/build-data.sh",
    "validator/generate-data.py",
    "validator/notices.py",
    "validator/verify-policy.ts",
    "tsconfig.feature-worker.json",
    "tsconfig.feature-validator.json",
)

spec = importlib.util.spec_from_file_location("validator_generate_data", ROOT / "validator/generate-data.py")
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


def rustc_version():
    environment = {**os.environ, "RUSTUP_TOOLCHAIN": "1.92.0"}
    compiler = environment.get("RUSTC") or "rustc"
    version = subprocess.check_output([compiler, "-vV"], env=environment, text=True)
    if not version.startswith("rustc 1.92.0 ") or "\nrelease: 1.92.0\n" not in version:
        raise ValueError("feature validator requires Rust 1.92.0")
    return version


def validator_sources():
    spec = importlib.util.spec_from_file_location("validator_build_data", ROOT / "validator/build-data.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.source_snapshot()


def source_identity(sources, worker_sources):
    files = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(sources.items())}
    encoded = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    worker_files = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(worker_sources.items())}
    worker_encoded = json.dumps(worker_files, sort_keys=True, separators=(",", ":")).encode()
    return {"treeSha256": hashlib.sha256(encoded).hexdigest(), "cargoLockSha256": files["Cargo.lock"],
            "files": files, "workerTreeSha256": hashlib.sha256(worker_encoded).hexdigest(), "workerFiles": worker_files}


def sdk_dependency(stage):
    spec = importlib.util.spec_from_file_location("validator_notices", ROOT / "validator/notices.py")
    notices = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(notices)
    manifest = notices.parse_manifest(notices.regular_file(ROOT / "third_party/validator/manifest.json"))
    noble = notices.verify_noble(ROOT)
    origin = ROOT / "node_modules/@noble/hashes"
    for path in origin.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"noble package contains a symbolic link: {path}")
    destination = stage / "node_modules/@noble/hashes"
    destination.parent.mkdir(parents=True)
    shutil.copytree(origin, destination)
    for name, expected in noble["inputs"].items():
        if hashlib.sha256((stage / "node_modules" / name).read_bytes()).hexdigest() != expected:
            raise ValueError(f"staged noble bundle input differs: {name}")
    if hashlib.sha256((destination / "LICENSE").read_bytes()).hexdigest() != noble["license_sha256"]:
        raise ValueError("staged noble license differs")
    return noble, manifest


def compiler_identity(version, manifest):
    fields = {}
    for line in version.splitlines()[1:]:
        name, separator, value = line.partition(": ")
        if separator:
            if name in fields:
                raise ValueError("duplicate rustc identity field")
            fields[name] = value
    expected = manifest["sources"]["rust"]
    if fields.get("release") != expected["version"] or fields.get("commit-hash") != expected["commit"] or not fields.get("host"):
        raise ValueError("Rust compiler identity differs from validator notices")
    return fields["host"]


def audit_metafile(path, stage, noble):
    metadata = json.loads(path.read_bytes())
    outputs = metadata.get("outputs")
    if not isinstance(outputs, dict) or len(outputs) != 1:
        raise ValueError("invalid feature bundle build metadata")
    output = next(iter(outputs.values()))
    if output.get("imports"):
        raise ValueError("feature bundle must not retain external imports")
    inputs = output.get("inputs")
    if not isinstance(inputs, dict):
        raise ValueError("invalid feature bundle input metadata")
    expected = {name for name in noble["inputs"] if name.endswith(".js")}
    bundled = set()
    modules = (stage / "node_modules").resolve()
    for name, description in inputs.items():
        if not isinstance(description, dict) or description.get("bytesInOutput", 0) <= 0:
            continue
        source = (stage / name).resolve(strict=True)
        if source.is_relative_to(modules):
            relative = source.relative_to(modules).as_posix()
            if relative not in expected:
                raise ValueError(f"unexpected feature bundle dependency: {relative}")
            if hashlib.sha256(source.read_bytes()).hexdigest() != noble["inputs"][relative]:
                raise ValueError(f"feature bundle dependency identity mismatch: {relative}")
            bundled.add(relative)
        elif not source.is_relative_to(stage):
            raise ValueError(f"unexpected feature bundle input: {name}")
    return sorted(bundled)


def build(output, sdk=False):
    output = output.absolute()
    target = ROOT / "target/validator"
    target.mkdir(parents=True, exist_ok=True)
    if (not sdk and output.name != "feature-validator.js") or not output.parent.resolve().is_relative_to(target.resolve()):
        raise ValueError("feature worker output must be under target/validator")
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
        if sdk:
            if output.exists() or output.is_symlink():
                raise ValueError(f"feature SDK output already exists: {output}")
        else:
            output.unlink(missing_ok=True)
        snapshots = {name: (ROOT / name).read_bytes() for name in INPUTS}
        validator_snapshot = validator_sources() if sdk else None
        compiler = rustc_version() if sdk else None
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
            noble, manifest = sdk_dependency(stage) if sdk else (None, None)
            host = compiler_identity(compiler, manifest) if sdk else None
            if not sdk:
                os.symlink(ROOT / "node_modules", stage / "node_modules", target_is_directory=True)
            tsc = ROOT / "node_modules/typescript/bin/tsc"
            subprocess.run(["bun", tsc, "--project", "tsconfig.feature-worker.json"], cwd=stage, check=True)
            worker = stage / "worker.js"
            worker_meta = stage / "worker-metafile.json"
            command = ["bun", "build", "bindings/typescript/src/feature-validator-worker.ts", "--target", "browser", "--format", "iife", "--outfile", worker]
            if sdk:
                command.append(f"--metafile={worker_meta}")
            subprocess.run(command, cwd=stage, check=True)
            if (generated / "helper-data.ts").read_text() != helper_source:
                raise ValueError("feature helper data changed during worker build")
            worker_source = "export const FEATURE_WORKER_SOURCE = " + json.dumps(worker.read_text()) + ";\n"
            (generated / "worker-source.ts").write_text(worker_source)
            subprocess.run(["bun", tsc, "--project", "tsconfig.feature-validator.json"], cwd=stage, check=True)
            declaration = None
            type_dependencies = {}
            if sdk:
                types = stage / "types"
                subprocess.run(["bun", tsc, "--project", "tsconfig.feature-validator.json", "--noEmit", "false",
                                "--declaration", "--emitDeclarationOnly", "--outDir", types], cwd=stage, check=True)
                text = (types / "bindings/typescript/src/feature-validator.d.ts").read_text()
                dependencies = ("module-manifest", "isolated-resources", "wasi-preview1")
                for name in dependencies:
                    text = text.replace(f'from "./{name}.ts"', f'from "./types/bindings/typescript/src/{name}.ts"')
                for line in text.splitlines():
                    if line.startswith("import ") and not re.fullmatch(r'import (?:type )?\{[^{}]+\} from "\./types/bindings/typescript/src/(?:module-manifest|isolated-resources|wasi-preview1)\.ts";', line):
                        raise ValueError("feature declaration contains an unresolved import")
                for name in ("module-manifest", "wasm-facts", "isolated-resources", "wasi-preview1"):
                    path = f"types/bindings/typescript/src/{name}.d.ts"
                    type_dependencies[path] = (stage / path).read_bytes()
                declaration = text.encode()
                if b"target/validator" in declaration or os.fsencode(stage) in declaration or os.fsencode(ROOT) in declaration:
                    raise ValueError("feature declaration contains an unresolved or local reference")
            bundle = stage / "feature-validator.js"
            bundle_meta = stage / "bundle-metafile.json"
            command = ["bun", "build", "bindings/typescript/src/feature-validator.ts", "--target", "browser", "--format", "esm", "--outfile", bundle]
            if sdk:
                command.append(f"--metafile={bundle_meta}")
            subprocess.run(command, cwd=stage, check=True)
            if (generated / "helper-data.ts").read_text() != helper_source:
                raise ValueError("feature helper data changed during bundle build")
            if (generated / "worker-source.ts").read_text() != worker_source:
                raise ValueError("feature worker source changed during bundle build")
            for name, contents in snapshots.items():
                if (ROOT / name).read_bytes() != contents or (stage / name).read_bytes() != contents:
                    raise ValueError(f"feature worker input changed during build: {name}")
            if sdk:
                if validator_sources() != validator_snapshot or rustc_version() != compiler:
                    raise ValueError("validator source or compiler changed during feature SDK build")
                sources = source_identity(validator_snapshot, snapshots)
                if sources["cargoLockSha256"] != manifest["validator_cargo_lock_sha256"]:
                    raise ValueError("validator source lock differs from notice materials")
                result = stage / "package"
                result.mkdir()
                bundle_bytes = bundle.read_bytes()
                encoded_bytes = encoded.encode("ascii")
                if bundle_bytes.count(encoded_bytes) != 1 or base64.b64decode(encoded_bytes, validate=True) != helper:
                    raise ValueError("feature bundle helper bytes do not match")
                helper_spec = importlib.util.spec_from_file_location("validator_build_helper", ROOT / "validator/build-helper.py")
                helper_builder = importlib.util.module_from_spec(helper_spec)
                helper_spec.loader.exec_module(helper_builder)
                for prefix in (*helper_builder.path_prefixes(os.environ), str(stage)):
                    if any(os.fsencode(prefix) in content for content in (helper, bundle_bytes, declaration, *type_dependencies.values())):
                        raise ValueError(f"feature SDK contains an unremapped build path: {prefix}")
                worker_inputs = audit_metafile(worker_meta, stage, noble)
                bundle_inputs = audit_metafile(bundle_meta, stage, noble)
                expected_inputs = sorted(name for name in noble["inputs"] if name.endswith(".js"))
                if worker_inputs != expected_inputs:
                    raise ValueError("feature worker dependency inventory differs")
                (result / "feature-validator.js").write_bytes(bundle_bytes)
                (result / "feature-validator.d.ts").write_bytes(declaration)
                (result / "helper.wasm").write_bytes(helper)
                for path, content in type_dependencies.items():
                    destination = result / path
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(content)
                identity = {
                    "schemaVersion": 1,
                    "helperSha256": digest,
                    "policyVersion": metadata["policyVersion"],
                    "bundleSha256": hashlib.sha256(bundle_bytes).hexdigest(),
                    "typesSha256": hashlib.sha256(declaration).hexdigest(),
                    "typeDependencies": {path: hashlib.sha256(content).hexdigest() for path, content in type_dependencies.items()},
                    "sourceIdentity": sources,
                    "rustcVersion": compiler,
                    "rustcHost": host,
                    "noble": noble,
                    "bundledInputs": {"worker": worker_inputs, "bundle": bundle_inputs},
                }
                (result / "identity.json").write_text(json.dumps(identity, indent=2) + "\n")
                if output.exists() or output.is_symlink():
                    raise ValueError(f"feature SDK output appeared during build: {output}")
                os.rename(result, output)
            else:
                os.replace(bundle, output)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--sdk-dir":
        build(Path(sys.argv[2]), sdk=True)
    elif len(sys.argv) <= 2 and (len(sys.argv) == 1 or not sys.argv[1].startswith("--")):
        build(Path(sys.argv[1]) if len(sys.argv) == 2 else ROOT / "target/validator/feature-validator.js")
    else:
        raise SystemExit("usage: build-worker.sh [output-js] | --sdk-dir NEW_DIRECTORY")
