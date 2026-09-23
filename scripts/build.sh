#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sdk=$(sh "$root/scripts/resolve-wasi-sdk.sh" "$root")
ninja=${NINJA_BIN:-ninja}

if [ -n "${LVGL_SOURCE_DIR:-}" ]; then
    cmake -S "$root" -B "$root/target/wasm" -G Ninja \
        -DCMAKE_MAKE_PROGRAM="$ninja" \
        -DCMAKE_TOOLCHAIN_FILE="$sdk/share/cmake/wasi-sdk-p1.cmake" \
        -DFETCHCONTENT_SOURCE_DIR_LVGL="$LVGL_SOURCE_DIR" \
        -DCMAKE_BUILD_TYPE=Release
else
    cmake -S "$root" -B "$root/target/wasm" -G Ninja \
        -DCMAKE_MAKE_PROGRAM="$ninja" \
        -DCMAKE_TOOLCHAIN_FILE="$sdk/share/cmake/wasi-sdk-p1.cmake" \
        -DCMAKE_BUILD_TYPE=Release
fi

cmake --build "$root/target/wasm" --target lvgl -j 4
if [ -n "${LVGL_SOURCE_DIR:-}" ]; then
    source_dir=$LVGL_SOURCE_DIR
else
    source_dir=$(sed -n 's/^FETCHCONTENT_SOURCE_DIR_LVGL:PATH=//p' "$root/target/wasm/CMakeCache.txt")
    if [ -z "$source_dir" ]; then
        source_dir="$root/target/wasm/_deps/lvgl-src"
    fi
fi
python3 "$root/generator/api.py" \
    --source "$source_dir" --sdk "$sdk" \
    --archive "$root/target/wasm/_deps/lvgl-build/liblvgl.a" \
    --output "$root/target/wasm/api.json" \
    --exports "$root/target/wasm/api-exports.txt"
cmake -S "$root" -B "$root/target/wasm"
cmake --build "$root/target/wasm" -j 4
cmake --build "$root/target/wasm" --target liblvgl_c_demo -j 4
cd "$root"
bun run build:ts
bun run build:browser
bun run build:studio
bun run build:apps
bun run build:ts-app
