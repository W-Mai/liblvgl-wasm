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
bun ./node_modules/typescript/bin/tsc --project tsconfig.studio-modules.json
python3 -B tests/studio-modules-browser.py

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
bun tests/fixtures/numeric-preflight/generate.ts
python3 -B tests/fixtures/numeric-environment/generate.py
python3 -B validator/wasi-numeric-fixtures.py
python3 -B tests/fixtures/numeric-wasi/generate.py
bun tests/fixtures/numeric-wasi/generate.ts
python3 -B validator/lvgl-core-fixture.py
python3 -B validator/lvgl-lifecycle-fixtures.py
python3 -B tests/fixtures/numeric-lvgl/generate.py
bun tests/fixtures/numeric-lvgl/generate.ts
python3 -B validator/lvgl-label-fixture.py
python3 -B validator/lvgl-label-negative-fixtures.py
python3 -B tests/fixtures/numeric-label/generate-test.py
python3 -B tests/fixtures/numeric-label/generate.py
label_tmp=$(mktemp -d "$root/target/.numeric-label.XXXXXX")
facts_tmp=
trap 'rm -rf "$label_tmp"; if [ -n "$facts_tmp" ]; then rm -rf "$facts_tmp"; fi' EXIT
LVW_TEST_LABEL_GRAPH="$label_tmp/graph.json"
export LVW_TEST_LABEL_GRAPH
bun tests/fixtures/numeric-label/generate.ts --output "$LVW_TEST_LABEL_GRAPH"
python3 -B validator/lvgl-event-fixture.py
python3 -B validator/lvgl-event-negative-fixtures.py
LVW_TEST_EVENT_GRAPH="$label_tmp/event-graph.json"
export LVW_TEST_EVENT_GRAPH
bun tests/fixtures/numeric-label/generate.ts --event --output "$LVW_TEST_EVENT_GRAPH"
cmake --build "$root/target/wasm" --target lvw_ndk -j 4
cmake --install "$root/target/wasm" --prefix "$label_tmp/chain-ndk" --component ndk
python3 -B validator/lvgl-chain-fixture-test.py
python3 -B validator/lvgl-chain-fixture.py --ndk "$label_tmp/chain-ndk" --output "$label_tmp/chain"
LVW_TEST_CHAIN_GRAPH="$label_tmp/chain-graph.json"
export LVW_TEST_CHAIN_GRAPH
bun tests/fixtures/numeric-chain/generate.ts --fixtures "$label_tmp/chain" --output "$LVW_TEST_CHAIN_GRAPH"
python3 -B validator/lvgl-label-lib-fixture.py --ndk "$label_tmp/chain-ndk" --output "$label_tmp/label-lib"
LVW_TEST_LABEL_LIB_GRAPH="$label_tmp/label-lib-graph.json"
export LVW_TEST_LABEL_LIB_GRAPH
bun tests/fixtures/numeric-label-lib/generate.ts --fixtures "$label_tmp/label-lib" --output "$LVW_TEST_LABEL_LIB_GRAPH"
python3 -B validator/lvgl-label-lib-fixture.py --event --ndk "$label_tmp/chain-ndk" --output "$label_tmp/event-lib"
LVW_TEST_EVENT_LIB_GRAPH="$label_tmp/event-lib-graph.json"
export LVW_TEST_EVENT_LIB_GRAPH
bun tests/fixtures/numeric-label-lib/generate.ts --event --fixtures "$label_tmp/event-lib" --output "$LVW_TEST_EVENT_LIB_GRAPH"
LVW_TEST_LABEL_LIB_FAULT="$label_tmp/label-lib-faults/label-lib-fault.wasm"
LVW_TEST_LABEL_LIB_APP_DATA="$label_tmp/label-lib-faults/label-lib-app-data.wasm"
LVW_TEST_LABEL_LIB_CLOSE_FAIL="$label_tmp/label-lib-faults/label-lib-close-fail.wasm"
LVW_TEST_LABEL_LIB_CLOSE_TRAP="$label_tmp/label-lib-faults/label-lib-close-trap.wasm"
LVW_TEST_LABEL_LIB_REACTOR="$label_tmp/label-lib-faults/label-lib-reactor.wasm"
LVW_TEST_LABEL_LIB_REACTOR_TRAP="$label_tmp/label-lib-faults/label-lib-reactor-trap.wasm"
export LVW_TEST_LABEL_LIB_FAULT LVW_TEST_LABEL_LIB_APP_DATA LVW_TEST_LABEL_LIB_CLOSE_FAIL LVW_TEST_LABEL_LIB_CLOSE_TRAP
export LVW_TEST_LABEL_LIB_REACTOR LVW_TEST_LABEL_LIB_REACTOR_TRAP
python3 -B validator/lvgl-label-lib-fault-fixtures-test.py
python3 -B validator/lvgl-label-lib-fault-fixtures.py "$label_tmp/label-lib-faults"
LVW_TEST_EVENT_LIB_FAULTS="$label_tmp/event-lib-faults"
export LVW_TEST_EVENT_LIB_FAULTS
python3 -B validator/lvgl-label-lib-fault-fixtures.py --event "$LVW_TEST_EVENT_LIB_FAULTS"
bun test validator/feature-validator.test.ts
bun test validator/feature-worker.test.ts validator/feature-worker-live.test.ts validator/feature-graph.test.ts validator/numeric-environment.test.ts validator/wasi-numeric-loader.test.ts
bun test validator/lvgl-core-profile.test.ts validator/lvgl-lifecycle.test.ts
bun test validator/lvgl-label-profile.test.ts validator/lvgl-label-negative.test.ts
bun test validator/numeric-label-preflight.test.ts
bun test validator/numeric-label-lib-preflight.test.ts
bun test validator/lvgl-label-lib-runtime.test.ts
bun test validator/lvgl-event-profile.test.ts validator/lvgl-event-negative.test.ts
bun test validator/numeric-event-preflight.test.ts
bun test validator/numeric-event-lib-preflight.test.ts
bun test validator/lvgl-event-lib-runtime.test.ts
bun test validator/lvgl-chain.test.ts
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
python3 -B tests/numeric_sdk_fixture_test.py
python3 -B tests/browser_temp_test.py

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
LVW_TEST_LVGL_CORE="$root/target/wasm/liblvgl-bounded.wasm" \
    LVW_TEST_LVGL_FAIL_APP="$root/target/validator/lvgl-core-app-fail-init.wasm" \
    LVW_TEST_LVGL_API="$root/target/wasm/api.json" \
    LVW_TEST_LVGL_PROOF="$root/target/wasm/api-verification-bounded.json" \
    CARGO_TARGET_DIR="$root/target/rust" \
    cargo test --manifest-path bindings/rust/Cargo.toml --locked --lib \
        real_lvgl_failed_app_rolls_back_same_core -- --ignored
LVW_TEST_LVGL_CORE="$root/target/wasm/liblvgl-bounded.wasm" \
    LVW_TEST_LVGL_API="$root/target/wasm/api.json" \
    LVW_TEST_LVGL_PROOF="$root/target/wasm/api-verification-bounded.json" \
    CARGO_TARGET_DIR="$root/target/rust" \
    cargo test --manifest-path bindings/rust/Cargo.toml --locked --lib \
        numeric_chain_test -- --ignored
LVW_TEST_LVGL_CORE="$root/target/wasm/liblvgl-bounded.wasm" \
    LVW_TEST_LVGL_API="$root/target/wasm/api.json" \
    LVW_TEST_LVGL_PROOF="$root/target/wasm/api-verification-bounded.json" \
    CARGO_TARGET_DIR="$root/target/rust" \
    cargo test --manifest-path bindings/rust/Cargo.toml --locked --lib \
        numeric_label_test -- --ignored
LVW_TEST_LVGL_CORE="$root/target/wasm/liblvgl-bounded.wasm" \
    LVW_TEST_LVGL_API="$root/target/wasm/api.json" \
    LVW_TEST_LVGL_PROOF="$root/target/wasm/api-verification-bounded.json" \
    CARGO_TARGET_DIR="$root/target/rust" \
    cargo test --manifest-path bindings/rust/Cargo.toml --locked --lib \
        numeric_label_lib_test -- --ignored
LVW_TEST_LVGL_CORE="$root/target/wasm/liblvgl-bounded.wasm" \
    LVW_TEST_LVGL_API="$root/target/wasm/api.json" \
    LVW_TEST_LVGL_PROOF="$root/target/wasm/api-verification-bounded.json" \
    CARGO_TARGET_DIR="$root/target/rust" \
    cargo test --manifest-path bindings/rust/Cargo.toml --locked --lib \
        numeric_event_lib_test -- --ignored
LVW_TEST_LVGL_CORE="$root/target/wasm/liblvgl-bounded.wasm" \
    LVW_TEST_LVGL_API="$root/target/wasm/api.json" \
    LVW_TEST_LVGL_PROOF="$root/target/wasm/api-verification-bounded.json" \
    CARGO_TARGET_DIR="$root/target/rust" \
    cargo test --manifest-path bindings/rust/Cargo.toml --locked --lib \
        numeric_event_test -- --ignored --test-threads=2
facts_tmp=$(mktemp -d "$root/target/.wasm-facts.XXXXXX")
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
    case "$module" in
        target/wasm/liblvgl.wasm) features=exceptions,bulk-memory,reference-types,sign-extension,saturating-float-to-int ;;
        *) features=- ;;
    esac
    bun tests/fixtures/feature-graph/real.ts "$module" "$facts_tmp/feature-graph.json" "$features"
    LVW_TEST_FEATURE_GRAPH_REAL="$facts_tmp/feature-graph.json" \
        CARGO_TARGET_DIR="$root/target/rust" \
        cargo test --manifest-path bindings/rust/Cargo.toml --locked --test feature_graph real_feature_graph
    LVW_TEST_FEATURE_GRAPH_REAL="$facts_tmp/feature-graph.json" \
        CARGO_TARGET_DIR="$root/target/rust" \
        cargo test --manifest-path bindings/rust/Cargo.toml --locked --test feature_graph_compile real_compiled_graph
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
rm -rf "$facts_tmp" "$label_tmp"
trap - EXIT
CARGO_TARGET_DIR="$root/target/rust" \
    cargo run --manifest-path bindings/rust/Cargo.toml --locked -- "$root/target/wasm/liblvgl.wasm"
CARGO_TARGET_DIR="$root/target/apps/rust/build" \
    cargo clippy --manifest-path toolchains/rust/Cargo.toml --locked --release \
        --target wasm32-unknown-unknown -- -D warnings
