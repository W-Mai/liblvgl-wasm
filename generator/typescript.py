#!/usr/bin/env python3
"""Generate TypeScript raw bindings from verified target API metadata."""

import argparse
import json
from pathlib import Path

from bindings import POINTER_KINDS, animation_exec_module, comment, function_signature, inventory
from bindings import generate as generate_bindings


def method(entry, report):
    name = entry["name"]
    slots, result, returned = function_signature(entry, report)

    def scalar(value, kind):
        if kind in POINTER_KINDS:
            return "UnsafeFunctionPointer" if kind == "function_pointer" else "UnsafePointer"
        return "bigint" if value == "i64" else "number"

    docs = ["/**", f" * C: {comment(entry['signature'])}"]
    if entry["category"] == "abi_shim":
        docs.append(f" * Shim: {comment(entry['abi_signature'])}")
    arguments = []
    for parameter, kind, value in slots:
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
    returns = scalar(returned, result) if returned else "void"
    return "\n".join(docs + [f"{name}({', '.join(arguments)}): {returns};"])


def render(report, identity):
    entries = inventory(report, identity)
    mapping = {entry["name"]: entry["export_name"] for entry in entries}
    methods = "\n\n".join("  " + method(entry, report).replace("\n", "\n  ") for entry in entries)
    return (
        "// Generated from verified API metadata. Do not edit.\n\n"
        "/** Linear-memory offset. The caller manages ownership, alignment, bounds, initialization, and lifetime. */\n"
        "export type UnsafePointer = number;\n\n"
        "/** Wasm function-table index. No callback installation or invocation adapter is provided. */\n"
        "export type UnsafeFunctionPointer = number;\n\n"
        f"export const bindingIdentity = /* @__PURE__ */ Object.freeze({json.dumps(identity, indent=2)} as const);\n\n"
        "/** @internal Typed exec adapter; imports core.dispatch and immutable core.slot. */\n"
        f"export const animationExecModuleBytes: readonly number[] = /* @__PURE__ */ Object.freeze({list(animation_exec_module(report))});\n\n"
        f"export const apiExports = /* @__PURE__ */ Object.freeze({json.dumps(mapping, indent=2)} as const);\n\n"
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
    return generate_bindings(api_path, wasm_path, verification_path, output, render)


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
