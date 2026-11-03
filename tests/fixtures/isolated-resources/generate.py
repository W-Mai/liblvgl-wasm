#!/usr/bin/env python3
"""Generate shared isolated topology inspection fixtures."""

import json
from pathlib import Path


def leb(n):
    output = []
    while True:
        byte = n & 127
        n >>= 7
        output.append(byte | (128 if n else 0))
        if not n:
            return bytes(output)


def name(value):
    data = value.encode()
    return leb(len(data)) + data


def vec(*entries):
    return leb(len(entries)) + b"".join(entries)


def section(kind, payload):
    return bytes([kind]) + leb(len(payload)) + payload


def wasm(*sections):
    return b"\0asm\x01\0\0\0" + b"".join(sections)


def imp(module, field, kind, *desc):
    return name(module) + name(field) + bytes([kind, *desc])


def exp(field, kind, index):
    return name(field) + bytes([kind]) + leb(index)


def fn(params=b"", results=b""):
    return bytes([0x60]) + leb(len(params)) + params + leb(len(results)) + results


cases = []


def case(label, binary, accepted, *, memories=0, tables=0, wasi=False, engine=None, error=None):
    item = {"name": label, "hex": binary.hex(), "accepted": accepted}
    if accepted:
        item.update(memories=memories, tables=tables, usesWasi=wasi)
    if engine is not None:
        item["engineValid"] = engine
    if error is not None:
        item["error"] = error
    cases.append(item)


case("empty", wasm(), True, engine=True)
owned = wasm(section(4, vec(bytes([0x70, 0, 1]))), section(5, vec(bytes([0, 1]))),
             section(7, vec(exp("memory", 2, 0), exp("alias", 2, 0), exp("table", 1, 0))))
case("owned resources and aliases", owned, True, memories=1, tables=1, engine=True)
case("unexported owned resources", wasm(section(4, vec(bytes([0x6F, 0, 0]))), section(5, vec(bytes([0, 0])))), True, memories=1, tables=1)
case("imported memory", wasm(section(2, vec(imp("env", "memory", 2, 0, 1)))), False, error="cannot import memory")
case("imported table", wasm(section(2, vec(imp("env", "table", 1, 0x70, 0, 1)))), False, error="cannot import table")
case("shared memory", wasm(section(5, vec(bytes([3, 1, 2])))), False, error="shared memory")
case("unexported multiple memories", wasm(section(5, vec(bytes([0, 1]), bytes([0, 1])))), False, error="multiple memories")
case("unexported multiple tables", wasm(section(4, vec(bytes([0x70, 0, 1]), bytes([0x70, 0, 1])))), False, error="multiple tables")

for name_, typ in [("funcref", 0x70), ("externref", 0x6F)]:
    parameter = section(1, vec(fn(bytes([typ]))))
    result = section(1, vec(fn(results=bytes([typ]))))
    case(f"{name_} function import parameter", wasm(parameter, section(2, vec(imp("env", "f", 0, 0)))), False, error="reference-typed")
    case(f"{name_} function import result", wasm(result, section(2, vec(imp("env", "f", 0, 0)))), False, error="reference-typed")
    case(f"{name_} function export parameter", wasm(parameter, section(3, vec(b"\0")), section(7, vec(exp("f", 0, 0)))), False, error="reference-typed")
    case(f"{name_} function export result", wasm(result, section(3, vec(b"\0")), section(7, vec(exp("f", 0, 0)))), False, error="reference-typed")
    case(f"{name_} tag import", wasm(parameter, section(2, vec(imp("env", "t", 4, 0, 0)))), False, error="reference-typed")
    case(f"{name_} tag export", wasm(parameter, section(13, vec(bytes([0, 0]))), section(7, vec(exp("t", 4, 0)))), False, error="reference-typed")
    case(f"{name_} immutable global import", wasm(section(2, vec(imp("env", "g", 3, typ, 0)))), False, error="mutable or reference")
    initializer = bytes([typ, 1, 0xD0, typ, 0x0B])
    case(f"{name_} mutable global export", wasm(section(6, vec(initializer)), section(7, vec(exp("g", 3, 0)))), True)
    case(f"{name_} local function", wasm(parameter, section(3, vec(b"\0")), section(10, vec(bytes([2, 0, 0x0B])))), True, engine=True)

case("mutable numeric global import", wasm(section(2, vec(imp("env", "g", 3, 0x7F, 1)))), False, error="mutable or reference")
for label, typ in [("i32", 0x7F), ("i64", 0x7E), ("f32", 0x7D), ("f64", 0x7C), ("v128", 0x7B)]:
    case(f"immutable {label} global import", wasm(section(2, vec(imp("env", "g", 3, typ, 0)))), True)
    case(f"{label} function boundary", wasm(section(1, vec(fn(bytes([typ]), bytes([typ])))), section(2, vec(imp("env", "f", 0, 0)))), True)
case("start section", wasm(section(1, vec(fn())), section(3, vec(b"\0")), section(8, b"\0"), section(10, vec(bytes([3, 0, 0, 0x0B])))), False, error="start section", engine=True)

types = section(1, vec(fn()))
p1 = section(2, vec(imp("wasi_snapshot_preview1", "fd_write", 0, 0)))
memory = section(5, vec(bytes([0, 1])))
case("P1 without memory", wasm(types, p1), False, error="export its own memory")
case("P1 hidden memory", wasm(types, p1, memory), False, error="export its own memory")
case("P1 wrong memory name", wasm(types, p1, memory, section(7, vec(exp("other", 2, 0)))), False, error="export its own memory")
globals_ = section(6, vec(bytes([0x7F, 0, 0x41, 0, 0x0B])))
case("P1 global named memory", wasm(types, p1, memory, globals_, section(7, vec(exp("memory", 3, 0)))), False, error="export its own memory")
case("P1 memory and alias, wrong ABI", wasm(types, p1, memory, section(7, vec(exp("memory", 2, 0), exp("alias", 2, 0)))), True, memories=1, wasi=True)
unknown = section(2, vec(imp("wasi_snapshot_preview1", "unknown", 0, 0)))
case("P1 unknown name with owned memory", wasm(types, unknown, memory, section(7, vec(exp("memory", 2, 0)))), True, memories=1, wasi=True)
for namespace in ["wasi_unstable", "wasi:cli/environment@0.2.0", "wasi_custom", ""]:
    case(f"ordinary topology namespace {namespace}", wasm(types, section(2, vec(imp(namespace, "f", 0, 0)))), True)
case("opaque invalid code", wasm(types, section(3, vec(b"\0")), section(10, vec(bytes([2, 0, 0])))), True, engine=False)
cases.append({"name": "10000 repeated imports", "recipe": "repeated", "repeat": 10000, "accepted": True, "memories": 0, "tables": 0, "usesWasi": False})

Path(__file__).with_name("cases.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n")
