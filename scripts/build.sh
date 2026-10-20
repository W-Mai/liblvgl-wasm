#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
rm -f "$root/target/wasm/api-verification.json"
sdk=$(sh "$root/scripts/resolve-wasi-sdk.sh" "$root")
ninja=${NINJA_BIN:-ninja}

source_dir=${LVGL_SOURCE_DIR:-}
if [ -z "$source_dir" ] && [ -f "$root/target/wasm/CMakeCache.txt" ]; then
    source_dir=$(sed -n 's/^FETCHCONTENT_SOURCE_DIR_LVGL:[^=]*=//p' "$root/target/wasm/CMakeCache.txt")
fi
if [ -n "$source_dir" ]; then
    if [ ! -f "$source_dir/CMakeLists.txt" ] || [ ! -f "$source_dir/include/lvgl/lvgl.h" ]; then
        if [ -n "${LVGL_SOURCE_DIR:-}" ]; then
            printf 'invalid LVGL_SOURCE_DIR: %s\n' "$source_dir" >&2
            exit 1
        fi
        printf 'Ignoring missing cached LVGL source: %s\n' "$source_dir" >&2
        source_dir=
    else
        source_dir=$(CDPATH= cd -- "$source_dir" && pwd)
    fi
fi

cmake -S "$root" -B "$root/target/wasm" -G Ninja \
    -DCMAKE_MAKE_PROGRAM="$ninja" \
    -DCMAKE_TOOLCHAIN_FILE="$sdk/share/cmake/wasi-sdk-p1.cmake" \
    -DFETCHCONTENT_SOURCE_DIR_LVGL:PATH="$source_dir" \
    -DCMAKE_BUILD_TYPE=Release

cmake --build "$root/target/wasm" --target lvgl -j 4
if [ -z "$source_dir" ]; then
    source_dir="$root/target/wasm/_deps/lvgl-src"
fi
python3 -B "$root/generator/api.py" \
    --source "$source_dir" --sdk "$sdk" \
    --config "$root/config" \
    --archive "$root/target/wasm/_deps/lvgl-build/liblvgl.a" \
    --output "$root/target/wasm/api.json" \
    --exports "$root/target/wasm/api-exports.txt" \
    --shims "$root/target/wasm/api-shims.c"
cmake -S "$root" -B "$root/target/wasm"
cmake --build "$root/target/wasm" -j 4
python3 -B "$root/generator/signatures.py" \
    --api "$root/target/wasm/api.json" \
    --wasm "$root/target/wasm/liblvgl.wasm" \
    --output "$root/target/wasm/api-verification.json"
cmake --build "$root/target/wasm" --target liblvgl_c_demo -j 4
cd "$root"
bun run build:ts
bun run build:browser
bun run build:studio
bun run build:apps
bun run build:ts-app
