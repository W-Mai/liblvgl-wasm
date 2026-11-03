"""Build isolated synthetic modules for LVGL label adapter boundary tests."""

import fcntl
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "validator"
OUTPUT = ROOT / "target/validator/lvgl-label-negative"


def main() -> None:
    core = (SOURCE / "lvgl-label-negative-core.wat").read_text()
    app = (SOURCE / "lvgl-label-negative-app.wat").read_text()
    common = {"LVW_IMPORT": "", "EXTRA_IMPORT": "", "MEMORY": '(memory (export "memory") 1 2)',
              "SETTER": "", "ALLOC": "i32.const 128", "FREE": "", "DISPLAY": "i32.const 100", "CREATE": "i32.const 300",
              "DEFAULT_SCREEN": "i32.const 200", "PARENT_CHECK": "", "FRAME": ""}
    frame = "local.get 1 i32.const @POINTER@ i32.store offset=8 local.get 1 i32.const 256 i32.store offset=12 " \
            "local.get 1 i32.const 8 i32.store offset=16 local.get 1 i32.const 8 i32.store offset=20 " \
            "local.get 1 i32.const 32 i32.store offset=24 local.get 1 i32.const 1 i32.store offset=28 " \
            "local.get 1 i32.const 123 i32.store offset=44"
    variants = {
        "core": {}, "core-alloc-zero": {"ALLOC": "i32.const 0"}, "core-alloc-trap": {"ALLOC": "unreachable"},
        "core-alloc-oob": {"ALLOC": "i32.const 65535"}, "core-set-trap": {"SETTER": "unreachable"},
        "core-free-trap": {"FREE": "unreachable"}, "core-no-memory": {"MEMORY": "(memory 1 2)"},
        "core-display-zero": {"DISPLAY": "i32.const 0"}, "core-create-zero": {"CREATE": "i32.const 0"},
        "core-foreign-default": {"DEFAULT_SCREEN": "i32.const 201", "PARENT_CHECK": "local.get 0 i32.const 200 i32.ne if unreachable end"},
        "core-null-frame": {"FRAME": frame.replace("@POINTER@", "0")},
        "core-valid-frame": {"FRAME": frame.replace("@POINTER@", "1024")},
        "core-oob-frame": {"FRAME": frame.replace("@POINTER@", "65535")},
        "core-event": {"LVW_IMPORT": '(import "lvw" "event" (func $event (param i32 i32 i32)))',
                       "SETTER": "i32.const 1 i32.const 2 i32.const 3 call $event"},
        "core-steal": {"EXTRA_IMPORT": '(import "lvgl" "lv_screen_active" (func (result i32)))'},
    }
    inputs: dict[str, str] = {}
    for name, changes in variants.items():
        text = core
        for key, value in {**common, **changes}.items():
            text = text.replace(f"@{key}@", value)
        inputs[name] = text
    app = app.replace("@APP_INIT@", "i32.const 0")
    inputs["app"] = app.replace("@LABEL_MODULE@", "lvgl").replace("@MEMORY@", '(memory (export "memory") 1 2)')
    inputs["app-init-fail"] = inputs["app"].replace("i32.const 31 call $trace i32.const 0", "i32.const 31 call $trace call $screen call $create drop i32.const 7")
    inputs["app-init-save-fail"] = inputs["app"].replace("i32.const 31 call $trace i32.const 0", "i32.const 31 call $trace call $screen call $create call $trace i32.const 7")
    inputs["app-reactor-use"] = inputs["app"].replace('(func (export "_initialize"))', '(func (export "_initialize") call $screen call $create drop)')
    inputs["app-alias"] = app.replace("@LABEL_MODULE@", "not-lvgl").replace("@MEMORY@", '(memory (export "memory") 1 2)')
    inputs["app-no-memory"] = app.replace("@LABEL_MODULE@", "lvgl").replace("@MEMORY@", "(memory 1 2)")
    inputs["app-bad-signature"] = inputs["app"].replace('(func $screen (result i32))', '(func $screen (param i32) (result i32))').replace('call $screen', 'i32.const 0 call $screen')
    parent = OUTPUT.parent
    parent.mkdir(parents=True, exist_ok=True)
    names = {f"{name}.wasm" for name in inputs}
    descriptor = os.open(parent / ".lvgl-label-negative.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            def check_output() -> None:
                if OUTPUT.is_symlink() or OUTPUT.exists() and not OUTPUT.is_dir():
                    raise ValueError("fixture output is not a directory")
                if OUTPUT.exists() and any(entry.name not in names or not entry.is_file() or entry.is_symlink() for entry in OUTPUT.iterdir()):
                    raise ValueError("fixture output contains unknown entries")

            check_output()
            with tempfile.TemporaryDirectory(prefix=".lvgl-label-negative-", dir=parent) as temporary:
                work = Path(temporary)
                published = work / "published"
                published.mkdir()
                for name, text in inputs.items():
                    wat, wasm = work / f"{name}.wat", published / f"{name}.wasm"
                    wat.write_text(text)
                    subprocess.run(["wasm-tools", "parse", str(wat), "-o", str(wasm)], check=True)
                    subprocess.run(["wasm-tools", "validate", "--features", "wasm1", str(wasm)], check=True)
                check_output()
                if OUTPUT.exists():
                    OUTPUT.replace(work / "previous")
                published.replace(OUTPUT)
        except BaseException:
            if OUTPUT.is_dir() and not OUTPUT.is_symlink():
                for name in names:
                    path = OUTPUT / name
                    if path.is_file() or path.is_symlink():
                        path.unlink()
            raise


if __name__ == "__main__":
    main()
