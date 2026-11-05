"""Build label library fault fixtures in a new target directory."""

import argparse
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise ValueError("fixture substitution must match exactly once")
    return text.replace(old, new)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    output = parser.parse_args().directory
    parent = output.parent.resolve(strict=True)
    if not parent.is_dir() or not parent.is_relative_to((ROOT / "target").resolve()):
        raise ValueError("fixture directory must be inside target")

    middle = (ROOT / "validator/lvgl-label-lib-runtime.wat").read_text()
    app = (ROOT / "validator/lvgl-label-lib-app.wat").read_text()
    app = replace_once(app, "@EXTRA_IMPORT@", "")
    app = replace_once(app, "@EXTRA@", '(data (i32.const 131071) "xx")')
    close = "i32.const 11 call $trace\n    i32.const 0)"
    reactor = '(func (export "_initialize") i32.const 5 call $trace call $screen call $create i32.const 64 call $set'
    entry = '  (func (export "module_init")'
    variants = {
        "label-lib-fault": middle,
        "label-lib-app-data": app,
        "label-lib-close-fail": replace_once(middle, close, "i32.const 11 call $trace\n    i32.const 7)"),
        "label-lib-close-trap": replace_once(middle, close, "i32.const 11 call $trace\n    unreachable)"),
        "label-lib-reactor": replace_once(middle, entry, f'  {reactor})\n{entry}'),
        "label-lib-reactor-trap": replace_once(middle, entry, f'  {reactor} unreachable)\n{entry}'),
    }
    directory = parent / output.name
    directory.mkdir(mode=0o700)
    for name, text in variants.items():
        wat = directory / f"{name}.wat"
        wasm = directory / f"{name}.wasm"
        with wat.open("x") as file:
            file.write(text)
        subprocess.run(["wasm-tools", "parse", str(wat), "-o", str(wasm)], check=True)
        subprocess.run(["wasm-tools", "validate", "--features=wasm1", str(wasm)], check=True)


if __name__ == "__main__":
    main()
