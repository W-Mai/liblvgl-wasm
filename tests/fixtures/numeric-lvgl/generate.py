"""Build real callback-invoking LVGL core profile fixtures."""

import argparse
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
CALLBACKS = {
    "event": (3, False), "timer": (2, False), "timer_release": (1, False),
    "anim_exec": (3, False), "anim_query": (3, True), "anim_notify": (3, False), "anim_release": (1, False),
    "observer": (3, False), "observer_release": (1, False), "decoder_info": (4, True),
    "decoder_open": (3, True), "decoder_area": (5, True), "decoder_close": (3, False), "decoder_release": (1, False),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "target/validator/numeric-lvgl")
    output = parser.parse_args().output
    output.mkdir(parents=True, exist_ok=True)
    template = (ROOT / "validator/lvgl-lifecycle.wat").read_text()
    base = {"LVW_MODULE": "lvw", "LVW_SIGNATURE": "(param i32 i32 i32)", "REACTOR": "", "ABI_TYPE": "i32",
            "ABI": "i32.const 1", "INIT_EXPORT": '(export "lvw_init")', "EXTRA_EXPORT": "",
            "INIT": "i32.const 0", "CLOSE": "i32.const 0", "TICK": "i32.const 7"}
    for name, (arity, result) in CALLBACKS.items():
        source = template
        for key, value in base.items():
            source = source.replace(f"@{key}@", value)
        old = '(import "lvw" "event" (func $event (param i32 i32 i32)))'
        signature = "(param " + " ".join(["i32"] * arity) + ")" + (" (result i32)" if result else "")
        declaration = f'(import "lvw" "{name}" (func $event {signature}))'
        if source.count(old) != 1:
            raise ValueError("unexpected LVGL callback import")
        source = source.replace(old, declaration)
        invoke = " ".join(["i32.const 0"] * arity) + " call $event" + (" drop" if result else "")
        marker = '(func (export "lv_tick_get") (result i32) i32.const 7)'
        if source.count(marker) != 1:
            raise ValueError("unexpected LVGL tick fixture")
        source = source.replace(marker, f'(func (export "lv_tick_get") (result i32) {invoke} i32.const 7)')
        destination = output / f"callback-{name}.wasm"
        destination.unlink(missing_ok=True)
        subprocess.run(["wasm-tools", "parse", "-o", str(destination), "-"], input=source, text=True, check=True)
        subprocess.run(["wasm-tools", "validate", "--features=wasm1", str(destination)], check=True)


if __name__ == "__main__":
    main()
