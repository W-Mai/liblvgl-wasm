---
name: liblvgl-wasm
description: Build LVGL v9+ WebAssembly applications, select a Studio upload format, or export a portable native or host SDK for a specific LVGL core.
---

# liblvgl-wasm

## Choose what to build

| Goal | Starting point |
| --- | --- |
| Run an app alongside the selected Studio core | Start with the [language examples](../../toolchains/). Wasm apps use `lvw_app`; JavaScript and bundled TypeScript expose `main(api)`. |
| Supply a framebuffer and handle pointer input in firmware | Export the `lvw_firmware_*` entry points from the [firmware header](../../toolchains/include/lvw_firmware.h). See the [C example](../../toolchains/firmware/app.c). |
| Split an app and its libraries into separate Wasm modules | [Module projects](../../docs/modules.md). Upload `project.json` and the Wasm files it names. Studio resolves declared imports against the available host interfaces. |
| Call the native `lv_*` API from C, C++, Zig, or another language with a C ABI | Link the application with the LVGL headers, configuration, and static libraries from one NDK. |
| Embed the core in a TypeScript or Rust application | Use the core under `host-sdk/runtime/` with the bindings from the same [host SDK](../../docs/hosts.md). |

## Use a development package

A complete package contains `source/`, `ndk/`, and `host-sdk/`. Run this command from its root after unpacking:

```sh
python3 -B source/toolchains/lvw.py verify-package --package . --json
```

Read `liblvgl.manifest.json` for the capabilities of the included core. Use `ndk/` directly for native builds, or `host-sdk/` to embed the core. Keep each directory intact when moving it, including its license files. To edit and rebuild the packaged sources, initialize a writable copy:

```sh
python3 -B source/toolchains/lvw.py init --source source --output ../lvgl-app
```

## Build against a chosen LVGL source

Run these commands from a checkout or initialized source project. `prepare` installs the pinned wasi-sdk and wasm-tools in `target/toolchains/`; add `--with-zig` for Zig, or pass `--sdk` to use an existing wasi-sdk. [Build and package](../../docs/build.md) lists the required build tools.

```sh
python3 -B toolchains/lvw.py prepare
python3 -B toolchains/lvw.py inspect-lvgl --source /path/to/lvgl --config /path/to/lv_conf.h --json
python3 -B toolchains/lvw.py export-ndk --source /path/to/lvgl --config /path/to/lv_conf.h \
  --build-dir target/custom-core --output target/custom-ndk
```

Use the caller's source and configuration. Read the inspection output for the available declarations, then build the requested features. The default managed callback set is `timer;animation;observer;decoder`; pass `--bridge-features ''` when the app needs only the base bridge. Legacy callback adapters require matching source revisions. Choose functions and layouts from the generated API for that build.

## Link a native application

Set `WASI_SDK_PATH` to the SDK path reported by `prepare`. Build the C example shipped with the NDK:

```sh
cmake -S target/custom-ndk/examples/c -B target/apps/native-c -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK_PATH/share/cmake/wasi-sdk-p1.cmake" \
  -DCMAKE_PREFIX_PATH="$PWD/target/custom-ndk" -DCMAKE_BUILD_TYPE=Release
cmake --build target/apps/native-c
```

The result is `target/apps/native-c/lvgl_native_example.wasm`. For another app, enable C and C++ in its CMake project, then use `find_package(liblvgl-wasm CONFIG REQUIRED)` and `lvw_add_reactor`. For Zig, see the NDK's `examples/zig/` and `lvw_add_zig_reactor`. Other C ABI languages can emit an object for the WASIp1 target and link it with `lvw_add_reactor`.

## Export host bindings or a complete package

Relinking native code changes the core identity. Generate host bindings for the Wasm file the host will actually load:

```sh
bun install --frozen-lockfile
python3 -B toolchains/lvw.py export-sdk --ndk target/custom-ndk \
  --core target/apps/native-c/lvgl_native_example.wasm --output target/native-sdk
```

To distribute the default source, NDK, and host SDK together, run `python3 -B toolchains/lvw.py export-package --output target/package` from a clean checkout. Each export takes a new output directory. Add `--with-validator` to include the optional TypeScript Wasm feature validator.

## Check the result

Use the `wasm-tools` executable reported by `prepare` to validate a produced Wasm. Start the app in Studio or load the reactor with its host and call its entry point.

| Change | Check |
| --- | --- |
| Legacy callback adapter | `bun run check:compatibility` |
| A renderer on a particular LVGL release | For example, `bun run check:software --component png --version v9.2.2` |
| Complete development package | `LVW_TEST_PACKAGE=target/package bun test ./tests/package-consumer.test.ts` runs both external host consumers. |
