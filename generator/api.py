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


def value_type(type_name, typedefs):
    underlying = typedefs.get(type_name, type_name)
    return underlying.startswith(("struct ", "union ")) and "*" not in type_name


def classify(declaration, symbols, typedefs):
    name = declaration["name"]
    if not declaration["static"] and name not in symbols:
        return "compile_disabled", "no definition in the configured LVGL archive"
    signature = declaration["signature"]
    if "..." in signature:
        return "unsupported", "variadic function requires a fixed-argument wrapper"
    if "(*" in signature or any("(*" in item for item in declaration["parameter_types"]):
        return "unsupported", "function pointer callback requires a synchronous trampoline"
    result_type = signature.split("(", 1)[0].strip()
    if declaration["static"] or value_type(result_type, typedefs) or any(
            value_type(item, typedefs) for item in declaration["parameter_types"]):
        return "abi_shim", None
    return "direct_export", None


def shim(declaration, typedefs):
    name = declaration["name"]
    export_name = f"lvw_api_{name}"
    result_type = declaration["signature"].split("(", 1)[0].strip()
    value_result = value_type(result_type, typedefs)
    parameters = []
    arguments = []
    for index, (type_name, underlying) in enumerate(zip(
            declaration["parameters"], declaration["parameter_types"])):
        if value_type(underlying, typedefs):
            parameters.append(f"const {type_name} *arg{index}")
            arguments.append(f"*arg{index}")
        else:
            parameters.append(f"{type_name} arg{index}")
            arguments.append(f"arg{index}")
    if value_result:
        parameters.insert(0, f"{result_type} *out")
    return_type = "void" if value_result else result_type
    call = f"{name}({', '.join(arguments)})"
    statement = f"*out = {call};" if value_result else (
        f"{call};" if result_type == "void" else f"return {call};")
    parameter_list = ", ".join(parameters) or "void"
    signature = f"{return_type} ({parameter_list})"
    source = f"{return_type} {export_name}({parameter_list}) {{\n    {statement}\n}}"
    return export_name, signature, source


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--sdk", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--exports", required=True, type=Path)
    parser.add_argument("--shims", required=True, type=Path)
    args = parser.parse_args()
    found, typedefs = declarations(args.sdk / "bin" / "clang", args.source, Path("config").resolve())
    symbols = definitions(args.sdk / "bin" / "llvm-nm", args.archive)
    entries = []
    shims = []
    for name, declaration in sorted(found.items()):
        category, reason = classify(declaration, symbols, typedefs)
        export_name = name if category == "direct_export" else None
        abi_signature = None
        if category == "abi_shim":
            export_name, abi_signature, source = shim(declaration, typedefs)
            shims.append(source)
        entries.append({**declaration, "category": category, "reason": reason,
                        "export_name": export_name, "abi_signature": abi_signature})
    counts = {category: sum(item["category"] == category for item in entries)
              for category in ("direct_export", "abi_shim", "compile_disabled", "unsupported")}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"summary": {"total": len(entries), **counts},
                                       "declarations": entries}, indent=2) + "\n")
    args.shims.write_text('#include "lvgl/lvgl.h"\n\n'
                          '#pragma clang diagnostic push\n'
                          '#pragma clang diagnostic ignored "-Wdeprecated-declarations"\n\n'
                          + "\n\n".join(shims) +
                          '\n\n#pragma clang diagnostic pop\n')
    exports = [item["export_name"] for item in entries if item["export_name"]]
    args.exports.write_text("\n".join(f"-Wl,--export={name}" for name in exports) + "\n")
    print(f"API inventory: {len(entries)} declarations, {counts}")


if __name__ == "__main__":
    main()
