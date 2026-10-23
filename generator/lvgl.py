"""Discover LVGL public headers and inspect the configured target declarations."""

import hashlib
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path


HEADER = '#include LVW_LVGL_HEADER\n'


@dataclass(frozen=True)
class SourceLayout:
    root: Path
    public_root: Path
    header: str

    @classmethod
    def discover(cls, source):
        root = Path(source).resolve(strict=True)
        if any(char in str(root) for char in '\\"\n\r;'):
            raise ValueError(f"unsupported header path characters: {root}")
        if (root / "include/lvgl/lvgl.h").is_file():
            return cls(root, root / "include/lvgl", "lvgl/lvgl.h")
        if (root / "lvgl.h").is_file():
            return cls(root, root, "lvgl.h")
        raise ValueError(f"missing LVGL public entry: {root}/lvgl.h or include/lvgl/lvgl.h")

    @property
    def entry(self):
        return self.public_root / "lvgl.h"

    @property
    def name(self):
        return "include/lvgl" if self.public_root != self.root else "root"


def config_file(config):
    path = Path(config).resolve(strict=True)
    path = path / "lv_conf.h" if path.is_dir() else path
    if not path.is_file() or path.name != "lv_conf.h":
        raise ValueError(f"configuration must be an existing lv_conf.h file: {path}")
    return path


def preprocess(command, text):
    result = subprocess.run(command + ["-E", "-dM", "-H", "-x", "c", "-"],
                            input=text, text=True, capture_output=True)
    if result.returncode:
        raise ValueError(f"LVGL header preprocessing failed:\n{result.stderr}")
    included = {Path(match[1]).resolve() for line in result.stderr.splitlines()
                if (match := re.fullmatch(r"\.+ (.+)", line))}
    versions = dict(re.findall(r"^#define (LVGL_VERSION_\w+) (.*)$", result.stdout, re.MULTILINE))
    return included, versions


def compiler_command(clang: Path, source: Path, config: Path):
    layout = SourceLayout.discover(source)
    configuration = config_file(config)
    command = [
        str(clang), "--target=wasm32-wasip1", "-std=c11",
        "-DLV_CONF_INCLUDE_SIMPLE", "-DLV_KCONFIG_IGNORE",
        "-DLV_LVGL_H_INCLUDE_SIMPLE", f'-DLVW_LVGL_HEADER="{layout.header}"',
        f"-I{configuration.parent}", f"-I{layout.root / 'include'}", f"-I{layout.root}",
    ]
    included, versions = preprocess(command, HEADER)
    if configuration not in included or layout.entry.resolve() not in included:
        raise ValueError("LVGL did not include the selected public header and configuration")
    wrapper = layout.root / "lvgl.h"
    if layout.name != "root" and wrapper.exists():
        # A second entry must forward to the selected public tree without changing its version.
        if any(char in str(wrapper) for char in '\\"\n\r'):
            raise ValueError(f"unsupported header path characters: {wrapper}")
        forwarded, wrapper_versions = preprocess(command, f'#include "{wrapper}"\n')
        if layout.entry.resolve() not in forwarded or wrapper_versions != versions:
            raise ValueError(f"conflicting LVGL public entries: {wrapper} and {layout.entry}")
    return command


def inspect_source(source: Path, config: Path, sdk: Path, contained=False):
    # Reuse the generator's target evaluation, including macro expressions and exact strings.
    from constants import collect_constants

    layout = SourceLayout.discover(source)
    configuration = config_file(config)
    command = compiler_command(sdk / "bin/clang", layout.root, configuration)
    if contained:
        included, _ = preprocess(command, HEADER)
        external = sorted(path for path in included
                          if not path.is_relative_to(layout.root) and not path.is_relative_to(sdk.resolve()))
        if external:
            raise ValueError(f"installed headers depend on files outside the NDK/SDK: {external}")
    report = collect_constants(command, layout.root, configuration.parent)
    constants = {entry["name"]: entry for entry in report["constants"]}
    version = {}
    for part in ("major", "minor", "patch"):
        entry = constants.get(f"LVGL_VERSION_{part.upper()}", {})
        if entry.get("category") != "integer" or int(entry["value"]) < 0:
            raise ValueError(f"missing or invalid LVGL version component: {part}")
        version[part] = int(entry["value"])
    info = constants.get("LVGL_VERSION_INFO", {})
    if info.get("category") != "string" or "text" not in info:
        raise ValueError("missing or invalid LVGL_VERSION_INFO string")
    version["info"] = info["text"]
    if version["major"] < 9:
        raise ValueError(f"LVGL {version['major']} is outside the v9+ source inspection range")

    probes = {}
    for name, expression in {
        "display_create": "&lv_display_create",
        "timer_external_data": "&lv_timer_set_external_data",
        "animation_external_data": "&lv_anim_set_external_data",
        "observer_with_target": "&lv_subject_add_observer_with_target",
        "decoder_create": "&lv_image_decoder_create",
        "input_timestamp": "((lv_indev_data_t *)0)->timestamp",
    }.items():
        result = subprocess.run(command + ["-Werror", "-fsyntax-only", "-x", "c", "-"],
                                input=HEADER + f"void lvw_probe(void) {{ (void)({expression}); }}\n",
                                text=True, capture_output=True)
        probes[name] = {"declared": result.returncode == 0}
        if result.returncode:
            probes[name]["diagnostic"] = result.stderr.strip()
    configuration_values = {}
    for name, entry in constants.items():
        if name.startswith("LV_USE_"):
            configuration_values[name] = {key: entry[key] for key in
                                         ("category", "value", "expression", "reason_code")
                                         if key in entry}
    return {
        "schema_version": 1, "version": version, "layout": layout.name,
        "source": str(layout.root), "header": layout.entry.relative_to(layout.root).as_posix(),
        "config": str(configuration),
        "config_sha256": hashlib.sha256(configuration.read_bytes()).hexdigest(),
        "target": report["target"], "configuration": configuration_values,
        "declaration_probes": probes,
        "build_verification": "not-run", "runtime_verification": "not-run",
    }


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--sdk", required=True, type=Path)
    parser.add_argument("--contained", action="store_true")
    args = parser.parse_args()
    print(json.dumps(inspect_source(args.source, args.config, args.sdk, args.contained), indent=2))
