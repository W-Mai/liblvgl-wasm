"""Build synthetic LVGL lifecycle modules for loader boundary tests."""

import fcntl
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "validator"
OUTPUT = ROOT / "target/validator/lvgl-lifecycle"


def main() -> None:
    core = (SOURCE / "lvgl-lifecycle.wat").read_text()
    app = (SOURCE / "lvgl-lifecycle-app.wat").read_text()
    common = {"LVW_MODULE": "lvw", "LVW_SIGNATURE": "(param i32 i32 i32)", "REACTOR": "", "ABI_TYPE": "i32",
              "ABI": "i32.const 1", "INIT_EXPORT": '(export "lvw_init")', "EXTRA_EXPORT": "",
              "INIT": "i32.const 0", "CLOSE": "i32.const 0", "TICK": "i32.const 7"}
    variants = {
        "core": {}, "core-bad-abi": {"ABI": "i32.const 2"}, "core-init-fail": {"INIT": "i32.const 7"},
        "core-init-trap": {"INIT": "unreachable"}, "core-reactor-trap": {"REACTOR": "unreachable"},
        "core-close-trap": {"CLOSE": "unreachable"}, "core-close-fail": {"CLOSE": "i32.const 7"},
        "core-run-trap": {"TICK": "unreachable"},
        "core-event-init": {"INIT": "i32.const 1 i32.const 2 i32.const 3 call $event i32.const 0"},
        "core-event-run": {"TICK": "i32.const 1 i32.const 2 i32.const 3 call $event i32.const 7"},
        "core-bad-event": {"LVW_SIGNATURE": "(param i32)"},
        "core-alias-event": {"LVW_MODULE": "not-lvw"},
        "core-missing-init": {"INIT_EXPORT": ""},
        "core-imported-init": {"INIT_EXPORT": "", "EXTRA_EXPORT": '(export "lvw_init" (func $ping))'},
        "core-bad-abi-signature": {"ABI_TYPE": "i64", "ABI": "i64.const 1"},
    }
    inputs = {"base": (SOURCE / "lvgl-lifecycle-base.wat").read_text()}
    inputs["base-close-trap"] = inputs["base"].replace("i32.const 19 call $trace i32.const 0", "i32.const 19 call $trace unreachable")
    for name, changes in variants.items():
        text = core
        for key, value in {**common, **changes}.items():
            text = text.replace(f"@{key}@", value)
        inputs[name] = text
    for name, function, init, extra in (("app", "lv_tick_get", "i32.const 0", ""),
                                        ("app-fail", "lv_tick_get", "i32.const 8", ""),
                                        ("app-reserved", "lvw_init", "i32.const 0", ""),
                                        ("app-steal", "lv_tick_get", "i32.const 0", '(import "lvw" "event" (func (param i32 i32 i32)))')):
        inputs[name] = app.replace("@IMPORT@", function).replace("@APP_INIT@", init).replace("@EXTRA_IMPORT@", extra)
    parent = OUTPUT.parent
    parent.mkdir(parents=True, exist_ok=True)
    names = {f"{name}.wasm" for name in inputs}
    descriptor = os.open(parent / ".lvgl-lifecycle.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            def check_output() -> None:
                if OUTPUT.is_symlink() or OUTPUT.exists() and not OUTPUT.is_dir():
                    raise ValueError("fixture output is not a directory")
                if OUTPUT.exists() and any(entry.name not in names or not entry.is_file() or entry.is_symlink() for entry in OUTPUT.iterdir()):
                    raise ValueError("fixture output contains unknown entries")

            check_output()
            with tempfile.TemporaryDirectory(prefix=".lvgl-lifecycle-", dir=parent) as temporary:
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
