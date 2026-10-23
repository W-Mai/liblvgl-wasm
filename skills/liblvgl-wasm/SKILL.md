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

Use the reported version, layout, effective configuration, and declaration probes. Inspection accepts the root and `include/lvgl` public header layouts and never downloads or builds. `build_verification` and `runtime_verification` remain `not-run`; successful inspection does not establish compatibility. Base display/input/event/resource/shutdown consumers and managed callbacks are checked with 9.0.0, 9.1.0, 9.2.2, 9.3.0, 9.4.0, 9.5.0, and 9.6.0. PNG is checked with 9.0.0 and 9.6.0; other software adaptations remain verified against 9.6.0. Check requested capabilities before choosing a configuration. Do not replace the selected source with 9.6.0, bypass adaptation hashes, silently disable requested features, or treat every v9 release as the same ABI.

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

`--bridge-features 'timer;animation;observer;decoder'` supports the verified v9.0.0, v9.1.0, v9.2.2, v9.3.0, v9.4.0, v9.5.0, and v9.6.0 sources without external data. The adapters check source SHA-256 and add native binding/release hooks to build-directory copies, preserving `user_data`, native variables, automatic deletion, and host-handler release. Link the exported bridge with the adapted LVGL archive. Use the shared TS/Rust lifecycle checks through `bun run check:compatibility`; a successful base-core check alone does not verify callbacks. LVGL 9.0.0, 9.1.0, and 9.2.2 early animation execution uses the starting value, starts notify once, reverse controls use `playback` names, and per-animation pause is unavailable. LVGL 9.3.0 queries the path during early apply and exposes reverse and pause APIs, but its start notification still runs once. LVGL 9.4.0 and 9.5.0 repeat the start notification for playback segments. Use the generated APIs and the selected source's native behavior. Software adaptations still require their independently verified source revisions.

On 9.0.0, 9.1.0, 9.2.2, 9.3.0, 9.4.0, and 9.5.0, allocate subject storage using the generated size and initialize it with `lv_subject_init_*`; remove observers and widget bindings before freeing that storage. Integer assignment also notifies for unchanged values on 9.0.0, 9.1.0, and 9.2.2; 9.3.0, 9.4.0, and 9.5.0 only notify when the integer changes. LVGL 9.2.2, 9.3.0, 9.4.0, and 9.5.0 provide `lv_subject_deinit`; observer user data has only a getter and its struct is private. On 9.0.0 and 9.1.0 the observer field is public and has a generated layout, but subject deinit is absent. Do not substitute newer allocation, userdata, or deletion APIs that the selected headers do not declare.

For object-bound cleanup, use `lv_subject_remove_all_obj(subject, object)` on 9.0.0 and 9.1.0, or `lv_obj_remove_from_subject(object, subject)` on 9.2.2, 9.3.0, 9.4.0, and 9.5.0. The adaptations clear the selected widget bindings and preserve other subjects' events. LVGL 9.2.2, 9.3.0, 9.4.0, and 9.5.0 subject deinit use the same scoped event cleanup; a null subject in object unbinding removes all subject bindings. The 9.3.0, 9.4.0, and 9.5.0 adapters skip descriptors marked for deferred deletion when unbinding during an event callback. The 9.4.0 and 9.5.0 widget helpers are adapted in separately SHA-256-checked source copies. Their `lv_obj_add_subject_*_event` helpers register raw events without observers; keep their subjects alive until those events or their objects are removed. Managed unbinding and subject deinit do not own those events. Do not call raw `lv_observer_remove` on object-bound registrations. Managed individual cancellation rejects these registrations on all verified versions.

LVGL 9.5.0 callbacks are also checked with `LV_USE_EXT_DATA=1`. Timer and animation destructors use that native slot. Subject external data remains separate from observer registration: the adapted `lv_subject_deinit` releases it after removing all observers, including on an empty subject. Observer or object deletion does not release it. Deinitialize caller-owned subjects before freeing or reinitializing storage; runtime shutdown only removes managed observers. `lv_subject_set_external_data` does not release a replaced payload; manage replacement explicitly.

Decoder info on 9.0.0 and 9.1.0 uses a callback-local host-view descriptor and has no preopened file: `view.file` is zero. Read `view.src` with the generated filesystem API and close that file within the callback. The flush-cache argument is unavailable; native open/area/close sessions and the 64-byte bridge view remain supported. Managed cancellation clears header-cache references. Failed native file opens release the source copy on 9.0.0; 9.1.0 borrows the caller's path through close and never frees it. Raw decoder deletion still requires no active sessions or cached headers. The compatibility matrix verifies whole-image and block decoding, fallback, failure cleanup, nested borrowing, replacement after cached info, and shutdown on both exported host SDKs.

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

Run `bun run check:software` for the PNG source/configuration matrix, or add `--offline` when its source archive is cached. The 9.0.0 PNG adapter validates headers and aligned stride before decoding and cleans file paths, draw buffers, and stale header entries. Its failed header inspection preserves the old image source. Keep borrowed image descriptors and bytes alive until all image and decoder references end, then drop their cache entries before reuse or release. Use the selected SDK's actual APIs; 9.0.0 has no `lv_image_get_src_width` or `lv_image_get_src_height`.

NDK installation collects notices and embedded attribution from the selected LVGL source. The installed runtime notice manifest uses schema 2 and separates selected-source hashes, fixed runtime origins, font supplements, and enabled dependency inventories. Montserrat/FontAwesome5 supplements require exact SHA-256 checks of font inputs or, when those are absent, the recorded generated font C sources. Modified inputs need local notices. Unknown ThorVG source identities require matching supplemental materials before export. Preserve the installed license tree when moving the NDK or host SDK. A complete file inventory does not prove license completeness for arbitrary source modifications or custom fonts.
