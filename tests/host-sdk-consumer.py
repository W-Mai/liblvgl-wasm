"""Exercise exported host packages through external package entry points."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "toolchains"))
from host_sdk import build_host_sdk
from lvw import file_inventory, publish_package


def run(*command, **kwargs):
    subprocess.run([str(item) for item in command], stdout=sys.stderr, check=True, **kwargs)


def readonly(root, enabled):
    for path in [root, *root.rglob("*")]:
        path.chmod((0o555 if enabled else 0o755) if path.is_dir() else (0o444 if enabled else 0o644))


def check(output, build=None):
    custom = build is not None
    callbacks = os.environ.get("LVW_TEST_CALLBACKS", "").split()
    if any(name not in {"timers", "animations", "observers", "decoders"} for name in callbacks):
        raise ValueError(f"unknown callback contract: {callbacks}")
    build = build or ROOT / "target/wasm"
    ndk = output / "ndk"
    run("cmake", "--build", build, "--target", "lvw_ndk", "-j", "4")
    run("cmake", "--install", build, "--prefix", ndk, "--component", "ndk")
    notices = file_inventory(ndk / "share/liblvgl-wasm/licenses")
    sdk = subprocess.check_output(["sh", str(ROOT / "scripts/resolve-wasi-sdk.sh"), str(ROOT)], text=True).strip()
    run("cmake", "-S", ndk / "examples/c", "-B", output / "native build", "-G", "Ninja",
        f"-DCMAKE_TOOLCHAIN_FILE={sdk}/share/cmake/wasi-sdk-p1.cmake", f"-DCMAKE_PREFIX_PATH={ndk}",
        "-DCMAKE_BUILD_TYPE=Release")
    run("cmake", "--build", output / "native build")
    build_script = output / "rust-build-script"
    run("rustc", "--edition=2024", "--cfg", 'feature="bundled-bindings"',
        ROOT / "bindings/rust/build.rs", "-o", build_script)
    packages = []
    for name, core in (("baseline", build / "liblvgl.wasm"),
                       ("native", output / "native build/lvgl_native_example.wasm")):
        original = output / name
        metadata = build_host_sdk(ROOT, ndk, core, original, "wasm-tools")
        if callbacks:
            (original / "rust/tests").mkdir()
            for contract in callbacks:
                shutil.copyfile(ROOT / f"bindings/rust/tests/{contract}.rs", original / f"rust/tests/{contract}.rs")
            if "decoders" in callbacks:
                shutil.copyfile(ROOT / "examples/browser/red.bmp", original / "rust/tests/red.bmp")
        files = file_inventory(original)
        package = output / f"moved {name}"
        publish_package(original, package, "sdk.json", {**metadata, "files": files})
        readonly(package, True)
        try:
            assert file_inventory(package / "licenses") == notices
            project = output / f"consumer {name}"
            project.mkdir()
            (project / "package.json").write_text('{"type":"module"}\n')
            (project / "node_modules").mkdir()
            (project / "node_modules/liblvgl-wasm").symlink_to(package / "typescript", target_is_directory=True)
            shutil.copyfile(ROOT / "tests/fixtures/host-sdk/consumer.ts", project / "consumer.ts")
            for mode in ("Bundler", "NodeNext"):
                config = {"compilerOptions": {"target": "ES2022", "strict": True, "noEmit": True,
                           "module": "ESNext" if mode == "Bundler" else "NodeNext",
                           "moduleResolution": mode, "lib": ["ES2022", "DOM"], "types": []},
                          "files": ["consumer.ts"]}
                (project / "tsconfig.json").write_text(json.dumps(config))
                run("bun", ROOT / "node_modules/typescript/bin/tsc", "--project", project / "tsconfig.json")
            run("bun", "build", "consumer.ts", "--target", "browser", "--outfile", "target/consumer.js", cwd=project)
            out = project / "target/rust-build-script"
            out.mkdir(parents=True)
            environment = {**os.environ, "CARGO_MANIFEST_DIR": str(package / "rust"), "OUT_DIR": str(out)}
            environment.pop("LVW_RUST_BINDINGS", None)
            run(build_script, env=environment)
            assert (out / "raw.rs").read_bytes() == (package / "rust/generated/raw.rs").read_bytes()
            # Reusing OUT_DIR must replace an earlier read-only generated copy.
            (out / "raw.rs").chmod(0o444)
            run(build_script, env=environment)
            assert (out / "raw.rs").read_bytes() == (package / "rust/generated/raw.rs").read_bytes()
            assert 'default = ["bundled-bindings"]' in (package / "rust/Cargo.toml").read_text()
            assert not (package / "rust/src/main.rs").exists()
            for path in (package / "typescript").rglob("*"):
                if path.suffix in (".ts", ".js"):
                    assert str(ROOT) not in path.read_text() and str(output) not in path.read_text(), path
            packages.append({"package": str(package), "consumer": str(project), **metadata})
            if callbacks:
                environment = {**os.environ, "LVW_TEST_CORE": str(package / "runtime/liblvgl.wasm"),
                               "LVW_TEST_API": str(package / "metadata/api.json"),
                               "LVW_TEST_BITMAP": str(package / "rust/tests/red.bmp"),
                               "LVW_TEST_TS_RUNTIME": str(package / "typescript/index.js"),
                               "CARGO_TARGET_DIR": str(ROOT / "target/rust")}
                environment.pop("LVW_RUST_BINDINGS", None)
                for contract in callbacks:
                    run("bun", "test", f"./tests/{contract}.test.ts", env=environment)
                    run("cargo", "test", "--locked", "--offline", "--manifest-path", package / "rust/Cargo.toml",
                        "--test", contract, env=environment)
            if custom:
                rust = project / "rust"
                (rust / "src").mkdir(parents=True)
                main = (ROOT / "bindings/rust/src/main.rs").read_text()
                (rust / "src/main.rs").write_text(main.replace("../../../examples/browser/red.bmp", "../red.bmp"))
                shutil.copyfile(ROOT / "examples/browser/red.bmp", rust / "red.bmp")
                (rust / "Cargo.toml").write_text('[package]\nname="lvw-compatibility-consumer"\n'
                    'version="0.1.0"\nedition="2024"\n[dependencies]\nliblvgl-wasm-host={path='
                    + json.dumps(str(package / "rust")) + '}\n')
                run("cargo", "run", "--offline", "--manifest-path", rust / "Cargo.toml", "--",
                    package / "runtime/liblvgl.wasm",
                    env={**os.environ, "CARGO_TARGET_DIR": str(ROOT / "target/rust")})
        finally:
            readonly(package, False)
    # Use a nested crate so the fallback is confined to the test directory.
    missing = output / "isolated/rust"
    missing.mkdir(parents=True)
    fallback = (missing / "../../target/rust-bindings/raw.rs").resolve()
    fallback.parent.mkdir(parents=True, exist_ok=True)
    fallback.write_text("external fallback must not be copied")
    environment = {**os.environ, "CARGO_MANIFEST_DIR": str(missing), "OUT_DIR": str(output)}
    environment.pop("LVW_RUST_BINDINGS", None)
    failed = subprocess.run([str(build_script)], env=environment, capture_output=True, text=True)
    assert failed.returncode != 0 and "generated/raw.rs" in failed.stderr
    (missing / "override.rs").write_text("explicit override")
    run(build_script, env={**environment, "LVW_RUST_BINDINGS": "override.rs"})
    assert (output / "raw.rs").read_text() == "explicit override"
    (output / "report.json").write_text(json.dumps(packages, indent=2) + "\n")


if __name__ == "__main__":
    check(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None)
