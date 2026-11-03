"""Build isolated synthetic modules for LVGL event adapter boundary tests."""

import fcntl
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "validator"
OUTPUT = ROOT / "target/validator/lvgl-event-negative"


def main() -> None:
    core = (SOURCE / "lvgl-event-negative-core.wat").read_text()
    app = (SOURCE / "lvgl-event-negative-app.wat").read_text()
    common = {"EXTRA_IMPORT": "", "ADD": "i32.const 0", "REMOVE": "i32.const 0", "EVENT_POINTER": "i32.const 500",
              "ORIGINAL_TARGET": "global.get $eventTarget", "SEND_TARGET": "local.get 0",
              "DISPATCH": "local.get 0 global.get $target i32.eq if (result i32) global.get $registration else global.get $registration2 end local.get 0 local.get 1 call $event"}
    cores = {
        "core": {}, "core-add-fail": {"ADD": "i32.const -3"}, "core-add-error": {"ADD": "i32.const 7"},
        "core-add-trap": {"ADD": "unreachable"}, "core-remove-fail": {"REMOVE": "i32.const 7"},
        "core-remove-trap": {"REMOVE": "unreachable"}, "core-event-null": {"EVENT_POINTER": "i32.const 0"},
        "core-original-mismatch": {"ORIGINAL_TARGET": "i32.const 301"},
        "core-bad-id": {"DISPATCH": "global.get $registration i32.const 1 i32.add local.get 0 local.get 1 call $event"},
        "core-bad-current": {"DISPATCH": "global.get $registration local.get 0 i32.const 1 i32.add local.get 1 call $event"},
        "core-bad-code": {"DISPATCH": "global.get $registration local.get 0 local.get 1 i32.const 1 i32.add call $event"},
        "core-cross-send": {"SEND_TARGET": "global.get $target2", "DISPATCH": "global.get $registration2 global.get $target2 local.get 1 call $event"},
        "core-steal": {"EXTRA_IMPORT": '(import "lvgl" "lv_event_get_code" (func (param i32) (result i32)))'},
    }
    inputs: dict[str, str] = {}
    for name, changes in cores.items():
        text = core
        for key, value in {**common, **changes}.items():
            text = text.replace(f"@{key}@", value)
        inputs[name] = text
    dispatch = '(func (export "app_event_dispatch") (param i32 i32) local.get 1 local.get 0 call_indirect (type $callback))'
    app_common = {"EVENT_MODULE": "lvgl", "EXTRA_IMPORT": "", "DISPATCH_EXPORT": dispatch,
                  "INDEX": "i32.const 1", "CODE": "i32.const 123", "INIT": "i32.const 0"}
    apps = {
        "app": {}, "app-init-fail": {"INIT": "i32.const 7"}, "app-null-index": {"INDEX": "i32.const 0"},
        "app-wrong-index": {"INDEX": "i32.const 2"}, "app-empty-index": {"INDEX": "i32.const 3"},
        "app-wrong-code": {"CODE": "i32.const 124"}, "app-alias": {"EVENT_MODULE": "not-lvgl"},
        "app-no-dispatch": {"DISPATCH_EXPORT": ""},
        "app-bad-dispatch": {"DISPATCH_EXPORT": '(func (export "app_event_dispatch") (param i32))'},
        "app-imported-dispatch": {"EXTRA_IMPORT": '(import "trace" "dispatch" (func $imported_dispatch (param i32 i32)))',
                                  "DISPATCH_EXPORT": '(export "app_event_dispatch" (func $imported_dispatch))'},
    }
    for name, changes in apps.items():
        text = app
        for key, value in {**app_common, **changes}.items():
            text = text.replace(f"@{key}@", value)
        inputs[name] = text
    inputs["app-close-fail"] = inputs["app"].replace("i32.const 39 call $trace i32.const 0", "i32.const 39 call $trace i32.const 8")
    inputs["app-close-trap"] = inputs["app"].replace("i32.const 39 call $trace i32.const 0", "i32.const 39 call $trace unreachable")
    inputs["app-callback-trap"] = inputs["app"].replace("i32.const 70 call $trace", "i32.const 70 call $trace unreachable")
    inputs["app-multilabel"] = inputs["app"].replace("local.get $eventToken call $event_target global.get $label i32.ne if unreachable end",
                                                     "local.get $eventToken call $event_target drop")
    inputs["app-multilabel"] = inputs["app-multilabel"].replace("if global.get $label i32.const 123 i32.const 0 call $send drop end",
                                                                 "if global.get $secondLabel i32.const 123 i32.const 0 call $send drop end")
    parent = OUTPUT.parent
    parent.mkdir(parents=True, exist_ok=True)
    names = {f"{name}.wasm" for name in inputs}
    descriptor = os.open(parent / ".lvgl-event-negative.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            def check_output() -> None:
                if OUTPUT.is_symlink() or OUTPUT.exists() and not OUTPUT.is_dir():
                    raise ValueError("fixture output is not a directory")
                if OUTPUT.exists() and any(entry.name not in names or not entry.is_file() or entry.is_symlink() for entry in OUTPUT.iterdir()):
                    raise ValueError("fixture output contains unknown entries")

            check_output()
            with tempfile.TemporaryDirectory(prefix=".lvgl-event-negative-", dir=parent) as temporary:
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
