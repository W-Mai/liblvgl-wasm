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

Use the reported version, layout, effective configuration, and declaration probes. Inspection accepts the root and `include/lvgl` public header layouts and never downloads or builds. `build_verification` and `runtime_verification` remain `not-run`; successful inspection does not establish compatibility. Base display/input/event/resource/shutdown consumers and managed callbacks are checked with 9.0.0, 9.1.0, 9.2.2, 9.3.0, 9.4.0, 9.5.0, and 9.6.0. PNG, GIF, TinyTTF, FreeType bitmap fonts, and vector drawing are checked with 9.0.0, 9.1.0, and 9.6.0; other software adaptations remain verified against 9.6.0. LVGL 9.0.0 and 9.1.0 FreeType have no font-info constructor or kerning and no software outline-font renderer; use its bitmap API, the configured LVGL filesystem port, and its non-null font deletion precondition. Check requested capabilities before choosing a configuration. Do not replace the selected source with 9.6.0, bypass adaptation hashes, silently disable requested features, or treat every v9 release as the same ABI.

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

Run `bun run check:software` for the PNG source/configuration matrix, or add `--offline` when its source archive is cached. The 9.0.0 and 9.1.0 PNG adapters validate headers and aligned stride before decoding and release draw buffers after failed cache insertion. Failed header inspection preserves the old image source. Version 9.0.0 releases its copied decoder path; 9.1.0 borrows the caller's path through close and copies cache keys independently. Both invalidate decoded and header entries through lv_image_cache_drop. Use `--component png --version v9.1.0` for the 9.1.0 uncached, header-only, and decoded-cache configurations. Keep borrowed image descriptors and bytes alive until all image and decoder references end, then drop their cache entries before reuse or release. Use the selected SDK's actual APIs; 9.0.0 has no `lv_image_get_src_width` or `lv_image_get_src_height`.

The software matrix also checks GIF on 9.0.0, 9.1.0, and 9.6.0, including both 9.0/9.1 LZW configurations and PNG/GIF enabled together. Add `--version v9.1.0` for its scoped report. Version 9.1.0 retains native header-cache invalidation; 9.0.0 requires the shared cache adaptation. Use `--component png`, `--component gif`, or `--component png-gif` for a scoped report; it does not replace full-matrix evidence. Versions 9.0.0 and 9.1.0 provide create/set-src/pause/resume/restart only; do not invent loaded-state, frame-count, size-query, or loop-count functions. Their decoder reads repeat counts from NETSCAPE data, emits READY only after finite playback's final delay, and keeps the old canvas until restart's next deadline. Keep variable GIF bytes alive; the old decoder does not enforce descriptor data_size and requires complete valid input. Source replacement, clear, and READY callback cleanup use the native adaptation, including when managed callbacks are disabled.

TinyTTF checks run with `--component tinyttf` on 9.0.0, 9.1.0, and 9.6.0, with packed and 8-byte-aligned output. Add `--version v9.1.0` for its scoped report. On 9.0.0 and 9.1.0, create_data_ex has 4 arguments, cache_size is ignored, and all fonts share 128 bitmap-cache entries. The 9.0.0 descriptor has a 4-bit bpp field; 9.1.0 uses a 1-byte format field. Both require the Unicode argument for get_glyph_bitmap and lack glyph_release_draw_data. Native C releases through resolved_font->release_glyph; host code releases TinyTTF's entry through its native cache and clears descriptor.entry. Release acquisitions before resize/destroy, remove label/style/fallback references, then destroy fonts and free their borrowed bytes. Adapters validate source hashes, invalidate only the affected font, and release the resolved fallback. File streaming is rejected on this legacy adapter; valid complete memory data is required because data_size is ignored. Do not manually call raw TinyTTF init/deinit within the runtime lifecycle.

FreeType bitmap checks use `--component freetype` with 9.0.0, 9.1.0, and 9.6.0; add `--version v9.1.0` for its scoped report. The 9.1.0 cases use 4 draw-data cache entries and exercise eviction while other glyphs remain borrowed. Enable `LV_FREETYPE_USE_LVGL_PORT` and preserve the pinned FreeType dependency and standard Wasm EH/setjmp requirements. Versions 9.0.0 and 9.1.0 use the path/mode/size/style constructor, copied paths, per-size cache keys, and manual resolved-font glyph release; they lack font-info constructors, kerning, and a software outline renderer. Use the generated descriptor layout: 9.0.0 has bpp, 9.1.0 has a 1-byte format. The runtime owns initialization; 9.1.0 takes one glyph-cache count instead of the 9.0.0 FTC limits. Release acquisitions, remove label/style/fallback references, then delete fonts.

Use `--component vector` to check the selected 9.0.0, 9.1.0, and 9.6.0 vector backends. Add `--version v9.0.0`, `--version v9.1.0`, or `--version v9.6.0` for a version-scoped report. Enable vector drawing, matrices, floating-point values, and the internal ThorVG renderer together. The 9.0.0 and 9.1.0 APIs use `lv_vector_dsc_*`, inclusive `lv_area_t` rectangles, and `lv_grad_dsc_t` gradients; preserve those signatures and generated layouts. Their ThorVG 0.11.99 renderer supports XRGB8888/ARGB8888, uses caller-initialized targets, and reads native SVG file inputs through `W:`. Version 9.0.0 lacks point/path transform helpers; 9.1.0 has them and applies a fixed-source rotation correction. Both lack the precise-point helper, LVGL SVG image/DOM APIs, ThorVG Lottie widget, and software FreeType outline renderer. Do not substitute absent APIs. All verified versions preserve object clipping, layer offsets, and straight-alpha layer composition through fixed-source adaptations. Retain the installed source-matched notice tree; the legacy package includes the complete pinned ThorVG sources with embedded attribution.

NDK installation collects notices and embedded attribution from the selected LVGL source. The installed runtime notice manifest uses schema 2 and separates selected-source hashes, fixed runtime origins, font supplements, and enabled dependency inventories. Montserrat/FontAwesome5 supplements require exact SHA-256 checks of font inputs or, when those are absent, the recorded generated font C sources. Modified inputs need local notices. Unknown ThorVG source identities require matching supplemental materials before export. Preserve the installed license tree when moving the NDK or host SDK. A complete file inventory does not prove license completeness for arbitrary source modifications or custom fonts.
