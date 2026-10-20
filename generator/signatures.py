"""Generate target Wasm signatures and verify a linked core against them."""

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

from wasm import read_module


SCALARS = {"i32", "i64", "f32", "f64"}


def supported_exports(declarations):
    exports = {}
    for entry in declarations:
        category = entry["category"]
        if category in ("compile_disabled", "unsupported"):
            continue
        if category not in ("direct_export", "abi_shim"):
            raise ValueError(f"unknown API category: {category}")
        name = entry["export_name"]
        if not name or name in exports:
            raise ValueError(f"missing or duplicate supported export: {name}")
        exports[name] = entry
    return exports


def collect_signatures(command, declarations, prototypes, output_dir: Path):
    expected = supported_exports(declarations)
    source = output_dir / "api-signatures.c"
    object_file = output_dir / "api-signatures.o"
    source.write_text(
        '#include "lvgl/lvgl.h"\n'
        '#pragma clang diagnostic ignored "-Wdeprecated-declarations"\n'
        + "\n".join(f"{prototype};" for prototype in prototypes) + "\n"
        + "\n".join(
            f"__attribute__((used)) __typeof__(&{name}) lvw_probe_{name} = &{name};"
            for name in expected
        ) + "\n"
    )
    return probe_signatures(command, source, object_file, expected)


def probe_signatures(command, source, object_file, expected):
    object_file.unlink(missing_ok=True)
    subprocess.run(command + ["-Wall", "-Wextra", "-Werror", "-c", str(source),
                              "-o", str(object_file)], check=True)
    module = read_module(object_file.read_bytes())
    actual = {}
    for item in module["imports"]:
        if item["kind"] != "function":
            continue
        name = item["name"]
        if item["module"] != "env" or name in actual:
            raise ValueError(f"unexpected function import in ABI probe: {item['module']}.{name}")
        actual[name] = item["signature"]
    if actual.keys() != expected.keys():
        raise ValueError("ABI probe function inventory differs: "
                         f"missing={sorted(expected.keys() - actual.keys())}, "
                         f"extra={sorted(actual.keys() - expected.keys())}")
    return actual


def collect_callback_signatures(command, types, callbacks, output_dir: Path):
    expected = {}
    declarations = []
    for identity in callbacks:
        name = types[identity]["name"]
        probe = f"lvw_callback_probe_{name}"
        if probe in expected:
            raise ValueError(f"duplicate callback probe: {probe}")
        expected[probe] = identity
        declarations.extend([
            f"#ifdef {name}",
            f'#error "callback typedef is shadowed by a macro: {name}"',
            "#endif",
            f"extern __typeof__(*({name})0) {probe};",
            f"__attribute__((used)) __typeof__(&{probe}) "
            f"lvw_callback_address_{name} = &{probe};",
        ])
    source = output_dir / "callback-signatures.c"
    object_file = output_dir / "callback-signatures.o"
    source.write_text(
        '#include "lvgl/lvgl.h"\n'
        '#pragma clang diagnostic ignored "-Wdeprecated-declarations"\n'
        + "\n".join(declarations) + "\n"
    )
    signatures = probe_signatures(command, source, object_file, expected)
    result = {}
    functions = {}
    for probe, identity in expected.items():
        reference = callbacks[identity]["function_type"]
        signature = signatures[probe]
        previous = functions.setdefault(reference["id"], signature)
        if previous != signature:
            raise ValueError(f"callback function type has inconsistent Wasm signatures: {identity}")
        result[identity] = {"function_type": reference, "wasm_signature": signature}
    return {
        "callback_types": result,
        "callback_summary": {
            "typedefs": len(result),
            "function_types": len(functions),
            "wasm_signatures": len({json.dumps(signature, sort_keys=True)
                                    for signature in signatures.values()}),
        },
    }


def verify(api_path: Path, wasm_path: Path, output: Path):
    if output.resolve() in (api_path.resolve(), wasm_path.resolve()):
        raise ValueError("verification output must differ from its inputs")
    output.unlink(missing_ok=True)
    api_bytes = api_path.read_bytes()
    wasm_bytes = wasm_path.read_bytes()
    report = json.loads(api_bytes)
    expected = supported_exports(report["declarations"])
    if report["wasm_summary"]["expected_functions"] != len(expected):
        raise ValueError("Wasm signature summary does not match the API inventory")
    actual = read_module(wasm_bytes)["exports"]
    for name, entry in expected.items():
        signature = entry["wasm_signature"]
        if (not isinstance(signature, dict) or set(signature) != {"params", "results"}
                or any(not isinstance(values, list) or
                       any(not isinstance(value, str) or value not in SCALARS for value in values)
                       for values in signature.values())):
            raise ValueError(f"invalid expected Wasm signature for {name}: {signature}")
        export = actual.get(name)
        if not export or export["kind"] != "function" or export["signature"] != signature:
            raise ValueError(f"Wasm signature mismatch for {name}: expected {signature}, actual {export}")
    result = {
        "schema_version": 1,
        "api_sha256": hashlib.sha256(api_bytes).hexdigest(),
        "wasm_sha256": hashlib.sha256(wasm_bytes).hexdigest(),
        "expected_functions": len(expected),
        "verified_functions": len(expected),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=output.parent, prefix=f".{output.name}.",
                                         delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(result, indent=2) + "\n")
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", required=True, type=Path)
    parser.add_argument("--wasm", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = verify(args.api, args.wasm, args.output)
    print(f"Wasm signatures: {result['verified_functions']} supported API exports verified")


if __name__ == "__main__":
    main()
