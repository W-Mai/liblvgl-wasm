"""Build and exercise verified software components with relocated native and host SDKs."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("compatibility", ROOT / "scripts/check-compatibility.py")
compatibility = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compatibility)


def check(component_filter=None):
    output = ROOT / "target/compatibility"
    output.mkdir(parents=True, exist_ok=True)
    report = output / (f"software-{component_filter}-report.json" if component_filter else "software-report.json")
    report.unlink(missing_ok=True)
    default = json.loads((ROOT / "target/wasm/lvgl-source.json").read_text())
    assert default["version"] == {"major": 9, "minor": 6, "patch": 0, "info": ""}
    sources = [("v9.0.0", compatibility.source_tree(output, compatibility.LEGACY[0])),
               ("v9.6.0", Path(default["source"]))]
    build = output / "software-build"
    preset = (ROOT / "config/base/lv_conf.h").read_text()
    results = []
    for component, macro in (("gif", "LV_USE_GIF"), ("png", "LV_USE_LODEPNG"), ("png-gif", "LV_USE_GIF")):
        if component_filter and component != component_filter:
            continue
        base = preset.replace(f"#define {macro} 0", f"#define {macro} 1")
        if component == "png-gif":
            base = base.replace("#define LV_USE_LODEPNG 0", "#define LV_USE_LODEPNG 1")
        for version, source in sources:
            if component == "png-gif" and version != "v9.0.0":
                continue
            cases = [("uncached", 0, 0, 1, component == "gif" and version == "v9.6.0"), ("cached", 16384, 4, 8, True)]
            if component == "png-gif":
                cases = cases[1:]
            if component == "png" and version == "v9.0.0":
                cases.insert(1, ("headers", 0, 4, 8, False))
            for label, cache_bytes, header_entries, stride, managed in cases:
                name = f"{version}-{component}-{label}"
                config = output / name / "lv_conf.h"
                config.parent.mkdir(exist_ok=True)
                prefix, suffix = base.rsplit("#endif", 1)
                config.write_text(prefix + f"#undef LV_CACHE_DEF_SIZE\n#define LV_CACHE_DEF_SIZE {cache_bytes}\n"
                                  f"#undef LV_IMAGE_HEADER_CACHE_DEF_CNT\n#define LV_IMAGE_HEADER_CACHE_DEF_CNT {header_entries}\n"
                                  f"#undef LV_DRAW_BUF_STRIDE_ALIGN\n#define LV_DRAW_BUF_STRIDE_ALIGN {stride}\n"
                                  "#endif" + suffix)
                legacy_gif = component in {"gif", "png-gif"} and version == "v9.0.0"
                if legacy_gif:
                    text = config.read_text()
                    before, after = text.rsplit("#endif", 1)
                    config.write_text(before + f"#define LV_GIF_CACHE_DECODE_DATA {int(managed)}\n#endif" + after)
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
                assert constants[macro] == "1"
                if component == "png-gif":
                    assert constants["LV_USE_LODEPNG"] == "1"
                if legacy_gif:
                    assert constants["LV_GIF_CACHE_DECODE_DATA"] == str(int(managed))
                assert constants["LV_DRAW_BUF_STRIDE_ALIGN"] == str(stride)
                with (output / f"{name}-consumers.log").open("w") as log:
                    subprocess.run(["bun", "test", "./tests/ndk.test.ts", "./tests/host-sdk.test.ts"], cwd=ROOT,
                                   env={**os.environ, "LVW_TEST_BUILD": str(build), "LVW_TEST_CALLBACKS": "",
                                        "LVW_TEST_SOFTWARE": component.replace("-", " ")}, stdout=log, stderr=subprocess.STDOUT, check=True)
                evidence = output / "evidence" / name
                evidence.mkdir(parents=True, exist_ok=True)
                for filename in ("api.json", "api-verification.json", "liblvgl.wasm", "lvgl-source.json"):
                    shutil.copyfile(build / filename, evidence / filename)
                proof = json.loads((build / "api-verification.json").read_text())
                inspected = json.loads((build / "lvgl-source.json").read_text())
                results.append({"version": inspected["version"], "component": component, "cache_bytes": cache_bytes,
                                "header_entries": header_entries, "stride_alignment": stride,
                                "bridge_features": features.split(";") if features else [],
                                "configuration": inspected["config_sha256"], "proof": proof,
                                "native": ["c", "cpp", "zig"], "hosts": ["bun", "rust"],
                                "evidence": evidence.relative_to(ROOT).as_posix()})
                if legacy_gif:
                    results[-1]["gif_decode_cache"] = bool(managed)
                print(f"{name}: pixels, source lifetimes, failure recovery, and relocated consumers passed", flush=True)
    with (output / "software-adapters.log").open("w") as log:
        subprocess.run(["bun", "test", "./tests/native-adapters.test.ts"], cwd=ROOT,
                       env={**os.environ, "LVW_TEST_PNG_SOURCE": str(sources[0][1]),
                            "LVW_TEST_GIF_SOURCE": str(sources[0][1])},
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    report.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="use the cached source archive")
    parser.add_argument("--component", choices=("png", "gif", "png-gif"), help="check one component group and write a scoped report")
    check(parser.parse_args().component)
