"""Exercise an optional feature validator SDK after read-only relocation."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "toolchains"))
from lvw import file_inventory
from host_sdk import verify_feature_validator
from feature_sdk_browser import run_browser


def run(*command, cwd=None, env=None):
    subprocess.run([str(item) for item in command], cwd=cwd, env=env, stdout=sys.stderr, check=True)


def readonly(root, enabled):
    for path in [root, *root.rglob("*")]:
        if path.is_dir():
            path.chmod(0o555 if enabled else 0o755)
        elif path.is_file():
            executable = path.stat().st_mode & 0o111
            path.chmod((0o444 | executable) if enabled else (0o644 | executable))


def check_result(result, core_sha, identity):
    if "error" in result:
        raise ValueError(f"feature SDK worker failed: {result['error']}")
    report = result["report"]
    graph_checks = {"declaration": "passed", "identity": "passed", "interface": "passed", "feature": "passed",
                    "wasiAbi": "not-observed", "resourceTopology": "passed", "engine": "passed",
                    "targetProvenance": "not-run", "pointerContracts": "not-run", "handleIsolation": "not-run",
                    "environmentIsolation": "not-run", "hostImplementation": "not-run", "lifecycle": "not-run", "runtime": "not-run"}
    if (report["status"] != "passed" or report["inputSha256"] != core_sha
            or report["helperSha256"] != identity["helperSha256"] or report["policyVersion"] != identity["policyVersion"]
            or report["checks"] != {"engine": "not-run", "wasiAbi": "not-run", "resourceTopology": "not-run", "runtime": "not-run"}
            or result["coreDenied"] != "module-rejected" or result["simdStatus"] != "passed"
            or result["simdDenied"] != "module-rejected" or result["policyDenied"] != "policy"
            or result["aborted"] != "aborted" or not result["knownFeatures"] or not result["rootExport"]
            or result["graphOrder"] != ["core", "lib", "app"] or result["graphChecks"] != [graph_checks] * 3
            or result["numericResult"] != 7 or result["numericState"] != "closed"
            or result["wasiResult"] != 6 or result["wasiState"] != "closed"
            or result["wasiOutput"] != ["c:2:ci", "c:1:C!", "c:2:ce"] or not result["wasiIdentity"] or not result["wasiExit"]):
        raise ValueError(f"unexpected feature SDK result: {result}")


def check_tampering(moved, work):
    altered = work / "altered sdk"
    shutil.copytree(moved, altered)
    readonly(altered, False)
    typescript = altered / "typescript"
    manifest_path = altered / "sdk.json"
    manifest = json.loads(manifest_path.read_bytes())
    bundle_path = typescript / "feature-validator.js"
    bundle = bytearray(bundle_path.read_bytes())
    matches = list(re.finditer(rb'["\']([A-Za-z0-9+/]{4096,}={0,2})["\']', bundle))
    if len(matches) != 1:
        raise ValueError("embedded helper is not uniquely identifiable")
    offset = matches[0].start(1)
    bundle[offset] = ord("B") if bundle[offset] != ord("B") else ord("C")
    bundle_path.write_bytes(bundle)
    identity_path = typescript / "feature-validator.identity.json"
    identity = json.loads(identity_path.read_bytes())
    identity["bundleSha256"] = hashlib.sha256(bundle).hexdigest()
    identity_path.write_text(json.dumps(identity, indent=2) + "\n")
    manifest["feature_validator"]["identity"] = identity
    inventory = file_inventory(altered)
    inventory.pop("sdk.json")
    manifest["files"] = inventory
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    try:
        verify_feature_validator(typescript, manifest["feature_validator"])
    except ValueError as error:
        if "helper identity" not in str(error):
            raise
    else:
        raise ValueError("altered embedded helper passed SDK identity verification")

    for name, missing in (("module-manifest", False), ("module-manifest", True), ("numeric-wasi", False), ("numeric-wasi", True)):
        shutil.rmtree(altered)
        shutil.copytree(moved, altered)
        readonly(altered, False)
        typescript = altered / "typescript"
        manifest_path = altered / "sdk.json"
        manifest = json.loads(manifest_path.read_bytes())
        dependency = typescript / f"types/bindings/typescript/src/{name}.d.ts"
        if missing:
            dependency.unlink()
        else:
            dependency.write_bytes(dependency.read_bytes() + b"\n// changed\n")
        inventory = file_inventory(altered)
        inventory.pop("sdk.json")
        manifest["files"] = inventory
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        try:
            verify_feature_validator(typescript, manifest["feature_validator"])
        except (ValueError, FileNotFoundError):
            pass
        else:
            raise ValueError("modified feature declaration dependency passed SDK identity verification")

    shutil.rmtree(altered)
    shutil.copytree(moved, altered)
    readonly(altered, False)
    typescript = altered / "typescript"
    manifest_path = altered / "sdk.json"
    manifest = json.loads(manifest_path.read_bytes())
    identity_path = typescript / "feature-validator.identity.json"
    identity = json.loads(identity_path.read_bytes())
    path = "types/bindings/typescript/src/numeric-environment.d.ts"
    declaration = typescript / path
    lines = declaration.read_bytes().splitlines(keepends=True)
    updated = b"".join(b"// " + line if line.startswith(b"import ") and b"numeric-wasi.ts" in line else line for line in lines)
    if updated == declaration.read_bytes():
        raise ValueError("expected numeric WASI declaration import is missing")
    declaration.write_bytes(updated)
    identity["typeDependencies"][path] = hashlib.sha256(updated).hexdigest()
    identity_path.write_text(json.dumps(identity, indent=2) + "\n")
    manifest["feature_validator"]["identity"] = identity
    inventory = file_inventory(altered)
    inventory.pop("sdk.json")
    manifest["files"] = inventory
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    try:
        verify_feature_validator(typescript, manifest["feature_validator"])
    except ValueError as error:
        if "WASI declaration dependencies are incomplete" not in str(error):
            raise
    else:
        raise ValueError("rehashed numeric WASI declaration passed SDK identity verification")

    for selected in (b"module-manifest", None, b"comments", b"block", b"numeric", b"numeric-block", b"wasi", b"wasi-block"):
        shutil.rmtree(altered)
        shutil.copytree(moved, altered)
        readonly(altered, False)
        typescript = altered / "typescript"
        manifest_path = altered / "sdk.json"
        manifest = json.loads(manifest_path.read_bytes())
        identity_path = typescript / "feature-validator.identity.json"
        identity = json.loads(identity_path.read_bytes())
        declaration = typescript / "feature-validator.d.ts"
        lines = declaration.read_bytes().splitlines(keepends=True)
        if selected == b"wasi":
            updated = b"".join(line for line in lines if not line.startswith(b"export { NumericWasiExit }"))
        elif selected == b"wasi-block":
            updated = b"".join(b"/*\n" + line + b"*/\n" if line.startswith(b"export { NumericWasiExit }") else line for line in lines)
        elif selected == b"numeric":
            updated = b"".join(line for line in lines if not (line.startswith(b"export type ") and b"numeric-environment" in line))
        elif selected == b"numeric-block":
            updated = b"".join(b"/*\n" + line + b"*/\n" if line.startswith(b"export type ") and b"numeric-environment" in line else line for line in lines)
        elif selected == b"block":
            imports = b"".join(line for line in lines if line.startswith(b"import "))
            updated = b"/*\n" + imports + b"*/\n" + b"".join(line for line in lines if not line.startswith(b"import "))
        elif selected == b"comments":
            updated = b"".join(b"// " + line if line.startswith(b"import ") else line for line in lines)
        else:
            updated = b"".join(line for line in lines if not (line.startswith(b"import ") and (selected is None or selected in line)))
        if updated == declaration.read_bytes():
            raise ValueError("expected feature declaration import is missing")
        declaration.write_bytes(updated)
        identity["typesSha256"] = hashlib.sha256(updated).hexdigest()
        if selected is None or selected == b"comments":
            identity.pop("typeDependencies")
        identity_path.write_text(json.dumps(identity, indent=2) + "\n")
        manifest["feature_validator"]["identity"] = identity
        inventory = file_inventory(altered)
        inventory.pop("sdk.json")
        manifest["files"] = inventory
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        try:
            verify_feature_validator(typescript, manifest["feature_validator"])
        except ValueError as error:
            if not any(part in str(error) for part in ("declaration import", "declaration dependencies", "numeric declaration", "WASI declaration")):
                raise
        else:
            raise ValueError("incomplete feature declaration imports passed SDK verification")

    for files_key, tree_key, name in (("files", "treeSha256", "src/lib.rs"),
                                      ("workerFiles", "workerTreeSha256", "bindings/typescript/src/feature-validator-worker.ts"),
                                      ("workerFiles", "workerTreeSha256", "validator/build-worker.sh")):
        shutil.rmtree(altered)
        shutil.copytree(moved, altered)
        readonly(altered, False)
        typescript = altered / "typescript"
        manifest_path = altered / "sdk.json"
        manifest = json.loads(manifest_path.read_bytes())
        identity_path = typescript / "feature-validator.identity.json"
        identity = json.loads(identity_path.read_bytes())
        entries = identity["sourceIdentity"][files_key]
        del entries[name]
        identity["sourceIdentity"][tree_key] = hashlib.sha256(
            json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        identity_path.write_text(json.dumps(identity, indent=2) + "\n")
        manifest["feature_validator"]["identity"] = identity
        inventory = file_inventory(altered)
        inventory.pop("sdk.json")
        manifest["files"] = inventory
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        try:
            verify_feature_validator(typescript, manifest["feature_validator"], ROOT)
        except ValueError as error:
            if "source inventory is incomplete" not in str(error):
                raise
        else:
            raise ValueError("incomplete feature source identity passed SDK verification")

    shutil.rmtree(altered)
    shutil.copytree(moved, altered)
    readonly(altered, False)
    typescript = altered / "typescript"
    manifest_path = altered / "sdk.json"
    manifest = json.loads(manifest_path.read_bytes())
    directory = typescript / "licenses/validator"
    notices = json.loads((directory / "manifest.json").read_bytes())
    notice = directory / next(iter(notices["files"]))
    notice.write_bytes(notice.read_bytes() + b"changed")
    inventory = file_inventory(altered)
    inventory.pop("sdk.json")
    manifest["files"] = inventory
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    try:
        verify_feature_validator(typescript, manifest["feature_validator"])
    except ValueError as error:
        if "notice identity mismatch" not in str(error):
            raise
    else:
        raise ValueError("altered notice passed SDK identity verification")

    entry = next(iter(notices["files"]))
    notices["files"][entry]["sha256"] = hashlib.sha256(notice.read_bytes()).hexdigest()
    notice_manifest = json.dumps(notices, indent=2).encode() + b"\n"
    (directory / "manifest.json").write_bytes(notice_manifest)
    manifest["feature_validator"]["notices"]["manifest_sha256"] = hashlib.sha256(notice_manifest).hexdigest()
    inventory = file_inventory(altered)
    inventory.pop("sdk.json")
    manifest["files"] = inventory
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    try:
        verify_feature_validator(typescript, manifest["feature_validator"])
    except ValueError as error:
        if "notice manifest identity mismatch" not in str(error):
            raise
    else:
        raise ValueError("rehashed altered notice passed SDK identity verification")

    shutil.rmtree(altered)
    shutil.copytree(moved, altered)
    readonly(altered, False)
    typescript = altered / "typescript"
    manifest = json.loads((altered / "sdk.json").read_bytes())
    with (typescript / "feature-validator.js").open("wb") as bundle:
        bundle.truncate(32 * 1024 * 1024 + 1)
    try:
        verify_feature_validator(typescript, manifest["feature_validator"])
    except ValueError as error:
        if "exceeds size limit" not in str(error):
            raise
    else:
        raise ValueError("oversized feature bundle passed SDK verification")


def check(sdk, chromium=None):
    sdk = Path(sdk).resolve(strict=True)
    wasi = ROOT / "target/validator/wasi-numeric-fixtures/c-app.wasm"
    if not wasi.is_file():
        raise ValueError("missing WASI fixture; run validator/wasi-numeric-fixtures.py")
    with tempfile.TemporaryDirectory(prefix="lvw feature sdk ") as temporary:
        work = Path(temporary)
        moved = work / "moved package"
        shutil.copytree(sdk, moved)
        readonly(moved, True)
        try:
            manifest = json.loads((moved / "sdk.json").read_bytes())
            inventory = file_inventory(moved)
            inventory.pop("sdk.json")
            if manifest.get("files") != inventory:
                raise ValueError("relocated SDK inventory differs")
            typescript = moved / "typescript"
            package = json.loads((typescript / "package.json").read_bytes())
            feature = package["exports"]["./feature-validator"]
            if feature != {"types": "./feature-validator.d.ts", "import": "./feature-validator.js"}:
                raise ValueError("feature SDK package exports differ")
            identity = json.loads((typescript / "feature-validator.identity.json").read_bytes())
            if manifest["feature_validator"]["identity"] != identity:
                raise ValueError("feature SDK identities differ")
            bundle = (typescript / "feature-validator.js").read_bytes()
            types = (typescript / "feature-validator.d.ts").read_bytes()
            if (hashlib.sha256(bundle).hexdigest() != identity["bundleSha256"]
                    or hashlib.sha256(types).hexdigest() != identity["typesSha256"]):
                raise ValueError("feature SDK bundle or types identity differs")
            matches = re.findall(rb'["\']([A-Za-z0-9+/]{4096,}={0,2})["\']', bundle)
            if len(matches) != 1:
                raise ValueError("embedded helper is not uniquely identifiable")
            helper = base64.b64decode(matches[0], validate=True)
            if hashlib.sha256(helper).hexdigest() != identity["helperSha256"]:
                raise ValueError("embedded helper identity differs")
            private_paths = {str(ROOT), str(Path.home()), str(sdk), str(work)}
            for key in ("CARGO_HOME", "RUSTUP_HOME", "TMPDIR"):
                if os.environ.get(key):
                    private_paths.add(os.environ[key])
            declarations = [(typescript / name).read_bytes() for name in identity.get("typeDependencies", {})]
            if any(len(path) > 1 and path.encode() in content for path in private_paths for content in (helper, bundle, types, *declarations)):
                raise ValueError("feature SDK contains a local build path")
            check_tampering(moved, work)

            project = work / "consumer project"
            project.mkdir()
            (project / "package.json").write_text('{"type":"module"}\n')
            (project / "node_modules").mkdir()
            (project / "node_modules/liblvgl-wasm").symlink_to(typescript, target_is_directory=True)
            for name in ("consumer.ts", "browser-worker.ts"):
                shutil.copyfile(ROOT / "tests/fixtures/feature-sdk" / name, project / name)
            for mode in ("Bundler", "NodeNext"):
                config = {"compilerOptions": {"target": "ES2022", "strict": True, "noEmit": True,
                          "module": "ESNext" if mode == "Bundler" else "NodeNext", "moduleResolution": mode,
                          "lib": ["ES2022", "DOM"], "types": []}, "files": ["consumer.ts"]}
                (project / "tsconfig.json").write_text(json.dumps(config))
                run("bun", ROOT / "node_modules/typescript/bin/tsc", "--project", project / "tsconfig.json")
            (project / "runner.ts").write_text('''globalThis.fetch = (() => { throw new Error("network is unavailable"); }) as typeof fetch;
const { exercise } = await import("./consumer.ts");
const result = await exercise(await Bun.file(Bun.argv[2]!).arrayBuffer(), await Bun.file(Bun.argv[3]!).arrayBuffer());
console.log(JSON.stringify(result));
''')
            core = moved / "runtime/liblvgl.wasm"
            core_sha = hashlib.sha256(core.read_bytes()).hexdigest()
            result = subprocess.run(["bun", "runner.ts", core, wasi], cwd=project, check=True, capture_output=True, text=True)
            check_result(json.loads(result.stdout), core_sha, identity)

            packable = work / "packable typescript"
            shutil.copytree(typescript, packable)
            readonly(packable, False)
            run("bun", "pm", "pack", "--ignore-scripts", "--destination", work, cwd=packable)
            archives = list(work.glob("*.tgz"))
            if len(archives) != 1:
                raise ValueError("expected one TypeScript SDK archive")
            with tarfile.open(archives[0], "r:gz") as archive:
                members = set(archive.getnames())
                required = {"package/feature-validator.js", "package/feature-validator.d.ts",
                            "package/feature-validator.identity.json", "package/LICENSE-noble-hashes.txt",
                            "package/licenses/validator/manifest.json", "package/package.json"}
                if not required <= members:
                    raise ValueError("packed TypeScript SDK is missing feature artifacts or notices")
                for name in ("feature-validator.js", "feature-validator.d.ts", "feature-validator.identity.json"):
                    if archive.extractfile("package/" + name).read() != (typescript / name).read_bytes():
                        raise ValueError(f"packed feature artifact differs: {name}")
                packed_package = json.loads(archive.extractfile("package/package.json").read())
                if packed_package.get("exports") != package.get("exports"):
                    raise ValueError("packed TypeScript SDK exports differ")
                notice_manifest = json.loads(archive.extractfile("package/licenses/validator/manifest.json").read())
                if notice_manifest != json.loads((typescript / "licenses/validator/manifest.json").read_bytes()):
                    raise ValueError("packed validator notice manifest differs")
                for name, entry in notice_manifest["files"].items():
                    path = "package/licenses/validator/" + name
                    if path not in members:
                        raise ValueError(f"packed validator notice is missing: {name}")
                    contents = archive.extractfile(path).read()
                    if (hashlib.sha256(contents).hexdigest() != entry["sha256"]
                            or contents != (typescript / "licenses/validator" / name).read_bytes()):
                        raise ValueError(f"packed validator notice identity differs: {name}")
                noble = archive.extractfile("package/LICENSE-noble-hashes.txt").read()
                if hashlib.sha256(noble).hexdigest() != notice_manifest["noble"]["license_sha256"]:
                    raise ValueError("packed noble license identity differs")
            browser = run_browser(project, moved, work, chromium, wasi) if chromium else None
            if browser is not None:
                if browser.get("hasSubtle") is not False:
                    raise ValueError("browser worker did not use an opaque origin")
                check_result(browser["result"], core_sha, identity)
            print(json.dumps({"typescript": True, "outerFetchBlocked": True, "readonly": True,
                              "opaqueConnectDisabled": browser is not None,
                              "helperSha256": identity["helperSha256"], "bundleSha256": identity["bundleSha256"]}))
        finally:
            readonly(moved, False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sdk")
    parser.add_argument("--chromium")
    args = parser.parse_args()
    check(args.sdk, args.chromium)
