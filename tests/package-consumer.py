"""Run TypeScript and Rust consumers against a relocated read-only host SDK."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "toolchains"))
from lvw import verify_package


def run(*command, cwd=None, env=None):
    subprocess.run([str(item) for item in command], cwd=cwd, env=env,
                   stdout=sys.stderr, check=True)


def readonly(root, enabled):
    for path in [root, *root.rglob("*")]:
        if path.is_dir():
            path.chmod(0o555 if enabled else 0o755)
        elif path.is_file():
            path.chmod(0o444 if enabled else 0o644)


def run_typescript(package, work):
    project = work / "typescript consumer"
    project.mkdir()
    (project / "package.json").write_text('{"type":"module"}\n')
    (project / "node_modules").mkdir()
    (project / "node_modules/liblvgl-wasm").symlink_to(
        package / "host-sdk/typescript", target_is_directory=True
    )
    shutil.copyfile(ROOT / "tests/fixtures/host-sdk/consumer.ts", project / "consumer.ts")
    for mode in ("Bundler", "NodeNext"):
        config = {
            "compilerOptions": {
                "target": "ES2022", "strict": True, "noEmit": True,
                "module": "ESNext" if mode == "Bundler" else "NodeNext",
                "moduleResolution": mode, "lib": ["ES2022", "DOM"], "types": [],
            },
            "files": ["consumer.ts"],
        }
        (project / "tsconfig.json").write_text(json.dumps(config))
        run("bun", ROOT / "node_modules/typescript/bin/tsc", "--project", project / "tsconfig.json")
    run("bun", "build", "consumer.ts", "--target", "browser",
        "--outfile", "target/consumer.js", cwd=project)
    (project / "runner.ts").write_text(
        '''import { exercise } from "./target/consumer.js";

const [corePath, bitmapPath] = Bun.argv.slice(2);
if (!corePath || !bitmapPath) throw new Error("consumer paths are required");
const result = await exercise(
  await Bun.file(corePath).arrayBuffer(),
  await Bun.file(corePath).arrayBuffer(),
  await Bun.file(bitmapPath).bytes(),
);
if (result.identity.sdk.status !== "matched" || result.clicks !== 1 ||
    result.remaining !== 0 || !result.closed || result.mismatch ||
    result.resourcePixel.join(",") !== "255,0,0" || !result.changed ||
    result.timerRejected !== !result.hasTimer) {
  throw new Error(JSON.stringify(result, (_, value) =>
    typeof value === "bigint" ? value.toString() : value));
}
console.log(JSON.stringify(result, (_, value) =>
  typeof value === "bigint" ? value.toString() : value));
'''
    )
    run("bun", "runner.ts", package / "host-sdk/runtime/liblvgl.wasm",
        package / "source/examples/browser/red.bmp", cwd=project)


def run_rust(package, work):
    project = work / "rust consumer"
    (project / "src").mkdir(parents=True)
    host = package / "host-sdk/rust"
    bitmap = (package / "source/examples/browser/red.bmp").as_posix()
    main = (ROOT / "bindings/rust/src/main.rs").read_text()
    main = main.replace(
        'include_bytes!("../../../examples/browser/red.bmp")',
        f'include_bytes!(r###"{bitmap}"###)',
    )
    (project / "src/main.rs").write_text(main)
    (project / "Cargo.toml").write_text(
        '[package]\nname = "relocated-host-consumer"\nversion = "0.1.0"\nedition = "2024"\n'
        '[dependencies]\nliblvgl-wasm-host = { path = '
        + json.dumps(str(host)) + ' }\n'
    )
    run("cargo", "generate-lockfile", "--manifest-path", project / "Cargo.toml")
    environment = {**os.environ, "CARGO_TARGET_DIR": str(work / "cargo-target")}
    run("cargo", "run", "--locked", "--manifest-path", project / "Cargo.toml", "--",
        package / "host-sdk/runtime/liblvgl.wasm", env=environment)


def check(package):
    package = Path(package).expanduser().resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="lvw relocated package ") as directory:
        work = Path(directory)
        moved = work / "moved package"
        shutil.copytree(package, moved)
        readonly(moved, True)
        try:
            verify_package(moved)
            run_typescript(moved, work)
            run_rust(moved, work)
            print(json.dumps({"package": str(moved), "typescript": True, "rust": True}))
        finally:
            readonly(moved, False)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: package-consumer.py PACKAGE")
    check(sys.argv[1])
