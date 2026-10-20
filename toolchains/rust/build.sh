#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
manifest="$root/toolchains/rust/Cargo.toml"
output="$root/target/apps/rust/app.wasm"
mkdir -p "$(dirname -- "$output")"
CARGO_TARGET_DIR="$root/target/apps/rust/build" \
RUSTFLAGS="-C link-arg=--no-entry -C link-arg=--export-memory -C link-arg=--max-memory=67108864" \
    cargo build --manifest-path "$manifest" --locked --target wasm32-unknown-unknown --release
cp "$root/target/apps/rust/build/wasm32-unknown-unknown/release/lvw_app_rust.wasm" "$output"
