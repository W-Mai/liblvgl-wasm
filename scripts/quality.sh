#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

./scripts/build.sh
sh "$root/validator/build.sh"
bun run typecheck

for module in \
    target/wasm/liblvgl.wasm \
    target/wasm/examples/c/liblvgl-c-demo.wasm \
    target/validator/feature-validator.wasm \
    target/apps/c/app.wasm \
    target/apps/cpp/app.wasm \
    target/apps/rust/app.wasm
do
    wasm-tools validate "$module"
done

wasm-tools validate --features=wasm1,bulk-memory,reference-types,sign-extension \
    target/validator/feature-validator.wasm

bun run test
python3 -B validator/fixtures.py
bun test validator/feature-validator.test.ts

cargo fmt --manifest-path bindings/rust/Cargo.toml --all -- --check
cargo fmt --manifest-path toolchains/rust/Cargo.toml --all -- --check
cargo fmt --manifest-path validator/Cargo.toml --all -- --check
CARGO_TARGET_DIR="$root/target/validator/build" \
    cargo clippy --manifest-path validator/Cargo.toml --locked --all-targets -- -D warnings
CARGO_TARGET_DIR="$root/target/validator/build" \
    cargo test --manifest-path validator/Cargo.toml --locked
CARGO_TARGET_DIR="$root/target/rust" \
    cargo clippy --manifest-path bindings/rust/Cargo.toml --locked --all-targets -- -D warnings
CARGO_TARGET_DIR="$root/target/rust" \
    cargo test --manifest-path bindings/rust/Cargo.toml --locked
CARGO_TARGET_DIR="$root/target/rust" \
    cargo run --manifest-path bindings/rust/Cargo.toml --locked -- "$root/target/wasm/liblvgl.wasm"
CARGO_TARGET_DIR="$root/target/apps/rust/build" \
    cargo clippy --manifest-path toolchains/rust/Cargo.toml --locked --release \
        --target wasm32-unknown-unknown -- -D warnings
