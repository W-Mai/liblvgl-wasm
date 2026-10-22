---
name: liblvgl-wasm
description: Build portable LVGL WASIp1 reactors, generate bindings matched to an exact core, and consume the relocatable C/C++ NDK or host SDK.
---

# liblvgl-wasm

Use this skill when a task needs an LVGL 9.6.0 WASIp1 reactor, a native C/C++ application, a core-specific TypeScript or Rust host, or a relocatable toolchain package.

## Choose the build route

- **Host SDK**: load `target/wasm/liblvgl.wasm` from TypeScript or Rust and use generated host bindings.
- **`lvw_app` application**: build a browser or Studio application that imports the host bridge and runs beside the selected core.
- **Native reactor**: link the application and LVGL into one Wasm module with the NDK; call the original `lv_*` C API directly.

Do not treat a native reactor as a Studio `lvw_app` upload. They have different ABIs and different core identities.

## Prepare a portable checkout

Run from the checkout or an initialized source project:

```sh
python3 -B toolchains/lvw.py doctor --json
python3 -B toolchains/lvw.py prepare --with-zig --json
bun install --frozen-lockfile
WASI_SDK_PATH=/reported/path ./scripts/build.sh
```

Use the `wasi-sdk.path` and `wasm-tools.executable` values reported by the tool command. Set `--project` for another checkout and `--cache` for a shared `target/toolchains` cache. `--offline` is valid only with verified cached archives and installations. The tool lock selects wasi-sdk 34.0, wasm-tools 1.246.2, and Zig 0.15.2.

For a relocatable source package:

```sh
python3 -B toolchains/lvw.py export-source --output target/source --json
python3 -B target/source/toolchains/lvw.py init \
  --source target/source --output /path/to/writable-project --json
```

The source package is Git-tracked content plus manifests. Build outputs, `.git`, `.local`, dependencies, and untracked files are not source inputs. Keep all generated artifacts under `target/`.

## Build a native reactor

Export a new NDK after the core has been built:

```sh
python3 -B toolchains/lvw.py export-ndk --output target/ndk --json
cmake -S target/ndk/examples/c -B target/apps/native-c -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE=/path/to/wasi-sdk/share/cmake/wasi-sdk-p1.cmake \
  -DCMAKE_PREFIX_PATH="$PWD/target/ndk" -DCMAKE_BUILD_TYPE=Release
cmake --build target/apps/native-c
wasm-tools validate target/apps/native-c/lvgl_native_example.wasm
```

Use `lvw_add_reactor` for C or C++ and `lvw_add_zig_reactor` for Zig. The NDK supplies LVGL headers, configured static archives, bridge and shim archives, generators, CMake targets, standard exception/SJLJ links, and runtime/component notice trees. Keep the installed NDK directory together when moving it.

Every native link creates a new core. Generate bindings against that exact Wasm file before using its raw API:

```sh
python3 -B target/ndk/share/liblvgl-wasm/generator/signatures.py \
  --api target/ndk/share/liblvgl-wasm/metadata/api.json \
  --wasm target/apps/native-c/lvgl_native_example.wasm \
  --output target/apps/native-c/verification.json
python3 -B target/ndk/share/liblvgl-wasm/generator/values.py \
  --api target/ndk/share/liblvgl-wasm/metadata/api.json \
  --wasm target/apps/native-c/lvgl_native_example.wasm \
  --verification target/apps/native-c/verification.json \
  --output target/apps/native-c/values.ts
```

Generate `raw.ts` and `raw.rs` with the same `--api`, `--wasm`, and `--verification` inputs. A signature proof from another core is invalid.

## Export a host SDK

```sh
python3 -B toolchains/lvw.py export-sdk \
  --ndk target/ndk --core target/wasm/liblvgl.wasm \
  --output target/host-sdk --json
```

The output contains `runtime/`, exact metadata and proof, TypeScript ESM and declarations, Rust source with bundled bindings, `sdk.json`, and the NDK notice tree. It is read-only consumable after relocation. Rust consumers require Rust 1.92+; TypeScript consumers use the generated values and raw bindings from the same SDK.

## Export the complete development package

For a release-ready directory containing the source snapshot, NDK, and host SDK:

```sh
python3 -B toolchains/lvw.py export-package --output target/package --json
```

The command requires a clean checkout, refuses an existing output, and writes a root `manifest.json` with semantic compatibility fields and a SHA-256 inventory. Use `--allow-dirty` only for a local development package; the manifest records that state. Archive the resulting directory after checking that the core identity in `manifest.json`, `ndk/ndk.json`, and `host-sdk/sdk.json` is identical.

## Verify before reporting success

Run `wasm-tools validate` for each produced module and compare its proof and values identity with the bindings used by the host. Run `env RUSTUP_TOOLCHAIN=1.92.0 bun run quality` for the repository gate. Do not claim a custom core matches the default SDK because its bridge ABI is compatible; compare the exact core SHA-256, API SHA-256, values identity, and configuration.

The SDK and NDK commands refuse existing outputs and publish only after file hashes, signatures, and package manifests are complete. Do not overwrite a package in place. Do not fetch source, licenses, or dependencies from an unpinned URL during a build.
