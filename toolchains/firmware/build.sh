#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
sdk=$(sh "$root/scripts/resolve-wasi-sdk.sh" "$root")
source_file=${1:-"$root/toolchains/firmware/app.c"}
output_file=${2:-"$root/target/apps/firmware/app.wasm"}
mkdir -p "$(dirname -- "$output_file")"
"$sdk/bin/clang" --target=wasm32-wasip1 -std=c11 -O2 -nostdlib \
    -I"$root/toolchains/include" -Wl,--no-entry -Wl,--export-memory \
    -Wl,--max-memory=67108864 "$source_file" -o "$output_file"
