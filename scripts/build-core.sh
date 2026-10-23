#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build=${LVW_BUILD_DIR:-"$root/target/wasm"}
build=$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$build")
case "$build" in
    "$root"/target/*) ;;
    *) printf 'LVW_BUILD_DIR must be inside %s/target\n' "$root" >&2; exit 1 ;;
esac
mkdir -p "$build"
rm -f "$build/api-verification.json"
sdk=$(sh "$root/scripts/resolve-wasi-sdk.sh" "$root")
ninja=${NINJA_BIN:-ninja}
config=${LVGL_CONFIG_PATH:-"$root/config/lv_conf.h"}
if [ ! -f "$config" ] || [ "$(basename -- "$config")" != lv_conf.h ]; then
    printf 'LVGL_CONFIG_PATH must name an existing lv_conf.h: %s\n' "$config" >&2
    exit 1
fi
config=$(CDPATH= cd -- "$(dirname -- "$config")" && pwd)/lv_conf.h
features=${LVW_BRIDGE_FEATURES-"timer;animation;observer;decoder"}

source_dir=${LVGL_SOURCE_DIR:-}
if [ -z "$source_dir" ] && [ -f "$build/CMakeCache.txt" ]; then
    source_dir=$(sed -n 's/^FETCHCONTENT_SOURCE_DIR_LVGL:[^=]*=//p' "$build/CMakeCache.txt")
fi
if [ -n "$source_dir" ]; then
    if [ ! -f "$source_dir/CMakeLists.txt" ] ||
       { [ ! -f "$source_dir/include/lvgl/lvgl.h" ] && [ ! -f "$source_dir/lvgl.h" ]; }; then
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

inputs=$(printf '%s\n' "$sdk" "$source_dir" "$config" "$features")
set -- cmake -S "$root" -B "$build" -G Ninja \
    -DCMAKE_MAKE_PROGRAM="$ninja" \
    -DCMAKE_TOOLCHAIN_FILE="$sdk/share/cmake/wasi-sdk-p1.cmake" \
    -DFETCHCONTENT_SOURCE_DIR_LVGL:PATH="$source_dir" \
    -DLVW_CONF_PATH:FILEPATH="$config" \
    -DLVW_BRIDGE_FEATURES:STRING="$features" \
    -DCMAKE_BUILD_TYPE=Release
if [ -f "$build/CMakeCache.txt" ]; then
    configured=$(cat "$build/.lvw-inputs" 2>/dev/null || :)
    cached_toolchain=$(sed -n 's/^CMAKE_TOOLCHAIN_FILE:[^=]*=//p' "$build/CMakeCache.txt")
    if [ "$configured" != "$inputs" ] || [ "$cached_toolchain" != "$sdk/share/cmake/wasi-sdk-p1.cmake" ]; then
        printf 'Refreshing CMake configuration for selected source, configuration, and compiler\n'
        set -- "$@" --fresh
    fi
fi
"$@"
printf '%s\n' "$inputs" > "$build/.lvw-inputs"
printf '%s\n' "$sdk" > "$build/.wasi-sdk"

cmake --build "$build" --target lvgl -j 4
if [ -z "$source_dir" ]; then
    source_dir="$build/_deps/lvgl-src"
fi
python3 -B "$root/generator/api.py" \
    --source "$source_dir" --sdk "$sdk" --config "$config" \
    --archive "$(cat "$build/lvgl-archive.txt")" \
    --output "$build/api.json" --exports "$build/api-exports.txt" --shims "$build/api-shims.c"
cmake -S "$root" -B "$build"
cmake --build "$build" --target liblvgl liblvgl_c_demo -j 4
python3 -B "$root/generator/signatures.py" \
    --api "$build/api.json" --wasm "$build/liblvgl.wasm" --output "$build/api-verification.json"
