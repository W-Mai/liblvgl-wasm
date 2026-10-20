"""Collect constants using the configured target compiler."""

import json
import re
import subprocess
from pathlib import Path


PUBLIC_NAME = re.compile(r"(?:LV|LVGL)_[A-Za-z0-9_]+\Z")
HEADER = '#include "lvgl/lvgl.h"\n'
CATEGORIES = ("integer", "string", "function_macro", "empty_macro", "unsupported")
CONTEXT_NAMES = {
    "__LINE__", "__FILE__", "__FILE_NAME__", "__BASE_FILE__", "__COUNTER__",
    "__INCLUDE_LEVEL__", "__DATE__", "__TIME__", "__TIMESTAMP__", "__func__",
    "__FUNCTION__", "__PRETTY_FUNCTION__",
}


def run(command, action, text=HEADER, check=True):
    return subprocess.run(command + action + ["-x", "c", "-"], input=text,
                          text=True, capture_output=True, check=check)


def json_nodes(output):
    decoder = json.JSONDecoder()
    offset = 0
    while offset < len(output):
        while offset < len(output) and output[offset].isspace():
            offset += 1
        if offset == len(output):
            break
        node, offset = decoder.raw_decode(output, offset)
        yield node


def origin_file(filename, source, config):
    if filename.startswith("<") and filename.endswith(">"):
        return filename
    path = Path(filename).resolve()
    for root, prefix in ((config, "config"), (source / "include/lvgl", "lvgl"),
                         (source, "lvgl")):
        if path.is_relative_to(root):
            return f"{prefix}/{path.relative_to(root)}"
    raise ValueError(f"constant declaration outside the source/config roots: {filename}")


def candidates(command, source, config):
    output = run(command, ["-Xclang", "-ast-dump=json", "-Xclang",
                           "-ast-dump-filter=LV", "-fsyntax-only"]).stdout
    entries = {}
    for node in json_nodes(output):
        name = node.get("name", "")
        if node.get("kind") != "EnumConstantDecl" or not PUBLIC_NAME.fullmatch(name):
            continue
        location = node["loc"]
        entries[name] = {
            "name": name, "origin": "enum",
            "origin_file": origin_file(location["file"], source, config),
            "line": location["line"],
        }
    macros, dependencies = {}, {}
    filename, line_number = "<stdin>", 1
    output = run(command, ["-E", "-dD"]).stdout
    for line in output.splitlines():
        marker = re.fullmatch(r'# (\d+) "((?:[^"\\]|\\.)*)"(?: .*)?', line)
        if marker:
            line_number = int(marker[1])
            filename = json.loads(f'"{marker[2]}"')
            continue
        definition = re.fullmatch(r"#define (\w+)(.*)", line)
        if definition:
            tokens = re.sub(r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'', "", definition[2])
            dependencies[definition[1]] = set(re.findall(r"[A-Za-z_]\w*", tokens))
        if definition and PUBLIC_NAME.fullmatch(definition[1]):
            name, body = definition.groups()
            entry = {
                "name": name, "origin": "macro",
                "origin_file": origin_file(filename, source, config),
                "line": line_number,
            }
            if body.startswith("("):
                parameters, expression = body[1:].split(")", 1)
                entry.update(category="function_macro",
                             parameters=parameters.split(",") if parameters else [],
                             expression=expression.strip())
            else:
                expression = body.strip()
                entry["expression"] = expression
                if not expression:
                    entry["category"] = "empty_macro"
                elif re.fullmatch(r"[A-Za-z_]\w*", expression):
                    entry["alias_of"] = expression
            macros[name] = entry
        undefinition = re.fullmatch(r"#undef (\w+)", line)
        if undefinition:
            macros.pop(undefinition[1], None)
            dependencies.pop(undefinition[1], None)
        line_number += 1
    contextual = set(CONTEXT_NAMES)
    while additions := {name for name, tokens in dependencies.items()
                        if name not in contextual and tokens & contextual}:
        contextual.update(additions)
    for name in contextual & macros.keys():
        if "category" not in macros[name]:
            macros[name].update(
                category="unsupported", reason_code="context_dependent",
                reason="The macro depends on its expansion location or compilation context.")
    entries.update(macros)
    return dict(sorted(entries.items()))


def probe_source(names):
    text = HEADER + ("__attribute__((used)) static const unsigned lvw_target_pointer_bits"
                     " = sizeof(void *) * __CHAR_BIT__;\n")
    for name in names:
        text += (f'#line 1 "lvw_constant_{name}"\n'
                 f"__attribute__((used)) static const __typeof__({name}) "
                 f"lvw_value_{name} = {name};\n")
    return text


def compile_values(command, entries):
    pending = {name for name, entry in entries.items() if "category" not in entry}
    while True:
        text = probe_source(sorted(pending))
        result = run(command, ["-ferror-limit=0", "-fno-color-diagnostics",
                              "-S", "-emit-llvm", "-o", "-"], text, check=False)
        if result.returncode == 0:
            return text, result.stdout, pending
        errors = [line for line in result.stderr.splitlines()
                  if re.search(r"\b(?:fatal )?error:", line)]
        if not errors:
            raise RuntimeError(f"constant compiler failed: {result.stderr}")
        rejected = {}
        for error in errors:
            match = re.fullmatch(r"lvw_constant_(\w+):\d+:\d+: error: (.*)", error)
            if not match or match[1] not in pending:
                raise RuntimeError(f"unattributed constant compiler error: {error}")
            rejected.setdefault(match[1], match[2])
        for name, error in rejected.items():
            if "not a compile-time constant" in error:
                code, reason = "not_constant", "The expression requires runtime evaluation."
            elif "undeclared identifier" in error:
                code, reason = "unavailable_declaration", "A referenced declaration is unavailable."
            else:
                code, reason = "not_value_expression", "The macro is not a constant value expression."
            entries[name].update(category="unsupported", reason_code=code, reason=reason)
        pending.difference_update(rejected)


def global_values(ir, prefix):
    values = {}
    for line in ir.splitlines():
        match = re.fullmatch(rf"@{prefix}(\w+) = internal constant (.*), align \d+", line)
        if match:
            if match[1] in values:
                raise ValueError(f"duplicate constant output: {match[1]}")
            values[match[1]] = match[2]
    return values


def string_bytes(encoded, length):
    if encoded == "zeroinitializer":
        return bytes(length)
    if not encoded.startswith('c"') or not encoded.endswith('"'):
        raise ValueError(f"unrecognized string constant encoding: {encoded}")
    data = bytearray()
    index = 2
    while index < len(encoded) - 1:
        char = encoded[index]
        if char == "\\":
            if encoded[index + 1:index + 2] == "\\":
                data.append(92)
                index += 2
                continue
            digits = encoded[index + 1:index + 3]
            if not re.fullmatch(r"[0-9A-Fa-f]{2}", digits):
                raise ValueError(f"unrecognized LLVM byte escape: {encoded}")
            data.append(int(digits, 16))
            index += 3
        else:
            data.extend(char.encode("ascii"))
            index += 1
    if len(data) != length:
        raise ValueError("string constant length does not match its target array type")
    return bytes(data)


def collect_constants(command: list[str], source: Path, config: Path) -> dict:
    source, config = source.resolve(), config.resolve()
    entries = candidates(command, source, config)
    text, ir, pending = compile_values(command, entries)
    values = global_values(ir, "lvw_value_")
    if set(values) != pending:
        raise ValueError("constant compiler output does not match the candidate set")
    types = {}
    output = run(command, ["-Xclang", "-ast-dump=json", "-Xclang",
                           "-ast-dump-filter=lvw_value_", "-fsyntax-only"], text).stdout
    for node in json_nodes(output):
        if node.get("kind") == "VarDecl":
            name = node["name"].removeprefix("lvw_value_")
            type_name = node["type"].get("desugaredQualType", node["type"]["qualType"])
            type_name = re.sub(r"(?<=at )(.+?)(?=:\d+:\d+\))",
                               lambda match: origin_file(match[1], source, config), type_name)
            types[name] = type_name.removeprefix("const ")
    if set(types) != pending:
        raise ValueError("constant compiler types do not match the candidate set")
    integers = {}
    for name, value in values.items():
        entry = entries[name]
        integer = re.fullmatch(r"i(\d+) (-?\d+|true|false)", value)
        string = re.fullmatch(r"\[(\d+) x i8\] (.*)", value)
        if integer:
            bits = int(integer[1])
            raw = {"true": 1, "false": 0}.get(integer[2])
            raw = int(integer[2]) if raw is None else raw
            if bits < 1 or not -(1 << (bits - 1)) <= raw < 1 << bits:
                raise ValueError(f"invalid target integer constant: {name}")
            integers[name] = raw % (1 << bits)
            entry.update(category="integer", c_type=types[name], bits=bits)
        elif string:
            data = string_bytes(string[2], int(string[1]))
            terminated = data.endswith(b"\0")
            entry.update(category="string", c_type=types[name], bytes_hex=data.hex(),
                         byte_length=len(data), nul_terminated=terminated)
            try:
                entry["text"] = (data[:-1] if terminated else data).decode("utf-8")
            except UnicodeDecodeError:
                pass
        elif value.startswith("i") and re.match(r"i\d+\b", value):
            raise ValueError(f"unrecognized target integer encoding: {name}: {value}")
        else:
            pointer = value.startswith("ptr ")
            entry.update(
                category="unsupported", reason_code="symbol_address" if pointer else "value_type",
                reason=("Address expressions require an instance-specific accessor." if pointer else
                        "Floating-point and aggregate constants are not generated."))
    if integers:
        signed_probe = HEADER + "\n".join(
            f"__attribute__((used)) static const _Bool lvw_signed_{name} = "
            f"((__typeof__({name})) -1) < ((__typeof__({name})) 0);"
            for name in integers)
        signs = global_values(run(command, ["-S", "-emit-llvm", "-o", "-"],
                                  signed_probe).stdout, "lvw_signed_")
        if set(signs) != set(integers) or any(value not in ("i8 0", "i8 1") for value in signs.values()):
            raise ValueError("constant signedness output is incomplete or invalid")
        for name, value in integers.items():
            entry = entries[name]
            signed = signs[name] == "i8 1"
            if signed and value >= 1 << (entry["bits"] - 1):
                value -= 1 << entry["bits"]
            entry.update(signed=signed, value=str(value))
    triple = re.search(r'^target triple = "([^"]+)"$', ir, re.MULTILINE)
    layout = re.search(r'^target datalayout = "([^"]+)"$', ir, re.MULTILINE)
    pointer_bits = re.search(r"^@lvw_target_pointer_bits = internal constant i\d+ (\d+), align \d+$",
                             ir, re.MULTILINE)
    if not triple or not layout or layout[1][0] not in "eE" or not pointer_bits:
        raise ValueError("constant compiler output has no complete target description")
    constants = list(entries.values())
    counts = {category: sum(entry["category"] == category for entry in constants)
              for category in CATEGORIES}
    return {
        "schema_version": 1,
        "target": {"triple": triple[1], "data_layout": layout[1],
                   "pointer_bits": int(pointer_bits[1]),
                   "endianness": "little" if layout[1][0] == "e" else "big"},
        "constants": constants,
        "constant_summary": {"total": len(constants), **counts},
    }
