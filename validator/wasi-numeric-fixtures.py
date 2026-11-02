"""Compile the multi-consumer WASI Preview 1 fixtures."""

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "target/validator/wasi-numeric-fixtures"

C_SOURCE = r'''
#include <unistd.h>

int module_init(void) { return write(2, "ci", 2) == 2 ? 0 : 1; }
int module_close(void) { return write(2, "ce", 2) == 2 ? 0 : 1; }
int app_run(int value) { return write(1, "C!", 2) == 2 ? value + 1 : -1; }
'''


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    source = (ROOT / "validator/wasi-numeric-consumer.wat").read_text()
    for name in ("lib", "app"):
        imports = '(import "lib" "invoke" (func $lib (param i32) (result i32)))' if name == "app" else ""
        export = ('(func (export "app_run") (param $op i32) (result i32) '
                  'local.get $op i32.const 100 i32.ge_s '
                  'if (result i32) local.get $op i32.const 100 i32.sub call $lib '
                  'else local.get $op call $execute end)') if name == "app" else '(export "invoke" (func $execute))'
        wat = source.replace("@@LIB_IMPORT@@", imports).replace("@@RUN_EXPORT@@", export)
        wat = wat.replace("@@LABEL@@", "APP!" if name == "app" else "LIB!")
        destination = OUTPUT / f"{name}.wasm"
        subprocess.run(["wasm-tools", "parse", "-o", str(destination), "-"], input=wat, text=True, check=True)
        subprocess.run(["wasm-tools", "validate", "--features=wasm1", str(destination)], check=True)
    sdk = Path(subprocess.check_output(["sh", str(ROOT / "scripts/resolve-wasi-sdk.sh"), str(ROOT)], text=True).strip())
    c_source = OUTPUT / "consumer.c"
    c_source.write_text(C_SOURCE)
    binary = OUTPUT / "c-app.wasm"
    subprocess.run([str(sdk / "bin/clang"), "--target=wasm32-wasip1", "-mexec-model=reactor", "-O2",
                    "-Wl,--export=module_init", "-Wl,--export=module_close", "-Wl,--export=app_run",
                    "-Wl,--max-memory=262144", str(c_source), "-o", str(binary)], check=True)
    subprocess.run(["wasm-tools", "validate", str(binary)], check=True)


if __name__ == "__main__":
    main()
