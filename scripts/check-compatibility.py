"""Build and exercise LVGL v9.0 and default-source base and managed callbacks."""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "toolchains"))
from lvw import RECEIPT, fetch_archive, safe_extract, tree_sha256

LEGACY = {
    "url": "https://codeload.github.com/lvgl/lvgl/tar.gz/refs/tags/v9.0.0",
    "root": "lvgl-9.0.0", "size": 55766129,
    "sha256": "73ae6ef7b44b434b41f25755ce4f6f5d23c49c1c254c4b7774b5a9cf83a46b7f",
}
CALLBACKS = {"timer": "timers", "animation": "animations", "observer": "observers", "decoder": "decoders"}


def check():
    output = ROOT / "target/compatibility"
    output.mkdir(parents=True, exist_ok=True)
    report = output / "report.json"
    report.unlink(missing_ok=True)
    default = json.loads((ROOT / "target/wasm/lvgl-source.json").read_text())
    assert default["version"] == {"major": 9, "minor": 6, "patch": 0, "info": ""}, default["version"]
    source = output / LEGACY["root"]
    archive = fetch_archive(output, LEGACY, "--offline" in sys.argv[1:])
    if not source.exists():
        with tempfile.TemporaryDirectory(prefix="source-", dir=output) as temporary:
            extracted = safe_extract(archive, Path(temporary), LEGACY["root"])
            receipt = {"archive": LEGACY["sha256"], "tree": tree_sha256(extracted)}
            (extracted / RECEIPT).write_text(json.dumps(receipt))
            extracted.rename(source)
    receipt = json.loads((source / RECEIPT).read_text())
    assert receipt == {"archive": LEGACY["sha256"], "tree": tree_sha256(source)}, "modified compatibility source"
    # Reuse one build directory to exercise source/config cache invalidation.
    build = output / "matrix-build"
    base_config = ROOT / "config/base/lv_conf.h"
    callback_config = output / "callbacks/lv_conf.h"
    callback_config.parent.mkdir(exist_ok=True)
    config_prefix, config_suffix = base_config.read_text().rsplit("#endif", 1)
    callback_config.write_text(config_prefix + "#undef LV_IMAGE_HEADER_CACHE_DEF_CNT\n"
                              "#define LV_IMAGE_HEADER_CACHE_DEF_CNT 4\n\n#endif" + config_suffix)
    results = []
    cases = [(version, selected, features) for version, selected in
             (("v9.0.0", source), ("v9.6.0", Path(default["source"]))) for features in ((), tuple(CALLBACKS))]
    for version, selected, features in cases:
        name = f"{version}-{'-'.join(features) or 'base'}"
        environment = {**os.environ, "LVGL_SOURCE_DIR": str(selected),
                       "LVGL_CONFIG_PATH": str(callback_config if features else base_config),
                       "LVW_BRIDGE_FEATURES": ";".join(features), "LVW_BUILD_DIR": str(build)}
        with (output / f"{name}-build.log").open("w") as log:
            subprocess.run(["sh", str(ROOT / "scripts/build-core.sh")], cwd=ROOT,
                           env=environment, stdout=log, stderr=subprocess.STDOUT, check=True)
        inspected = json.loads((build / "lvgl-source.json").read_text())
        assert inspected["version"]["minor"] == (0 if version == "v9.0.0" else 6)
        proof = json.loads((build / "api-verification.json").read_text())
        with (output / f"{name}-consumers.log").open("w") as log:
            subprocess.run(["bun", "test", "./tests/ndk.test.ts", "./tests/host-sdk.test.ts"], cwd=ROOT,
                           env={**os.environ, "LVW_TEST_BUILD": str(build),
                                "LVW_TEST_CALLBACKS": " ".join(CALLBACKS[feature] for feature in features)},
                           stdout=log, stderr=subprocess.STDOUT, check=True)
        results.append({"version": inspected["version"], "proof": proof,
                        "configuration": inspected["config_sha256"],
                        "bridge_features": list(features),
                        "native": ["c", "cpp", "zig"], "hosts": ["bun", "rust"]})
        if version == "v9.0.0" and not features:
            with (output / "rejected-adapter.log").open("w") as log:
                failed = subprocess.run(["sh", str(ROOT / "scripts/build-core.sh")], cwd=ROOT,
                    env={**environment, "LVW_BRIDGE_FEATURES": "unknown"}, stdout=log, stderr=subprocess.STDOUT)
            assert failed.returncode != 0
            assert "Unknown managed bridge feature" in (output / "rejected-adapter.log").read_text()
            assert not (build / "api-verification.json").exists(), "stale proof after failed configuration"
        print(f"{name}: C/C++/Zig relocation and TS/Rust runtime contracts passed", flush=True)
    assert results[0]["proof"]["api_sha256"] != results[2]["proof"]["api_sha256"]
    assert len({result["proof"]["wasm_sha256"] for result in results}) == len(results)
    report.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    check()
