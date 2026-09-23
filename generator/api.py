#!/usr/bin/env python3
"""Inventory enabled LVGL declarations against the WASIp1 static library."""

import argparse
import json
import re
import subprocess
from pathlib import Path


def declarations(clang: Path, source: Path, config: Path):
    command = [
        str(clang), "--target=wasm32-wasip1", "-std=c11",
        "-DLV_CONF_INCLUDE_SIMPLE", "-DLV_KCONFIG_IGNORE",
        "-DLV_LVGL_H_INCLUDE_SIMPLE", f"-I{config}",
        f"-I{source / 'include'}", f"-I{source}",
        "-Xclang", "-ast-dump=json", "-Xclang", "-ast-dump-filter=lv_",
        "-fsyntax-only", "-x", "c", "-",
    ]
    output = subprocess.run(command, input='#include "lvgl/lvgl.h"\n',
                            text=True, capture_output=True, check=True).stdout
    decoder = json.JSONDecoder()
    offset = 0
    by_name = {}
    typedefs = {}
    header_root = (source / "include" / "lvgl").resolve()
    while offset < len(output):
        while offset < len(output) and output[offset].isspace():
            offset += 1
        if offset == len(output):
            break
        node, offset = decoder.raw_decode(output, offset)
        if node.get("kind") == "TypedefDecl":
            typedefs[node.get("name", "")] = node.get("type", {}).get("qualType", "")
            continue
        if node.get("kind") != "FunctionDecl":
            continue
        name = node.get("name", "")
        path = node.get("loc", {}).get("file")
        if not name.startswith("lv_") or not path:
            continue
        header = Path(path).resolve()
        if not header.is_relative_to(header_root):
            continue
        parameters = [part["type"]["qualType"] for part in node.get("inner", [])
                      if part.get("kind") == "ParmVarDecl"]
        parameter_types = [part["type"].get("desugaredQualType", part["type"]["qualType"])
                           for part in node.get("inner", []) if part.get("kind") == "ParmVarDecl"]
        signature = node["type"]["qualType"]
        result = {
            "name": name,
            "header": str(header.relative_to(header_root)),
            "line": node["loc"].get("line", 0),
            "signature": signature,
            "parameters": parameters,
            "parameter_types": parameter_types,
            "static": node.get("storageClass") == "static",
        }
        by_name.setdefault(name, result)
    return by_name, typedefs


def definitions(nm: Path, archive: Path):
    output = subprocess.run([str(nm), "--format=posix", "--defined-only", str(archive)],
                            text=True, capture_output=True, check=True).stdout
    return {match.group(1) for line in output.splitlines()
            if (match := re.match(r"^(lv_[A-Za-z0-9_]+) [TW] ", line))}


def classify(declaration, symbols, typedefs):
    name = declaration["name"]
    if declaration["static"]:
        return "unsupported", "static inline requires an ABI wrapper"
    if name not in symbols:
        return "compile_disabled", "no definition in the configured LVGL archive"
    signature = declaration["signature"]
    if "(*" in signature or any("(*" in item for item in declaration["parameter_types"]):
        return "unsupported", "function pointer callback requires a synchronous trampoline"
    result_type = signature.split(" (", 1)[0]
    result_underlying = typedefs.get(result_type, result_type)
    if result_underlying.startswith(("struct ", "union ")) and "*" not in result_type:
        return "unsupported", "value return requires a target ABI audit or wrapper"
    if any(item.startswith(("struct ", "union ")) and "*" not in item
           for item in declaration["parameter_types"]):
        return "unsupported", "value parameter requires a target ABI audit or wrapper"
    return "direct_export", None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--sdk", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--exports", required=True, type=Path)
    args = parser.parse_args()
    found, typedefs = declarations(args.sdk / "bin" / "clang", args.source, Path("config").resolve())
    symbols = definitions(args.sdk / "bin" / "llvm-nm", args.archive)
    entries = []
    for name, declaration in sorted(found.items()):
        category, reason = classify(declaration, symbols, typedefs)
        entries.append({**declaration, "category": category, "reason": reason})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"declarations": entries}, indent=2) + "\n")
    exports = [item["name"] for item in entries if item["category"] == "direct_export"]
    args.exports.write_text("\n".join(f"-Wl,--export={name}" for name in exports) + "\n")
    counts = {category: sum(item["category"] == category for item in entries)
              for category in ("direct_export", "compile_disabled", "unsupported")}
    print(f"API inventory: {len(entries)} declarations, {counts}")


if __name__ == "__main__":
    main()
