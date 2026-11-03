#!/usr/bin/env python3
"""Generate shared WASI Preview 1 declaration fixtures."""

import json
from pathlib import Path

SIGNATURES = {
    "args_get": "ii/i", "args_sizes_get": "ii/i", "clock_res_get": "ii/i", "clock_time_get": "iIi/i",
    "environ_get": "ii/i", "environ_sizes_get": "ii/i", "fd_advise": "iIIi/i", "fd_allocate": "iII/i",
    "fd_close": "i/i", "fd_datasync": "i/i", "fd_fdstat_get": "ii/i", "fd_fdstat_set_flags": "ii/i",
    "fd_fdstat_set_rights": "iII/i", "fd_filestat_get": "ii/i", "fd_filestat_set_size": "iI/i",
    "fd_filestat_set_times": "iIIi/i", "fd_pread": "iiiIi/i", "fd_prestat_dir_name": "iii/i",
    "fd_prestat_get": "ii/i", "fd_pwrite": "iiiIi/i", "fd_read": "iiii/i", "fd_readdir": "iiiIi/i",
    "fd_renumber": "ii/i", "fd_seek": "iIii/i", "fd_sync": "i/i", "fd_tell": "ii/i", "fd_write": "iiii/i",
    "path_create_directory": "iii/i", "path_filestat_get": "iiiii/i", "path_filestat_set_times": "iiiiIIi/i",
    "path_link": "iiiiiii/i", "path_open": "iiiiiIIii/i", "path_readlink": "iiiiii/i", "path_remove_directory": "iii/i",
    "path_rename": "iiiiii/i", "path_symlink": "iiiii/i", "path_unlink_file": "iii/i", "poll_oneoff": "iiii/i",
    "proc_exit": "i/", "proc_raise": "i/i", "random_get": "ii/i", "sched_yield": "/i", "sock_accept": "iii/i",
    "sock_recv": "iiiiii/i", "sock_send": "iiiii/i", "sock_shutdown": "ii/i",
}


def leb(value):
    output = []
    while True:
        byte = value & 127
        value >>= 7
        output.append(byte | (128 if value else 0))
        if not value:
            return bytes(output)


def name(value):
    data = value.encode()
    return leb(len(data)) + data


def vec(*items):
    return leb(len(items)) + b"".join(items)


def section(kind, payload):
    return bytes([kind]) + leb(len(payload)) + payload


def wasm(*sections):
    return b"\0asm\1\0\0\0" + b"".join(sections)


def fn(signature):
    params, results = signature.split("/")
    values = {"i": 0x7F, "I": 0x7E}
    return bytes([0x60]) + leb(len(params)) + bytes(values[x] for x in params) + leb(len(results)) + bytes(values[x] for x in results)


def imp(module, field, kind, *desc):
    return name(module) + name(field) + bytes([kind, *desc])


def exp(field, kind, index):
    return name(field) + bytes([kind]) + leb(index)


def function_import(module, field, signature, repeat=1):
    return wasm(section(1, vec(fn(signature))), section(2, vec(*([imp(module, field, 0, 0)] * repeat))))


cases = []


def case(label, binary, accepted, **expected):
    cases.append({"name": label, "hex": binary.hex(), "accepted": accepted, **expected})


namespace = "wasi_snapshot_preview1"
for field, signature in SIGNATURES.items():
    case(f"{field} correct", function_import(namespace, field, signature), True, imports=[field])
    params, results = signature.split("/")
    wrong_params = ("I" if params[0] == "i" else "i") + params[1:] if params else "i"
    case(f"{field} wrong parameter", function_import(namespace, field, f"{wrong_params}/{results}"), False, error="signature")
    wrong_results = "" if results else "i"
    case(f"{field} wrong result", function_import(namespace, field, f"{params}/{wrong_results}"), False, error="signature")
    case(f"{field} wrong kind", wasm(section(2, vec(imp(namespace, field, 3, 0x7F, 0)))), False, error="function")

case("empty module", wasm(), True, imports=[])
case("duplicate ordered imports", function_import(namespace, "fd_close", "i/i", 3), True, imports=["fd_close"] * 3)
case("unknown import", function_import(namespace, "__proto__", "/"), False, error="unsupported WASI Preview 1 import")
case("empty WASI import name", function_import(namespace, "", "/"), False, error="unsupported WASI Preview 1 import")
case("empty ordinary namespace", function_import("", "f", "/"), True, imports=[])
cases.append({"name": "10000 repeated imports", "recipe": "fd_close", "repeat": 10000, "accepted": True})
for namespace_ in ["wasi_unstable", "wasi:cli/environment@0.2.0"]:
    case(f"unsupported namespace {namespace_}", function_import(namespace_, "f", "/"), False, error="namespace")
for namespace_ in ["wasi_custom", "wasi", "WASI", "my.wasi:foo"]:
    case(f"ordinary namespace {namespace_}", function_import(namespace_, "f", "/"), True, imports=[])
for field in ["_initialize", "_start"]:
    good = wasm(section(1, vec(fn("/"))), section(3, vec(b"\0")), section(7, vec(exp(field, 0, 0))), section(10, vec(bytes([2, 0, 0x0B]))))
    case(f"{field} valid", good, True, imports=[], entrypoint=field)
    wrong = wasm(section(1, vec(fn("i/"))), section(3, vec(b"\0")), section(7, vec(exp(field, 0, 0))), section(10, vec(bytes([2, 0, 0x0B]))))
    case(f"{field} wrong signature", wrong, False, error="entrypoint")
    glob = wasm(section(6, vec(bytes([0x7F, 0, 0x41, 0, 0x0B]))), section(7, vec(exp(field, 3, 0))))
    case(f"{field} wrong kind", glob, False, error="entrypoint")
trap = wasm(section(1, vec(fn("/"))), section(3, vec(b"\0")), section(8, b"\0"), section(10, vec(bytes([3, 0, 0, 0x0B]))))
case("trapping start not executed", trap, True, imports=[], startSection=True, engineValid=True)
invalid = wasm(section(1, vec(fn("/"))), section(3, vec(b"\0")), section(10, vec(bytes([2, 0, 0]))))
case("opaque invalid code", invalid, True, imports=[], engineValid=False)

Path(__file__).with_name("cases.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n")
