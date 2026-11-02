"""Compile the numeric-only environment fixtures."""

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "target/validator/numeric-fixtures"


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name in ("core", "b", "a", "app"):
        source = (ROOT / "validator" / f"numeric-{name}.wat").read_text()
        compile_fixture(name, source)
        init = {"core": 10, "b": 20, "a": 30, "app": 40}[name]
        for suffix, code, result in (("fail", init, "i32.const 7"),
                                      ("init-trap", init, "unreachable"),
                                      ("close-fail", init + 1, "i32.const 7"),
                                      ("close-trap", init + 1, "unreachable")):
            before = f"i32.const {code} call $event i32.const 0"
            if source.count(before) != 1:
                raise ValueError("unexpected module lifecycle fixture")
            compile_fixture(name + "-" + suffix, source.replace(before, f"i32.const {code} call $event {result}"))
        before = f'i32.const {init + 2} call $event)'
        if source.count(before) != 1:
            raise ValueError("unexpected reactor initialization fixture")
        compile_fixture(name + "-reactor-trap", source.replace(before, f'i32.const {init + 2} call $event unreachable)'))
        if name == "b":
            before = '  (memory 1 2)'
            if source.count(before) != 1:
                raise ValueError("unexpected library fixture")
            compile_fixture("b-reserved", source.replace(before,
                '  (import "core" "module_init" (func $reserved (result i32)))\n' + before))
        if name == "core":
            compile_fixture("core-export-memory", source.replace("(memory 1 2)", '(memory (export "memory") 1 2)'))
            compile_fixture("core-export-table", source.replace("(memory 1 2)", '(memory 1 2)\n  (table (export "table") 1 2 funcref)'))
            for kind in ("f32", "v128"):
                compile_fixture("core-" + kind, source.replace("(memory 1 2)",
                    f'(memory 1 2)\n  (func (export "other") (param {kind}) (result {kind}) local.get 0)'), kind == "v128")
        if name == "app":
            marker = "  (memory 1 2)"
            variants = {
                "wasi": '  (import "wasi_snapshot_preview1" "fd_write" (func $wasi (param i32 i32 i32 i32) (result i32)))',
                "memory-import": '  (import "core" "memory" (memory 1 2))',
                "table-import": '  (import "core" "table" (table 1 2 funcref))',
                "f32": '  (import "core" "other" (func $other (param f32) (result f32)))',
                "v128": '  (import "core" "other" (func $other (param v128) (result v128)))',
            }
            for variant, declaration in variants.items():
                replacement = declaration if variant == "memory-import" else declaration + "\n" + marker
                compile_fixture("app-" + variant, source.replace(marker, replacement), variant == "v128")
            compile_fixture("app-start", source.replace(marker, marker + '\n  (func (export "_start"))'))
            compile_fixture("app-unbounded", source.replace(marker, "  (memory 1)"))
            initialization = '  (func (export "module_init") (result i32) i32.const 40 call $event i32.const 0)'
            if source.count(initialization) != 1:
                raise ValueError("unexpected app lifecycle entry")
            imported = source.replace(marker, '  (import "core" "module_init" (func $init (result i32)))\n' + marker)
            compile_fixture("app-import-init", imported.replace(initialization, '  (export "module_init" (func $init))'))


def compile_fixture(name, source, simd=False):
    destination = OUTPUT / f"{name}.wasm"
    subprocess.run(["wasm-tools", "parse", "-o", str(destination), "-"], input=source, text=True, check=True)
    features = "wasm1,simd" if simd else "wasm1"
    subprocess.run(["wasm-tools", "validate", "--features=" + features, str(destination)], check=True)


if __name__ == "__main__":
    main()
