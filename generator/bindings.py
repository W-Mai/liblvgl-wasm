"""Validate binding inputs and describe their verified Wasm argument slots."""

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

from signatures import SCALARS, supported_exports


IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
IDENTITY_KEYS = {"schema_version", "api_sha256", "wasm_sha256",
                 "expected_functions", "verified_functions"}
POINTER_KINDS = {"pointer", "function_pointer", "record"}


def inventory(report, identity):
    exports = supported_exports(report["declarations"])
    names = [entry["name"] for entry in report["declarations"]]
    if (len(names) != len(set(names)) or
            any(not isinstance(name, str) or not name.startswith("lv_") or
                not IDENTIFIER.fullmatch(name) for name in names)):
        raise ValueError("missing, invalid, or duplicate C API name")
    if any(not isinstance(name, str) or not IDENTIFIER.fullmatch(name) for name in exports):
        raise ValueError("invalid Wasm API export name")
    if type(report["schema_version"]) is not int or report["schema_version"] != 1:
        raise ValueError("unsupported API metadata schema")
    if report["target"]["pointer_bits"] != 32:
        raise ValueError("pointer bindings require a wasm32 target")
    counts = [report["wasm_summary"]["expected_functions"],
              identity["expected_functions"], identity["verified_functions"]]
    if any(type(count) is not int or count != len(exports) for count in counts):
        raise ValueError("verification counts differ from the supported API inventory")
    return sorted(exports.values(), key=lambda entry: entry["name"])


def function_signature(entry, report):
    name = entry["name"]
    types = report["types"]
    function = types[report["function_types"][name]["canonical"]["id"]]
    if function["kind"] != "function" or function["variadic"]:
        raise ValueError(f"invalid canonical function type for {name}")

    def kind(reference):
        node = types[reference["id"]]
        if node["kind"] == "pointer" and types[node["pointee"]["id"]]["kind"] == "function":
            return "function_pointer"
        return node["kind"]

    result = kind(function["result"])
    parameters = [kind(reference) for reference in function["parameters"]]
    allowed = {"primitive", "enum"} | POINTER_KINDS
    if result not in allowed | {"void"} or any(kind not in allowed for kind in parameters):
        raise ValueError(f"unsupported canonical type for {name}")
    if entry["category"] == "direct_export" and "record" in [result, *parameters]:
        raise ValueError(f"direct export contains an aggregate value: {name}")
    signature = entry["wasm_signature"]
    if (not isinstance(signature, dict) or set(signature) != {"params", "results"}
            or any(not isinstance(values, list) or
                   any(not isinstance(value, str) or value not in SCALARS for value in values)
                   for values in signature.values())
            or len(signature["results"]) > 1):
        raise ValueError(f"invalid Wasm signature for {name}")
    slots = [("out", "record")] if result == "record" else []
    slots += [(f"arg{index}", kind) for index, kind in enumerate(parameters)]
    if len(slots) != len(signature["params"]):
        raise ValueError(f"canonical and Wasm parameter counts differ for {name}")
    if len(signature["results"]) != (0 if result in {"void", "record"} else 1):
        raise ValueError(f"canonical and Wasm results differ for {name}")
    parameters = [(name, kind, value) for (name, kind), value in zip(slots, signature["params"])]
    returns = signature["results"][0] if signature["results"] else None
    if any(kind in POINTER_KINDS and value != "i32"
           for _, kind, value in parameters + ([("result", result, returns)] if returns else [])):
        raise ValueError(f"pointer or aggregate slot is not i32 for {name}")
    return parameters, result, returns


def comment(text):
    return text.replace("*/", "* /").replace("\n", " ").replace("\r", " ")


def generate(api_path: Path, wasm_path: Path, verification_path: Path, output: Path, render):
    if output.resolve() in {path.resolve() for path in (api_path, wasm_path, verification_path)}:
        raise ValueError("binding output must differ from its inputs")
    output.unlink(missing_ok=True)
    api_bytes, wasm_bytes = api_path.read_bytes(), wasm_path.read_bytes()
    identity = json.loads(verification_path.read_bytes())
    if (not isinstance(identity, dict) or set(identity) != IDENTITY_KEYS or
            type(identity["schema_version"]) is not int or identity["schema_version"] != 1):
        raise ValueError("unsupported API verification schema")
    if (identity["api_sha256"] != hashlib.sha256(api_bytes).hexdigest() or
            identity["wasm_sha256"] != hashlib.sha256(wasm_bytes).hexdigest()):
        raise ValueError("API verification hashes do not match the binding inputs")
    text = render(json.loads(api_bytes), identity)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=output.parent, prefix=f".{output.name}.",
                                         delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return identity["verified_functions"]
