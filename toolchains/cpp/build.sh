#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
sdk=${WASI_SDK_PATH:-"$root/.local/wasi-sdk-34.0-arm64-macos"}
source_file=${1:-"$root/toolchains/cpp/app.cpp"}
output_file=${2:-"$root/target/apps/cpp/app.wasm"}
mkdir -p "$(dirname -- "$output_file")"
"$sdk/bin/clang++" --target=wasm32-wasip1 -std=c++17 -O2 -nostdlib \
    -fno-exceptions -fno-rtti -I"$root/toolchains/include" \
    -Wl,--no-entry -Wl,--export-memory -Wl,--max-memory=67108864 \
    "$source_file" -o "$output_file"
