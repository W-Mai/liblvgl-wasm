"""Generate independent WebAssembly feature-policy fixtures."""

from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "target/validator/fixtures"
CASES = {
    "bulk-memory": ("(module (memory 1) (func i32.const 0 i32.const 0 i32.const 1 memory.copy))", []),
    "reference-types": ("(module (table 1 externref))", []),
    "sign-extension": ("(module (func (result i32) i32.const 1 i32.extend8_s))", []),
    "saturating-float-to-int": ("(module (func (result i32) f32.const 1 i32.trunc_sat_f32_s))", []),
    "exceptions": ("(module (tag (param i32)))", []),
    "simd": ("(module (func (result v128) v128.const i32x4 1 2 3 4))", []),
    "multi-value": ("(module (func (result i32 i32) i32.const 1 i32.const 2))", []),
    "threads": ("(module (memory 1 1 shared))", []),
    "memory64": ("(module (memory i64 1))", []),
    "multi-memory": ("(module (memory 1) (memory 1))", []),
    "tail-call": ("(module (func $f) (func return_call $f))", []),
    "extended-const": ("(module (global i32 (i32.add (i32.const 1) (i32.const 2))))", []),
    "relaxed-simd": ("(module (func (result v128) v128.const i32x4 0 0 0 0 v128.const i32x4 0 0 0 0 v128.const i32x4 0 0 0 0 f32x4.relaxed_madd))", ["simd"]),
    "function-references": ("(module (type $f (func)) (func (param (ref null $f))))", ["reference-types"]),
    "gc": ("(module (type $s (struct (field i32))) (func (result (ref $s)) i32.const 1 struct.new $s))", ["reference-types", "function-references"]),
}


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for feature, (source, dependencies) in CASES.items():
        destination = OUTPUT / f"{feature}.wasm"
        subprocess.run(["wasm-tools", "parse", "-o", str(destination), "-"], input=source, text=True, check=True)
        check(feature, dependencies, destination)
    # wasm-tools no longer parses legacy try/catch syntax; encode an empty try/catch_all body.
    destination = OUTPUT / "legacy-exceptions.wasm"
    destination.write_bytes(bytes.fromhex("0061736d01000000010401600000030201000a080106000640190b0b"))
    check("legacy-exceptions", [], destination)


def check(feature, dependencies, destination):
    def accepts(names):
        return subprocess.run(["wasm-tools", "validate", "--features=" + ",".join(names), str(destination)], capture_output=True).returncode == 0

    baseline = ["wasm1", *dependencies]
    if accepts(baseline) or not accepts([*baseline, feature]):
        raise ValueError(f"feature fixture has unexpected validation outcome: {feature}")


if __name__ == "__main__":
    main()
