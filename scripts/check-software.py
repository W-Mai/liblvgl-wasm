"""Build and exercise verified software components with relocated native and host SDKs."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("compatibility", ROOT / "scripts/check-compatibility.py")
compatibility = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compatibility)


def check():
    output = ROOT / "target/compatibility"
    output.mkdir(parents=True, exist_ok=True)
    report = output / "software-report.json"
    report.unlink(missing_ok=True)
    default = json.loads((ROOT / "target/wasm/lvgl-source.json").read_text())
    assert default["version"] == {"major": 9, "minor": 6, "patch": 0, "info": ""}
    sources = [("v9.0.0", compatibility.source_tree(output, compatibility.LEGACY[0])),
               ("v9.6.0", Path(default["source"]))]
    build = output / "software-build"
    base = (ROOT / "config/base/lv_conf.h").read_text().replace("#define LV_USE_LODEPNG 0", "#define LV_USE_LODEPNG 1")
    results = []
    for version, source in sources:
        cases = [("uncached", 0, 0, 1, False), ("cached", 16384, 4, 8, True)]
        if version == "v9.0.0":
            cases.insert(1, ("headers", 0, 4, 8, False))
        for label, cache_bytes, header_entries, stride, managed in cases:
            name = f"{version}-png-{label}"
            config = output / name / "lv_conf.h"
            config.parent.mkdir(exist_ok=True)
            prefix, suffix = base.rsplit("#endif", 1)
            config.write_text(prefix + f"#undef LV_CACHE_DEF_SIZE\n#define LV_CACHE_DEF_SIZE {cache_bytes}\n"
                              f"#undef LV_IMAGE_HEADER_CACHE_DEF_CNT\n#define LV_IMAGE_HEADER_CACHE_DEF_CNT {header_entries}\n"
                              f"#undef LV_DRAW_BUF_STRIDE_ALIGN\n#define LV_DRAW_BUF_STRIDE_ALIGN {stride}\n"
                              "#endif" + suffix)
            features = "timer;animation;observer;decoder" if managed else ""
            environment = {**os.environ, "LVGL_SOURCE_DIR": str(source), "LVGL_CONFIG_PATH": str(config),
                           "LVW_BUILD_DIR": str(build), "LVW_BRIDGE_FEATURES": features}
            with (output / f"{name}-build.log").open("w") as log:
                subprocess.run(["sh", "scripts/build-core.sh"], cwd=ROOT, env=environment,
                               stdout=log, stderr=subprocess.STDOUT, check=True)
            api = json.loads((build / "api.json").read_text())
            constants = {entry["name"]: entry.get("value") for entry in api["constants"]}
            assert constants["LV_CACHE_DEF_SIZE"] == str(cache_bytes)
            assert constants["LV_IMAGE_HEADER_CACHE_DEF_CNT"] == str(header_entries)
            assert constants["LV_USE_LODEPNG"] == "1"
            assert constants["LV_DRAW_BUF_STRIDE_ALIGN"] == str(stride)
            with (output / f"{name}-consumers.log").open("w") as log:
                subprocess.run(["bun", "test", "./tests/ndk.test.ts", "./tests/host-sdk.test.ts"], cwd=ROOT,
                               env={**os.environ, "LVW_TEST_BUILD": str(build), "LVW_TEST_CALLBACKS": "",
                                    "LVW_TEST_SOFTWARE": "png"}, stdout=log, stderr=subprocess.STDOUT, check=True)
            evidence = output / "evidence" / name
            evidence.mkdir(parents=True, exist_ok=True)
            for filename in ("api.json", "api-verification.json", "liblvgl.wasm", "lvgl-source.json"):
                shutil.copyfile(build / filename, evidence / filename)
            proof = json.loads((build / "api-verification.json").read_text())
            inspected = json.loads((build / "lvgl-source.json").read_text())
            results.append({"version": inspected["version"], "component": "png", "cache_bytes": cache_bytes,
                            "header_entries": header_entries, "stride_alignment": stride,
                            "bridge_features": features.split(";") if features else [],
                            "configuration": inspected["config_sha256"], "proof": proof,
                            "native": ["c", "cpp", "zig"], "hosts": ["bun", "rust"],
                            "evidence": evidence.relative_to(ROOT).as_posix()})
            print(f"{name}: pixels, source lifetimes, failure recovery, and relocated consumers passed", flush=True)
        if version == "v9.0.0":
            with (output / "png-adapters.log").open("w") as log:
                subprocess.run(["bun", "test", "./tests/native-adapters.test.ts"], cwd=ROOT,
                               env={**os.environ, "LVW_TEST_PNG_SOURCE": str(source)},
                               stdout=log, stderr=subprocess.STDOUT, check=True)
    report.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    check()
