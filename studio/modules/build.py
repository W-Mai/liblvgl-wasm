"""Build the isolated C module example and its browser runner."""

import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "target/studio/modules"


def run(*arguments):
    subprocess.run([str(value) for value in arguments], cwd=ROOT, check=True)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inventory(directory):
    files = {}
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise ValueError("Studio module assets must not contain symbolic links")
        if path.is_file():
            files[path.relative_to(directory).as_posix()] = digest(path.read_bytes())
    return files


def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    validator = ROOT / "target/validator"
    validator.mkdir(parents=True, exist_ok=True)
    if OUTPUT.is_symlink() or OUTPUT.parent.is_symlink():
        raise ValueError("Studio module output must not be a symbolic link")
    with (OUTPUT.parent / ".modules.lock").open("w") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        inputs = [*sorted((ROOT / "studio/modules").glob("*.ts")), Path(__file__).resolve(),
                  ROOT / "studio/src/controller.ts", ROOT / "studio/src/protocol.ts", ROOT / "studio/src/paths.ts",
                  ROOT / "validator/lvgl-event-lib.c", ROOT / "validator/lvgl-label-lib-app.c",
                  ROOT / "validator/lvgl-label-lib-fixture.py", ROOT / "tests/fixtures/numeric-label-lib/generate.ts",
                  ROOT / "tests/fixtures/numeric-lvgl/generate.ts", ROOT / "scripts/build-studio-modules.sh"]
        snapshot = {path: path.read_bytes() for path in inputs}
        run("sh", ROOT / "scripts/build-bounded-core.sh")
        with tempfile.TemporaryDirectory(prefix=".studio-modules-", dir=OUTPUT.parent) as scratch, \
                tempfile.TemporaryDirectory(prefix=".studio-sdk-", dir=validator) as validator_scratch:
            work = Path(scratch)
            package = work / "package"
            package.mkdir()
            ndk = work / "ndk"
            run("cmake", "--build", ROOT / "target/wasm", "--target", "lvw_ndk", "-j", "2")
            run("cmake", "--install", ROOT / "target/wasm", "--component", "ndk", "--prefix", ndk)
            run("python3", "-B", ROOT / "validator/lvgl-label-lib-fixture.py",
                "--event", "--ndk", ndk, "--output", work / "fixtures")
            graph_path = work / "graph.json"
            run("bun", ROOT / "tests/fixtures/numeric-label-lib/generate.ts", "--event", "--real-only",
                "--fixtures", work / "fixtures", "--output", graph_path)
            [graph] = json.loads(graph_path.read_bytes())
            if graph["name"] != "real" or graph["label"]["consumer"] != "middle":
                raise ValueError("Unexpected Studio event example")

            sdk = Path(validator_scratch) / "sdk"
            run("sh", ROOT / "validator/build-worker.sh", "--sdk-dir", sdk)
            shutil.copytree(sdk, package / "sdk")
            notices_spec = importlib.util.spec_from_file_location("studio_validator_notices", ROOT / "validator/notices.py")
            notices = importlib.util.module_from_spec(notices_spec)
            notices_spec.loader.exec_module(notices)
            shutil.copyfile(ROOT / "node_modules/@noble/hashes/LICENSE", package / "LICENSE-noble-hashes.txt")
            notices.copy_notices(ROOT, package / "LICENSE-noble-hashes.txt", package / "licenses/validator")

            wasi = next(host for host in graph["input"]["hosts"] if host["id"] == "host.wasi")
            allowed = [item["name"] for item in wasi["exports"]]
            if not set(allowed).issubset({"environ_get", "environ_sizes_get", "clock_time_get", "fd_close",
                                        "fd_seek", "fd_write", "proc_exit"}):
                raise ValueError("Studio module core requires an unsupported WASI capability")
            preset = {"modules": graph["profile"]["modules"], "hosts": graph["profile"]["hosts"], "wasi": allowed,
                      "limits": graph["profile"]["limits"], "label": graph["label"],
                      "event": graph["event"], "allowedFeatures": graph["allowedFeatures"]}
            (package / "preset.ts").write_text("export const PRESET = " + json.dumps(preset) + " as const;\n")
            modules = []
            source = package / "source"
            source.mkdir()
            for entry in graph["input"]["modules"]:
                manifest = entry["manifest"]
                filename = {"lvcore": "liblvgl.wasm", "middle": "events.wasm", "app": "app.wasm"}[manifest["id"]]
                data = bytes.fromhex(entry["hex"])
                if digest(data) != manifest["artifact"]["sha256"]:
                    raise ValueError("Studio module input identity differs")
                manifest["artifact"]["path"] = filename
                (package / filename).write_bytes(data)
                modules.append({"manifest": manifest, **({"source": "source/events.c"} if manifest["id"] == "middle"
                               else {"source": "source/app.c"} if manifest["id"] == "app" else {})})
            for original, name in [("validator/lvgl-event-lib.c", "events.c"),
                                   ("validator/lvgl-label-lib-app.c", "app.c"),
                                   ("scripts/build-studio-modules.sh", "build.sh")]:
                shutil.copyfile(ROOT / original, source / name)
            shutil.copyfile(ROOT / "target/wasm/api-verification-bounded.json", package / "verification.json")

            staged = work / "worker-source"
            staged.mkdir()
            for name in ("protocol.ts", "runtime.ts", "worker.ts"):
                text = snapshot[ROOT / "studio/modules" / name].decode()
                for relative in ("sdk/feature-validator.js", "preset.ts"):
                    text = text.replace(json.dumps("../../target/studio/modules/" + relative),
                                        json.dumps((package / relative).as_posix()))
                (staged / name).write_text(text)
            config = work / "tsconfig.json"
            config.write_text(json.dumps({"extends": str(ROOT / "tsconfig.studio-modules.json"),
                                          "files": [str(staged / "worker.ts")], "include": []}))
            run("bun", ROOT / "node_modules/typescript/bin/tsc", "--project", config)
            run("bun", "build", staged / "worker.ts", "--target", "browser", "--format", "iife",
                "--minify", "--outfile", package / "worker.js")
            run("bun", "build", ROOT / "studio/modules/controller.ts", "--target", "browser", "--format", "esm",
                "--minify", "--outfile", package / "controller.js")
            for name in ("worker.js", "controller.js"):
                data = (package / name).read_bytes()
                if str(ROOT).encode() in data or str(work).encode() in data or str(sdk).encode() in data:
                    raise ValueError("Studio module bundle contains a local build path")

            public_files = {name: sha for name, sha in inventory(package).items()
                            if not name.startswith("sdk/") and name != "preset.ts"}
            project = {"schema_version": 1, "kind": "studio-module-project", "modules": modules,
                       "hosts": graph["input"]["hosts"], "files": public_files}
            (package / "project.json").write_text(json.dumps(project, indent=2) + "\n")
            if any(path.read_bytes() != data for path, data in snapshot.items()):
                raise ValueError("Studio module source changed during the build")
            record = {"schema_version": 1, "kind": "studio-module-build", "files": inventory(package),
                      "inputs": {path.relative_to(ROOT).as_posix(): digest(data) for path, data in snapshot.items()},
                      "runtime_files": sorted([*public_files, "project.json"])}
            (package / "build.json").write_text(json.dumps(record, indent=2) + "\n")
            if OUTPUT.exists():
                old = json.loads((OUTPUT / "build.json").read_bytes())
                actual = inventory(OUTPUT)
                actual.pop("build.json")
                if old.get("kind") != "studio-module-build" or old.get("files") != actual:
                    raise ValueError("Existing Studio module output has changed")
                backup = work / "previous"
                os.rename(OUTPUT, backup)
                try:
                    os.rename(package, OUTPUT)
                except BaseException:
                    os.rename(backup, OUTPUT)
                    raise
            else:
                os.rename(package, OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    build()
