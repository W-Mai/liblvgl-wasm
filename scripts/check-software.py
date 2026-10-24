"""Build and exercise verified software components with relocated native and host SDKs."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("compatibility", ROOT / "scripts/check-compatibility.py")
compatibility = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compatibility)


def cached_freetype(build):
    recipe = (ROOT / "cmake/freetype.cmake").read_text()
    filename = re.search(r"URL https://\S+/(freetype-[^/\s]+\.tar\.xz)", recipe)[1]
    digest = re.search(r"URL_HASH SHA256=([0-9a-f]{64})", recipe)[1]
    relative = Path("_deps/freetype-subbuild/freetype-populate-prefix/src") / filename
    archive = ROOT / "target/wasm" / relative
    if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
        raise ValueError("Software checks require the verified FreeType archive from the default build")
    destination = build / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists() or destination.read_bytes() != archive.read_bytes():
        shutil.copyfile(archive, destination)


def check(component_filter=None, version_filter=None):
    output = ROOT / "target/compatibility"
    output.mkdir(parents=True, exist_ok=True)
    scope = "-".join(filter(None, ("software", component_filter, version_filter)))
    report = output / f"{scope}-report.json"
    report.unlink(missing_ok=True)
    default = json.loads((ROOT / "target/wasm/lvgl-source.json").read_text())
    assert default["version"] == {"major": 9, "minor": 6, "patch": 0, "info": ""}
    sources = [("v9.0.0", compatibility.source_tree(output, compatibility.LEGACY[0])),
               ("v9.6.0", Path(default["source"]))]
    if component_filter in {None, "png", "gif", "png-gif", "tinyttf", "freetype"} and version_filter in {None, "v9.1.0"}:
        sources.insert(1, ("v9.1.0", compatibility.source_tree(output, compatibility.LEGACY[1])))
    build = output / "software-build"
    preset = (ROOT / "config/base/lv_conf.h").read_text()
    results = []
    for component, macro in (("gif", "LV_USE_GIF"), ("png", "LV_USE_LODEPNG"), ("png-gif", "LV_USE_GIF"),
                             ("tinyttf", "LV_USE_TINY_TTF"), ("freetype", "LV_USE_FREETYPE"),
                             ("vector", "LV_USE_VECTOR_GRAPHIC")):
        if component_filter and component != component_filter:
            continue
        base = preset.replace(f"#define {macro} 0", f"#define {macro} 1")
        if component == "png-gif":
            base = base.replace("#define LV_USE_LODEPNG 0", "#define LV_USE_LODEPNG 1")
        if component == "freetype":
            base = base.replace("#define LV_USE_FREETYPE 1", "#define LV_USE_FREETYPE 1\n#define LV_FREETYPE_USE_LVGL_PORT 1")
            cached_freetype(build)
        if component == "vector":
            base = base.replace("#define LV_USE_THORVG 0", "#define LV_USE_THORVG 1")
            base = base.replace("#define LV_USE_THORVG_INTERNAL 0", "#define LV_USE_THORVG_INTERNAL 1")
            before, after = base.rsplit("#endif", 1)
            base = before + "#define LV_USE_FLOAT 1\n#define LV_USE_MATRIX 1\n#endif" + after
        for version, source in sources:
            if version_filter and version != version_filter:
                continue
            if version == "v9.1.0" and component not in {"png", "gif", "png-gif", "tinyttf", "freetype"}:
                continue
            if component == "png-gif" and version not in {"v9.0.0", "v9.1.0"}:
                continue
            cases = [("uncached", 0, 0, 1, component == "gif" and version == "v9.6.0"), ("cached", 16384, 4, 8, True)]
            if component == "png-gif":
                cases = cases[1:]
            if component in {"tinyttf", "freetype", "vector"}:
                cases = [("packed", 0, 0, 1, False), ("aligned", 0, 0, 8, True)]
            if component == "png" and version in {"v9.0.0", "v9.1.0"}:
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
                legacy_gif = component in {"gif", "png-gif"} and version in {"v9.0.0", "v9.1.0"}
                if legacy_gif:
                    text = config.read_text()
                    before, after = text.rsplit("#endif", 1)
                    config.write_text(before + f"#define LV_GIF_CACHE_DECODE_DATA {int(managed)}\n#endif" + after)
                if component in {"tinyttf", "freetype"}:
                    before, after = config.read_text().rsplit("#endif", 1)
                    config.write_text(before + "#define LV_TINY_TTF_FILE_SUPPORT 0\n#endif" + after)
                if component == "freetype" and managed:
                    config.write_text(config.read_text().replace("#define LV_USE_TINY_TTF 0", "#define LV_USE_TINY_TTF 1"))
                if component == "freetype" and version == "v9.1.0":
                    before, after = config.read_text().rsplit("#endif", 1)
                    config.write_text(before + "#define LV_FREETYPE_CACHE_FT_GLYPH_CNT 4\n#endif" + after)
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
                if component == "tinyttf":
                    assert constants["LV_TINY_TTF_FILE_SUPPORT"] == "0"
                if component == "freetype":
                    assert constants["LV_FREETYPE_USE_LVGL_PORT"] == "1"
                    assert constants["LV_USE_VECTOR_GRAPHIC"] == "0"
                    assert constants["LV_USE_TINY_TTF"] == str(int(managed))
                if component == "vector":
                    assert constants["LV_USE_FLOAT"] == "1"
                    assert constants["LV_USE_THORVG_INTERNAL"] == "1"
                assert constants["LV_DRAW_BUF_STRIDE_ALIGN"] == str(stride)
                contracts = component.replace("-", " ") + (" tinyttf" if component == "freetype" and managed else "")
                with (output / f"{name}-consumers.log").open("w") as log:
                    subprocess.run(["bun", "test", "./tests/ndk.test.ts", "./tests/host-sdk.test.ts"], cwd=ROOT,
                                   env={**os.environ, "LVW_TEST_BUILD": str(build), "LVW_TEST_CALLBACKS": "",
                                        "LVW_TEST_SOFTWARE": contracts}, stdout=log, stderr=subprocess.STDOUT, check=True)
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
                if component == "tinyttf":
                    results[-1]["tinyttf_file_support"] = False
                if component == "freetype":
                    results[-1].update({"freetype_port": "lvgl", "freetype_render_modes": ["bitmap"],
                                       "software_contracts": contracts.split()})
                if component == "vector":
                    results[-1].update({"thorvg": "0.11.99" if version == "v9.0.0" else "0.15.3",
                                       "software_contracts": contracts.split()})
                print(f"{name}: pixels, source lifetimes, failure recovery, and relocated consumers passed", flush=True)
    if not results:
        raise ValueError("No software configurations match the requested component and version")
    with (output / "software-adapters.log").open("w") as log:
        subprocess.run(["bun", "test", "./tests/native-adapters.test.ts"], cwd=ROOT,
                       env={**os.environ, "LVW_TEST_PNG_SOURCE": str(sources[0][1]),
                            "LVW_TEST_GIF_SOURCE": str(sources[0][1]),
                            "LVW_TEST_TINYTTF_SOURCE": str(sources[0][1]),
                            "LVW_TEST_THORVG_SOURCE": str(sources[0][1])},
                       stdout=log, stderr=subprocess.STDOUT, check=True)
        legacy_components = {result["component"] for result in results if result["version"]["minor"] == 1}
        if legacy_components:
            environment = dict(os.environ)
            if legacy_components & {"png", "png-gif"}:
                environment["LVW_TEST_PNG_SOURCE"] = str(sources[1][1])
            if legacy_components & {"gif", "png-gif"}:
                environment["LVW_TEST_GIF_SOURCE"] = str(sources[1][1])
            if legacy_components & {"tinyttf", "freetype"}:
                environment["LVW_TEST_TINYTTF_SOURCE"] = str(sources[1][1])
            subprocess.run(["bun", "test", "./tests/native-adapters.test.ts"], cwd=ROOT,
                           env=environment,
                           stdout=log, stderr=subprocess.STDOUT, check=True)
    report.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="use the cached source archive")
    parser.add_argument("--component", choices=("png", "gif", "png-gif", "tinyttf", "freetype", "vector"), help="check one component group and write a scoped report")
    parser.add_argument("--version", choices=("v9.0.0", "v9.1.0", "v9.6.0"), help="check one version and write a scoped report")
    args = parser.parse_args()
    check(args.component, args.version)
