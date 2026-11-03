#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

./scripts/build.sh
./scripts/build-bounded-core.sh
sh "$root/validator/build.sh"
sh "$root/validator/build-data.sh"
sh "$root/validator/build-worker.sh"
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
python3 -B validator/numeric-fixtures.py
python3 -B validator/wasi-numeric-fixtures.py
python3 -B validator/lvgl-core-fixture.py
python3 -B validator/lvgl-lifecycle-fixtures.py
python3 -B validator/lvgl-label-fixture.py
python3 -B validator/lvgl-label-negative-fixtures.py
python3 -B validator/lvgl-event-fixture.py
python3 -B validator/lvgl-event-negative-fixtures.py
bun test validator/feature-validator.test.ts
bun test validator/feature-worker.test.ts validator/feature-worker-live.test.ts validator/feature-graph.test.ts validator/numeric-environment.test.ts validator/wasi-numeric-loader.test.ts
bun test validator/lvgl-core-profile.test.ts validator/lvgl-lifecycle.test.ts
bun test validator/lvgl-label-profile.test.ts validator/lvgl-label-negative.test.ts
bun test validator/lvgl-event-profile.test.ts validator/lvgl-event-negative.test.ts
bun test validator/feature-sdk.test.ts
bun test validator/bounded-core.test.ts
python3 -B validator/bounded-core.test.py
bun test validator/numeric-wasi-service.test.ts
python3 -B validator/build-data.test.py
python3 -B validator/build-helper.test.py
python3 -B validator/build-worker.test.py
python3 -B validator/notices.test.py
python3 -B tests/native-validator-package.py
python3 -B tests/multimodule-build.py

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
facts_tmp=$(mktemp -d "$root/target/.wasm-facts.XXXXXX")
trap 'rm -rf "$facts_tmp"' EXIT
for module in target/wasm/liblvgl.wasm target/apps/c/app.wasm
do
    bun tests/fixtures/wasm-facts/reference.ts "$module" "$facts_tmp/reference.json"
    LVW_TEST_WASM_FACTS_REAL_INPUT="$root/$module" \
        LVW_TEST_WASM_FACTS_REAL_REFERENCE="$facts_tmp/reference.json" \
        CARGO_TARGET_DIR="$root/target/rust" \
        cargo test --manifest-path bindings/rust/Cargo.toml --locked --test wasm_facts real_wasm_fact_comparison
    bun tests/fixtures/module-manifest/real.ts "$module" "$facts_tmp/manifest.json"
    LVW_TEST_MODULE_MANIFEST_REAL="$facts_tmp/manifest.json" \
        CARGO_TARGET_DIR="$root/target/rust" \
        cargo test --manifest-path bindings/rust/Cargo.toml --locked --test module_manifest real_manifest_case
    bun tests/fixtures/wasi-preview1/real.ts "$module" "$facts_tmp/wasi.json"
    LVW_TEST_WASI_REAL_INPUT="$root/$module" \
        LVW_TEST_WASI_REAL_REFERENCE="$facts_tmp/wasi.json" \
        CARGO_TARGET_DIR="$root/target/rust" \
        cargo test --manifest-path bindings/rust/Cargo.toml --locked --test wasi_preview1 real_wasi_preview1
    bun tests/fixtures/isolated-resources/real.ts "$module" "$facts_tmp/isolated.json"
    LVW_TEST_ISOLATED_REAL_INPUT="$root/$module" \
        LVW_TEST_ISOLATED_REAL_REFERENCE="$facts_tmp/isolated.json" \
        CARGO_TARGET_DIR="$root/target/rust" \
        cargo test --manifest-path bindings/rust/Cargo.toml --locked --test isolated_resources real_isolated_resources
done
wasi_sdk=$(sh "$root/scripts/resolve-wasi-sdk.sh" "$root")
"$wasi_sdk/bin/clang" --target=wasm32-wasip1 -std=c11 -O0 -Werror \
    -Wl,--no-entry -Wl,--export-memory tests/fixtures/wasi/preview1-imports.c -o "$facts_tmp/wasi45.wasm"
bun tests/fixtures/wasi-preview1/real.ts "$facts_tmp/wasi45.wasm" "$facts_tmp/wasi.json" sdk45
LVW_TEST_WASI_REAL_INPUT="$facts_tmp/wasi45.wasm" \
    LVW_TEST_WASI_REAL_REFERENCE="$facts_tmp/wasi.json" \
    CARGO_TARGET_DIR="$root/target/rust" \
    cargo test --manifest-path bindings/rust/Cargo.toml --locked --test wasi_preview1 real_wasi_preview1
bun tests/fixtures/isolated-resources/real.ts "$facts_tmp/wasi45.wasm" "$facts_tmp/isolated.json"
LVW_TEST_ISOLATED_REAL_INPUT="$facts_tmp/wasi45.wasm" \
    LVW_TEST_ISOLATED_REAL_REFERENCE="$facts_tmp/isolated.json" \
    CARGO_TARGET_DIR="$root/target/rust" \
    cargo test --manifest-path bindings/rust/Cargo.toml --locked --test isolated_resources real_isolated_resources
rm -rf "$facts_tmp"
trap - EXIT
CARGO_TARGET_DIR="$root/target/rust" \
    cargo run --manifest-path bindings/rust/Cargo.toml --locked -- "$root/target/wasm/liblvgl.wasm"
CARGO_TARGET_DIR="$root/target/apps/rust/build" \
    cargo clippy --manifest-path toolchains/rust/Cargo.toml --locked --release \
        --target wasm32-unknown-unknown -- -D warnings
