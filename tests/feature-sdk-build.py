"""Build and exercise an optional feature SDK against the installed NDK."""

import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "toolchains"))
from host_sdk import build_host_sdk
from lvw import file_inventory, publish_package
from feature_sdk_consumer import check


def main(output):
    output = Path(output).resolve()
    build, ndk = ROOT / "target/wasm", output / "ndk"
    subprocess.run(["cmake", "--build", build, "--target", "lvw_ndk", "-j", "4"], check=True)
    subprocess.run(["cmake", "--install", build, "--prefix", ndk, "--component", "ndk"], check=True)
    staged, sdk = output / "staged-sdk", output / "sdk"
    metadata = build_host_sdk(ROOT, ndk, build / "liblvgl.wasm", staged, "wasm-tools", with_validator=True)
    target = json.loads((ROOT / "toolchains/tools.lock.json").read_text())["target"]
    manifest = {"schema_version": 1, "kind": "wasip1-host-sdk", "target": target,
                **metadata, "files": file_inventory(staged)}
    publish_package(staged, sdk, "sdk.json", manifest)
    check(sdk, ndk)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: feature-sdk-build.py OUTPUT")
    main(sys.argv[1])
