---
name: liblvgl-wasm
description: Inspect LVGL v9+ sources and configurations, build WASIp1 reactors, generate core-specific bindings, and consume portable native or host SDKs.
---

# liblvgl-wasm

Use this skill for LVGL v9+ source inspection, WASIp1 reactors, native applications, core-specific TypeScript or Rust hosts, and portable toolchain packages.

## Inspect the requested LVGL input

Preserve the user's source version and configuration. For a source checkout, use its actual public headers and `lv_conf.h`:

```sh
python3 -B toolchains/lvw.py inspect-lvgl \
  --source /path/to/lvgl --config /path/to/lv_conf.h --json
```

Use the reported version, layout, effective configuration, and declaration probes. Inspection accepts the root and `include/lvgl` public header layouts and never downloads or builds. `build_verification` and `runtime_verification` remain `not-run`; successful inspection does not establish compatibility. Base display/input/event/resource/shutdown consumers are checked with 9.0.0 and 9.6.0. Managed callback adapters and software source adaptations remain verified against 9.6.0. Check requested capabilities before choosing a configuration. Do not replace the selected source with 9.6.0, bypass adaptation hashes, silently disable requested features, or treat every v9 release as the same ABI.

For an existing NDK or host SDK, inspect its manifests and exact core/API identities instead of rebuilding from a guessed version. A bare LVGL Wasm module may not implement the `lvw` bridge. Languages using a C ABI must consume headers, constants, layouts, and native libraries from the same selected source and configuration.

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

For an existing LVGL source and configuration, keep the output separate from the default website build:

```sh
python3 -B toolchains/lvw.py export-ndk \
  --source /path/to/lvgl --config /path/to/lv_conf.h \
  --build-dir target/custom-core --output target/custom-ndk --json
```

The default managed adapter list is `timer;animation;observer;decoder`. Select `--bridge-features ''` only when a base bridge satisfies the requested capabilities. `config/base/lv_conf.h` is an explicit software-rendering/BMP preset, not a replacement for the user's configuration. Old sources with unavailable requested adapters fail before building. The exporter installs the selected `lv_conf.h` and rejects config dependencies outside the NDK/SDK. Local config helper headers are not packaged automatically.

`--bridge-features 'timer;animation;observer;decoder'` supports the verified v9.0.0 and v9.6.0 sources without external data. The adapters check source SHA-256 and add native binding/release hooks to build-directory copies, preserving `user_data`, native variables, automatic deletion, and host-handler release. Link the exported bridge with the adapted LVGL archive. Use the shared TS/Rust lifecycle checks through `bun run check:compatibility`; a successful base-core check alone does not verify callbacks. LVGL 9.0.0 early animation execution uses the starting value, starts notify once, reverse controls use `playback` names, and per-animation pause is unavailable. Use the generated APIs and the selected source's native behavior. Software adaptations still require their independently verified source revisions.

On 9.0.0, allocate subject storage using the generated size and initialize it with `lv_subject_init_*`; remove observers and widget bindings before freeing that storage. Integer assignment also notifies for unchanged values. Observer user data is a public field with a generated layout. Use `lv_subject_remove_all_obj(subject, object)` for object-bound cleanup; the adapted implementation preserves other subjects' events and clears the selected widget bindings. Do not call raw `lv_observer_remove` on object-bound registrations. Managed individual cancellation rejects these registrations on both versions. Do not substitute newer subject allocation, userdata, or deletion APIs that the selected headers do not declare.

Decoder info on 9.0.0 uses a callback-local host-view descriptor and has no preopened file: `view.file` is zero. Read `view.src` with the generated filesystem API and close that file within the callback. The flush-cache argument is unavailable; native open/area/close sessions and the 64-byte bridge view remain supported. Managed cancellation clears header-cache references, and failed native file opens release the source copy. Raw decoder deletion still requires no active sessions or cached headers. The compatibility matrix verifies whole-image and block decoding, fallback, failure cleanup, nested borrowing, replacement after cached info, and shutdown on both exported host SDKs.

The equivalent core-only command uses `LVGL_SOURCE_DIR`, `LVGL_CONFIG_PATH`, `LVW_BUILD_DIR`, and `LVW_BRIDGE_FEATURES` with `scripts/build-core.sh`. It leaves the default website and host outputs alone. Supply the resulting NDK and exact core to `export-sdk`.

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
