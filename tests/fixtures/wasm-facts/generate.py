#!/usr/bin/env python3
"""Write shared declaration-reader test cases."""

import json
from pathlib import Path


def leb(value):
    result = []
    while True:
        byte = value & 0x7F
        value >>= 7
        result.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(result)


def vec(*items):
    return leb(len(items)) + b"".join(items)


def name(value):
    data = value.encode("utf-8")
    return leb(len(data)) + data


def section(kind, payload):
    return bytes([kind]) + leb(len(payload)) + payload


def wasm(*sections):
    return b"\0asm\x01\0\0\0" + b"".join(sections)


def entry(module, field, kind, *ty):
    return name(module) + name(field) + bytes([kind, *ty])


def exported(field, kind, index):
    return name(field) + bytes([kind]) + leb(index)


mixed = wasm(
    section(1, vec(bytes([0x60, 1, 0x7F, 1, 0x7F]), bytes([0x60, 0, 0]))),
    section(2, vec(
        entry("env", "same", 0, 0), entry("env", "same", 0, 1),
        entry("env", "table", 1, 0x70, 1, 1, 3),
        entry("env", "memory", 2, 1, 1, 2),
        entry("\ufeffenv", "global", 3, 0x7F, 0),
    )),
    section(3, vec(bytes([1]), bytes([1]))),
    section(4, vec(bytes([0x6F, 0, 0]), bytes([0x70, 0, 0]))),
    section(6, vec(bytes([0x7E, 1, 0x42, 0x7F, 0x0B]), bytes([0x7F, 0, 0x41, 0, 0x0B]))),
    section(7, vec(
        exported("first", 0, 0), exported("start", 0, 2), exported("alias", 0, 2),
        exported("table", 1, 0), exported("other-table", 1, 1), exported("memory", 2, 0),
        exported("global", 3, 0), exported("other-global", 3, 1),
    )),
    section(8, bytes([2])), section(12, bytes([0])),
    section(10, vec(bytes([2, 0, 0x0B]), bytes([2, 0, 0x0B]))), section(11, bytes([0])),
)
tags = wasm(
    section(1, vec(bytes([0x60, 1, 0x7F, 0]))),
    section(2, vec(entry("env", "tag", 4, 0, 0))),
    section(13, vec(bytes([0, 0]))),
    section(7, vec(exported("imported-tag", 4, 0), exported("defined-tag", 4, 1))),
)
memories = wasm(
    section(2, vec(entry("env", "first", 2, 0, 0), entry("env", "second", 2, 1, 1, 4))),
    section(5, vec(bytes([3, 0, 2]))),
    section(7, vec(exported("defined", 2, 2))),
)

cases = []


def case(label, payload, valid, *, engine_valid=None):
    item = {"name": label, "hex": payload.hex(), "accepted": valid}
    if engine_valid is not None:
        item["engineValid"] = engine_valid
    cases.append(item)


case("mixed", mixed, True, engine_valid=True)
case("tags", tags, True, engine_valid=True)
case("memories", memories, True)
case("opaque element", wasm(section(9, b"\xff")), True, engine_valid=False)
case("opaque code", wasm(section(10, b"\xff")), True, engine_valid=False)
case("opaque data", wasm(section(11, b"\xff")), True, engine_valid=False)
case("function code mismatch", wasm(section(1, vec(bytes([0x60, 0, 0]))), section(3, vec(bytes([0]))), section(10, b"\0")), True, engine_valid=False)
case("short header", b"\0as", False)
case("wrong version", b"\0asm\x02\0\0\0", False)
case("section truncated", b"\0asm\x01\0\0\0\x05\x02\0", False)
case("invalid utf8", wasm(section(2, bytes([1, 1, 0xFF, 0, 0, 0]))), False)
case("u32 overflow", wasm(section(5, bytes([1, 0, 0x80, 0x80, 0x80, 0x80, 0x10]))), False)
case("signed overflow", wasm(section(6, bytes([1, 0x7F, 0, 0x41, 0x80, 0x80, 0x80, 0x80, 8, 0x0B]))), False)
case("duplicate section", wasm(section(5, b"\0"), section(5, b"\0")), False)
case("out of order", wasm(section(5, b"\0"), section(4, b"\0")), False)
case("unknown section", wasm(section(14, b"\0")), False)
case("duplicate export", wasm(section(5, b"\x01\0\0"), section(7, vec(exported("x", 2, 0), exported("x", 2, 0)))), False)
case("out of bounds export", wasm(section(7, vec(exported("x", 0, 0)))), False)
case("invalid start signature", wasm(section(1, vec(bytes([0x60, 1, 0x7F, 0]))), section(3, b"\x01\0"), section(8, b"\0")), False)
case("tag result", wasm(section(1, vec(bytes([0x60, 0, 1, 0x7F]))), section(13, b"\x01\0\0")), False)
case("memory flags", wasm(section(5, b"\x01\x80\0\0")), False)
case("table flags", wasm(section(4, b"\x01\x70\x80\0\0")), False)
case("memory64", wasm(section(5, b"\x01\x04\0")), False)
case("memory bounds", wasm(section(5, bytes([1, 0]) + leb(65537))), False)
case("table max below min", wasm(section(4, bytes([1, 0x70, 1, 2, 1]))), False)
case("invalid global initializer", wasm(section(6, bytes([1, 0x7F, 0, 0x45, 0x0B]))), False)
case("unsupported reference type", wasm(section(1, bytes([1, 0x60, 1, 0x63, 0]))), False)
case("trailing section bytes", wasm(section(1, b"\0\0")), False)

recipes = [
    {"name": "1001 parameters", "recipe": "parameters", "count": 1001, "accepted": True},
    {"name": "vector limit", "recipe": "parameters", "count": 49999, "accepted": True},
    {"name": "vector over limit", "recipe": "parameters", "count": 50000, "accepted": False, "limit": "vector elements"},
    {"name": "cumulative vector limit", "recipe": "cumulative-parameters", "count": 24999, "accepted": True},
    {"name": "cumulative vector over limit", "recipe": "cumulative-parameters", "count": 25000, "accepted": False, "limit": "vector elements"},
    {"name": "100001 name bytes", "recipe": "name", "count": 100001, "accepted": True},
    {"name": "name byte limit", "recipe": "name", "count": 4194304, "accepted": True},
    {"name": "name bytes over limit", "recipe": "name", "count": 4194305, "accepted": False, "limit": "name bytes"},
    {"name": "cumulative name limit", "recipe": "cumulative-names", "count": 2097152, "accepted": True},
    {"name": "cumulative names over limit", "recipe": "cumulative-names", "count": 2097153, "accepted": False, "limit": "name bytes"},
    {"name": "section limit", "recipe": "sections", "count": 4096, "accepted": True},
    {"name": "section over limit", "recipe": "sections", "count": 4097, "accepted": False, "limit": "sections"},
    {"name": "input byte limit", "recipe": "input", "count": 67108864, "accepted": True},
    {"name": "input bytes over limit", "recipe": "input", "count": 67108865, "accepted": False, "limit": "input bytes"},
]
output = Path(__file__).with_name("cases.json")
output.write_text(json.dumps(cases + recipes, ensure_ascii=False, indent=2) + "\n")
