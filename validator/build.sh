#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output="$root/target/validator/feature-validator.wasm"
rm -f "$output"
export RUSTUP_TOOLCHAIN=1.92.0
version=$("${RUSTC:-rustc}" --version)
case "$version" in
    "rustc 1.92.0 "*) ;;
    *) printf 'Feature validator requires Rust 1.92.0; found %s\n' "$version" >&2; exit 1 ;;
esac
CARGO_TARGET_DIR="$root/target/validator/build" \
RUSTFLAGS="-C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=268435456" \
    cargo build --manifest-path "$root/validator/Cargo.toml" --locked \
        --release --target wasm32-unknown-unknown
mkdir -p "$(dirname -- "$output")"
temporary=$(mktemp "$root/target/validator/.feature-validator.XXXXXX")
trap 'rm -f "$temporary"' 0
cp "$root/target/validator/build/wasm32-unknown-unknown/release/lvw_feature_validator.wasm" "$temporary"
mv "$temporary" "$output"
