"""Describe public C types using the configured SDK's target ABI."""

import hashlib
import json
import re
from collections import Counter
from pathlib import Path

from cindex import TranslationUnit


INTEGER_KINDS = set(range(4, 21))
UNSIGNED_KINDS = set(range(4, 13))
FLOAT_KINDS = {21, 22, 23, 30, 31, 32}


class TypeGraph:
    def __init__(self, clang, sdk, source, config):
        self.clang = clang
        self.roots = [(config.resolve(), "config"),
                      ((source / "include/lvgl").resolve(), "lvgl"),
                      (source.resolve(), "lvgl"), (clang.resource_dir.resolve(), "resource"),
                      (sdk.resolve(), "sdk")]
        self.types = {}
        self.declarations = {}
        self.structures = {}

    def origin(self, cursor):
        location = self.clang.origin(cursor)
        filename = location["file"]
        if not filename:
            if self.clang.string(self.clang.getCursorSpelling(cursor)).startswith("__builtin_"):
                return {"origin_file": "<built-in>", "line": 0, "column": 0}
            raise ValueError("type declaration has no source location: "
                             + self.clang.string(self.clang.getCursorSpelling(cursor)))
        path = Path(filename).resolve()
        for root, prefix in self.roots:
            if path.is_relative_to(root):
                return {"origin_file": f"{prefix}/{path.relative_to(root)}",
                        "line": location["line"], "column": location["column"]}
        raise ValueError(f"type declaration outside configured source roots: {filename}")

    def layout(self, ctype, status="complete"):
        if status != "complete":
            return {"status": status, "size": None, "alignment": None}
        size = self.clang.Type_getSizeOf(ctype)
        alignment = self.clang.Type_getAlignOf(ctype)
        if size < 0 or alignment < 1:
            raise ValueError(f"invalid complete type layout: {size}, {alignment}")
        return {"status": "complete", "size": size, "alignment": alignment}

    def intern(self, kind, description, layout):
        key = json.dumps(description, sort_keys=True, separators=(",", ":"))
        identity = f"{kind}:{hashlib.sha256(key.encode()).hexdigest()[:24]}"
        if identity in self.structures and self.structures[identity] != key:
            raise ValueError("structural type identifier collision")
        self.structures[identity] = key
        node = {"kind": kind, **description, "layout": layout}
        if identity in self.types and self.types[identity] != node:
            raise ValueError("structural type has inconsistent target layouts")
        self.types[identity] = node
        return identity

    def declaration(self, ctype, kind):
        clang = self.clang
        cursor = clang.getTypeDeclaration(ctype)
        definition = clang.getCursorDefinition(cursor)
        cursor = (definition if definition.kind in (2, 3, 4, 20)
                  else clang.getCanonicalCursor(cursor))
        location = self.origin(cursor)
        spelling = clang.string(clang.getCursorSpelling(cursor))
        name = spelling if re.fullmatch(r"[A-Za-z_]\w*", spelling) else None
        identity = (f"{kind}:{location['origin_file']}:{location['line']}:"
                    f"{location['column']}:{name or ''}")
        if identity in self.types:
            if not clang.equalCursors(self.declarations[identity], cursor):
                raise ValueError(f"distinct declarations share a type identifier: {identity}")
            return identity
        self.declarations[identity] = cursor
        node = {"kind": kind, "name": name, **location}
        self.types[identity] = node
        if kind == "alias":
            node["underlying"] = self.ref(clang.getTypedefDeclUnderlyingType(cursor))
        elif kind == "enum":
            node["layout"] = self.layout(ctype)
            node["integer_type"] = self.ref(clang.getEnumDeclIntegerType(cursor))
        else:
            complete = bool(clang.isCursorDefinition(cursor))
            node["record_kind"] = "struct" if cursor.kind == 2 else "union"
            node["layout"] = self.layout(ctype, "complete" if complete else "opaque")
            if complete:
                fields = []
                for field in clang.fields(clang.getCursorType(cursor)):
                    field_type = clang.getCursorType(field)
                    if field_type.kind == 0:
                        raise ValueError("invalid record field type")
                    field_name = clang.string(clang.getCursorSpelling(field))
                    if field_name and not field_name.isidentifier():
                        declaration = clang.getTypeDeclaration(clang.getCanonicalType(field_type))
                        if not clang.Cursor_isAnonymousRecordDecl(declaration):
                            raise ValueError("record field has an unexpected synthetic name")
                        field_name = None
                    offset = clang.Cursor_getOffsetOfField(field)
                    if offset < 0:
                        raise ValueError(f"record field has no target offset: {identity}")
                    bitfield = bool(clang.Cursor_isBitField(field))
                    width = clang.getFieldDeclBitWidth(field) if bitfield else None
                    if bitfield and width < 0:
                        raise ValueError(f"record bitfield has no target width: {identity}")
                    fields.append({
                        "name": field_name or None,
                        "type": self.ref(field_type),
                        "bit_offset": offset, "bit_width": width,
                    })
                node["fields"] = fields
        return identity

    def ref(self, ctype):
        clang = self.clang
        if ctype.kind == 0:
            raise ValueError("invalid type in public type graph")
        qualifiers = [name for name, query in (
            ("const", clang.isConstQualifiedType),
            ("volatile", clang.isVolatileQualifiedType),
            ("restrict", clang.isRestrictQualifiedType)) if query(ctype)]
        while ctype.kind in (119, 163):
            ctype = (clang.Type_getNamedType(ctype) if ctype.kind == 119
                     else clang.Type_getModifiedType(ctype))
            if ctype.kind == 0:
                raise ValueError("invalid elaborated or attributed type")
            for name, query in (("const", clang.isConstQualifiedType),
                                ("volatile", clang.isVolatileQualifiedType),
                                ("restrict", clang.isRestrictQualifiedType)):
                if query(ctype) and name not in qualifiers:
                    qualifiers.append(name)
        # Unqualifying a typedef can erase its name when its underlying type is const.
        if ctype.kind != 107:
            ctype = clang.getUnqualifiedType(ctype)
        kind = ctype.kind
        if kind in (105, 106, 107):
            identity = self.declaration(ctype, {105: "record", 106: "enum", 107: "alias"}[kind])
        elif kind == 2 or kind == 3 or kind in INTEGER_KINDS | FLOAT_KINDS:
            name = clang.string(clang.getTypeKindSpelling(kind))
            identity = f"builtin:{name}"
            node = {"kind": "void" if kind == 2 else "primitive",
                    "name": clang.spelling(ctype),
                    "layout": self.layout(ctype, "not_object" if kind == 2 else "complete")}
            if kind != 2:
                node["scalar"] = ("bool" if kind == 3 else
                                  "integer" if kind in INTEGER_KINDS else "float")
                node["bits"] = node["layout"]["size"] * 8
                if kind in INTEGER_KINDS:
                    node["signed"] = kind not in UNSIGNED_KINDS
            if identity in self.types and self.types[identity] != node:
                raise ValueError(f"primitive type has inconsistent layout: {identity}")
            self.types[identity] = node
        elif kind == 101:
            identity = self.intern("pointer", {"pointee": self.ref(clang.getPointeeType(ctype))},
                                   self.layout(ctype))
        elif kind in (112, 114, 115):
            length = clang.getArraySize(ctype) if kind == 112 else None
            if length is not None and length < 0:
                raise ValueError("constant array has no target length")
            identity = self.intern(
                "array", {"element": self.ref(clang.getArrayElementType(ctype)),
                          "length": length,
                          "bound": {112: "constant", 114: "incomplete", 115: "variable"}[kind]},
                self.layout(ctype, "complete" if kind == 112 else "incomplete"))
        elif kind in (110, 111):
            count = clang.getNumArgTypes(ctype)
            if kind == 111 and count < 0:
                raise ValueError("function prototype has no parameter types")
            convention = clang.getFunctionTypeCallingConv(ctype)
            if convention not in (0, 1):
                raise ValueError(f"unsupported target C calling convention: {convention}")
            identity = self.intern(
                "function", {"result": self.ref(clang.getResultType(ctype)),
                             "parameters": [self.ref(clang.getArgType(ctype, i))
                                            for i in range(max(0, count))],
                             "variadic": bool(clang.isFunctionTypeVariadic(ctype)),
                             "prototype": kind == 111,
                             "calling_convention": "default" if convention == 0 else "c"},
                self.layout(ctype, "not_object"))
        else:
            label = clang.string(clang.getTypeKindSpelling(kind))
            raise ValueError(f"unsupported type kind in public type graph: {label}")
        return {"id": identity, "qualifiers": sorted(qualifiers)}

    def callback_types(self, cursors):
        typedefs = {}
        for cursor in cursors:
            if cursor.kind == 20:
                name = self.clang.string(self.clang.getCursorSpelling(cursor))
                typedefs.setdefault(name, []).append(self.clang.getCanonicalCursor(cursor))

        def unalias(reference):
            seen = set()
            while self.types[reference["id"]]["kind"] == "alias":
                if reference["id"] in seen:
                    raise ValueError("cyclic callback type aliases")
                seen.add(reference["id"])
                reference = self.types[reference["id"]]["underlying"]
            return reference

        callbacks = {}
        names = {}
        for identity, node in sorted(self.types.items()):
            if node["kind"] != "alias" or not node["name"]:
                continue
            pointer = self.types[unalias(node["underlying"])["id"]]
            if pointer["kind"] != "pointer":
                continue
            reference = unalias(pointer["pointee"])
            if self.types[reference["id"]]["kind"] != "function":
                continue
            name = node["name"]
            visible = typedefs.get(name, [])
            declaration = self.declarations[identity]
            if not visible or any(not self.clang.equalCursors(cursor, declaration)
                                  for cursor in visible):
                raise ValueError(f"callback typedef is not unambiguously visible: {identity}")
            if name in names and names[name] != identity:
                raise ValueError(f"callback typedef name collision: {name}")
            names[name] = identity
            callbacks[identity] = {"function_type": reference}
        return callbacks


def collect_layouts(command, sdk: Path, source: Path, config: Path,
                    function_names, output_dir: Path) -> dict:
    expected = set(function_names)
    with TranslationUnit(sdk, command, output_dir) as clang:
        graph = TypeGraph(clang, sdk, source, config)
        functions = {}
        cursors = clang.children(clang.cursor)
        for cursor in cursors:
            if cursor.kind != 8:
                continue
            name = clang.string(clang.getCursorSpelling(cursor))
            location = clang.origin(cursor)
            if (not name.startswith("lv_") or not location["file"] or
                    not Path(location["file"]).resolve().is_relative_to(
                        (source / "include/lvgl").resolve())):
                continue
            ctype = clang.getCursorType(cursor)
            signatures = {"declared": graph.ref(ctype),
                          "canonical": graph.ref(clang.getCanonicalType(ctype))}
            if name in functions and functions[name] != signatures:
                raise ValueError(f"conflicting public function declarations: {name}")
            functions[name] = signatures
        if functions.keys() != expected:
            raise ValueError("public function type inventory differs: "
                             f"missing={sorted(expected - functions.keys())}, "
                             f"extra={sorted(functions.keys() - expected)}")
        aliases = [(identity, node) for identity, node in graph.types.items()
                   if node["kind"] == "alias"]
        while aliases:
            remaining = []
            for identity, node in aliases:
                layout = graph.types[node["underlying"]["id"]].get("layout")
                if layout is None:
                    remaining.append((identity, node))
                else:
                    ctype = clang.getCursorType(graph.declarations[identity])
                    node["layout"] = graph.layout(ctype, layout["status"])
            if len(remaining) == len(aliases):
                raise ValueError("cyclic aliases have no object layout")
            aliases = remaining
        records = [node for node in graph.types.values() if node["kind"] == "record"]
        return {
            "target": clang.target,
            "types": dict(sorted(graph.types.items())),
            "function_types": dict(sorted(functions.items())),
            "callback_types": graph.callback_types(cursors),
            "type_summary": {
                "total": len(graph.types),
                "kinds": dict(sorted(Counter(node["kind"] for node in graph.types.values()).items())),
                "records": dict(sorted(Counter(node["layout"]["status"] for node in records).items())),
                "bitfields": sum(field["bit_width"] is not None
                                 for node in records for field in node.get("fields", [])),
            },
        }
