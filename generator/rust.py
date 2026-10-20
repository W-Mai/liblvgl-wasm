#!/usr/bin/env python3
"""Generate Rust raw bindings from verified target API metadata."""

import argparse
from pathlib import Path

from bindings import POINTER_KINDS, comment, function_signature, inventory
from bindings import generate as generate_bindings
from values import render_rust


def rust_type(kind, value):
    if value is None:
        return "()"
    if kind in POINTER_KINDS:
        return "UnsafeFunctionPointer" if kind == "function_pointer" else "UnsafePointer"
    return value


def method(entry, report):
    slots, result, returned = function_signature(entry, report)
    docs = [f"/// C: `{comment(entry['signature'])}`."]
    if entry["category"] == "abi_shim":
        docs.append(f"/// Shim: `{comment(entry['abi_signature'])}`.")
    parameters, arguments, types = [], [], []
    for name, kind, value in slots:
        parameters.append(f"{name}: {rust_type(kind, value)}")
        arguments.append(f"{name}.0 as i32" if kind in POINTER_KINDS else name)
        types.append(value)
        if name == "out":
            docs.append("/// `out` is writable aggregate result storage in this instance's linear memory.")
        elif kind == "record":
            docs.append(f"/// `{name}` points to aggregate argument storage in this instance's linear memory.")
        elif kind == "pointer":
            docs.append(f"/// `{name}` is a pointer into this instance's linear memory.")
        elif kind == "function_pointer":
            docs.append(f"/// `{name}` is a function-table index; no host callback trampoline is provided.")
    if result == "pointer":
        docs.append("/// Returns a pointer into this instance's linear memory.")
    elif result == "function_pointer":
        docs.append("/// Returns a function-table index; no callback invocation adapter is provided.")
    parameter_list = ", ".join(["&mut self", *parameters])
    tuple_type = f"({', '.join(types)},)" if types else "()"
    tuple_value = f"({', '.join(arguments)},)" if arguments else "()"
    call = (f'self.runtime.call_raw::<{tuple_type}, {returned or "()"}>'
            f'("{entry["export_name"]}", {tuple_value})')
    if returned and result in POINTER_KINDS:
        call += f".map(|pointer| {rust_type(result, returned)}(pointer as u32))"
    return "\n///\n".join(docs) + "\n" + "\n".join([
        f'pub fn {entry["name"]}({parameter_list}) -> crate::Result<{rust_type(result, returned)}> {{',
        f"    {call}",
        "}",
    ])


def render(report, identity):
    entries = inventory(report, identity)
    mapping = "\n".join(f'    ("{entry["name"]}", "{entry["export_name"]}"),' for entry in entries)
    methods = "\n\n".join("    " + method(entry, report).replace("\n", "\n    ") for entry in entries)
    return (
        "// Generated from verified API metadata. Do not edit.\n\n"
        "/// Identity of the API metadata and core used to generate these bindings.\n"
        "#[derive(Clone, Copy, Debug, Eq, PartialEq)]\n"
        "pub struct BindingIdentity {\n"
        "    pub schema_version: u32,\n"
        "    pub api_sha256: &'static str,\n"
        "    pub wasm_sha256: &'static str,\n"
        "    pub expected_functions: usize,\n"
        "    pub verified_functions: usize,\n"
        "}\n\n"
        "pub const BINDING_IDENTITY: BindingIdentity = BindingIdentity {\n"
        f'    schema_version: {identity["schema_version"]},\n'
        f'    api_sha256: "{identity["api_sha256"]}",\n'
        f'    wasm_sha256: "{identity["wasm_sha256"]}",\n'
        f'    expected_functions: {identity["expected_functions"]},\n'
        f'    verified_functions: {identity["verified_functions"]},\n'
        "};\n\n"
        "/// Original C names and their Wasm export names.\n"
        f"pub const API_EXPORTS: &[(&str, &str)] = &[\n{mapping}\n];\n\n"
        "/// Linear-memory offset. The caller manages ownership, alignment, bounds, initialization, and lifetime.\n"
        "#[repr(transparent)]\n"
        "#[derive(Clone, Copy, Debug, Eq, PartialEq)]\n"
        "pub struct UnsafePointer(pub u32);\n\n"
        "/// Wasm function-table index. No callback installation or invocation adapter is provided.\n"
        "#[repr(transparent)]\n"
        "#[derive(Clone, Copy, Debug, Eq, PartialEq)]\n"
        "pub struct UnsafeFunctionPointer(pub u32);\n\n"
        "/// Borrowed raw bindings for the verified core.\n"
        "///\n"
        "/// Calls preserve Wasm scalar types and signed integer values. The caller maintains the C API's guest object and pointer preconditions; these methods do not validate pointer ownership or object lifetime. Use the runtime's shutdown method for cleanup.\n"
        "pub struct RawApi<'a> {\n"
        "    pub(crate) runtime: &'a mut crate::Runtime,\n"
        "}\n\n"
        "#[allow(clippy::too_many_arguments)]\n"
        "impl RawApi<'_> {\n"
        "    /// Allocate scratch memory. Release it with `Self::free`.\n"
        "    pub fn alloc(&mut self, bytes: u32) -> crate::Result<UnsafePointer> {\n"
        "        self.runtime.alloc(bytes).map(UnsafePointer)\n"
        "    }\n\n"
        "    /// Release scratch memory allocated by `Self::alloc` on this runtime.\n"
        "    pub fn free(&mut self, pointer: UnsafePointer) -> crate::Result<()> {\n"
        "        self.runtime.free(pointer.0)\n"
        "    }\n\n"
        "    /// Read bytes from linear memory, checking the requested range.\n"
        "    pub fn read_memory(&self, pointer: UnsafePointer, buffer: &mut [u8]) -> crate::Result<()> {\n"
        "        self.runtime.read_memory(pointer.0, buffer)\n"
        "    }\n\n"
        "    /// Write bytes to linear memory, checking the requested range.\n"
        "    pub fn write_memory(&mut self, pointer: UnsafePointer, bytes: &[u8]) -> crate::Result<()> {\n"
        "        self.runtime.write_memory(pointer.0, bytes)\n"
        "    }\n\n"
        f"{methods}\n"
        "}\n"
        "\npub mod values {\n"
        + "".join("    " + line + "\n" if line else "\n" for line in render_rust(report).splitlines())
        + "}\n"
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
    print(f"Rust bindings: {count} supported API methods generated")


if __name__ == "__main__":
    main()
