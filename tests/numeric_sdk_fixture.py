"""Prepare the shared numeric graph for relocated Rust SDK consumers."""

from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def scratch_target():
    base = (ROOT / "target/validator").resolve()
    target = Path(os.environ.get("LVW_TEST_SDK_SCRATCH", base)).resolve()
    if not target.is_relative_to(base):
        raise ValueError("SDK fixture scratch must be under target/validator")
    target.mkdir(parents=True, exist_ok=True)
    return target


def prepare(directory):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    fixtures = directory / "wasm"
    graph = directory / "graph.json"
    subprocess.run([sys.executable, "-B", str(ROOT / "validator/numeric-fixtures.py"),
                    "--output", str(fixtures)], cwd=ROOT, check=True)
    subprocess.run(["bun", str(ROOT / "tests/fixtures/numeric-preflight/generate.ts"),
                    "--fixtures", str(fixtures), "--output", str(graph)], cwd=ROOT, check=True)
    return graph


def install(source):
    fixtures = Path(source) / "fixtures"
    for name, file in (("numeric-environment", "fixture.rs"), ("numeric-wasi", "fixture.rs"),
                       ("numeric-lvgl", "fixture.rs"), ("numeric-label", "fixture.rs"),
                       ("feature-graph", "decode.rs")):
        destination = fixtures / name
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "tests/fixtures" / name / file, destination / file)


def prepare_wasi(directory):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    fixtures, variants, graph = directory / "wasm", directory / "variants", directory / "graph.json"
    subprocess.run([sys.executable, "-B", str(ROOT / "validator/wasi-numeric-fixtures.py"),
                    "--output", str(fixtures)], cwd=ROOT, check=True)
    subprocess.run([sys.executable, "-B", str(ROOT / "tests/fixtures/numeric-wasi/generate.py"),
                    "--output", str(variants)], cwd=ROOT, check=True)
    subprocess.run(["bun", str(ROOT / "tests/fixtures/numeric-wasi/generate.ts"),
                    "--fixtures", str(fixtures), "--variants", str(variants), "--output", str(graph)],
                   cwd=ROOT, check=True)
    return graph


def prepare_lvgl(directory):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / "graph.json"
    target = scratch_target()
    with tempfile.TemporaryDirectory(prefix="lvw-sdk-core-fixture-", dir=target) as temporary:
        subprocess.run([sys.executable, "-B", str(ROOT / "validator/lvgl-core-fixture.py"),
                        "--output", temporary], cwd=ROOT, check=True)
        subprocess.run(["bun", str(ROOT / "tests/fixtures/numeric-lvgl/generate.ts"), "--real-only",
                        "--core", str(ROOT / "target/wasm/liblvgl-bounded.wasm"),
                        "--app", str(Path(temporary) / "lvgl-core-app.wasm"),
                        "--api", str(ROOT / "target/wasm/api.json"),
                        "--proof", str(ROOT / "target/wasm/api-verification-bounded.json"),
                        "--output", str(output)], cwd=ROOT, check=True)
    return output


def reject_ndk_links(root):
    for parent, directories, files in os.walk(root, followlinks=False):
        if any((Path(parent) / name).is_symlink() for name in directories + files):
            raise ValueError("label fixture NDK must not contain symbolic links")


def prepare_label(directory, ndk, *, event=False):
    directory = Path(directory).resolve()
    ndk = Path(ndk).resolve(strict=True)
    target = scratch_target()
    if (directory == ndk or directory.is_relative_to(ndk) or ndk.is_relative_to(directory)
            or target == ndk or target.is_relative_to(ndk)):
        raise ValueError("label fixture output and NDK must not overlap")
    reject_ndk_links(ndk)
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / "graph.json"
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="lvw-sdk-label-fixture-", dir=target) as temporary:
        work = Path(temporary)
        copied_ndk = work / "readonly-ndk"
        shutil.copytree(ndk, copied_ndk, symlinks=True)
        reject_ndk_links(copied_ndk)
        paths = [copied_ndk, *copied_ndk.rglob("*")]
        for path in paths:
            path.chmod(0o555 if path.is_dir() else 0o444 | (path.stat().st_mode & 0o111))
        try:
            fixture = "event" if event else "label"
            subprocess.run([sys.executable, "-B", str(ROOT / f"validator/lvgl-{fixture}-fixture.py"),
                            "--ndk", str(copied_ndk), "--output", str(work / "app")], cwd=ROOT, check=True)
            subprocess.run(["bun", str(ROOT / "tests/fixtures/numeric-label/generate.ts"), "--real-only",
                            *(["--event"] if event else []),
                            "--core", str(ROOT / "target/wasm/liblvgl-bounded.wasm"),
                            "--app", str(work / f"app/lvgl-{fixture}-app.wasm"),
                            "--api", str(ROOT / "target/wasm/api.json"),
                            "--proof", str(ROOT / "target/wasm/api-verification-bounded.json"),
                            "--output", str(output)], cwd=ROOT, check=True)
        finally:
            for path in paths:
                path.chmod(0o755 if path.is_dir() else 0o644 | (path.stat().st_mode & 0o111))
    return output


def prepare_event(directory, ndk):
    return prepare_label(directory, ndk, event=True)


def prepare_chain(directory, ndk):
    return prepare_library_graph(directory, ndk, "chain")


def prepare_label_lib(directory, ndk):
    return prepare_library_graph(directory, ndk, "label-lib")


def prepare_event_lib(directory, ndk):
    return prepare_library_graph(directory, ndk, "event-lib")


def prepare_library_graph(directory, ndk, kind):
    if kind not in {"chain", "label-lib", "event-lib"}:
        raise ValueError("unknown SDK library graph")
    directory = Path(directory).resolve()
    ndk = Path(ndk).resolve(strict=True)
    target = scratch_target()
    if (directory == ndk or directory.is_relative_to(ndk) or ndk.is_relative_to(directory)
            or target == ndk or target.is_relative_to(ndk)):
        raise ValueError(f"{kind} fixture output and NDK must not overlap")
    reject_ndk_links(ndk)
    directory.mkdir(parents=True, exist_ok=True)
    target.mkdir(parents=True, exist_ok=True)
    output = directory / "graph.json"
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"{kind} graph output already exists: {output}")
    with tempfile.TemporaryDirectory(prefix=f"lvw-sdk-{kind}-fixture-", dir=target) as temporary:
        work = Path(temporary)
        copied_ndk = work / "readonly-ndk"
        shutil.copytree(ndk, copied_ndk, symlinks=True)
        reject_ndk_links(copied_ndk)
        paths = [copied_ndk, *copied_ndk.rglob("*")]
        for path in paths:
            path.chmod(0o555 if path.is_dir() else 0o444 | (path.stat().st_mode & 0o111))
        try:
            source_kind = "label-lib" if kind == "event-lib" else kind
            event_args = ["--event"] if kind == "event-lib" else []
            subprocess.run([sys.executable, "-B", str(ROOT / f"validator/lvgl-{source_kind}-fixture.py"), *event_args,
                            "--ndk", str(copied_ndk), "--output", str(work / "fixtures")], cwd=ROOT, check=True)
            graph = work / "graph.json"
            subprocess.run(["bun", str(ROOT / f"tests/fixtures/numeric-{source_kind}/generate.ts"), "--real-only", *event_args,
                            "--fixtures", str(work / "fixtures"),
                            "--core", str(ROOT / "target/wasm/liblvgl-bounded.wasm"),
                            "--api", str(ROOT / "target/wasm/api.json"),
                            "--proof", str(ROOT / "target/wasm/api-verification-bounded.json"),
                            "--output", str(graph)], cwd=ROOT, check=True)
            with tempfile.TemporaryDirectory(prefix=f".lvw-{kind}-graph-", dir=directory) as staged:
                copied = Path(staged) / "graph.json"
                shutil.copyfile(graph, copied)
                os.link(copied, output)
        finally:
            for path in paths:
                path.chmod(0o755 if path.is_dir() else 0o644 | (path.stat().st_mode & 0o111))
    return output


def run_event_consumer(package, project, graph, environment):
    consumer = Path(project) / "rust-event"
    (consumer / "src").mkdir(parents=True)
    shutil.copyfile(ROOT / "tests/fixtures/host-sdk/event-graph.rs", consumer / "src/main.rs")
    install(consumer / "src")
    (consumer / "Cargo.toml").write_text('[package]\nname="lvw-event-consumer"\n'
        'version="0.1.0"\nedition="2024"\n[dependencies]\nliblvgl-wasm-host={path='
        + json.dumps(str(Path(package) / "rust")) + '}\nserde_json="=1.0.151"\nsha2="=0.10.9"\n')
    shutil.copyfile(Path(package) / "rust/Cargo.lock", consumer / "Cargo.lock")
    manifest = consumer / "Cargo.toml"
    subprocess.run(["cargo", "metadata", "--offline", "--format-version", "1", "--manifest-path", str(manifest)],
                   env=environment, stdout=subprocess.DEVNULL, check=True)
    subprocess.run(["cargo", "run", "--locked", "--offline", "--manifest-path", str(manifest), "--", str(graph)],
                   env=environment, check=True)


def run_chain_consumer(package, project, graph, environment):
    consumer = Path(project) / "rust-chain"
    (consumer / "src/fixtures/host-sdk").mkdir(parents=True)
    shutil.copyfile(ROOT / "tests/fixtures/host-sdk/chain-graph.rs", consumer / "src/fixtures/host-sdk/chain-graph.rs")
    (consumer / "src/main.rs").write_text('#[path = "fixtures/host-sdk/chain-graph.rs"]\n#[allow(dead_code)]\nmod chain;\nfn main() { chain::main(); }\n')
    install(consumer / "src")
    (consumer / "Cargo.toml").write_text('[package]\nname="lvw-chain-consumer"\n'
        'version="0.1.0"\nedition="2024"\n[dependencies]\nliblvgl-wasm-host={path='
        + json.dumps(str(Path(package) / "rust")) + '}\nserde_json="=1.0.151"\nsha2="=0.10.9"\n')
    shutil.copyfile(Path(package) / "rust/Cargo.lock", consumer / "Cargo.lock")
    manifest = consumer / "Cargo.toml"
    subprocess.run(["cargo", "metadata", "--offline", "--format-version", "1", "--manifest-path", str(manifest)],
                   env=environment, stdout=subprocess.DEVNULL, check=True)
    subprocess.run(["cargo", "run", "--locked", "--offline", "--manifest-path", str(manifest), "--", str(graph)],
                   env=environment, check=True)


def run_label_consumer(package, project, graph, environment):
    consumer = Path(project) / "rust-label-consumer"
    (consumer / "src/fixtures/host-sdk").mkdir(parents=True)
    shutil.copyfile(ROOT / "tests/fixtures/host-sdk/label-consumer.rs", consumer / "src/fixtures/host-sdk/label-consumer.rs")
    (consumer / "src/main.rs").write_text('#[path = "fixtures/host-sdk/label-consumer.rs"]\nmod label;\nfn main() { label::main(); }\n')
    install(consumer / "src")
    (consumer / "Cargo.toml").write_text('[package]\nname="lvw-label-consumer"\n'
        'version="0.1.0"\nedition="2024"\n[dependencies]\nliblvgl-wasm-host={path='
        + json.dumps(str(Path(package) / "rust")) + '}\nserde_json="=1.0.151"\nsha2="=0.10.9"\n')
    shutil.copyfile(Path(package) / "rust/Cargo.lock", consumer / "Cargo.lock")
    manifest = consumer / "Cargo.toml"
    subprocess.run(["cargo", "metadata", "--offline", "--format-version", "1", "--manifest-path", str(manifest)],
                   env=environment, stdout=subprocess.DEVNULL, check=True)
    subprocess.run(["cargo", "run", "--locked", "--offline", "--manifest-path", str(manifest), "--", str(graph)],
                   env=environment, check=True)
