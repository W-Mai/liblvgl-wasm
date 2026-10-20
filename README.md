# liblvgl-wasm

`liblvgl.wasm` embeds LVGL 9.6.0 as a WASIp1 reactor. The `lvw_*` bridge accepts input, advances time, provides resources, and returns software-rendered frames. LVGL Studio runs the module and user applications in a browser workspace. Browser/Bun and Rust hosts can also load the same module directly.

## Build

Requires CMake 3.25+, Ninja, Python 3.9+, Bun, Rust 1.92+ with the `wasm32-unknown-unknown` target, and the complete wasi-sdk 34 distribution for macOS or Linux. API generation loads the SDK's bundled libclang and uses Python's standard library; keep the SDK's libraries and sysroot together. Set `WASI_SDK_PATH` to the SDK root or add its `bin` directory to `PATH`. Existing builds can reuse the SDK path recorded in `target/wasm/CMakeCache.txt`. CMake downloads the official LVGL 9.6.0 lite source archive and verifies the SHA-256 pinned in `CMakeLists.txt`; set `LVGL_SOURCE_DIR` to use an existing source tree.

On Ubuntu 24.04, install `libtinfo6`, `libstdc++6`, and `libgcc-s1` for the SDK's shared libraries. Keep the bundled `libclang`, LLVM, and `libedit` libraries and their symlinks intact.

```sh
WASI_SDK_PATH=/path/to/wasi-sdk ./scripts/build.sh
```

The build script can be invoked from another working directory. Relative SDK and source paths resolve from the caller's directory. A valid cached source override is reused; a missing cached source falls back to the pinned archive. An invalid explicit `LVGL_SOURCE_DIR` stops the build with an error.

Generated files stay under `target/`:

| Path | Content |
| --- | --- |
| `target/wasm/liblvgl.wasm` | WASIp1 library module |
| `target/wasm/api.json` | Enabled functions, binding status, constants, and target type layouts |
| `target/wasm/api-verification.json` | API/core hashes and verified function signature counts |
| `target/wasm/api-exports.txt` | Generated linker export flags |
| `target/wasm/api-shims.c` | Generated wrappers for aggregate values and inline functions |
| `target/wasm/examples/c/liblvgl-c-demo.wasm` | C demo linked with LVGL |
| `target/browser/main.js` | Browser example bundle |
| `target/typescript/index.js` | TypeScript host adapter bundle |
| `target/studio/{main,worker}.js` | Studio page and isolated runner bundles |
| `target/apps/ts/app.js` | TypeScript sample application |
| `target/apps/{c,cpp,rust}/app.wasm` | C, C++, and Rust sample applications |
| `target/rust/` | Rust host build cache |

## Quality checks

Install `wasm-tools`, `rustfmt`, and `clippy` in addition to the build prerequisites, then run:

```sh
bun run quality
```

This command rebuilds the core, generated API wrappers, C demo, browser bundles, and application samples before validating all five Wasm modules. It runs the Bun tests, Rust formatting checks, Clippy with warnings denied for both Rust packages, host tests, and the Rust host's rendering/input checks. Every command stops on failure. Rust builds use the checked-in lockfiles. `bun run test` runs only the repository's `tests/` directory and requires existing build outputs.

The GitHub Actions quality workflow runs the same command on Ubuntu 24.04 with Bun 1.3.14, Rust 1.92.0, wasi-sdk 34, and wasm-tools 1.246.2. SDK and Wasm tool downloads are verified against pinned SHA-256 values.

## LVGL Studio

Start a static server from the repository root after building:

```sh
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/studio/`. The page starts with the default core and JavaScript sample. Select a compatible local `liblvgl.wasm` to replace the core, or return to the default build. Drop a built `.js` or `.wasm` application into the application panel. Resource files are copied into the selected core's `W:` drive. Run, stop, restart, and change the preview resolution from the page. The preview frame animates to the selected resolution and fits narrow viewports. The runtime console shows validation errors and application logs. The Light/Dark control remembers the selected theme; the preview preserves each LVGL application's own colors and styles.

Custom cores must implement bridge ABI 1 and the exports used by Studio. An arbitrary LVGL Wasm build without this bridge cannot be loaded. Application uploads are executable artifacts: Studio does not compile C, C++, Rust, or TypeScript source in the browser. Uploaded code runs in a sandboxed iframe worker; stopping the app removes its runner. Files are read by the browser and are not sent to a compilation service.

### Application toolchains

The toolchain panel shows sample source files with syntax highlighting in a side panel and provides build commands. On localhost, an open source panel refreshes when its file changes. Build from the repository root, then upload the output shown below. `scripts/build.sh` builds all included samples; individual commands rebuild one sample.

| Language | Build command | Upload |
| --- | --- | --- |
| JavaScript | No build step; use `toolchains/js/app.js` | `.js` |
| TypeScript | `bun run build:ts-app` | `target/apps/ts/app.js` |
| C | `./toolchains/c/build.sh` | `target/apps/c/app.wasm` |
| C++ | `./toolchains/cpp/build.sh` | `target/apps/cpp/app.wasm` |
| Rust | `./toolchains/rust/build.sh` | `target/apps/rust/app.wasm` |

JavaScript applications define `main(api)` and may use the runtime, display, screen, resources, and log function passed in `api`; see `toolchains/js/app.js`. TypeScript applications bundle to a single JavaScript file with the same entry point; see `toolchains/ts/app.ts`. C, C++, and Rust applications use application ABI 1 through `toolchains/include/lvw_app.h` or equivalent imports. They export `memory`, `app_abi_version()`, `app_init()`, and `app_event(id, code)`. The sample source files show the required imports and event handling. Application Wasm modules use their own memory; Studio copies text and resources through the bridge.

## Other hosts

```sh
bun run test
CARGO_TARGET_DIR=target/rust cargo run --manifest-path bindings/rust/Cargo.toml
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/examples/browser/` after starting the server. The browser example renders a button and a BMP resource; pointer input changes the button label. The Rust example checks rendering, resource pixels, input, callbacks, and shutdown.

Select the C toolchain in Studio and open **C API preview**. The Studio workspace shifts left to show the preview panel. Opening `direct_api.c` shifts the workspace and preview left again, with the source in a second panel on the right. [`examples/c/direct_api.c`](examples/c/direct_api.c) creates the button and handles its click with native `lv_*` calls. `scripts/build.sh` links that C source and LVGL into a separate Wasm module at `target/wasm/examples/c/liblvgl-c-demo.wasm`. This linked module is separate from Studio's uploaded application ABI, which uses `lvw_app` imports.

## Interface

The bridge ABI version is `1`. A Wasm instance owns one LVGL runtime and may create multiple displays. `lvw_step(elapsed_ms)` advances LVGL time and returns the next timer interval and frame count. Frames use XRGB8888 bytes in blue, green, red, unused order. Hosts must read or copy frame data before a call that can change the framebuffer. Each host must call `_initialize` before `lvw_init`.

The generated API report classifies declarations as `direct_export`, `abi_shim`, `compile_disabled`, or `unsupported`. Direct functions keep their `lv_*` export names. Aggregate values and inline functions use generated `lvw_api_lv_*` wrappers: aggregate arguments are pointers into Wasm memory, and aggregate returns use an output pointer. Aggregate classification uses canonical types, including qualified records and typedef chains; wrapper storage preserves the record layout while removing top-level C qualifiers. `target/wasm/api.json` records each export name, wrapper signature, and unsupported reason. Function pointer callbacks and variadic functions remain unsupported by the raw API generator. The TypeScript adapter provides a typed interface for the bridge and the APIs used by its example.

The report also includes `constants` and `constant_summary` for active `LV_*` and `LVGL_*` enums and macros visible through the configured public header. Values are evaluated by the same Wasm target compiler as the core. Integers include the C type, bit width, signedness, and a decimal string value to preserve 64-bit precision. Strings include exact bytes in `bytes_hex`, their length and termination flag, and UTF-8 text when valid. Function macros, empty macros, and unsupported expressions have separate classifications; symbol addresses require an instance-specific accessor and are not exported as numeric constants. Private `_LV_*` names and declarations hidden by disabled configuration are outside this inventory. Function counts in `summary` remain separate from constant counts.

`types` describes the types reachable from public function declarations, including aliases, pointers, arrays, records, enums, and callback signatures. Each reference contains a stable `id` and its C qualifiers. Complete object layouts record byte sizes and alignments; record fields record bit offsets and optional bit widths. Opaque records, incomplete arrays, functions, and `void` have explicit layout statuses and null sizes. Hosts must use the target layouts when allocating aggregate values; `lv_color_t`, for example, occupies three bytes. Bitfields require masks or accessors, and opaque records expose no fields. `function_types` records both declared C signatures and canonical signatures with adjusted array and function parameters. These are C type descriptions, not Wasm function signatures. `type_summary` counts nodes, record layout statuses, and bitfields. The generator rejects disagreement between the compiler inventories and omits machine-specific paths from identifiers.

Each supported declaration has a `wasm_signature` with the parameter and result types emitted by the target compiler. Aggregate shims record their exported wrapper ABI. A separate compilation of function-address probes supplies these signatures; the build checks every supported API against the linked core before building host bundles. `i64` values require `bigint` in JavaScript. Unsupported declarations have null signatures. `api-verification.json` records the SHA-256 of both inputs and the number of verified API exports; failed builds clear the previous verification record. Bridge exports and `_initialize` are outside this API count. The quality checks also link a generated consumer against every supported export, letting the Wasm engine check the metadata independently.

The software configuration enables PNG, BMP, GIF, and TinyTTF. ThorVG, FreeType, SVG, Lottie, native windows, and hardware drawing backends are disabled. The Wasm linear memory maximum is 256 MiB.
