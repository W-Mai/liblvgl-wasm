#!/usr/bin/env python3
"""Generate shared multi-module feature graph test inputs."""

import copy
import hashlib
import json
from pathlib import Path


def leb(n):
    result = []
    while True:
        byte = n & 127
        n >>= 7
        result.append(byte | (128 if n else 0))
        if not n:
            return bytes(result)


def name(value):
    value = value.encode()
    return leb(len(value)) + value


def vec(*items):
    return leb(len(items)) + b"".join(items)


def section(kind, payload):
    return bytes([kind]) + leb(len(payload)) + payload


def wasm(*sections):
    return b"\0asm\1\0\0\0" + b"".join(sections)


def imp(module, field, kind, *ty):
    return name(module) + name(field) + bytes([kind, *ty])


def exp(field, kind, index):
    return name(field) + bytes([kind]) + leb(index)


def body(*ops):
    data = bytes([0, *ops, 0x0B])
    return leb(len(data)) + data


fn = {"kind": "function", "params": [], "results": ["i32"]}
mem = {"kind": "memory", "minimumPages": 1, "maximumPages": 4, "shared": False}
wasi = {"kind": "function", "params": ["i32"] * 4, "results": ["i32"]}


def req_import(module, field, provider_export, ty):
    return {"module": module, "name": field, "provider_export": provider_export, **ty}


def requirement(provider, interface, imports):
    return {"provider": provider, "interface": interface, "version": 1, "imports": imports}


def export(field, ty):
    return {"name": field, **ty}


def module(identifier, role, binary, requires, exports, features=None):
    return {"manifest": {"schema_version": 1, "kind": "wasm-module", "id": identifier, "role": role,
                         "artifact": {"path": identifier + ".wasm", "sha256": hashlib.sha256(binary).hexdigest()},
                         "target": {"abi": "wasip1", "features": features or []}, "interface": {"name": identifier, "version": 1},
                         "memory_model": "isolated", "requires": requires, "exports": exports, "runtime_verification": "not-run"},
            "hex": binary.hex()}


def fixture():
    types = section(1, vec(bytes([0x60, 0, 1, 0x7F]), bytes([0x60, 4, 0x7F, 0x7F, 0x7F, 0x7F, 1, 0x7F])))
    core = wasm(types, section(2, vec(imp("wasi_snapshot_preview1", "fd_write", 0, 1))), section(3, vec(b"\0")),
                section(5, vec(bytes([1, 1, 4]))), section(7, vec(exp("get", 0, 1), exp("memory", 2, 0))), section(10, vec(body(0x41, 42))))
    lib = wasm(types, section(2, vec(imp("core", "get", 0, 0))), section(3, vec(b"\0")), section(5, vec(bytes([1, 1, 4]))),
               section(7, vec(exp("get", 0, 1), exp("memory", 2, 0))), section(10, vec(body(0x10, 0, 0x41, 1, 0x6A))))
    app = wasm(types, section(2, vec(imp("core", "get", 0, 0), imp("lib", "get", 0, 0))), section(3, vec(b"\0")),
               section(5, vec(bytes([1, 1, 4]))), section(7, vec(exp("run", 0, 2), exp("memory", 2, 0))),
               section(10, vec(body(0x10, 0, 0x10, 1, 0x6A))))
    core_req = requirement("core", "core", [req_import("core", "get", "get", fn)])
    return {"modules": [
        module("app", "app", app, [core_req, requirement("lib", "lib", [req_import("lib", "get", "get", fn)])], [export("run", fn), export("memory", mem)]),
        module("lib", "lib", lib, [core_req], [export("get", fn), export("memory", mem)]),
        module("core", "lib", core, [requirement("host.wasi", "wasi", [req_import("wasi_snapshot_preview1", "fd_write", "fd_write", wasi)])],
               [export("get", fn), export("memory", mem)])],
        "hosts": [{"id": "host.wasi", "interface": {"name": "wasi", "version": 1}, "exports": [export("fd_write", wasi)]}]}


cases = []


def add(label, input_, accepted, allowed=None, stage=None, module_id=None):
    case = {"name": label, "input": copy.deepcopy(input_), "allowedFeatures": allowed or [], "accepted": accepted}
    if stage:
        case["stage"] = stage
    if module_id:
        case["module"] = module_id
    cases.append(case)


add("three-module DAG", fixture(), True)
g = fixture(); g["modules"][0]["manifest"]["target"]["features"] = ["simd"]; add("different per-module declarations", g, True, ["simd"])
add("unknown host feature", fixture(), False, ["unknown"], "policy")
add("duplicate host feature", fixture(), False, ["simd", "simd"], "policy")
g = fixture(); g["modules"][0]["manifest"]["artifact"]["sha256"] = "0" * 64; add("wrong hash", g, False, stage="manifest")
g = fixture(); g["modules"][0]["manifest"]["requires"][1]["version"] = 2; add("wrong interface", g, False, stage="manifest")
g = fixture(); g["modules"][2]["manifest"]["requires"].append(requirement("lib", "lib", [])); add("dependency cycle", g, False, stage="manifest")
g = fixture(); g["modules"][0]["manifest"]["target"]["features"] = ["simd"]; add("declared feature disallowed", g, False, stage="feature", module_id="app")
g = fixture(); g["modules"][0]["manifest"]["target"]["features"] = ["unknown"]; add("unknown feature", g, False, stage="feature", module_id="app")
g = fixture(); g["modules"][0]["manifest"]["target"]["features"] = ["simd", "simd"]; add("duplicate declaration", g, False, stage="manifest")
g = fixture(); binary = bytearray.fromhex(g["modules"][0]["hex"]); binary[-1] = 0
g["modules"][0]["hex"] = binary.hex(); g["modules"][0]["manifest"]["artifact"]["sha256"] = hashlib.sha256(binary).hexdigest()
add("invalid code", g, False, stage="feature", module_id="app")
g["modules"][0]["manifest"]["requires"][1]["version"] = 2; add("interface before invalid code", g, False, stage="manifest")
start = wasm(section(1, vec(bytes([0x60, 0, 0]))), section(3, vec(b"\0")), section(8, b"\0"), section(10, vec(body(0))))
add("start rejected", {"modules": [module("app", "app", start, [], [])], "hosts": []}, False, stage="resource", module_id="app")
imported = wasm(section(2, vec(imp("host", "memory", 2, 1, 1, 4))))
memory_host = {"id": "host.memory", "interface": {"name": "memory", "version": 1}, "exports": [export("memory", mem)]}
memory_req = requirement("host.memory", "memory", [req_import("host", "memory", "memory", mem)])
add("imported memory rejected", {"modules": [module("app", "app", imported, [memory_req], [])], "hosts": [memory_host]}, False, stage="resource", module_id="app")
bad = wasm(section(1, vec(bytes([0x60, 0, 1, 0x7F]))), section(2, vec(imp("wasi_snapshot_preview1", "fd_write", 0, 0))),
           section(5, vec(bytes([1, 1, 4]))), section(7, vec(exp("memory", 2, 0))))
bad_host = {"id": "host.wasi", "interface": {"name": "wasi", "version": 1}, "exports": [export("fd_write", fn)]}
bad_req = requirement("host.wasi", "wasi", [req_import("wasi_snapshot_preview1", "fd_write", "fd_write", fn)])
add("wrong WASI signature", {"modules": [module("app", "app", bad, [bad_req], [export("memory", mem)])], "hosts": [bad_host]}, False, stage="wasi", module_id="app")
simd = bytes.fromhex("0061736d010000000105016000017b030201000a16011400fd0c010000000200000003000000040000000b")
add("host-only SIMD not enabled", {"modules": [module("app", "app", simd, [], [])], "hosts": []}, False, ["simd"], "feature", "app")
add("declared SIMD disallowed", {"modules": [module("app", "app", simd, [], [], ["simd"])], "hosts": []}, False, [], "feature", "app")
add("declared and allowed SIMD", {"modules": [module("app", "app", simd, [], [], ["simd"])], "hosts": []}, True, ["simd"])
shared_simd = {"modules": [module("lib", "lib", simd, [], [], ["simd"]),
                           module("app", "app", simd, [requirement("lib", "lib", [])], [])], "hosts": []}
add("SIMD in other module does not authorize app", shared_simd, False, ["simd"], "feature", "app")
shared_simd["modules"][1]["manifest"]["target"]["features"] = ["simd"]
add("SIMD authorized separately for both modules", shared_simd, True, ["simd"])

Path(__file__).with_name("cases.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n")
