"""Build WASI lifecycle and isolation fixtures from the shared consumer."""

from pathlib import Path
import argparse
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / "target/validator/numeric-wasi-fixtures"


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError(f"unexpected fixture marker: {before!r}")
    return source.replace(before, after)


def build(name, source):
    output = OUTPUT / f"{name}.wasm"
    output.unlink(missing_ok=True)
    subprocess.run(["wasm-tools", "parse", "-o", str(output), "-"], input=source, text=True, check=True)
    subprocess.run(["wasm-tools", "validate", "--features=wasm1", str(output)], check=True)


def main():
    global OUTPUT
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUTPUT)
    OUTPUT = parser.parse_args().output
    OUTPUT.mkdir(parents=True, exist_ok=True)
    source = (ROOT / "validator/wasi-numeric-consumer.wat").read_text()
    app = source.replace("@@LIB_IMPORT@@", '(import "lib" "invoke" (func $lib (param i32) (result i32)))')
    app = app.replace("@@RUN_EXPORT@@", '(func (export "app_run") (param $op i32) (result i32) '
                      'local.get $op i32.const 100 i32.ge_s if (result i32) local.get $op i32.const 100 i32.sub '
                      'call $lib else local.get $op call $execute end)')
    app = app.replace("@@LABEL@@", "APP!")
    init = '(func (export "module_init") (result i32) i32.const 0)'
    build("app-init-fail", replace_once(app, init, '(func (export "module_init") (result i32) i32.const 7)'))
    marker = '  (memory (export "memory") 1 2)'
    build("app-data-fail", replace_once(app, marker, marker + '\n  (data (i32.const 65536) "X")'))
    build("app-import-memory", replace_once(app, marker,
          '  (import "lib" "memory" (memory 1 2))\n  (export "memory" (memory 0))'))
    lib = source.replace("@@LIB_IMPORT@@", "").replace("@@RUN_EXPORT@@", '(export "invoke" (func $execute))').replace("@@LABEL@@", "LIB!")
    build("lib-reexport-wasi", replace_once(lib, marker, marker + '\n  (export "close_alias" (func $close))'))
    lib_import = '(import "lib" "invoke" (func $lib (param i32) (result i32)))'
    imported = replace_once(app, lib_import, lib_import + '\n  (import "lib" "close_alias" (func $bad (param i32) (result i32)))')
    imported = replace_once(imported, 'local.get $op i32.const 100 i32.ge_s',
                            'i32.const 1 call $bad drop local.get $op i32.const 100 i32.ge_s')
    build("app-reexport-wasi", imported)


if __name__ == "__main__":
    main()
