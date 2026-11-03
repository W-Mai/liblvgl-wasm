"""Prepare the shared numeric graph for relocated Rust SDK consumers."""

from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


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
    for name, file in (("numeric-environment", "fixture.rs"), ("feature-graph", "decode.rs")):
        destination = fixtures / name
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "tests/fixtures" / name / file, destination / file)
