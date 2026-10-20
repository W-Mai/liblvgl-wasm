#!/usr/bin/env python3
"""Generate static SDK constants and named target layouts."""

import argparse
import json
import re
from pathlib import Path

from bindings import IDENTIFIER, inventory
from bindings import generate as generate_bindings


def unsigned(value, maximum, description, minimum=0):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"invalid {description}: {value}")
    return value


def collect(report):
    names, constants, layouts = {}, [], []

    def claim(name, source):
        if not isinstance(name, str) or not IDENTIFIER.fullmatch(name):
            raise ValueError(f"invalid SDK export name: {name}")
        if name in names:
            raise ValueError(f"SDK export name collision for {name}: {names[name]} and {source}")
        names[name] = source

    for item in sorted(report["constants"], key=lambda item: item["name"]):
        name, category = item["name"], item["category"]
        claim(name, f"constant {name}")
        if not re.fullmatch(r"(?:LV|LVGL)_[A-Za-z0-9_]+", name):
            raise ValueError(f"invalid public constant name: {name}")
        if category == "integer":
            bits, signed, text = item["bits"], item["signed"], item["value"]
            if (type(bits) is not int or bits not in {1, 8, 16, 32, 64, 128}
                    or type(signed) is not bool or (bits == 1 and signed)
                    or not isinstance(text, str) or not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", text)):
                raise ValueError(f"invalid integer constant: {name}")
            value = int(text)
            minimum, maximum = (-(1 << (bits - 1)), (1 << (bits - 1)) - 1) if signed else (0, (1 << bits) - 1)
            if not minimum <= value <= maximum:
                raise ValueError(f"integer constant outside its target range: {name}")
            constants.append({"name": name, "kind": category, "bits": bits, "signed": signed, "value": value})
        elif category == "string":
            encoded = item["bytes_hex"]
            if not isinstance(encoded, str) or not re.fullmatch(r"(?:[0-9a-fA-F]{2})*", encoded):
                raise ValueError(f"invalid string bytes: {name}")
            data = bytes.fromhex(encoded)
            if (type(item["byte_length"]) is not int or item["byte_length"] != len(data)
                    or type(item["nul_terminated"]) is not bool
                    or item["nul_terminated"] != data.endswith(b"\0")):
                raise ValueError(f"inconsistent string length or termination: {name}")
            constants.append({"name": name, "kind": category, "data": data})
        elif category not in {"function_macro", "empty_macro", "unsupported"}:
            raise ValueError(f"unknown constant category: {name}: {category}")

    types = report["types"]

    def reference(ref):
        identity = ref["id"]
        if not isinstance(identity, str) or identity not in types:
            raise ValueError(f"missing layout type reference: {identity}")
        return identity

    def terminal(identity):
        seen = set()
        while types[identity]["kind"] == "alias":
            if identity in seen:
                raise ValueError(f"alias cycle in SDK layout: {identity}")
            seen.add(identity)
            identity = reference(types[identity]["underlying"])
        return types[identity]

    def layout(node):
        item = node["layout"]
        status = item["status"]
        if status == "complete":
            unsigned(item["size"], 0xffffffff, "layout byte size")
            unsigned(item["alignment"], 0xffffffff, "layout alignment", 1)
        elif status not in {"opaque", "incomplete", "not_object"}:
            raise ValueError(f"unknown layout status: {status}")
        elif item["size"] is not None or item["alignment"] is not None:
            raise ValueError(f"non-complete layout has a size or alignment: {status}")
        return item

    for node in types.values():
        refs = [node[key] for key in ("underlying", "pointee", "element", "integer_type", "result") if key in node]
        refs += node.get("parameters", [])
        refs += [field["type"] for field in node.get("fields", [])]
        for ref in refs:
            reference(ref)

    for identity, node in sorted(types.items()):
        if (node["kind"] not in {"alias", "record"} or not node.get("name")
                or not node.get("origin_file", "").startswith("lvgl/")):
            continue
        if not IDENTIFIER.fullmatch(node["name"]):
            raise ValueError(f"invalid named layout: {identity}")
        prefix = node["name"].upper()
        if node["kind"] == "record":
            if node["record_kind"] not in {"struct", "union"}:
                raise ValueError(f"invalid record kind: {identity}")
            prefix = node["record_kind"].upper() + "_" + prefix
        own = layout(node)
        final = terminal(identity)
        item = {"name": prefix, **own}
        claim(prefix + "_STATUS", f"layout {identity}")
        if own["status"] == "complete":
            claim(prefix + "_SIZE", f"layout {identity}")
            claim(prefix + "_ALIGN", f"layout {identity}")
            if final["kind"] == "record":
                record = layout(final)
                if record["status"] != "complete":
                    raise ValueError(f"complete alias has a non-complete record: {identity}")
                limit = min(own["size"], record["size"]) * 8
                fields = []
                for field in final["fields"]:
                    field_name = field["name"]
                    if field_name is not None and (not isinstance(field_name, str) or not field_name):
                        raise ValueError(f"invalid field name: {identity}")
                    field_id = reference(field["type"])
                    offset = unsigned(field["bit_offset"], min((1 << 64) - 1, (1 << 53) - 1), "field bit offset")
                    width = field["bit_width"]
                    if width is not None:
                        unsigned(width, min((1 << 64) - 1, (1 << 53) - 1), "field bit width")
                        end = offset + width
                    else:
                        if offset % 8:
                            raise ValueError(f"non-bitfield is not byte aligned: {identity}")
                        field_layout = layout(types[field_id])
                        if field_layout["status"] == "complete":
                            end = offset + field_layout["size"] * 8
                        elif (field_layout["status"] == "incomplete"
                              and terminal(field_id)["kind"] == "array"):
                            end = offset
                        else:
                            raise ValueError(f"field has no object layout: {identity}")
                    if end > limit:
                        raise ValueError(f"field exceeds its record layout: {identity}")
                    fields.append({"name": field_name, "type_id": field_id, "bit_offset": offset, "bit_width": width})
                claim(prefix + "_FIELDS", f"layout {identity}")
                item["fields"] = fields
        layouts.append(item)
    return constants, sorted(layouts, key=lambda item: item["name"])


def render_typescript(report, identity):
    inventory(report, identity)
    constants, layouts = collect(report)
    lines = [
        "// Generated from verified API metadata. Do not edit.",
        f"export const valuesIdentity = /* @__PURE__ */ Object.freeze({json.dumps(identity, indent=2)} as const);",
    ]
    for item in constants:
        name = item["name"]
        if item["kind"] == "integer":
            lines.append(f'export const {name} = {item["value"]}{"n" if item["bits"] > 32 else ""};')
        else:
            data = item["data"]
            lines.append(f"/** {len(data)} raw bytes; trailing NUL: {str(data.endswith(bytes([0]))).lower()}. */")
            values = ", ".join(f"0x{byte:02x}" for byte in data)
            lines.append(f"export const {name} = /* @__PURE__ */ Object.freeze([{values}] as const);")
    for item in layouts:
        prefix = item["name"]
        lines.append(f'export const {prefix}_STATUS = {json.dumps(item["status"])};')
        if item["status"] == "complete":
            lines.append(f'export const {prefix}_SIZE = {item["size"]};')
            lines.append(f'export const {prefix}_ALIGN = {item["alignment"]};')
        if "fields" in item:
            fields = "\n".join(
                f"  /* @__PURE__ */ Object.freeze({json.dumps(field)} as const),"
                for field in item["fields"])
            lines.append(f"export const {prefix}_FIELDS = /* @__PURE__ */ Object.freeze([\n{fields}\n] as const);")
    return "\n\n".join(lines) + "\n"


def rust_string(value):
    escapes = {"\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t"}
    return '"' + "".join(escapes.get(char, f"\\u{{{ord(char):x}}}" if ord(char) < 32 or ord(char) == 127 else char)
                         for char in value) + '"'


def render_rust(report):
    constants, layouts = collect(report)
    lines = [
        "/// Target record field layout. Offsets and widths are measured in bits.\n"
        "#[derive(Clone, Copy, Debug, Eq, PartialEq)]\n"
        "pub struct FieldLayout {\n"
        "    pub name: Option<&'static str>,\n"
        "    pub type_id: &'static str,\n"
        "    pub bit_offset: u64,\n"
        "    pub bit_width: Option<u64>,\n"
        "}",
    ]
    for item in constants:
        name = item["name"]
        attribute = ('#[allow(non_upper_case_globals, reason = "preserve the original C constant name")]\n'
                     if name != name.upper() else "")
        if item["kind"] == "integer":
            kind = ("i" if item["signed"] else "u") + str(max(item["bits"], 8))
            lines.append(attribute + f'pub const {name}: {kind} = {item["value"]};')
        else:
            data = item["data"]
            docs = f"/// {len(data)} raw bytes; trailing NUL: {str(data.endswith(bytes([0]))).lower()}.\n"
            values = ", ".join(f"0x{byte:02x}" for byte in data)
            lines.append(docs + attribute + f"pub const {name}: &[u8] = &[{values}];")
    for item in layouts:
        prefix = item["name"]
        lines.append(f'pub const {prefix}_STATUS: &str = "{item["status"]}";')
        if item["status"] == "complete":
            lines.append(f'pub const {prefix}_SIZE: u32 = {item["size"]};')
            lines.append(f'pub const {prefix}_ALIGN: u32 = {item["alignment"]};')
        if "fields" in item:
            fields = []
            for field in item["fields"]:
                name = f'Some({rust_string(field["name"])})' if field["name"] is not None else "None"
                width = f'Some({field["bit_width"]})' if field["bit_width"] is not None else "None"
                fields.append("    FieldLayout { "
                              f'name: {name}, type_id: {rust_string(field["type_id"])}, '
                              f'bit_offset: {field["bit_offset"]}, bit_width: {width} '
                              "},")
            lines.append(f"pub const {prefix}_FIELDS: &[FieldLayout] = &[\n" + "\n".join(fields) + "\n];")
    return "\n\n".join(lines) + "\n"


def generate(api_path: Path, wasm_path: Path, verification_path: Path, output: Path):
    return generate_bindings(api_path, wasm_path, verification_path, output, render_typescript)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", required=True, type=Path)
    parser.add_argument("--wasm", required=True, type=Path)
    parser.add_argument("--verification", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    generate(args.api, args.wasm, args.verification, args.output)
    print("SDK values: TypeScript constants and named layouts generated")


if __name__ == "__main__":
    main()
