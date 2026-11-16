"""Build label library fault fixtures in a new target directory."""

import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise ValueError("fixture substitution must match exactly once")
    return text.replace(old, new)


def event_variants(app):
    api = json.loads((ROOT / "target/wasm/api.json").read_bytes())
    clicked = int(next(item["value"] for item in api["constants"] if item["name"] == "LV_EVENT_CLICKED"))
    if not 0 < clicked < 2**31:
        raise ValueError("invalid clicked event code")
    middle = (ROOT / "validator/lvgl-event-negative-app.wat").read_text()
    markers = {"EVENT_MODULE": "lvgl", "EXTRA_IMPORT": '(import "lvcore" "lv_is_initialized" (func $core (result i32)))',
               "DISPATCH_EXPORT": '(func (export "app_event_dispatch") (param i32 i32) local.get 1 local.get 0 call_indirect (type $callback))',
               "INDEX": "i32.const 1", "CODE": f"i32.const {clicked}", "INIT": "i32.const 0"}
    for key, value in markers.items():
        middle = middle.replace(f"@{key}@", value)
    if "@" in middle:
        raise ValueError("unexpanded event fixture")
    middle = middle.replace('"trace" "event"', '"trace" "lifecycle"').replace("i32.const 123", f"i32.const {clicked}")
    middle = replace_once(middle, '(export "app_run")', '(export "middle_update")')
    middle = replace_once(middle, '  (func (export "_initialize"))',
                          '  (func (export "middle_active") (result i32) call $core)\n  (func (export "_initialize"))')
    variants = {"event-lib-fault": middle, "event-lib-app-data": app}
    close = '(func (export "module_close") (result i32) i32.const 39 call $trace i32.const 0)'
    variants["event-lib-close-fail"] = replace_once(middle, close, close.replace("i32.const 0)", "i32.const 7)"))
    variants["event-lib-close-trap"] = replace_once(middle, close, close.replace("i32.const 0)", "unreachable)"))
    for trap in (False, True):
        reactor = replace_once(middle, '(func (export "module_init")', '(func $setup')
        variants["event-lib-reactor" + ("-trap" if trap else "")] = replace_once(reactor, '(func (export "_initialize"))',
            f'(func (export "_initialize") call $setup drop global.get $label i32.const {clicked} i32.const 0 call $send drop {"unreachable" if trap else ""})\n'
            + '(func (export "module_init") (result i32) i32.const 33 call $trace i32.const 0)')
    for index in (2, 3, 4):
        variants[f"event-lib-index-{index}"] = replace_once(middle,
            f'global.get $label i32.const 1 i32.const {clicked} i32.const 80 call $add global.set $descriptor',
            f'global.get $label i32.const {index} i32.const {clicked} i32.const 80 call $add global.set $descriptor')
    foreign = replace_once(middle, '  (global $label', '  (global $foreign (mut i32) (i32.const 0))\n  (global $label')
    foreign = replace_once(foreign, '    i32.const 70 call $trace',
                           '    global.get $foreign if global.get $foreign call $code drop end\n    i32.const 70 call $trace')
    start = foreign.index('  (func (export "middle_update")')
    variants["event-lib-foreign"] = foreign[:start] + f'''  (func (export "middle_update") (param i32) (result i32)
      local.get 0 i32.const -1 i32.eq if global.get $savedEvent return end
      local.get 0 global.set $foreign
      global.get $label i32.const {clicked} i32.const 0 call $send drop global.get $count))'''
    core = (ROOT / "validator/lvgl-event-negative-core.wat").read_text()
    markers = {"EXTRA_IMPORT": "", "ADD": "i32.const 0", "REMOVE": "i32.const 7", "EVENT_POINTER": "i32.const 500",
               "ORIGINAL_TARGET": "global.get $eventTarget", "SEND_TARGET": "local.get 0",
               "DISPATCH": "global.get $registration local.get 0 local.get 1 call $event"}
    for key, value in markers.items():
        core = core.replace(f"@{key}@", value)
    core = core.replace('"trace" "event"', '"trace" "lifecycle"').replace("i32.const 123", f"i32.const {clicked}")
    variants["event-lib-core-remove-fail"] = replace_once(core, '  (func (export "_initialize")',
        '  (func (export "lv_is_initialized") (result i32) i32.const 1)\n  (func (export "_initialize")')
    return variants


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--event", action="store_true")
    arguments = parser.parse_args()
    output = arguments.directory
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
    if arguments.event:
        variants = event_variants(app)
    directory = parent / output.name
    directory.mkdir(mode=0o700)
    for name, text in variants.items():
        wat = directory / f"{name}.wat"
        wasm = directory / f"{name}.wasm"
        with wat.open("x") as file:
            file.write(text)
        subprocess.run(["wasm-tools", "parse", str(wat), "-o", str(wasm)], check=True)
        subprocess.run(["wasm-tools", "validate", "--features=wasm1,reference-types" if arguments.event else "--features=wasm1", str(wasm)], check=True)


if __name__ == "__main__":
    main()
