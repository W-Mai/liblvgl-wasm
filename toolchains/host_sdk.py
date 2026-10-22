"""Build self-contained host packages using the existing runtimes and generators."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def build_host_sdk(project, ndk, core, output, validator):
    for source in (project / "bindings", project / "node_modules", ndk):
        if output.resolve().is_relative_to(source.resolve()):
            raise ValueError(f"SDK output overlaps an input directory: {source}")

    def run(*command, cwd=None):
        subprocess.run([str(item) for item in command], cwd=cwd or project,
                       stdout=sys.stderr, check=True)

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
    (typescript / "package.json").write_text(json.dumps({
        "name": "liblvgl-wasm", "version": project_manifest["version"], "private": True,
        "type": "module", "main": "./index.js", "types": entry,
        "exports": {".": {"types": entry, "import": "./index.js"}},
        "files": ["index.js", "types", "LICENSE-noble-hashes.txt"],
    }, indent=2) + "\n")
    return {"identity": identity, "version": project_manifest["version"],
            "tools": {"bun": bun_version, "typescript": versions["typescript"]},
            "dependencies": versions,
            "packages": {"typescript": "typescript/package.json", "rust": "rust/Cargo.toml"}}
