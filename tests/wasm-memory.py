"""Check the Wasm reader's memory-index and memory-limit contract."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "generator"))
from wasm import read_module


def u32(value):
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def name(value):
    data = value.encode("utf-8")
    return u32(len(data)) + data


def vector(items):
    return u32(len(items)) + b"".join(items)


def section(kind, contents):
    return bytes([kind]) + u32(len(contents)) + contents


def module(*sections):
    return b"\0asm\1\0\0\0" + b"".join(sections)


def limits(flags, minimum, maximum=None):
    return bytes([flags]) + u32(minimum) + (u32(maximum) if maximum is not None else b"")


class MemoryContract(unittest.TestCase):
    def test_memory_import_indices_ignore_other_import_kinds(self):
        types = section(1, vector([b"\x60\x00\x00"]))
        imports = section(2, vector([
            name("env") + name("first") + b"\x02" + limits(0, 0),
            name("env") + name("function") + b"\x00\x00",
            name("env") + name("second") + b"\x02" + limits(1, 4, 6),
        ]))
        exports = section(7, vector([name("second") + b"\x02\x01"]))
        report = read_module(module(types, imports, exports))
        self.assertEqual([item["index"] for item in report["imports"] if item["kind"] == "memory"], [0, 1])
        self.assertEqual(report["exports"]["second"]["index"], 1)
        self.assertEqual(report["memories"][1], {
            "minimum_pages": 4, "maximum_pages": 6, "shared": False, "imported": True,
        })

    def test_imports_and_definitions_share_memory_index_space(self):
        types = section(1, vector([b"\x60\x00\x00"]))
        imports = section(2, vector([
            name("env") + name("function") + b"\x00\x00",
            name("env") + name("imported") + b"\x02" + limits(1, 1, 7),
        ]))
        definitions = section(5, vector([limits(0, 2), limits(3, 0, 65536)]))
        exports = section(7, vector([
            name("fn") + b"\x00\x00", name("first") + b"\x02\x00",
            name("second") + b"\x02\x01", name("third") + b"\x02\x02",
            name("alias") + b"\x02\x01",
        ]))
        report = read_module(module(types, imports, definitions, exports))
        self.assertEqual(report["imports"][0]["signature"], {"params": [], "results": []})
        self.assertEqual(report["imports"][1], {
            "module": "env", "name": "imported", "kind": "memory", "index": 0,
        })
        self.assertEqual(report["memories"], [
            {"minimum_pages": 1, "maximum_pages": 7, "shared": False, "imported": True},
            {"minimum_pages": 2, "maximum_pages": None, "shared": False, "imported": False},
            {"minimum_pages": 0, "maximum_pages": 65536, "shared": True, "imported": False},
        ])
        self.assertEqual(report["exports"]["fn"], {"kind": "function", "signature": {"params": [], "results": []}})
        for export, index in (("first", 0), ("second", 1), ("third", 2), ("alias", 1)):
            self.assertEqual(report["exports"][export], {"kind": "memory", "index": index})
        self.assertEqual(read_module(module())["memories"], [])
        largest = read_module(module(section(5, vector([limits(0, 65536)]))))
        self.assertEqual(largest["memories"][0]["minimum_pages"], 65536)

    def test_invalid_memory_types_and_indices_are_rejected(self):
        invalid = [
            (b"\x02\x01", "unsupported memory limits flags"),
            (b"\x04\x01", "unsupported memory limits flags"),
            (b"\x03\x01", "truncated input"),
            (b"\x01\x02\x01", "maximum is smaller than minimum"),
            (limits(0, 65537), "memory limits exceed the wasm32 address space"),
            (limits(1, 0, 65537), "memory limits exceed the wasm32 address space"),
            (b"\x00\x80\x80\x80\x80\x10", "invalid u32 LEB encoding"),
            (b"\x00\x01\x00", "unexpected trailing bytes"),
        ]
        for entry, message in invalid:
            with self.subTest(entry=entry):
                with self.assertRaisesRegex(ValueError, message):
                    read_module(module(section(5, b"\x01" + entry)))
                with self.assertRaisesRegex(ValueError, message):
                    read_module(module(section(2, b"\x01" + name("env") + name("memory") + b"\x02" + entry)))
        with self.assertRaisesRegex(ValueError, "memory index 1 is out of bounds"):
            read_module(module(section(5, vector([limits(0, 1)])),
                               section(7, vector([name("memory") + b"\x02\x01"]))))


if __name__ == "__main__":
    unittest.main()
