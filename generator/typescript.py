#!/usr/bin/env python3
"""Generate TypeScript raw bindings from verified target API metadata."""

import argparse
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

from signatures import SCALARS, supported_exports


IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
IDENTITY_KEYS = {"schema_version", "api_sha256", "wasm_sha256",
                 "expected_functions", "verified_functions"}


def method(entry, report):
    name = entry["name"]
    types = report["types"]
    function = types[report["function_types"][name]["canonical"]["id"]]
    if function["kind"] != "function" or function["variadic"]:
        raise ValueError(f"invalid canonical function type for {name}")
    def kind(reference):
        node = types[reference["id"]]
        if node["kind"] == "pointer" and types[node["pointee"]["id"]]["kind"] == "function":
            return "function_pointer"
        return node["kind"]

    result = kind(function["result"])
    parameters = [kind(reference) for reference in function["parameters"]]
    allowed = {"primitive", "enum", "pointer", "function_pointer", "record"}
    if result not in allowed | {"void"} or any(kind not in allowed for kind in parameters):
        raise ValueError(f"unsupported canonical type for {name}")
    if entry["category"] == "direct_export" and "record" in [result, *parameters]:
        raise ValueError(f"direct export contains an aggregate value: {name}")
    signature = entry["wasm_signature"]
    if (not isinstance(signature, dict) or set(signature) != {"params", "results"}
            or any(not isinstance(values, list) or
                   any(not isinstance(value, str) or value not in SCALARS for value in values)
                   for values in signature.values())
            or len(signature["results"]) > 1):
        raise ValueError(f"invalid Wasm signature for {name}")
    slots = [("out", "record")] if result == "record" else []
    slots += [(f"arg{index}", kind) for index, kind in enumerate(parameters)]
    if len(slots) != len(signature["params"]):
        raise ValueError(f"canonical and Wasm parameter counts differ for {name}")
    if len(signature["results"]) != (0 if result in {"void", "record"} else 1):
        raise ValueError(f"canonical and Wasm results differ for {name}")

    def scalar(value, kind):
        if kind in {"pointer", "function_pointer", "record"}:
            if value != "i32":
                raise ValueError(f"pointer or aggregate slot is not i32 for {name}")
            return "UnsafeFunctionPointer" if kind == "function_pointer" else "UnsafePointer"
        return "bigint" if value == "i64" else "number"

    def comment(text):
        return text.replace("*/", "* /").replace("\n", " ").replace("\r", " ")

    docs = ["/**", f" * C: {comment(entry['signature'])}"]
    if entry["category"] == "abi_shim":
        docs.append(f" * Shim: {comment(entry['abi_signature'])}")
    arguments = []
    for (parameter, kind), value in zip(slots, signature["params"]):
        arguments.append(f"{parameter}: {scalar(value, kind)}")
        if parameter == "out":
            docs.append(" * @param out Writable aggregate result storage in this instance's Wasm memory.")
        elif kind == "record":
            docs.append(f" * @param {parameter} Aggregate argument storage in this instance's Wasm memory.")
        elif kind == "pointer":
            docs.append(f" * @param {parameter} Pointer into this instance's Wasm memory.")
        elif kind == "function_pointer":
            docs.append(f" * @param {parameter} Wasm function-table index; no host callback trampoline is provided.")
    if result == "pointer":
        docs.append(" * @returns A pointer into this instance's Wasm memory.")
    elif result == "function_pointer":
        docs.append(" * @returns A Wasm function-table index, not a linear-memory address or JavaScript function.")
    docs.append(" */")
    returns = scalar(signature["results"][0], result) if signature["results"] else "void"
    return "\n".join(docs + [f"{name}({', '.join(arguments)}): {returns};"])


def render(report, identity):
    exports = supported_exports(report["declarations"])
    names = [entry["name"] for entry in report["declarations"]]
    if (len(names) != len(set(names)) or
            any(not isinstance(name, str) or not name.startswith("lv_") or
                not IDENTIFIER.fullmatch(name) for name in names)):
        raise ValueError("missing, invalid, or duplicate C API name")
    if any(not isinstance(name, str) or not IDENTIFIER.fullmatch(name) for name in exports):
        raise ValueError("invalid Wasm API export name")
    if type(report["schema_version"]) is not int or report["schema_version"] != 1:
        raise ValueError("unsupported API metadata schema")
    if report["target"]["pointer_bits"] != 32:
        raise ValueError("TypeScript pointer bindings require a wasm32 target")
    counts = [report["wasm_summary"]["expected_functions"],
              identity["expected_functions"], identity["verified_functions"]]
    if any(type(count) is not int or count != len(exports) for count in counts):
        raise ValueError("verification counts differ from the supported API inventory")
    entries = sorted(exports.values(), key=lambda entry: entry["name"])
    mapping = {entry["name"]: entry["export_name"] for entry in entries}
    methods = "\n\n".join("  " + method(entry, report).replace("\n", "\n  ") for entry in entries)
    return (
        "// Generated from verified API metadata. Do not edit.\n\n"
        "/** Linear-memory offset. The caller manages ownership, alignment, bounds, initialization, and lifetime. */\n"
        "export type UnsafePointer = number;\n\n"
        "/** Wasm function-table index. No callback installation or invocation adapter is provided. */\n"
        "export type UnsafeFunctionPointer = number;\n\n"
        f"export const bindingIdentity = Object.freeze({json.dumps(identity, indent=2)} as const);\n\n"
        f"export const apiExports = Object.freeze({json.dumps(mapping, indent=2)} as const);\n\n"
        "/** Raw Wasm calls. i32 values retain their signed JavaScript representation. */\n"
        f"export interface UnsafeLvglApi {{\n{methods}\n}}\n\n"
        "/** @internal */\n"
        "export function createUnsafeLvglApi(\n"
        "  exports: Record<string, unknown>, guard: () => void,\n"
        "): UnsafeLvglApi {\n"
        "  type Call = (...args: (number | bigint)[]) => number | bigint | void;\n"
        "  const api: Record<string, Call> = {};\n"
        "  for (const [name, exportName] of Object.entries(apiExports)) {\n"
        "    const fn = exports[exportName];\n"
        "    if (typeof fn !== \"function\") throw new Error(`missing Wasm function: ${exportName}`);\n"
        "    const call = fn as Call;\n"
        "    api[name] = (...args) => { guard(); return call(...args); };\n"
        "  }\n"
        "  return Object.freeze(api) as unknown as UnsafeLvglApi;\n"
        "}\n"
    )


def generate(api_path: Path, wasm_path: Path, verification_path: Path, output: Path):
    if output.resolve() in {path.resolve() for path in (api_path, wasm_path, verification_path)}:
        raise ValueError("binding output must differ from its inputs")
    output.unlink(missing_ok=True)
    api_bytes, wasm_bytes = api_path.read_bytes(), wasm_path.read_bytes()
    identity = json.loads(verification_path.read_bytes())
    if (not isinstance(identity, dict) or set(identity) != IDENTITY_KEYS or
            type(identity["schema_version"]) is not int or identity["schema_version"] != 1):
        raise ValueError("unsupported API verification schema")
    if (identity["api_sha256"] != hashlib.sha256(api_bytes).hexdigest() or
            identity["wasm_sha256"] != hashlib.sha256(wasm_bytes).hexdigest()):
        raise ValueError("API verification hashes do not match the binding inputs")
    text = render(json.loads(api_bytes), identity)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=output.parent, prefix=f".{output.name}.",
                                         delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return identity["verified_functions"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", required=True, type=Path)
    parser.add_argument("--wasm", required=True, type=Path)
    parser.add_argument("--verification", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    count = generate(args.api, args.wasm, args.verification, args.output)
    print(f"TypeScript bindings: {count} supported API methods generated")


if __name__ == "__main__":
    main()
