"""Read target declarations through the libclang bundled with wasi-sdk."""

import ctypes as C
import re
import subprocess
import sys
from pathlib import Path

from lvgl import HEADER


class Cursor(C.Structure):
    _fields_ = [("kind", C.c_uint), ("xdata", C.c_int), ("data", C.c_void_p * 3)]


class Type(C.Structure):
    _fields_ = [("kind", C.c_uint), ("data", C.c_void_p * 2)]


class String(C.Structure):
    _fields_ = [("data", C.c_void_p), ("flags", C.c_uint)]


class Location(C.Structure):
    _fields_ = [("data", C.c_void_p * 2), ("int_data", C.c_uint)]


Visitor = C.CFUNCTYPE(C.c_uint, Cursor, Cursor, C.c_void_p)
FieldVisitor = C.CFUNCTYPE(C.c_uint, Cursor, C.c_void_p)


class TranslationUnit:
    def __init__(self, sdk: Path, command, output_dir: Path):
        self.sdk = sdk.resolve()
        self.command = command
        self.output_dir = output_dir
        self._index = None
        self._tu = C.c_void_p()
        filename = {"darwin": "lib/libclang.dylib", "linux": "lib/libclang.so"}.get(sys.platform)
        if filename is None:
            raise RuntimeError(f"SDK libclang loading is not configured for {sys.platform}")
        library = self.sdk / filename
        try:
            self.lib = C.CDLL(str(library))
        except OSError as error:
            raise RuntimeError(f"cannot load SDK libclang at {library}: {error}") from error

        self.bind("createIndex", C.c_void_p, C.c_int, C.c_int)
        self.bind("disposeIndex", None, C.c_void_p)
        self.bind("parseTranslationUnit2", C.c_int, C.c_void_p, C.c_char_p,
                  C.POINTER(C.c_char_p), C.c_int, C.c_void_p, C.c_uint,
                  C.c_uint, C.POINTER(C.c_void_p))
        self.bind("disposeTranslationUnit", None, C.c_void_p)
        self.bind("getTranslationUnitCursor", Cursor, C.c_void_p)
        self.bind("getTranslationUnitTargetInfo", C.c_void_p, C.c_void_p)
        self.bind("TargetInfo_getTriple", String, C.c_void_p)
        self.bind("TargetInfo_getPointerWidth", C.c_int, C.c_void_p)
        self.bind("TargetInfo_dispose", None, C.c_void_p)
        self.bind("getClangVersion", String)
        self.bind("getCString", C.c_char_p, String)
        self.bind("disposeString", None, String)
        self.bind("getNumDiagnostics", C.c_uint, C.c_void_p)
        self.bind("getDiagnostic", C.c_void_p, C.c_void_p, C.c_uint)
        self.bind("getDiagnosticSeverity", C.c_uint, C.c_void_p)
        self.bind("formatDiagnostic", String, C.c_void_p, C.c_uint)
        self.bind("disposeDiagnostic", None, C.c_void_p)
        self.bind("getCursorSpelling", String, Cursor)
        self.bind("getCursorKindSpelling", String, C.c_uint)
        self.bind("getCursorType", Type, Cursor)
        self.bind("getCanonicalCursor", Cursor, Cursor)
        self.bind("equalCursors", C.c_uint, Cursor, Cursor)
        self.bind("getCursorDefinition", Cursor, Cursor)
        self.bind("isCursorDefinition", C.c_uint, Cursor)
        self.bind("Cursor_isAnonymous", C.c_uint, Cursor)
        self.bind("Cursor_isAnonymousRecordDecl", C.c_uint, Cursor)
        self.bind("getTypeSpelling", String, Type)
        self.bind("getTypeKindSpelling", String, C.c_uint)
        self.bind("getCanonicalType", Type, Type)
        self.bind("getUnqualifiedType", Type, Type)
        self.bind("getTypeDeclaration", Cursor, Type)
        self.bind("getTypedefDeclUnderlyingType", Type, Cursor)
        self.bind("Type_getNamedType", Type, Type)
        self.bind("Type_getModifiedType", Type, Type)
        self.bind("getPointeeType", Type, Type)
        self.bind("getResultType", Type, Type)
        self.bind("getNumArgTypes", C.c_int, Type)
        self.bind("getArgType", Type, Type, C.c_uint)
        self.bind("isFunctionTypeVariadic", C.c_uint, Type)
        self.bind("getFunctionTypeCallingConv", C.c_uint, Type)
        self.bind("getArrayElementType", Type, Type)
        self.bind("getArraySize", C.c_longlong, Type)
        self.bind("getEnumDeclIntegerType", Type, Cursor)
        self.bind("Type_getSizeOf", C.c_longlong, Type)
        self.bind("Type_getAlignOf", C.c_longlong, Type)
        self.bind("Cursor_getOffsetOfField", C.c_longlong, Cursor)
        self.bind("getFieldDeclBitWidth", C.c_int, Cursor)
        self.bind("Cursor_isBitField", C.c_uint, Cursor)
        self.bind("isConstQualifiedType", C.c_uint, Type)
        self.bind("isVolatileQualifiedType", C.c_uint, Type)
        self.bind("isRestrictQualifiedType", C.c_uint, Type)
        self.bind("getCursorLocation", Location, Cursor)
        self.bind("getSpellingLocation", None, Location, C.POINTER(C.c_void_p),
                  C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.POINTER(C.c_uint))
        self.bind("getFileName", String, C.c_void_p)
        self.bind("visitChildren", C.c_uint, Cursor, Visitor, C.c_void_p)
        self.bind("Type_visitFields", C.c_uint, Type, FieldVisitor, C.c_void_p)

    def bind(self, name, result, *parameters):
        function = getattr(self.lib, f"clang_{name}")
        function.restype, function.argtypes = result, list(parameters)
        setattr(self, name, function)

    def string(self, value):
        try:
            return (self.getCString(value) or b"").decode("utf-8")
        finally:
            self.disposeString(value)

    def spelling(self, ctype):
        return self.string(self.getTypeSpelling(ctype))

    def children(self, cursor):
        result = []

        @Visitor
        def append(child, parent, data):
            result.append(child)
            return 1

        self.visitChildren(cursor, append, None)
        return result

    def fields(self, ctype):
        result = []

        @FieldVisitor
        def append(field, data):
            result.append(field)
            return 1

        self.Type_visitFields(ctype, append, None)
        return result

    def origin(self, cursor):
        file = C.c_void_p()
        line, column, offset = C.c_uint(), C.c_uint(), C.c_uint()
        self.getSpellingLocation(self.getCursorLocation(cursor), C.byref(file),
                                 C.byref(line), C.byref(column), C.byref(offset))
        return {"file": self.string(self.getFileName(file)) if file else None,
                "line": line.value, "column": column.value}

    def __enter__(self):
        try:
            driver_version = subprocess.check_output([self.command[0], "--version"], text=True)
            library_version = self.string(self.getClangVersion())
            version = r"clang version (\d+\.\d+\.\d+)"
            driver = re.search(version, driver_version, re.IGNORECASE)
            library = re.search(version, library_version, re.IGNORECASE)
            if not driver or not library or driver[1] != library[1]:
                raise RuntimeError("SDK compiler and libclang versions do not match")
            resource_dir = subprocess.check_output(
                [self.command[0], "-print-resource-dir"], text=True).strip()
            arguments = self.command[1:] + [
                f"--sysroot={self.sdk / 'share/wasi-sysroot'}",
                "-resource-dir", resource_dir, "-x", "c",
            ]
            self.resource_dir = Path(resource_dir).resolve()
            self.output_dir.mkdir(parents=True, exist_ok=True)
            source = self.output_dir / "api-layout.c"
            source.write_text(HEADER)
            argv = (C.c_char_p * len(arguments))(*(arg.encode() for arg in arguments))
            self._index = self.createIndex(0, 0)
            if not self._index:
                raise RuntimeError("libclang could not create an index")
            # Skip function bodies; the graph is rooted in public declarations.
            error = self.parseTranslationUnit2(self._index, str(source).encode(), argv,
                                               len(arguments), None, 0, 64, C.byref(self._tu))
            if error or not self._tu:
                raise RuntimeError(f"libclang could not parse the configured headers (error {error})")
            errors = []
            for index in range(self.getNumDiagnostics(self._tu)):
                diagnostic = self.getDiagnostic(self._tu, index)
                try:
                    if self.getDiagnosticSeverity(diagnostic) >= 3:
                        errors.append(self.string(self.formatDiagnostic(diagnostic, 0)))
                finally:
                    self.disposeDiagnostic(diagnostic)
            if errors:
                raise RuntimeError("libclang header errors:\n" + "\n".join(errors))
            target = self.getTranslationUnitTargetInfo(self._tu)
            if not target:
                raise RuntimeError("libclang returned no target information")
            try:
                self.target = {"triple": self.string(self.TargetInfo_getTriple(target)),
                               "pointer_bits": self.TargetInfo_getPointerWidth(target)}
            finally:
                self.TargetInfo_dispose(target)
            self.cursor = self.getTranslationUnitCursor(self._tu)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, exception_type, exception, traceback):
        if self._tu:
            self.disposeTranslationUnit(self._tu)
            self._tu = C.c_void_p()
        if self._index:
            self.disposeIndex(self._index)
            self._index = None
