#!/bin/sh
set -eu

root=$1
sdk=${WASI_SDK_PATH:-}

if [ -n "$sdk" ] && [ ! -f "$sdk/share/cmake/wasi-sdk-p1.cmake" ]; then
    printf 'invalid WASI_SDK_PATH: %s\n' "$sdk" >&2
    exit 1
fi

if [ -z "$sdk" ] && [ -f "$root/target/wasm/CMakeCache.txt" ]; then
    toolchain=$(sed -n 's/^CMAKE_TOOLCHAIN_FILE:[^=]*=//p' "$root/target/wasm/CMakeCache.txt")
    case "$toolchain" in
        */share/cmake/wasi-sdk-p1.cmake)
            sdk=${toolchain%/share/cmake/wasi-sdk-p1.cmake}
            ;;
    esac
fi

if [ -z "$sdk" ] || [ ! -f "$sdk/share/cmake/wasi-sdk-p1.cmake" ]; then
    compiler=$(command -v clang || :)
    if [ -n "$compiler" ]; then
        candidate=$(CDPATH= cd -- "$(dirname -- "$compiler")/.." && pwd)
        if [ -f "$candidate/share/cmake/wasi-sdk-p1.cmake" ]; then
            sdk=$candidate
        fi
    fi
fi

if [ -z "$sdk" ] || [ ! -x "$sdk/bin/clang" ] || [ ! -f "$sdk/share/cmake/wasi-sdk-p1.cmake" ]; then
    printf 'wasi-sdk not found; set WASI_SDK_PATH or add wasi-sdk/bin to PATH\n' >&2
    exit 1
fi

printf '%s\n' "$sdk"
