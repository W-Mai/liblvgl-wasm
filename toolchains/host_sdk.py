"""Build self-contained host packages using the existing runtimes and generators."""

import json
import base64
import hashlib
import importlib.util
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

FEATURE_GRAPH_TYPE_DEPENDENCIES = {f"types/bindings/typescript/src/{name}.d.ts" for name in
                                   ("module-manifest", "wasm-facts", "isolated-resources", "wasi-preview1")}
FEATURE_NUMERIC_TYPE_DEPENDENCY = "types/bindings/typescript/src/numeric-environment.d.ts"
FEATURE_WASI_TYPE_DEPENDENCY = "types/bindings/typescript/src/numeric-wasi.d.ts"
LEGACY_FEATURE_BUILDER_SHA256 = "efee79b5e5055e03e74fdc1b4f53d8792b69b4f6eea1bbfd15a0c0f0fa306816"
GRAPH_FEATURE_BUILDER_SHA256 = "f0ec7cfe34843a089961acff876d3ee8cf5ce7b87888f740b84d389b4e04c4a8"
NUMERIC_FEATURE_BUILDER_SHA256 = "5f9616429d3f1c8996b45407ff0f2a07184a39c3c0ffea84f113aec3b212b3f5"
WASI_FEATURE_BUILDER_SHA256 = "045f2810bfb19c940ce56c16a653b5c5052238ceb065bee4add3e8dd1f5f7a44"


def read_limited(path, limit):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError(f"feature validator input must be a regular file: {path}")
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"feature validator input exceeds size limit: {path}")
    return data


def build_host_sdk(project, ndk, core, output, validator, *, with_validator=False):
    inputs = [project / "bindings", project / "node_modules", ndk]
    if with_validator:
        inputs.extend((project / "validator", project / "generator", project / "third_party/validator"))
    for source in inputs:
        if output.resolve().is_relative_to(source.resolve()):
            raise ValueError(f"SDK output overlaps an input directory: {source}")

    def run(*command, cwd=None, env=None):
        subprocess.run([str(item) for item in command], cwd=cwd or project,
                       stdout=sys.stderr, env=env, check=True)

    project_manifest = json.loads((project / "package.json").read_text())
    bun_version = subprocess.check_output(["bun", "--version"], text=True).strip()
    versions = {}
    for name, section in (("typescript", "devDependencies"), ("@noble/hashes", "dependencies")):
        installed = project / "node_modules" / name / "package.json"
        version = json.loads(installed.read_text())["version"]
        if version != project_manifest[section][name]:
            raise ValueError(f"{name} version differs from package.json; run bun install --frozen-lockfile")
        versions[name] = version
    data = ndk / "share/liblvgl-wasm"
    (output / "runtime").mkdir(parents=True)
    (output / "metadata").mkdir()
    shutil.copyfile(core, output / "runtime/liblvgl.wasm")
    shutil.copyfile(data / "metadata/api.json", output / "metadata/api.json")
    core, api, proof = (output / "runtime/liblvgl.wasm", output / "metadata/api.json",
                        output / "metadata/verification.json")
    run(validator, "validate", core)
    run(sys.executable, "-B", data / "generator/signatures.py", "--api", api,
        "--wasm", core, "--output", proof)
    identity = json.loads(proof.read_text())
    shutil.copytree(data / "licenses", output / "licenses")

    rust = output / "rust"
    shutil.copytree(project / "bindings/rust/src", rust / "src", ignore=shutil.ignore_patterns("main.rs"))
    for name in ("Cargo.lock", "build.rs"):
        shutil.copyfile(project / "bindings/rust" / name, rust / name)
    manifest = (project / "bindings/rust/Cargo.toml").read_text()
    features = '[features]\ndefault = []\nbundled-bindings = []\n'
    if manifest.count(features) != 1:
        raise ValueError("Rust manifest must define the expected bundled-bindings feature")
    (rust / "Cargo.toml").write_text(manifest.replace(features,
        '[features]\ndefault = ["bundled-bindings"]\nbundled-bindings = []\n'))
    run(sys.executable, "-B", data / "generator/rust.py", "--api", api,
        "--wasm", core, "--verification", proof, "--output", rust / "generated/raw.rs")

    typescript = output / "typescript"
    typescript.mkdir()
    shutil.copyfile(project / "node_modules/@noble/hashes/LICENSE", typescript / "LICENSE-noble-hashes.txt")
    with tempfile.TemporaryDirectory(prefix="sources-", dir=output.parent) as temporary:
        source = Path(temporary)
        shutil.copytree(project / "bindings/typescript/src", source / "bindings/typescript/src")
        os.symlink(project / "node_modules", source / "node_modules", target_is_directory=True)
        for generator, file in (("values", "values.ts"), ("typescript", "raw.ts")):
            run(sys.executable, "-B", data / f"generator/{generator}.py", "--api", api,
                "--wasm", core, "--verification", proof, "--output", source / "target/typescript" / file)
        run("bun", "build", "bindings/typescript/src/index.ts", "--target", "browser",
            "--format", "esm", "--minify", "--outfile", typescript / "index.js", cwd=source)
        config = {"compilerOptions": {"target": "ES2022", "module": "ESNext",
                    "moduleResolution": "Bundler", "lib": ["ES2022", "DOM"], "types": [],
                    "strict": True, "declaration": True, "emitDeclarationOnly": True,
                    "allowImportingTsExtensions": True, "rootDir": str(source),
                    "outDir": str(typescript / "types")},
                  "files": ["bindings/typescript/src/index.ts"]}
        (source / "tsconfig.json").write_text(json.dumps(config))
        run("bun", project / "node_modules/typescript/bin/tsc", "--project", source / "tsconfig.json")
    entry = "./types/bindings/typescript/src/index.d.ts"
    exports = {".": {"types": entry, "import": "./index.js"}}
    files = ["index.js", "types", "LICENSE-noble-hashes.txt"]
    feature_validator = None
    if with_validator:
        feature_validator = build_feature_validator(project, typescript, validator, run)
        exports["./feature-validator"] = {"types": "./feature-validator.d.ts", "import": "./feature-validator.js"}
        files.extend(("feature-validator.js", "feature-validator.d.ts", "feature-validator.identity.json", "licenses/validator"))
    (typescript / "package.json").write_text(json.dumps({
        "name": "liblvgl-wasm", "version": project_manifest["version"], "private": True,
        "type": "module", "main": "./index.js", "types": entry,
        "exports": exports, "files": files,
    }, indent=2) + "\n")
    if feature_validator is not None:
        verify_feature_validator(typescript, feature_validator, project)
    metadata = {"identity": identity, "version": project_manifest["version"],
            "tools": {"bun": bun_version, "typescript": versions["typescript"]},
            "dependencies": versions,
            "packages": {"typescript": "typescript/package.json", "rust": "rust/Cargo.toml"}}
    if feature_validator is not None:
        metadata["feature_validator"] = feature_validator
    return metadata


def build_feature_validator(project, typescript, validator, run):
    spec = importlib.util.spec_from_file_location("lvw_validator_notices", project / "validator/notices.py")
    notices = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(notices)
    noble = notices.verify_noble(project)
    cache = project / "target/validator"
    cache.mkdir(parents=True, exist_ok=True)
    environment = {**os.environ, "WASM_TOOLS": str(validator), "CARGO_NET_OFFLINE": "true"}
    with tempfile.TemporaryDirectory(prefix=".sdk-feature-", dir=cache) as temporary:
        staged = Path(temporary) / "artifact"
        run("sh", project / "validator/build-worker.sh", "--sdk-dir", staged, env=environment)
        identity = json.loads((staged / "identity.json").read_bytes())
        if not isinstance(identity, dict) or identity.get("schemaVersion") != 1 or identity.get("policyVersion") != 1:
            raise ValueError("invalid feature validator build identity")
        artifacts = {}
        for name, key in (("feature-validator.js", "bundleSha256"),
                          ("feature-validator.d.ts", "typesSha256"), ("helper.wasm", "helperSha256")):
            value = (staged / name).read_bytes()
            expected = identity.get(key)
            if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected) or hashlib.sha256(value).hexdigest() != expected:
                raise ValueError(f"feature validator artifact identity mismatch: {name}")
            artifacts[name] = value
        dependencies = identity.get("typeDependencies")
        if not isinstance(dependencies, dict) or set(dependencies) != FEATURE_GRAPH_TYPE_DEPENDENCIES | {FEATURE_NUMERIC_TYPE_DEPENDENCY, FEATURE_WASI_TYPE_DEPENDENCY}:
            raise ValueError("feature validator declaration dependencies are incomplete")
        for name, expected in dependencies.items():
            value = read_limited(staged / name, 1024 * 1024)
            if not isinstance(expected, str) or hashlib.sha256(value).hexdigest() != expected:
                raise ValueError(f"feature validator declaration dependency differs: {name}")
            if name in (FEATURE_NUMERIC_TYPE_DEPENDENCY, FEATURE_WASI_TYPE_DEPENDENCY):
                (typescript / name).write_bytes(value)
            elif read_limited(typescript / name, 1024 * 1024) != value:
                raise ValueError(f"feature validator declaration dependency differs: {name}")
            artifacts[name] = value
        hidden_roots = {str(project.resolve()), str(Path.home().resolve()), str(Path(temporary).resolve()), str(Path.cwd().resolve())}
        for name in ("CARGO_HOME", "RUSTUP_HOME", "TMPDIR"):
            if os.environ.get(name):
                path = Path(os.environ[name]).expanduser()
                hidden_roots.update((str(path), str(path.resolve())))
        for root in hidden_roots:
            if len(root) > 1 and any(root.encode() in value for value in artifacts.values()):
                raise ValueError("feature validator artifact contains a local build path")
        if notices.verify_noble(project) != noble:
            raise ValueError("feature validator bundle inputs changed during build")
        for name in ("feature-validator.js", "feature-validator.d.ts"):
            (typescript / name).write_bytes(artifacts[name])
        (typescript / "feature-validator.identity.json").write_text(json.dumps(identity, indent=2) + "\n")
    (typescript / "licenses").mkdir()
    notice_report = notices.copy_notices(project, typescript / "LICENSE-noble-hashes.txt", typescript / "licenses/validator")
    result = {"identity": identity, "notices": notice_report}
    verify_feature_validator(typescript, result, project)
    return result


def verify_feature_validator(typescript, expected, source=None):
    """Verify the optional feature package's internal identities and notices."""
    typescript = Path(typescript)
    if not isinstance(expected, dict) or set(expected) != {"identity", "notices"}:
        raise ValueError("invalid feature validator package metadata")
    identity = json.loads(read_limited(typescript / "feature-validator.identity.json", 2 * 1024 * 1024))
    if (not isinstance(identity, dict) or identity != expected["identity"]
            or identity.get("schemaVersion") != 1 or identity.get("policyVersion") != 1):
        raise ValueError("feature validator package identity differs")
    package = json.loads(read_limited(typescript / "package.json", 1024 * 1024)) if (typescript / "package.json").exists() else None
    if package is not None:
        if (not isinstance(package, dict) or package.get("name") != "liblvgl-wasm"
                or package.get("type") != "module" or not isinstance(package.get("exports"), dict)):
            raise ValueError("invalid TypeScript SDK package metadata")
        root = {"types": "./types/bindings/typescript/src/index.d.ts", "import": "./index.js"}
        if package["exports"].get(".") != root:
            raise ValueError("TypeScript SDK root export differs")
        entry = package["exports"].get("./feature-validator")
        if entry != {"types": "./feature-validator.d.ts", "import": "./feature-validator.js"}:
            raise ValueError("feature validator package export differs")
        required = {"index.js", "types", "feature-validator.js", "feature-validator.d.ts", "feature-validator.identity.json", "licenses/validator", "LICENSE-noble-hashes.txt"}
        if (not isinstance(package.get("files"), list) or not all(isinstance(name, str) for name in package["files"])
                or not required <= set(package["files"])):
            raise ValueError("feature validator package files are incomplete")
        for name in ("index.js", "types/bindings/typescript/src/index.d.ts"):
            if not (typescript / name).is_file():
                raise ValueError("TypeScript SDK root export is missing")
    bundle = read_limited(typescript / "feature-validator.js", 32 * 1024 * 1024)
    types = read_limited(typescript / "feature-validator.d.ts", 1024 * 1024)
    if (hashlib.sha256(bundle).hexdigest() != identity.get("bundleSha256")
            or hashlib.sha256(types).hexdigest() != identity.get("typesSha256")):
        raise ValueError("feature validator bundle or types identity mismatch")
    graph_types = set()
    numeric_import = False
    numeric_types = False
    wasi_value = False
    wasi_types = False
    for index, line in enumerate(types.splitlines()):
        if line.startswith(b"import "):
            if index != len(graph_types) + int(numeric_import):
                raise ValueError("invalid feature validator declaration import")
            match = re.fullmatch(rb'import (?:type )?\{[^{}]+\} from "\./types/bindings/typescript/src/(module-manifest|isolated-resources|wasi-preview1|numeric-environment)\.ts";', line)
            if match is None:
                raise ValueError("invalid feature validator declaration import")
            name = match.group(1).decode()
            if name == "numeric-environment":
                if numeric_import:
                    raise ValueError("duplicate feature validator declaration import")
                numeric_import = True
            elif name in graph_types:
                raise ValueError("duplicate feature validator declaration import")
            else:
                graph_types.add(name)
            read_limited(typescript / f"types/bindings/typescript/src/{name}.d.ts", 1024 * 1024)
        if line.startswith(b"export type ") and b" from " in line:
            if (index == len(graph_types) + int(numeric_import) and line == b'export type { NumericEnvironment, NumericEnvironmentOptions } from "./types/bindings/typescript/src/numeric-environment.ts";' and not numeric_types):
                numeric_types = True
            elif (index == len(graph_types) + int(numeric_import) + int(numeric_types) + int(wasi_value)
                  and line == b'export type { NumericWasiOptions, NumericWasiService } from "./types/bindings/typescript/src/numeric-environment.ts";' and wasi_value and not wasi_types):
                wasi_types = True
            else:
                raise ValueError("invalid feature validator numeric declaration export")
        if line.startswith(b"export { ") and b" from " in line:
            if (index != len(graph_types) + int(numeric_import) + int(numeric_types)
                    or line != b'export { NumericWasiExit } from "./types/bindings/typescript/src/numeric-environment.ts";' or not numeric_types or wasi_value):
                raise ValueError("invalid feature validator WASI declaration export")
            wasi_value = True
    if numeric_import != numeric_types:
        raise ValueError("feature validator numeric declarations are incomplete")
    if wasi_value != wasi_types:
        raise ValueError("feature validator WASI declarations are incomplete")
    dependencies = identity.get("typeDependencies")
    if graph_types:
        if graph_types != {"module-manifest", "isolated-resources", "wasi-preview1"}:
            raise ValueError("feature validator declaration imports are incomplete")
        expected_dependencies = FEATURE_GRAPH_TYPE_DEPENDENCIES | ({FEATURE_NUMERIC_TYPE_DEPENDENCY} if numeric_types else set()) | ({FEATURE_WASI_TYPE_DEPENDENCY} if wasi_types else set())
        if not isinstance(dependencies, dict) or set(dependencies) != expected_dependencies:
            raise ValueError("feature validator declaration dependencies are incomplete")
        for name, digest in dependencies.items():
            if not isinstance(digest, str) or hashlib.sha256(read_limited(typescript / name, 1024 * 1024)).hexdigest() != digest:
                raise ValueError(f"feature validator declaration dependency differs: {name}")
        if numeric_types:
            numeric_declaration = read_limited(typescript / FEATURE_NUMERIC_TYPE_DEPENDENCY, 1024 * 1024).splitlines()
            wasi_lines = [b'import { NumericWasiExit, type NumericWasiOptions, type NumericWasiService } from "./numeric-wasi.ts";',
                          b'export { NumericWasiExit };', b'export type { NumericWasiOptions, NumericWasiService };']
            if (wasi_types and numeric_declaration[1:4] != wasi_lines) or (not wasi_types and any(b"numeric-wasi" in line for line in numeric_declaration)):
                raise ValueError("feature validator WASI declaration dependencies are incomplete")
    elif dependencies is not None or numeric_types:
        raise ValueError("unexpected feature validator declaration dependencies")
    matches = re.findall(rb'["\']([A-Za-z0-9+/]{4096,}={0,2})["\']', bundle)
    if len(matches) != 1:
        raise ValueError("feature validator embedded helper is not unique")
    try:
        helper = base64.b64decode(matches[0], validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError("invalid feature validator embedded helper") from error
    if (len(helper) > 16 * 1024 * 1024 or not helper.startswith(b"\0asm\x01\0\0\0")
            or hashlib.sha256(helper).hexdigest() != identity.get("helperSha256")):
        raise ValueError("feature validator helper identity mismatch")
    generator_path = Path(__file__).resolve().parent.parent / "validator/generate-data.py"
    spec = importlib.util.spec_from_file_location("lvw_validator_generator", generator_path)
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    generator.inspect_helper_structure(helper)
    notices = expected["notices"]
    if not isinstance(notices, dict) or notices.get("kind") != "lvw-feature-validator-notices":
        raise ValueError("invalid feature validator notice metadata")
    directory = typescript / "licenses/validator"
    if directory.is_symlink():
        raise ValueError("feature validator notice directory must not be a symbolic link")
    notice_bytes = read_limited(directory / "manifest.json", 2 * 1024 * 1024)
    if hashlib.sha256(notice_bytes).hexdigest() != notices.get("manifest_sha256"):
        raise ValueError("feature validator notice manifest identity mismatch")
    notice_path = Path(__file__).resolve().parent.parent / "validator/notices.py"
    spec = importlib.util.spec_from_file_location("lvw_validator_notices", notice_path)
    notice_contract = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(notice_contract)
    manifest = notice_contract.parse_manifest(notice_bytes)
    if not isinstance(manifest, dict) or manifest.get("kind") != notices["kind"] or manifest.get("schema_version") != 1:
        raise ValueError("invalid feature validator notice manifest")
    files = manifest.get("files")
    if not isinstance(files, dict) or notices.get("files") != len(files):
        raise ValueError("feature validator notice inventory differs")
    actual = set()
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise ValueError("feature validator notices contain a symbolic link")
        if path.is_file():
            actual.add(path.relative_to(directory).as_posix())
    if actual != set(files) | {"manifest.json"}:
        raise ValueError("feature validator notice inventory differs")
    notice_total = 0
    for name, entry in files.items():
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name or not isinstance(entry, dict):
            raise ValueError("invalid feature validator notice path")
        data = read_limited(directory / path, 16 * 1024 * 1024 - notice_total)
        notice_total += len(data)
        if hashlib.sha256(data).hexdigest() != entry.get("sha256"):
            raise ValueError(f"feature validator notice identity mismatch: {name}")
    noble = hashlib.sha256(read_limited(typescript / "LICENSE-noble-hashes.txt", 1024 * 1024)).hexdigest()
    noble_info = manifest.get("noble")
    if (not isinstance(noble_info, dict) or noble != notices.get("noble_license_sha256")
            or noble != noble_info.get("license_sha256")):
        raise ValueError("feature validator noble license identity mismatch")
    bundled = identity.get("bundledInputs")
    noble_inputs = noble_info.get("inputs")
    if (identity.get("noble") != noble_info or not isinstance(noble_inputs, dict)
            or not isinstance(bundled, dict) or set(bundled) != {"worker", "bundle"}
            or not isinstance(bundled["worker"], list) or not isinstance(bundled["bundle"], list)):
        raise ValueError("feature validator bundled input identity mismatch")
    allowed = set(noble_inputs) - {"@noble/hashes/package.json"}
    for name in ("worker", "bundle"):
        values = bundled[name]
        if not all(isinstance(value, str) for value in values) or values != sorted(set(values)) or not set(values) <= allowed:
            raise ValueError("feature validator has unrecorded bundled inputs")
    if set(bundled["worker"]) != allowed:
        raise ValueError("feature validator worker input inventory differs")
    source_identity = identity.get("sourceIdentity")
    if not isinstance(source_identity, dict):
        raise ValueError("feature validator source identity is missing")
    validator_root = Path(__file__).resolve().parent.parent / "validator"
    contracts = {}
    for name in ("build-data", "build-worker"):
        spec = importlib.util.spec_from_file_location("lvw_validator_" + name.replace("-", "_"), validator_root / (name + ".py"))
        contracts[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(contracts[name])
    validator_files = set(contracts["build-data"].SOURCE_FILES) | {"src/lib.rs", "src/bin/metadata.rs"}
    if source is not None:
        source_directory = Path(source) / "validator/src"
        if source_directory.is_symlink() or not source_directory.is_dir():
            raise ValueError("feature validator source directory is missing")
        validator_files = set(contracts["build-data"].SOURCE_FILES)
        for path in source_directory.rglob("*"):
            if path.is_symlink():
                raise ValueError("feature validator source contains a symbolic link")
            if path.is_file():
                validator_files.add(path.relative_to(Path(source) / "validator").as_posix())
                if len(validator_files) > 4096:
                    raise ValueError("feature validator source inventory exceeds limit")
    worker_files = set(contracts["build-worker"].INPUTS)
    graph_worker_files = {f"bindings/typescript/src/{name}.ts" for name in
                          ("module-graph", "module-manifest", "isolated-resources", "wasi-preview1")}
    numeric_worker_file = "bindings/typescript/src/numeric-environment.ts"
    event_worker_file = "bindings/typescript/src/numeric-events.ts"
    wasi_worker_file = "bindings/typescript/src/numeric-wasi.ts"
    for files_key, tree_key, prefix in (("files", "treeSha256", "validator"),
                                        ("workerFiles", "workerTreeSha256", "")):
        entries = source_identity.get(files_key)
        if not isinstance(entries, dict) or not entries or len(entries) > 4096:
            raise ValueError("feature validator source inventory is missing")
        names = set(entries)
        if files_key == "files" and ((source is not None and names != validator_files)
                                      or (source is None and not validator_files <= names)):
            raise ValueError("feature validator source inventory is incomplete")
        if files_key == "workerFiles":
            if names == worker_files:
                if not graph_types or not numeric_types or not wasi_types:
                    raise ValueError("feature validator declaration imports are incomplete")
            elif (names == worker_files - {event_worker_file} and graph_types and numeric_types and wasi_types
                  and entries.get("validator/build-worker.py") == WASI_FEATURE_BUILDER_SHA256):
                pass
            elif (names == worker_files - {event_worker_file, wasi_worker_file} and graph_types and numeric_types and not wasi_types
                  and entries.get("validator/build-worker.py") == NUMERIC_FEATURE_BUILDER_SHA256):
                pass
            elif (names == worker_files - {event_worker_file, numeric_worker_file, wasi_worker_file} and graph_types and not numeric_types and not wasi_types
                  and entries.get("validator/build-worker.py") == GRAPH_FEATURE_BUILDER_SHA256):
                pass
            elif (names != worker_files - graph_worker_files - {event_worker_file, numeric_worker_file, wasi_worker_file} or graph_types or numeric_types or wasi_types
                  or entries.get("validator/build-worker.py") != LEGACY_FEATURE_BUILDER_SHA256):
                raise ValueError("feature validator source inventory is incomplete")
        tree = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if tree != source_identity.get(tree_key):
            raise ValueError("feature validator source tree identity mismatch")
        source_total = 0
        for name, digest in entries.items():
            path = Path(name)
            if (not isinstance(name, str) or not name or path.is_absolute() or ".." in path.parts
                    or "\\" in name or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)):
                raise ValueError("invalid feature validator source identity")
            if source is not None:
                candidate = Path(source) / prefix / path
                data = read_limited(candidate, 8 * 1024 * 1024 - source_total)
                source_total += len(data)
                if hashlib.sha256(data).hexdigest() != digest:
                    raise ValueError(f"feature validator source identity mismatch: {name}")
    if (source_identity.get("cargoLockSha256") != source_identity["files"].get("Cargo.lock")
            or source_identity.get("cargoLockSha256") != manifest.get("validator_cargo_lock_sha256")):
        raise ValueError("feature validator dependency identity mismatch")
    rustc = identity.get("rustcVersion")
    if (not isinstance(rustc, str) or "\nrelease: 1.92.0\n" not in rustc
            or "\ncommit-hash: ded5c06cf21d2b93bffd5d884aa6e96934ee4234\n" not in rustc):
        raise ValueError("feature validator Rust toolchain identity mismatch")
    host = re.search(r"(?m)^host: ([^\r\n]+)$", rustc)
    if host is None or identity.get("rustcHost") != host.group(1):
        raise ValueError("feature validator Rust host identity mismatch")
    return identity
