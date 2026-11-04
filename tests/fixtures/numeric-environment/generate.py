"""Compile numeric loader fixtures with distinct import bindings and failed instantiation."""

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / "target/validator/numeric-environment-fixtures"


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError(f"expected one fixture marker: {before!r}")
    return source.replace(before, after)


def build(name, source):
    output = OUTPUT / f"{name}.wasm"
    output.unlink(missing_ok=True)
    subprocess.run(["wasm-tools", "parse", "-o", str(output), "-"], input=source, text=True, check=True)
    subprocess.run(["wasm-tools", "validate", "--features=wasm1", str(output)], check=True)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    b = (ROOT / "validator/numeric-b.wat").read_text()
    a = (ROOT / "validator/numeric-a.wat").read_text()
    app = (ROOT / "validator/numeric-app.wat").read_text()
    build("b-distinct", replace_once(b, '(import "core" "calc"', '(import "shared" "calc"'))
    build("a-distinct", replace_once(a, '(import "b" "calc"', '(import "shared" "calc"'))
    declaration = '  (import "a" "calc" (func $a (param i32) (result i32)))'
    duplicate = declaration + '\n  (import "a" "calc" (func $a_duplicate (param i32) (result i32)))'
    app_duplicate = replace_once(app, declaration, duplicate)
    app_duplicate = replace_once(app_duplicate, '    local.get 0 i32.const -1 i32.eq',
                                 '    i32.const 0 call $a_duplicate drop\n    local.get 0 i32.const -1 i32.eq')
    build("app-duplicate", app_duplicate)
    build("app-instantiate-fail", replace_once(app, "  (memory 1 2)",
                                                '  (memory 1 2)\n  (data (i32.const 65536) "X")'))
    build("app-instantiate-table-fail", replace_once(app, "  (memory 1 2)",
        '  (memory 1 2)\n  (table 1 1 funcref)\n  (elem (i32.const 1) $a)'))


if __name__ == "__main__":
    main()
