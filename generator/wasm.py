"""Read scalar function and exception tag signatures from core Wasm modules and object files.

This checks signature sections and export indices, not instructions or complete module validity. Table, memory, and global definitions supply only their counts; their payloads must be checked separately with a full Wasm validator.
"""


SCALARS = {0x7F: "i32", 0x7E: "i64", 0x7D: "f32", 0x7C: "f64"}
KINDS = {0: "function", 1: "table", 2: "memory", 3: "global", 4: "tag"}
REFERENCES = {0x70, 0x6F}


class Reader:
    def __init__(self, data, context):
        self.data = memoryview(data)
        self.position = 0
        self.context = context

    def take(self, size):
        end = self.position + size
        if end > len(self.data):
            raise ValueError(f"{self.context}: truncated input at byte {self.position}")
        result = self.data[self.position:end]
        self.position = end
        return result

    def byte(self):
        return self.take(1)[0]

    def u32(self):
        value = 0
        for shift in range(0, 35, 7):
            byte = self.byte()
            if shift == 28 and byte > 0x0F:
                raise ValueError(f"{self.context}: invalid u32 LEB encoding")
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                return value
        raise ValueError(f"{self.context}: invalid u32 LEB encoding")

    def name(self):
        value = self.take(self.u32())
        try:
            return bytes(value).decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(f"{self.context}: invalid UTF-8 name") from error

    def scalar_vector(self):
        values = []
        for _ in range(self.u32()):
            kind = self.byte()
            if kind not in SCALARS:
                raise ValueError(f"{self.context}: unsupported function value type 0x{kind:02x}")
            values.append(SCALARS[kind])
        return values

    def tag_type(self, types):
        if self.byte() != 0:
            raise ValueError(f"{self.context}: unsupported tag attribute")
        signature = indexed(types, self.u32(), f"{self.context} tag type")
        if signature["results"]:
            raise ValueError(f"{self.context}: tag type must not have results")
        return signature

    def limits(self, kind):
        flags = self.byte()
        accepted = (0, 1, 3) if kind == "memory" else (0, 1)
        if flags not in accepted:
            raise ValueError(f"{self.context}: unsupported {kind} limits flags {flags}")
        minimum = self.u32()
        maximum = self.u32() if flags & 1 else None
        if maximum is not None and maximum < minimum:
            raise ValueError(f"{self.context}: {kind} maximum is smaller than minimum")
        if kind == "memory" and (minimum > 65536 or maximum is not None and maximum > 65536):
            raise ValueError(f"{self.context}: memory limits exceed the wasm32 address space")

    def finish(self):
        if self.position != len(self.data):
            raise ValueError(f"{self.context}: unexpected trailing bytes")


def indexed(items, index, label):
    if index >= len(items):
        raise ValueError(f"{label} index {index} is out of bounds ({len(items)})")
    return items[index]


def read_module(data: bytes) -> dict:
    """Return imports and exports, including their numeric function and tag signatures."""
    module = Reader(data, "module")
    if bytes(module.take(8)) != b"\x00asm\x01\x00\x00\x00":
        raise ValueError("expected a core Wasm module with version 1")
    sections = {}
    while module.position < len(module.data):
        section_id = module.byte()
        section = Reader(module.take(module.u32()), f"section {section_id}")
        if section_id == 0:
            section.name()
            continue
        if section_id not in range(1, 14):
            raise ValueError(f"unsupported Wasm section {section_id}")
        if section_id in sections:
            raise ValueError(f"duplicate Wasm section {section_id}")
        sections[section_id] = section

    types = []
    section = sections.get(1)
    if section is not None:
        for _ in range(section.u32()):
            tag = section.byte()
            if tag != 0x60:
                raise ValueError(f"section 1: unsupported type tag 0x{tag:02x}")
            types.append({"params": section.scalar_vector(), "results": section.scalar_vector()})
        section.finish()

    imports = []
    functions = []
    tags = []
    counts = {"table": 0, "memory": 0, "global": 0}
    section = sections.get(2)
    if section is not None:
        for _ in range(section.u32()):
            item = {"module": section.name(), "name": section.name()}
            tag = section.byte()
            if tag not in KINDS:
                raise ValueError(f"section 2: unsupported import kind {tag}")
            kind = item["kind"] = KINDS[tag]
            if kind == "function":
                signature = indexed(types, section.u32(), "import function type")
                functions.append(signature)
                item["signature"] = signature
            elif kind == "tag":
                signature = section.tag_type(types)
                tags.append(signature)
                item["signature"] = signature
            elif kind == "table":
                reference = section.byte()
                if reference not in REFERENCES:
                    raise ValueError(f"section 2: unsupported table reference type 0x{reference:02x}")
                section.limits(kind)
            elif kind == "memory":
                section.limits(kind)
            else:
                value = section.byte()
                if value not in SCALARS and value not in REFERENCES and value != 0x7B:
                    raise ValueError(f"section 2: unsupported global value type 0x{value:02x}")
                if section.byte() not in (0, 1):
                    raise ValueError("section 2: invalid global mutability")
            if kind not in ("function", "tag"):
                counts[kind] += 1
            imports.append(item)
        section.finish()

    section = sections.get(3)
    if section is not None:
        for _ in range(section.u32()):
            functions.append(indexed(types, section.u32(), "defined function type"))
        section.finish()

    for section_id, kind in ((4, "table"), (5, "memory"), (6, "global")):
        section = sections.get(section_id)
        if section is not None:
            counts[kind] += section.u32()

    section = sections.get(13)
    if section is not None:
        for _ in range(section.u32()):
            tags.append(section.tag_type(types))
        section.finish()

    exports = {}
    section = sections.get(7)
    if section is not None:
        for _ in range(section.u32()):
            name, tag, index = section.name(), section.byte(), section.u32()
            if name in exports:
                raise ValueError(f"section 7: duplicate export {name!r}")
            if tag not in KINDS:
                raise ValueError(f"section 7: unsupported export kind {tag}")
            kind = KINDS[tag]
            item = {"kind": kind}
            if kind == "function":
                item["signature"] = indexed(functions, index, f"export {name!r} function")
            elif kind == "tag":
                item["signature"] = indexed(tags, index, f"export {name!r} tag")
            elif index >= counts[kind]:
                raise ValueError(f"export {name!r} {kind} index {index} is out of bounds ({counts[kind]})")
            exports[name] = item
        section.finish()
    return {"imports": imports, "exports": exports}
