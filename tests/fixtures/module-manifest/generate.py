#!/usr/bin/env python3
"""Generate shared typed manifest and Wasm test cases."""

import copy
import hashlib
import json
from pathlib import Path


def leb(value):
    result = []
    while True:
        byte = value & 127
        value >>= 7
        result.append(byte | (128 if value else 0))
        if not value:
            return bytes(result)


def name(value):
    encoded = value.encode()
    return leb(len(encoded)) + encoded


def vec(*items):
    return leb(len(items)) + b"".join(items)


def section(kind, data):
    return bytes([kind]) + leb(len(data)) + data


def wasm(*sections):
    return b"\0asm\1\0\0\0" + b"".join(sections)


def imp(module, field, kind, *ty):
    return name(module) + name(field) + bytes([kind, *ty])


def exp(field, kind, index):
    return name(field) + bytes([kind]) + leb(index)


def body(*ops):
    data = bytes([0, *ops, 0x0B])
    return leb(len(data)) + data


def core():
    return wasm(
        section(1, vec(bytes([0x60, 1, 0x7F, 1, 0x7E]), bytes([0x60, 1, 0x7E, 0]), bytes([0x60, 0, 0]))),
        section(2, vec(imp("env", "tick", 0, 2))), section(3, vec(bytes([0]), bytes([2]))),
        section(4, vec(bytes([0x70, 1, 2, 5]))), section(5, vec(bytes([1, 2, 4]))),
        section(13, vec(bytes([0, 1]))), section(6, vec(bytes([0x7F, 0, 0x41, 7, 0x0B]))),
        section(7, vec(exp("convert", 0, 1), exp("table", 1, 0), exp("memory", 2, 0), exp("palette", 3, 0), exp("signal", 4, 0))),
        section(8, bytes([2])), section(10, vec(body(0x20, 0, 0xAC), body(0))),
    )


def widgets():
    return wasm(section(1, vec(bytes([0x60, 0, 0]), bytes([0x60, 1, 0x7F, 1, 0x7E]))),
                section(2, vec(imp("core", "convert", 0, 1))), section(3, vec(bytes([1]))),
                section(7, vec(exp("draw", 0, 1))), section(10, vec(body(0x20, 0, 0x10, 0))))


def app(duplicate=False, table_min=1, table_max=8, memory_min=1, memory_max=6):
    imports = [imp("core", "convert", 0, 1), imp("core", "table", 1, 0x70, 1, table_min, table_max),
               imp("core", "memory", 2, 1, memory_min, memory_max), imp("core", "palette", 3, 0x7F, 0),
               imp("core", "signal", 4, 0, 2), imp("widgets", "render", 0, 1)]
    if duplicate:
        imports.append(imports[-1])
    return wasm(section(1, vec(bytes([0x60, 0, 0]), bytes([0x60, 1, 0x7F, 1, 0x7E]), bytes([0x60, 1, 0x7E, 0]))),
                section(2, vec(*imports)))


func = {"kind": "function", "params": ["i32"], "results": ["i64"]}
table = {"kind": "table", "element": "funcref", "minimum": 2, "maximum": 5}
memory = {"kind": "memory", "minimumPages": 2, "maximumPages": 4, "shared": False}
glob = {"kind": "global", "value": "i32", "mutable": False}
tag = {"kind": "tag", "params": ["i64"], "results": []}
tick = {"kind": "function", "params": [], "results": []}


def imp_decl(module, field, provider_export, ty):
    return {"module": module, "name": field, "provider_export": provider_export, **ty}


def exp_decl(field, ty):
    return {"name": field, **ty}


def module(module_id, role, binary, requires, exports):
    return {"manifest": {"schema_version": 1, "kind": "wasm-module", "id": module_id, "role": role,
                         "artifact": {"path": f"{module_id}.wasm", "sha256": hashlib.sha256(binary).hexdigest()},
                         "target": {"abi": "wasip1", "features": []}, "interface": {"name": module_id, "version": 1},
                         "memory_model": "isolated", "requires": requires, "exports": exports, "runtime_verification": "not-run"},
            "hex": binary.hex()}


def requirement(provider, interface, imports, version=1):
    return {"provider": provider, "interface": interface, "version": version, "imports": imports}


def graph(duplicate=False):
    app_imports = [imp_decl("core", "convert", "convert", func), imp_decl("core", "table", "table", {**table, "minimum": 1, "maximum": 8}),
                   imp_decl("core", "memory", "memory", {**memory, "minimumPages": 1, "maximumPages": 6}),
                   imp_decl("core", "palette", "palette", glob), imp_decl("core", "signal", "signal", tag)]
    render = imp_decl("widgets", "render", "draw", func)
    widget_imports = [render, copy.deepcopy(render)] if duplicate else [render]
    return {"modules": [
        module("app", "app", app(duplicate), [requirement("core", "core", app_imports), requirement("widgets", "widgets", widget_imports)], []),
        module("widgets", "lib", widgets(), [requirement("core", "core", [imp_decl("core", "convert", "convert", func)])], [exp_decl("draw", func)]),
        module("core", "lib", core(), [requirement("host.clock", "clock", [imp_decl("env", "tick", "now", tick)])],
               [exp_decl("convert", func), exp_decl("table", table), exp_decl("memory", memory), exp_decl("palette", glob), exp_decl("signal", tag)])],
        "hosts": [{"id": "host.clock", "interface": {"name": "clock", "version": 1}, "exports": [exp_decl("now", tick)]}]}


cases = []


def add(label, value, accepted, *, engine_valid=None):
    case = {"name": label, "input": value, "accepted": accepted}
    if engine_valid is not None:
        case["engineValid"] = engine_valid
    cases.append(case)


add("five-kind graph with trapping start", graph(), True, engine_valid=True)
add("duplicate import occurrences", graph(True), True, engine_valid=True)
def duplicated_type_graph(different=False):
    first = bytes([0x60, 1, 0x7F, 1, 0x7E])
    second = bytes([0x60, 1, 0x7E, 1, 0x7E]) if different else first
    binary = wasm(section(1, vec(first, second)), section(2, vec(imp("env", "f", 0, 0), imp("env", "f", 0, 1))))
    other = {"kind": "function", "params": ["i64"], "results": ["i64"]} if different else func
    inputs = [imp_decl("env", "f", "f", func), imp_decl("env", "f", "f", other)]
    return {"modules": [module("app", "app", binary, [requirement("host.fn", "fn", inputs)], [])],
            "hosts": [{"id": "host.fn", "interface": {"name": "fn", "version": 1}, "exports": [exp_decl("f", func)]}]}
add("same import and signature across type indices", duplicated_type_graph(), True, engine_valid=True)
add("same import and provider with different signatures", duplicated_type_graph(True), False)
pairs = [("a.b", "c"), ("a", "b.c"), ("a\0b", "c"), ("a", "b\0c"), ("__proto__", "constructor"), ("", "")]
binary = wasm(section(1, vec(bytes([0x60, 0, 0]))), section(2, vec(*(imp(m, n, 0, 0) for m, n in pairs))))
special = {"modules": [module("app", "app", binary, [requirement("host.clock", "clock", [imp_decl(m, n, "", tick) for m, n in pairs])], [])],
           "hosts": [{"id": "host.clock", "interface": {"name": "clock", "version": 1}, "exports": [exp_decl("", tick)]}]}
add("special namespace pairs and empty names", special, True, engine_valid=True)
g = copy.deepcopy(special); g["modules"][0]["manifest"]["requires"][0]["imports"][0]["name"] = "b.c"; add("special pairs not interchangeable", g, False)
g = graph(True); g["modules"][0]["manifest"]["requires"][1]["imports"].pop(); add("duplicate import missing occurrence", g, False)
g = graph(True); g["modules"][0]["manifest"]["requires"][1]["imports"][1]["provider_export"] = "other"; add("duplicate import conflicting binding", g, False)
g = graph(); g["modules"][0]["manifest"]["artifact"]["sha256"] = "0" * 64; add("wrong hash", g, False)
g = graph(); g["modules"][0]["manifest"]["requires"][0]["imports"].pop(); add("missing import declaration", g, False)
g = graph(); g["modules"][2]["manifest"]["exports"].pop(); add("missing export declaration", g, False)
g = graph(); g["modules"][2]["manifest"]["exports"].append(exp_decl("extra", func)); add("extra export declaration", g, False)
g = graph(); g["modules"][0]["manifest"]["requires"][0]["imports"].append(imp_decl("core", "extra", "convert", func)); add("extra import declaration", g, False)
g = graph(); g["modules"][0]["manifest"]["requires"].append(requirement("host.clock", "clock", [])); add("empty requirement", g, True)
g = graph(); g["modules"][0]["manifest"]["requires"].append(requirement("host.clock", "wrong", [])); add("empty requirement wrong interface", g, False)
g = graph(); g["modules"][0]["manifest"]["target"]["features"] = ["unknown-feature"]; add("unverified unknown feature", g, True)
g = graph(); g["modules"][0]["manifest"]["target"]["features"] = ["simd", "simd"]; add("duplicate feature", g, False)
g = graph(); g["modules"][0]["manifest"]["requires"][1]["version"] = 2; add("wrong interface version", g, False)
g = graph(); g["modules"][0]["manifest"]["requires"][1]["imports"][0]["provider_export"] = "missing"; add("missing provider export", g, False)
for index, key, value in [(0, "results", ["i32"]), (1, "element", "externref"), (2, "shared", True), (3, "mutable", True), (4, "params", ["i32"])]:
    g = graph(); g["modules"][0]["manifest"]["requires"][0]["imports"][index][key] = value; add(f"actual import mismatch {index}", g, False)
for field, value in [("table_min", 3), ("table_max", 4), ("memory_min", 3), ("memory_max", 3)]:
    g = graph(); binary = app(**{field: value}); item = g["modules"][0]; item["hex"] = binary.hex(); item["manifest"]["artifact"]["sha256"] = hashlib.sha256(binary).hexdigest()
    index, key = {"table_min": (1, "minimum"), "table_max": (1, "maximum"), "memory_min": (2, "minimumPages"), "memory_max": (2, "maximumPages")}[field]
    item["manifest"]["requires"][0]["imports"][index][key] = value; add(f"provider incompatible {field}", g, False)
for path in ["", "/core.wasm", "../core.wasm", "a/../core.wasm", "a//core.wasm", "a\\core.wasm", "a%2fcore.wasm", "a?x", "a#x"]:
    g = graph(); g["modules"][2]["manifest"]["artifact"]["path"] = path; add(f"unsafe path {path}", g, False)
g = graph(); g["modules"][0]["manifest"]["interface"]["version"] = 0; add("zero version", g, False)
g = graph(); g["modules"][0]["manifest"]["target"]["abi"] = "unknown"; add("wrong ABI", g, False)
g = graph(); g["modules"][0]["manifest"]["memory_model"] = "shared"; add("wrong memory model", g, False)
g = graph(); g["hosts"][0]["id"] = "core"; add("duplicate provider", g, False)
g = graph(); g["modules"][2]["manifest"]["requires"].append(requirement("widgets", "widgets", [])); add("dependency cycle", g, False)
g = graph(); g["modules"][1]["manifest"]["requires"][0]["provider"] = "app"; add("app provider", g, False)
g = graph(); binary = bytearray.fromhex(g["modules"][2]["hex"]); binary[-1] = 0; g["modules"][2]["hex"] = binary.hex(); g["modules"][2]["manifest"]["artifact"]["sha256"] = hashlib.sha256(binary).hexdigest(); add("opaque invalid code", g, True, engine_valid=False)

Path(__file__).with_name("cases.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n")
