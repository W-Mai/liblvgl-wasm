"""Check the installed NDK's relocation and C/C++/Zig ABI contracts."""

import json
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(*command):
    subprocess.run([str(item) for item in command], check=True, stdout=sys.stderr)


def verify_runtime_notices(data):
    runtime = data / "licenses/runtime"
    manifest_path = runtime / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["schema_version"] == 1
    expected = manifest["files"]
    actual = {}
    for path in runtime.rglob("*"):
        if path.is_file() and path.name != "manifest.json":
            relative = path.relative_to(runtime).as_posix()
            actual[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    assert actual == expected
    for required in (
        "README.md",
        "wasi-libc/LICENSE-APACHE-LLVM",
        "wasi-libc/musl-COPYRIGHT",
        "llvm/source-notices.json",
        "lvgl/COPYRIGHTS.md",
    ):
        assert required in actual and actual[required]


def layout_checks(api):
    lines = ['#include <stddef.h>', '#include "lvgl/lvgl.h"', '#include "lvw.h"',
             '#ifdef __cplusplus', '#define CHECK static_assert', '#define ALIGN alignof',
             '#else', '#define CHECK _Static_assert', '#define ALIGN _Alignof', '#endif']
    count = 0
    for node in api["types"].values():
        if (node["kind"] != "alias" or not node.get("origin_file", "").startswith("lvgl/")
                or node["layout"]["status"] != "complete"):
            continue
        name, layout = node["name"], node["layout"]
        lines += [f'CHECK(sizeof({name}) == {layout["size"]}, "{name} size");',
                  f'CHECK(ALIGN({name}) == {layout["alignment"]}, "{name} alignment");']
        count += 1
        record = node
        while record["kind"] == "alias":
            record = api["types"][record["underlying"]["id"]]
        if record["kind"] == "record":
            for field in record["fields"]:
                if field["name"] and field["bit_width"] is None:
                    lines.append(f'CHECK(offsetof({name}, {field["name"]}) * 8 == '
                                 f'{field["bit_offset"]}, "{name}.{field["name"]} offset");')
    return "\n".join(lines) + "\n", count


def zig_checks(api):
    # Check native value types; bitfields and types containing them are not Zig values.
    names = {"lv_color_t", "lv_color32_t", "lv_point_t", "lv_point_precise_t",
             "lv_area_t", "lv_matrix_t", "lv_grad_stop_t"}
    lines = ["const checked_layouts = blk: {", "    @setEvalBranchQuota(10000);",
             "    var count: u32 = 0;"]
    for node in api["types"].values():
        if node["kind"] != "alias" or node["name"] not in names:
            continue
        name, layout = node["name"], node["layout"]
        assert layout["status"] == "complete"
        names.remove(name)
        lines += [f'    if (@typeInfo(lv.{name}) != .@"opaque") {{',
                  f'        if (@sizeOf(lv.{name}) != {layout["size"]} or '
                  f'@alignOf(lv.{name}) != {layout["alignment"]}) @compileError("{name} layout");']
        record = node
        while record["kind"] == "alias":
            record = api["types"][record["underlying"]["id"]]
        if record["kind"] == "record":
            for field in record["fields"]:
                if field["name"] and field["bit_width"] is None:
                    lines.append(f'        if (@typeInfo(lv.{name}) == .@"struct") {{ '
                                 f'if (@offsetOf(lv.{name}, "{field["name"]}") * 8 != '
                                 f'{field["bit_offset"]}) @compileError("{name}.{field["name"]} offset"); }}')
        lines += ["        count += 1;", "    }"]
    assert not names, names
    for name in ("LV_EVENT_CLICKED", "LV_PART_MAIN", "LV_PALETTE_BLUE", "LV_COLOR_FORMAT_ARGB8888"):
        constant = next(item for item in api["constants"] if item["name"] == name)
        lines.append(f'    if (lv.{name} != {constant["value"]}) @compileError("{name} value");')
    lines += ["    break :blk count;", "};", '''
export fn zig_abi_layouts() u32 { return checked_layouts; }
extern fn ndk_eh_test() c_int;
export fn zig_abi_eh() c_int { return ndk_eh_test(); }
export fn zig_abi_wide(value: i64) i64 { return lv.lv_pow(value, 1); }
export fn zig_abi_color(value: u32) u32 { return lv.lv_color_to_int(lv.lv_color_hex(value)); }
export fn zig_abi_float(value: f32) f32 {
    var matrix: lv.lv_matrix_t = undefined;
    lv.lv_matrix_identity(&matrix);
    lv.lv_matrix_translate(&matrix, value, 0.25);
    return matrix.m[0][2];
}
''']
    return "\n".join(lines)


def check(output):
    sdk = subprocess.check_output(["sh", str(ROOT / "scripts/resolve-wasi-sdk.sh"), str(ROOT)],
                                  text=True).strip()
    run("cmake", "--build", ROOT / "target/wasm", "--target", "lvw_ndk", "-j", "4")
    with tempfile.TemporaryDirectory(prefix="lvw ndk contract ") as temporary:
        base = Path(temporary).resolve()
        package = base / "original package"
        run("cmake", "--install", ROOT / "target/wasm", "--prefix", package, "--component", "ndk")
        for path in package.rglob("*.cmake"):
            text = path.read_text()
            assert str(ROOT) not in text and sdk not in text, path
        data = package / "share/liblvgl-wasm"
        verify_runtime_notices(data)
        api = json.loads((data / "metadata/api.json").read_text())
        header, layouts = layout_checks(api)
        project = base / "original project"
        project.mkdir()
        (project / "layout.h").write_text(header)
        example = (package / "examples/c/direct_api.c").read_text()
        (project / "main.c").write_text('#include "layout.h"\n' + example)
        (project / "main.cpp").write_text('#include "layout.h"\n' + example)
        (project / "eh.cpp").write_text('''#include "lvw.h"
#include <setjmp.h>
#include <string>
static jmp_buf jump;
extern "C" __attribute__((export_name("ndk_eh_test"))) int ndk_eh_test() {
    if (setjmp(jump) == 0) longjmp(jump, 7);
    try { throw std::string("standard EH"); }
    catch (const std::string &value) { return value == "standard EH" && lvw_abi_version() == 1 ? 42 : -1; }
}
''')
        (project / "main.zig").write_text((package / "examples/zig/direct_api.zig").read_text()
                                         + "\n" + zig_checks(api))
        (project / "CMakeLists.txt").write_text('''cmake_minimum_required(VERSION 3.25)
project(ndk_contract LANGUAGES C CXX)
find_package(liblvgl-wasm CONFIG REQUIRED)
lvw_add_reactor(consumer_c main.c)
lvw_add_reactor(consumer_cpp main.cpp)
lvw_add_zig_reactor(consumer_zig main.zig)
target_sources(consumer_cpp PRIVATE eh.cpp)
target_sources(consumer_zig PRIVATE eh.cpp)
target_link_options(consumer_zig PRIVATE -Wl,--export=lvw_demo_create
    -Wl,--export=zig_abi_layouts -Wl,--export=zig_abi_wide
    -Wl,--export=zig_abi_color -Wl,--export=zig_abi_float -Wl,--export=zig_abi_eh)
target_compile_options(consumer_c PRIVATE -Wall -Wextra -Werror)
target_compile_options(consumer_cpp PRIVATE -Wall -Wextra -Werror)
''')
        zig = os.environ.get("LVW_ZIG") or shutil.which("zig")
        if not zig:
            candidates = list((ROOT / "target/toolchains/tools").glob("zig-0.15.2-*/zig"))
            if len(candidates) != 1:
                raise ValueError("run toolchains/lvw.py prepare --with-zig, or set LVW_ZIG")
            zig = str(candidates[0])
        run(zig, "fmt", "--check", package / "examples/zig/direct_api.zig")

        def build():
            run("cmake", "-S", project, "-B", project / "target", "-G", "Ninja",
                f"-DCMAKE_TOOLCHAIN_FILE={sdk}/share/cmake/wasi-sdk-p1.cmake",
                f"-Dliblvgl-wasm_DIR={package}/lib/cmake/liblvgl-wasm", "-DCMAKE_BUILD_TYPE=Release",
                f"-DLVW_ZIG={zig}")
            run("cmake", "--build", project / "target", "-j", "2")

        build()
        shutil.rmtree(project / "target")
        package = package.rename(base / "moved package")
        project = project.rename(base / "moved project")
        for path in [*package.rglob("*"), package]:
            path.chmod(0o555 if path.is_dir() else 0o444)
        try:
            build()
            data = package / "share/liblvgl-wasm"
            for language in ("c", "cpp", "zig"):
                core = output / f"{language}.wasm"
                shutil.copyfile(project / f"target/consumer_{language}.wasm", core)
                run("wasm-tools", "validate", core)
                proof = output / f"{language}-verification.json"
                run(sys.executable, "-B", data / "generator/signatures.py", "--api",
                    data / "metadata/api.json", "--wasm", core, "--output", proof)
                generated = output / language / "target/typescript"
                generated.mkdir(parents=True)
                for generator, file in (("values", "values.ts"), ("typescript", "raw.ts"),
                                        ("rust", "raw.rs")):
                    run(sys.executable, "-B", data / f"generator/{generator}.py", "--api",
                        data / "metadata/api.json", "--wasm", core, "--verification", proof,
                        "--output", generated / file)
                # Host SDK packaging is separate; exercise the existing host with this core's bindings.
                shutil.copytree(ROOT / "bindings/typescript/src", output / language / "bindings/typescript/src")
                os.symlink(ROOT / "node_modules", output / language / "node_modules", target_is_directory=True)
            (output / "report.json").write_text(json.dumps({"layouts": layouts, "relocated": True,
                                                           "readonly_package": True}) + "\n")
        finally:
            for path in [package, *package.rglob("*")]:
                path.chmod(0o755 if path.is_dir() else 0o644)


if __name__ == "__main__":
    check(Path(sys.argv[1]).resolve())
