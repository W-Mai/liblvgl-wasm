"""Build owned-export and non-execution label preflight fixtures."""

import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
MARKER = ".lvw-numeric-label-fixtures"
MARKER_CONTENT = "liblvgl-wasm numeric label fixtures\n"
NAMES = {"core-missing-create.wasm", "core-bad-display.wasm", "core-imported-alloc.wasm",
         "app-reactor-trap.wasm", "app-init-trap.wasm"}


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError(f"unexpected fixture marker: {before!r}")
    return source.replace(before, after)


def check_output(output):
    if output.is_symlink():
        raise ValueError("fixture output must not be a symlink")
    if not output.exists():
        return
    if not output.is_dir():
        raise ValueError("fixture output is not a directory")
    entries = {item.name for item in output.iterdir()}
    marker = output / MARKER
    if (entries != NAMES | {MARKER} or marker.is_symlink() or not marker.is_file()
            or marker.stat().st_size != len(MARKER_CONTENT.encode()) or marker.read_text() != MARKER_CONTENT):
        raise ValueError("fixture output is not owned by this generator")
    if any(item.is_symlink() or not item.is_file() for item in output.iterdir()):
        raise ValueError("fixture output has an invalid entry")


def publish_output(output, staged, backup):
    check_output(output)
    if backup.exists() or backup.is_symlink():
        raise ValueError("fixture backup path already exists")
    try:
        if output.exists():
            os.replace(output, backup)
        os.replace(staged, output)
    except BaseException as error:
        if backup.exists():
            try:
                os.replace(backup, output)
            except OSError as restore:
                raise RuntimeError(f"fixture rollback failed; previous output remains at {backup}: {restore}") from error
        raise


def inputs():
    core = (ROOT / "validator/lvgl-label-negative-core.wat").read_text()
    common = {"LVW_IMPORT": "", "EXTRA_IMPORT": "", "MEMORY": '(memory (export "memory") 1 2)',
              "SETTER": "", "ALLOC": "i32.const 128", "FREE": "", "DISPLAY": "i32.const 100", "CREATE": "i32.const 300",
              "DEFAULT_SCREEN": "i32.const 200", "PARENT_CHECK": "", "FRAME": ""}
    for key, value in common.items():
        core = core.replace(f"@{key}@", value)
    fixtures = {
        "core-missing-create": replace_once(core, '(export "lv_label_create")', '(export "hidden_create")'),
        "core-bad-display": replace_once(core, '(export "lvw_display_create") (param i32 i32 i32)',
                                         '(export "lvw_display_create") (param i32)'),
    }
    imported = replace_once(core, '  (import "trace" "event" (func $trace (param i32)))',
                            '  (import "trace" "event" (func $trace (param i32)))\n'
                            '  (import "trace" "fake_alloc" (func $fake_alloc (param i32) (result i32)))')
    fixtures["core-imported-alloc"] = replace_once(imported,
        '(func (export "lvw_alloc") (param i32) (result i32) i32.const 50 call $trace i32.const 128)',
        '(export "lvw_alloc" (func $fake_alloc))')
    app = (ROOT / "validator/lvgl-label-negative-app.wat").read_text().replace("@LABEL_MODULE@", "lvgl")
    app = app.replace("@MEMORY@", '(memory (export "memory") 1 2)').replace("@APP_INIT@", "i32.const 0")
    fixtures["app-reactor-trap"] = replace_once(app, '(func (export "_initialize"))', '(func (export "_initialize") unreachable)')
    fixtures["app-init-trap"] = replace_once(app, 'i32.const 31 call $trace i32.const 0', 'i32.const 31 call $trace unreachable')
    return fixtures


def run(command, *, source=None, lock_fd):
    subprocess.run(command, input=source, text=True, check=True, pass_fds=(lock_fd,))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "target/validator/numeric-label")
    argument = parser.parse_args().output
    target = (ROOT / "target").resolve()
    if argument.is_symlink():
        parser.error("--output must not be a symlink")
    output = argument.resolve()
    if output == target or not output.is_relative_to(target):
        parser.error("--output must be a directory inside the project target directory")
    target.mkdir(parents=True, exist_ok=True)
    lock_dir = target / ".numeric-label-locks"
    if lock_dir.is_symlink():
        raise ValueError("fixture lock directory must not be a symlink")
    lock_dir.mkdir(exist_ok=True)
    lock_path = lock_dir / (hashlib.sha256(os.fsencode(output)).hexdigest() + ".lock")
    descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError(f"fixture output is already being built: {output}") from error
        check_output(output)
        sources = inputs()
        if {name + ".wasm" for name in sources} != NAMES:
            raise ValueError("fixture input inventory differs")
        output.parent.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix=".numeric-label-build-", dir=output.parent))
        staged, backup = work / "published", work / "previous"
        staged.mkdir()
        published = False
        try:
            for name, source in sources.items():
                destination = staged / f"{name}.wasm"
                run(["wasm-tools", "parse", "-o", str(destination), "-"], source=source, lock_fd=descriptor)
                run(["wasm-tools", "validate", "--features=wasm1", str(destination)], lock_fd=descriptor)
            (staged / MARKER).write_text(MARKER_CONTENT)
            publish_output(output, staged, backup)
            published = True
        finally:
            if published or not backup.exists():
                try:
                    shutil.rmtree(work)
                except OSError as error:
                    print(f"could not remove fixture staging {work}: {error}", file=sys.stderr)
        print(f"Built label fixtures in {output}")


if __name__ == "__main__":
    main()
