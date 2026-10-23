# liblvgl-wasm

`liblvgl.wasm` builds LVGL as a WASIp1 reactor, with 9.6.0 as the default source. The `lvw_*` bridge accepts input, advances time, provides resources, and returns software-rendered frames. LVGL Studio runs the module and user applications in a browser workspace. Browser/Bun and Rust hosts can also load the same module directly.

## Build

Requires CMake 3.25+, Ninja, Python 3.9+, Bun, Rust 1.92+ with the `wasm32-unknown-unknown` target, and the complete wasi-sdk 34 distribution for macOS or Linux. API generation loads the SDK's bundled libclang and uses Python's standard library; keep the SDK's libraries and sysroot together. Set `WASI_SDK_PATH` to the SDK root or add its `bin` directory to `PATH`. Existing builds can reuse the SDK path recorded in `target/wasm/CMakeCache.txt`. CMake downloads the official LVGL 9.6.0 lite and FreeType 2.14.3 source archives and verifies their pinned SHA-256 values; set `LVGL_SOURCE_DIR` to use an existing LVGL source tree.

The core and C demo require standard WebAssembly exception handling for FreeType's font validation, ThorVG's rasterizer, and the C++ runtime. The Rust host enables this feature in Wasmtime. The build uses the SDK's exception-enabled C++ libraries, `setjmp`, and `unwind`. FreeType uses LVGL's memory and resource filesystem, with host environment configuration and external zlib, bzip2, PNG, HarfBuzz, and Brotli dependencies disabled. Its bundled zlib remains enabled. WASI environment queries return an empty environment in both hosts; `proc_exit` fails the current instance without exiting the host process.

On Ubuntu 24.04, install `libtinfo6`, `libstdc++6`, and `libgcc-s1` for the SDK's shared libraries. Keep the bundled `libclang`, LLVM, and `libedit` libraries and their symlinks intact.

```sh
bun install --frozen-lockfile
WASI_SDK_PATH=/path/to/wasi-sdk ./scripts/build.sh
```

The build script can be invoked from another working directory. Relative SDK and source paths resolve from the caller's directory. A valid cached source override is reused; a missing cached source falls back to the pinned archive. An invalid explicit `LVGL_SOURCE_DIR` stops the build with an error.

Changing the SDK, source path, configuration path, or managed bridge features refreshes CMake's cached configuration while retaining downloaded sources and build files. Build directories without an input record are also refreshed. The selected inputs are reapplied; other manually added CMake cache settings must be supplied again after a refresh.

### Selected sources and configurations

`scripts/build-core.sh` builds the core, native C demo, API metadata, and signature proof without building the website or host packages. `LVGL_CONFIG_PATH` selects an existing file named `lv_conf.h`. `LVW_BUILD_DIR` selects a directory inside the checkout's `target/`; relative paths resolve from the caller's working directory. Keep different configurations in different directories.

```sh
LVGL_SOURCE_DIR=/path/to/lvgl-9.0.0 \
LVGL_CONFIG_PATH=config/base/lv_conf.h \
LVW_BRIDGE_FEATURES='' LVW_BUILD_DIR=target/v9.0 \
    ./scripts/build-core.sh
```

`config/base/lv_conf.h` enables software rendering and BMP resources. The base bridge provides displays, pointer input, synchronous events, resources, frame copying, and shutdown. LVGL 9.0.0 and 9.6.0 base builds are exercised with relocated C/C++/Zig consumers and matching TS/Rust host SDKs. Other source revisions require their own build and runtime checks.

`LVW_BRIDGE_FEATURES` is a semicolon-separated list of managed `timer;animation;observer;decoder` adapters; each listed adapter is selected by default, and an explicitly empty value selects the base bridge. Host callback adapters are selected independently of native LVGL timers and animations. Managed timers, animations, observers, and image decoders support the verified 9.0.0 and 9.6.0 sources, including configurations without external data. Software source adaptations remain verified against 9.6.0. An unavailable requested adapter fails configuration. The full preset remains `config/lv_conf.h`. Future major versions require independent native adaptation.

Generate a new host SDK from the resulting NDK and core before using raw APIs. Bindings, constants, and layouts from another core remain invalid even when both versions are v9. `scripts/build.sh` retains the default `target/wasm` path for website and sample builds; use `build-core.sh` for isolated outputs.

### Compiler preparation

`toolchains/lvw.py` prepares wasi-sdk 34.0 and wasm-tools 1.246.2 from the official archives pinned in `toolchains/tools.lock.json`. `--with-zig` also prepares Zig 0.15.2. Python 3.9+ and the standard library are sufficient for preparation.

```sh
python3 -B toolchains/lvw.py prepare
python3 -B toolchains/lvw.py doctor --json
python3 -B toolchains/lvw.py prepare --offline
```

`--project` selects an existing directory and defaults to the current working directory. Downloads and complete tool installations default to `<project>/target/toolchains/`. `--cache` selects a shared cache, with relative paths resolved against `--project`. The entry point and lock file can be moved together into a read-only directory and invoked by absolute path from another project.

`doctor` checks Python, CMake 3.25+, Ninja, the selected tool versions, the SDK's libclang loader, and required WASIp1 headers and runtime libraries. It reads the cache without downloading or compiling. `--json` reports success, paths, versions, tool origins, archive hashes, and errors; either command exits nonzero on failure. Use the reported `wasi-sdk.path` as `WASI_SDK_PATH` for `scripts/build.sh` and the reported `wasm-tools.executable` to validate modules. Bun, Rust, the Rust target, and Linux shared-library prerequisites remain the requirements listed above.

`--sdk /path/to/wasi-sdk` takes precedence over `WASI_SDK_PATH`; both select an existing SDK instead of downloading one. Relative SDK paths resolve against `--project`. These SDKs are reported as `source: user` and checked for version and required files; they have no managed archive identity. Managed tools are selected from this command's cache, without searching old build directories or `PATH` for substitutes.

Preparation verifies archive size and SHA-256, rejects escaping archive paths and links, and publishes installations only after validation. Reuse checks the complete installed tree, including file bytes, executable bits, and link targets. A cache lock prevents concurrent preparation from publishing partial tools. Invalid existing archives or installations produce an error; remove the named archive or move the named installation aside before retrying. `--offline` reuses verified installations or cached archives and never downloads. This option covers compiler preparation; source archives and Bun/Cargo dependencies have their own build requirements.

macOS arm64 preparation, relocation, offline reuse, and a C++ standard-exception/SJLJ reactor have been checked locally. Linux x86_64 archives are configured; this preparation path requires validation in Linux CI. Other build hosts are rejected.

### LVGL source inspection

`inspect-lvgl` reads an LVGL v9+ source tree with the selected wasi-sdk and configuration. Both the root `lvgl.h` layout and `include/lvgl/lvgl.h` layout are recognized. A second root entry must forward to the public header tree without changing its version. The selected `lv_conf.h` must actually be included.

```sh
python3 -B toolchains/lvw.py inspect-lvgl \
    --source /path/to/lvgl --config /path/to/lv_conf.h --json
```

The command shares header discovery and target constant evaluation with the API generator. It reports the actual version, target, effective `LV_USE_*` values, configuration file hash, and selected declaration probes. Macro expressions are evaluated by the target compiler. Missing declarations are reported separately from a failed inspection. Inspection does not build a reactor or verify runtime compatibility; both verification fields remain `not-run`.

The command is read-only and does not download tools or create a cache. `--project`, `--cache`, and `--sdk` use the preparation command's path rules; only wasi-sdk is required. Keep the source package's `generator/` directory with `toolchains/` when moving this command. The configuration can be an `lv_conf.h` file or its parent directory. Its reported hash covers that file, not its transitive includes or a complete build identity.

### Source packages

`export-source` copies the checkout's tracked source files into a new directory, including working-tree edits. It requires Git and the checkout root as `--project`; add new source files to Git before exporting. Compiler installations, build outputs, installed dependencies, `.git`, `.local`, and untracked files are excluded. Tracked local or build paths and symbolic links are rejected.

```sh
python3 -B toolchains/lvw.py export-source --json
python3 -B target/source/toolchains/lvw.py init \
    --source "$PWD/target/source" --output /path/to/new/project --json
```

The source package defaults to `target/source/`. Its `source.json` records the package version, Git revision and dirty state, file hashes, and executable files. It includes the CMake build, generators, host sources, Studio, examples, tests, and dependency locks. Exporting does not run the build or download dependencies.

`init` checks the complete source inventory and executable flags, then creates a writable project with the same relative file layout. The input package can be moved and kept read-only. Existing destinations and outputs inside the input package are rejected; failed initialization leaves no published project. `--output` defaults to `target/project/`, and relative `--source` and `--output` paths resolve against `--project`. Initialization does not create a Git repository. The original manifest and its hash are retained in the new project's `target/source-origin.json`.

Run the existing build from the initialized project:

```sh
cd /path/to/new/project
python3 -B toolchains/lvw.py prepare --with-zig --json
bun install --frozen-lockfile
WASI_SDK_PATH=/reported/wasi-sdk/path ./scripts/build.sh
```

Use the SDK path reported by `prepare`. Bun, Rust with the Wasm application target, and the other build prerequisites are still required. The build fetches the pinned LVGL and FreeType sources and generates the core, metadata, host bindings, website, and application samples under the new project's `target/`. It does not require Git or the original checkout. `export-ndk`, `export-sdk`, and the native C/C++/Zig examples use this same project layout.

### Native C/C++ development kit

`export-ndk` rebuilds the source checkout through `scripts/build-core.sh`, validates the core, and exports its public headers, configured static archives, CMake targets, API metadata, and Python generators. The base configuration contains LVGL, bridge, and shim archives; FreeType and ThorVG archives are included when enabled. Run `prepare` first; `--sdk`, `--cache`, and `--project` use the same path rules as compiler preparation. Core export requires CMake, Ninja, Python, wasi-sdk, and wasm-tools; host SDK export also requires the Bun dependencies.

```sh
python3 -B toolchains/lvw.py export-ndk --json
cmake -S target/ndk/examples/c -B target/apps/native-c -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE=/path/to/wasi-sdk/share/cmake/wasi-sdk-p1.cmake \
    -DCMAKE_PREFIX_PATH="$PWD/target/ndk" -DCMAKE_BUILD_TYPE=Release
cmake --build target/apps/native-c
```

Select another source and configuration explicitly:

```sh
python3 -B toolchains/lvw.py export-ndk \
    --source /path/to/lvgl-9.0.0 --config config/base/lv_conf.h \
    --bridge-features '' --build-dir target/v9.0 --output target/ndk-v9.0 --json
```

These options use the corresponding build environment defaults when omitted, except `--build-dir`, which defaults to `target/wasm`. Relative CLI paths resolve against `--project`. The NDK installs the selected `lv_conf.h`; it must be self-contained apart from LVGL and SDK headers. Missing includes or references outside the installed NDK and compiler distribution reject export before publication.

The default output is `target/ndk/`; `--output` selects another new directory. Existing outputs are rejected. Installation, reference signature verification, and per-file hashing finish in a temporary directory before the complete package is moved into place. `ndk.json` records the WASIp1 target, standard exception requirement, compiler versions, library hashes, file hashes, and reference API/core identity. The package contains LVGL, FreeType, ThorVG, wasi-libc, LLVM runtime, decoder, and bundled-font license material. `share/liblvgl-wasm/licenses/runtime/manifest.json` records the fixed source identities and hashes for the runtime notice tree. The compiler distribution remains separately prepared through `prepare`.

An external CMake project can use the package after relocation, including from a read-only directory:

```cmake
cmake_minimum_required(VERSION 3.25)
project(application LANGUAGES C CXX)
find_package(liblvgl-wasm CONFIG REQUIRED)
lvw_add_reactor(application main.c)
```

`main.c` can include `lvgl/lvgl.h` and call the original `lv_*` API, including native callbacks. C++ sources are also accepted. `lvw_add_reactor` links through Clang++, retains the bridge and generated wrappers, exports the configured LVGL APIs and function table, and supplies the standard exception/SJLJ runtime links. Both C and C++ languages and wasi-sdk 34.0 are required even for a C-only application. The installed configuration and archives must stay together; changing `LV_*` configuration macros requires rebuilding the libraries and metadata.

The example produces `target/apps/native-c/lvgl_native_example.wasm`, a reactor containing both the application and LVGL. Its host initializes the reactor and bridge, creates a display, and calls `lvw_demo_create(display)`. This module uses the native C ABI inside its own memory. Studio's separate `app.wasm` upload slot expects the `lvw_app` ABI and cannot load this reactor as an application.

Every newly linked reactor has a new core identity. Regenerate the host bindings before accessing its raw LVGL API; the reference verification record in the NDK applies only to the core used to export the package:

```sh
ndk="$PWD/target/ndk/share/liblvgl-wasm"
core="$PWD/target/apps/native-c/lvgl_native_example.wasm"
wasm-tools validate "$core"
python3 -B "$ndk/generator/signatures.py" --api "$ndk/metadata/api.json" \
    --wasm "$core" --output target/apps/native-c/verification.json
python3 -B "$ndk/generator/values.py" --api "$ndk/metadata/api.json" \
    --wasm "$core" --verification target/apps/native-c/verification.json \
    --output target/apps/native-c/typescript/values.ts
python3 -B "$ndk/generator/typescript.py" --api "$ndk/metadata/api.json" \
    --wasm "$core" --verification target/apps/native-c/verification.json \
    --output target/apps/native-c/typescript/raw.ts
python3 -B "$ndk/generator/rust.py" --api "$ndk/metadata/api.json" \
    --wasm "$core" --verification target/apps/native-c/verification.json \
    --output target/apps/native-c/rust/raw.rs
```

These commands generate the core-specific binding sources. The TypeScript runtime must be built with both matching generated TypeScript files; the Rust host accepts the matching Rust file through `LVW_RUST_BINDINGS`. The NDK does not contain prebuilt host SDKs for arbitrary application reactors.

### Native Zig applications

The NDK includes `examples/zig` and `lvw_add_zig_reactor`, using Zig 0.15.2 to compile a C-ABI object and wasi-sdk 34 to link the reactor. Prepare Zig and select the paths reported by `doctor --with-zig --json`:

```sh
python3 -B toolchains/lvw.py prepare --with-zig
python3 -B toolchains/lvw.py doctor --with-zig --json
cmake -S target/ndk/examples/zig -B target/apps/native-zig -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE=/path/to/wasi-sdk/share/cmake/wasi-sdk-p1.cmake \
    -DCMAKE_PREFIX_PATH="$PWD/target/ndk" -DCMAKE_BUILD_TYPE=Release \
    -DLVW_ZIG=/path/to/zig
cmake --build target/apps/native-zig
```

Export a new NDK from the current checkout if the existing package lacks the Zig example. `LVW_ZIG` is a CMake cache variable; if omitted, CMake searches `PATH`. Other Zig versions are rejected. The output is `target/apps/native-zig/lvgl_zig_example.wasm`; it has the same `lvw_demo_create(display)` native entry as the C example. Its Zig source calls `lv_*` directly, passes `lv_color_t` by value, and registers a `callconv(.c)` click callback. It is a complete reactor and cannot use Studio's `lvw_app` application upload slot.

An external project can call `lvw_add_zig_reactor(application main.zig)`, then select its exports with `target_link_options(application PRIVATE -Wl,--export=my_entry)`. Extra arguments to `lvw_add_zig_reactor` are dependency files, such as imported Zig modules; list them so CMake rebuilds the object when they change. Public header changes also invalidate the object. Translation uses `@cImport`, the NDK's include directories and configuration definitions, and the SDK's WASIp1 libc headers. Both Zig caches and intermediate files stay in the consumer's CMake binary directory; the package can remain read-only.

Zig objects use `ReleaseSafe` checks, with stack-protector instrumentation disabled to match the C runtime's import contract. The example uses Zig's trap-only panic handler. Final links use the CMake `Release` configuration and the NDK's standard exception/SJLJ libraries; Zig's compiler runtime is not linked. A new reactor requires a newly generated host SDK, as described below.

Zig's C translator does not represent C bitfields as Zig values. Records containing them, including several draw descriptors, can also be unusable through translated callback signatures. Zig 0.15.2 additionally reports a dependency cycle for `lv_color_filter_cb_t` and `lv_color_filter_dsc_t`. Use C accessors for those types; successful import of `lvgl.h` does not make every declaration usable. The native contract checks compare seven color, point, area, matrix, and gradient-stop layouts with compiler-derived metadata, and exercise color values, `i64`, `f32`, native callbacks, and calls into the standard exception/SJLJ runtime.

### Independent host SDKs

`export-sdk` creates TypeScript and Rust host packages for a selected core. It checks the NDK's file hashes, validates the Wasm module, verifies its exported LVGL signatures, and generates bindings for its exact bytes. It requires an exported NDK, the source checkout's installed Bun dependencies, Python, Bun, and prepared wasm-tools. It does not rebuild the core or download dependencies.

```sh
python3 -B toolchains/lvw.py export-sdk --json
python3 -B toolchains/lvw.py export-sdk --ndk target/ndk \
    --core target/apps/native-c/lvgl_native_example.wasm \
    --output target/native-host-sdk --json
```

`--project` selects the source checkout, `--ndk` defaults to `target/ndk`, `--core` defaults to `target/wasm/liblvgl.wasm`, and `--output` defaults to `target/host-sdk`. Relative paths resolve against `--project`. The selected core must have been linked with that NDK's configuration and libraries; signature verification cannot establish arbitrary user-supplied type layouts or constant values. Existing outputs are rejected, and failed exports leave no published package. Output directories must be separate from the input NDK, host sources, and dependency tree.

The exported directory contains `runtime/liblvgl.wasm`, `metadata/{api,verification}.json`, `typescript/`, `rust/`, license material from the NDK, and `sdk.json`. The manifest records the NDK hash, core/API identity, generator counts, Bun/TypeScript versions, and each packaged file's SHA-256. The TypeScript bundle includes the fixed `@noble/hashes` implementation and its original license. Packages remain private and are not published to a registry by this command.

The TypeScript package contains an ESM bundle and a complete declaration tree. Install it from an application directory:

```sh
bun add /path/to/host-sdk/typescript
```

```ts
import { LvglRuntime } from "liblvgl-wasm";

const core = await Bun.file("/path/to/host-sdk/runtime/liblvgl.wasm").arrayBuffer();
const runtime = await LvglRuntime.load(core);
const display = runtime.createDisplay(320, 240);
const button = runtime.createButton(runtime.screen(display));
runtime.unsafe.lv_obj_set_size(button.handle, 140, 60);
runtime.unsafe.lv_obj_center(button.handle);
runtime.step(40);
const frame = runtime.readFrame(display);
console.log(frame.width, frame.height, frame.rgba.byteLength);
display.destroy();
runtime.shutdown();
```

Browser applications can import the same package and pass fetched Wasm bytes to `LvglRuntime.load`. TypeScript 5.9.3 consumers are checked with both `Bundler` and `NodeNext` resolution, an ES2022 target, and DOM types. The runtime bundle has no external JavaScript dependencies and does not require WebCrypto.

The Rust directory is an independent library crate with its lockfile and `generated/raw.rs`. A consumer can use a path dependency:

```toml
[dependencies]
liblvgl-wasm-host = { path = "/path/to/host-sdk/rust" }
```

The exported manifest enables `bundled-bindings` by default. A missing bundled file is an error; the build does not search the checkout's generated output. `LVW_RUST_BINDINGS` can explicitly override the file, with relative paths resolved against the crate's manifest directory. Disabling default features selects the source-checkout binding path and requires an explicit override outside a checkout. Rust 1.92+ and the locked Cargo dependencies are required; a lockfile alone does not provide an offline dependency cache. Put consumer build outputs in the consumer's `target/` or an explicitly selected `CARGO_TARGET_DIR`; the SDK can remain read-only.

### Complete development package

`export-package` assembles one relocatable directory containing the verified source snapshot, native NDK, core-specific host SDK, and a root `manifest.json`. The command requires a clean Git checkout so the source revision, core SHA-256, API SHA-256, NDK manifest, SDK manifest, target triple, and tool versions describe one consistent package.

```sh
python3 -B toolchains/lvw.py export-package --output target/package --json
```

The package has `source/`, `ndk/`, and `host-sdk/` directories. `manifest.json` is a semantic compatibility record plus a SHA-256 inventory for every file below those directories. The NDK and host SDK keep their own manifests and runtime notice trees. `--allow-dirty` is available for local development checks and marks the source entry as dirty; release automation leaves it disabled. The output is a directory suitable for archiving and remains usable after relocation.

CMake compiles adapted copies of the pinned `lv_observer.c` and `lv_image_decoder.c` with bridge notifications at native deletion points. Decoder deinitialization deletes individual decoders to deliver those notifications. The original source tree stays unchanged; different source hashes are rejected. The adapted `liblvgl.a` requires the bridge's `lvw_observer_release_native` and `lvw_decoder_release_native` implementations.

The pinned `lv_gif.c` also compiles from an adapted copy that preserves playback during frame-count queries, applies each frame's delay, stops timers before closing sources, and delivers completion events after frame processing.

The adapted `lv_draw_sw_letter.c` composites FreeType outline glyphs as premultiplied images and scales cached paths by the exact font-size ratio. The original source is checked against its pinned hash before adaptation.

Generated files stay under `target/`:

| Path | Content |
| --- | --- |
| `target/wasm/liblvgl.wasm` | WASIp1 library module |
| `target/wasm/api.json` | Enabled functions, binding status, constants, target layouts, and callback typedef signatures |
| `target/wasm/api-verification.json` | API/core hashes and verified function signature counts |
| `target/wasm/api-exports.txt` | Generated linker export flags |
| `target/wasm/api-shims.c` | Generated wrappers for aggregate values and inline functions |
| `target/wasm/lvgl-adapted/lv_observer.c` | Observer deletion notification added to the pinned source |
| `target/wasm/lvgl-adapted/lv_image_decoder.c` | Decoder deletion notifications and deinitialization cleanup |
| `target/wasm/lvgl-adapted/lv_gif.c` | GIF playback timing, queries, and callback lifetime fixes |
| `target/wasm/lvgl-adapted/lv_draw_sw_letter.c` | Outline glyph alpha compositing and font-size scaling |
| `target/wasm/examples/c/liblvgl-c-demo.wasm` | C demo linked with LVGL |
| `target/browser/main.js` | Browser example bundle |
| `target/typescript/index.js` | TypeScript host adapter bundle |
| `target/typescript/raw.ts` | Generated typed `lv_*` calls, export mapping, and core identity |
| `target/typescript/values.ts` | Generated constants, named type layouts, and matching identity |
| `target/rust-bindings/raw.rs` | Generated Rust `lv_*` methods, values module, pointer types, export mapping, and core identity |
| `target/studio/{main,worker}.js` | Studio page and isolated runner bundles |
| `target/apps/ts/app.js` | TypeScript sample application |
| `target/apps/ts/samples/png.js` | PNG sample application |
| `target/apps/ts/samples/gif.js` | GIF sample application |
| `target/apps/ts/samples/freetype.js` | FreeType font sample application |
| `target/apps/ts/samples/tinyttf.js` | TinyTTF font sample application |
| `target/apps/{c,cpp,rust}/app.wasm` | C, C++, and Rust sample applications |
| `target/rust/` | Rust host build cache |
| `target/ndk/` | Relocatable native C/C++ development kit from `export-ndk` |
| `target/host-sdk/` | Core-specific TypeScript and Rust packages from `export-sdk` |
| `target/package/` | Complete source, NDK, and host SDK package from `export-package` |
| `target/source/` | Verified build-source snapshot from `export-source` |
| `target/project/` | Writable source project from `init` |

## Quality checks

Native ABI checks require Zig 0.15.2. Run `python3 -B toolchains/lvw.py prepare --with-zig`, or set `LVW_ZIG` to an existing executable before running the quality command. Source-package checks also require Git.

Install `wasm-tools`, `rustfmt`, and `clippy` in addition to the build prerequisites, then run:

```sh
bun run quality
```

`bun run check:compatibility` downloads a SHA-256-pinned v9.0.0 fixture and checks its base and managed-callback configurations alongside the default 9.6.0 source. It reuses one isolated build directory to verify source, configuration, and feature changes and failed-configuration proof invalidation, then runs the existing C/C++/Zig relocation and TS/Rust package consumers. Both exported host SDKs run the shared timer, animation, observer, and decoder lifecycle contracts against the core and a newly linked NDK consumer. Callback cases enable 4 header-cache entries in a generated copy of the base preset and verify cache invalidation on decoder cancellation. Native C/C++ callbacks also retain their version's deletion behavior. Use `bun run check:compatibility --offline` with the cached archive. Logs and successful proof identities are written under `target/compatibility/`; a failed run removes the previous aggregate report. Run the default build before this check and use Rust 1.92+ with populated Cargo dependencies. The quality workflow runs both commands.

This command rebuilds the core, generated API wrappers, TypeScript bindings, C demo, browser bundles, and application samples before validating all five Wasm modules. It runs strict TypeScript checks for the generated bindings and runtime, Bun tests, Rust formatting checks, Clippy with warnings denied for both Rust packages, host tests, and the Rust host's rendering/input checks. The NDK test installs and relocates a read-only package, compiles C/C++ consumers against the generated type layouts, validates their modules, and checks matching bindings, native click callbacks, rendering, destruction, and C++ exceptions. Every command stops on failure. Dependency installation and Rust builds use the checked-in lockfiles. `bun run test` runs only the repository's `tests/` directory and requires existing build outputs.

The GitHub Actions quality workflow runs the same command on Ubuntu 24.04 with Bun 1.3.14, Rust 1.92.0, wasi-sdk 34, and wasm-tools 1.246.2. SDK and Wasm tool downloads are verified against pinned SHA-256 values.

Host SDK checks generate packages for the core and a separately linked native reactor. External consumers check both TypeScript resolution modes, browser bundles, exact identities, colors, wide integers, click callbacks, and shutdown. Rust build-script checks cover bundled input selection, missing-file errors, and explicit overrides.

## LVGL Studio

Start a static server from the repository root after building:

```sh
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/studio/`. The page starts with the default core and JavaScript sample. Select a compatible local `liblvgl.wasm` to replace the core, or return to the default build. Drop a built `.js` or `.wasm` application into the application panel. Resource files are copied into the selected core's `W:` drive. Run, stop, restart, and change the preview resolution from the page. The preview frame animates to the selected resolution and fits narrow viewports. The runtime console shows validation errors and application logs. The Light/Dark control remembers the selected theme; the preview preserves each LVGL application's own colors and styles.

Custom cores must implement bridge ABI 1 and the exports used by Studio. An arbitrary LVGL Wasm build without this bridge cannot be loaded. Application uploads are executable artifacts: Studio does not compile C, C++, Rust, or TypeScript source in the browser. Uploaded code runs in a sandboxed iframe worker; stopping the app removes its runner. Files are read by the browser and are not sent to a compilation service.

The library status opens **Library details** in the same side panel used for source files. It shows the loaded core's SHA-256, bridge ABI, host SDK match, and import/export counts. A matching core also shows its generated LVGL version and software configuration. A different bridge-compatible core shows **Bridge only**, with unknown build configuration; the default file location does not bypass this check. Enabled configuration entries do not imply complete format support; the [software rendering sections](#software-rendering) document the verified behavior and limits. Stopping, restarting, or failing an application clears its active library details. Cancelling a pending load keeps it stopped.

### Application toolchains

The toolchain panel shows sample source files with syntax highlighting in a side panel and provides build commands. On localhost, an open source panel refreshes when its file changes. Build from the repository root, then upload the output shown below. `scripts/build.sh` builds all included samples; individual commands rebuild one sample.

| Language | Build command | Upload |
| --- | --- | --- |
| JavaScript | No build step; use `toolchains/js/app.js` | `.js` |
| TypeScript | `bun run build:ts-app` | `target/apps/ts/app.js` |
| TypeScript PNG | `bun run build:ts-samples` | `target/apps/ts/samples/png.js` |
| TypeScript GIF | `bun run build:ts-samples` | `target/apps/ts/samples/gif.js` |
| TypeScript FreeType | `bun run build:ts-samples` | `target/apps/ts/samples/freetype.js` |
| TypeScript TinyTTF | `bun run build:ts-samples` | `target/apps/ts/samples/tinyttf.js` |
| TypeScript SVG | `bun run build:ts-samples` | `target/apps/ts/samples/svg.js` |
| TypeScript Lottie | `bun run build:ts-samples` | `target/apps/ts/samples/lottie.js` |
| C | `./toolchains/c/build.sh` | `target/apps/c/app.wasm` |
| C++ | `./toolchains/cpp/build.sh` | `target/apps/cpp/app.wasm` |
| Rust | `./toolchains/rust/build.sh` | `target/apps/rust/app.wasm` |

JavaScript applications define `main(api)` and may use the runtime, display, screen, resources, and log function passed in `api`; see `toolchains/js/app.js`. TypeScript applications bundle to a single JavaScript file with the same entry point; see `toolchains/ts/app.ts`. C, C++, and Rust applications use application ABI 1 through `toolchains/include/lvw_app.h` or equivalent imports. They export `memory`, `app_abi_version()`, `app_init()`, and `app_event(id, code)`. The sample source files show the required imports and event handling. Application Wasm modules use their own memory; Studio copies text and resources through the bridge.

The TypeScript sample and Studio worker share `AppApi` in `toolchains/ts/api.ts`. The sample calls `lv_obj_set_size`, `lv_obj_center`, `lv_palette_main`, and `lv_obj_set_style_bg_color` through `runtime.unsafe`, using generated constants and `LV_COLOR_T_SIZE` for the color result. Its managed click callback changes the color and count. Before accessing the guest, it checks its bundled `valuesIdentity` against the loaded core and host SDK; rebuild the application when those identities differ. Constants are imported from `target/typescript/values.ts` so the application does not bundle another host runtime. `bun run build:ts-app` verifies and regenerates the SDK inputs before bundling. In Studio, select **TypeScript** and run the sample; both `app.ts` and `api.ts` open in the source panel.

The TypeScript **Sample** selector offers an API button, PNG, GIF, FreeType, TinyTTF, SVG, and Lottie. Selecting an entry changes its source links and build command; **Load** runs it in the central canvas. The PNG example renders `tests/fixtures/png/rgba.png` through LVGL at 16× scale and switches between light and dark backgrounds to show alpha compositing. These examples use the identity check in `toolchains/ts/sdk.ts`. `bun run build:ts-samples` verifies the generated SDK inputs and builds the entries under `toolchains/ts/samples/`.

The GIF example plays `tests/fixtures/gif/playback.gif` at 16× scale using native `lv_gif_*` calls. **Pause** and **Resume** control playback; **Restart** starts another continuous loop. Resume preserves elapsed time and may advance immediately. Restart clears the image until the native timer decodes its first frame. The application retains its guest source path for the GIF object's lifetime; `lv_gif_set_src` borrows that pointer. For manual uploads, select `playback.gif` as a resource before uploading `gif.js`.

The FreeType example displays `AB Á` from `tests/fixtures/tinyttf/geometry.ttf`. Its controls switch between 16 and 32 px and between bitmap and outline rendering. Outline glyphs use the native ThorVG renderer. Both controls create a new font, assign it to the label, and delete the old font. If replacement creation returns null, the existing text, size, and mode remain usable and the error appears in the console. This original fixture contains only space, A, B, and Á; captions and controls use LVGL's default font. For manual uploads, select `geometry.ttf` as a resource before uploading `freetype.js`.

The TinyTTF example loads the same complete font file with `lv_fs_load_with_alloc` and displays `AB Á`. Its button calls `lv_tiny_ttf_set_size` and refreshes the label's text-font style to update layout at 16 and 32 px. The font borrows the loaded bytes for its lifetime. This configuration does not validate arbitrary malformed or truncated font data; use a valid, complete font. For manual uploads, select `geometry.ttf` as a resource before uploading `tinyttf.js`. Studio Stop discards the complete runner; it does not call individual raw font destructors.

The SVG example switches between `tests/fixtures/svg/geometry.svg` and `gradient.svg` in the same image object. LVGL renders their 32×24 viewports with a 4× vector transform, including transparent fills. Both SVG files open with tag and attribute highlighting in the source panel. For manual uploads, select both files as resources before uploading `svg.js`. The sample checks source dimensions after loading; actual rendering depends on the [supported SVG features](#svg-geometry).

The Lottie example plays `tests/fixtures/lottie/translation-opacity.json` with native `lv_lottie_*` and `lv_anim_*` calls. Its 32×24 animation renders directly into a 128×96 draw buffer; **Pause**, **Resume**, and **Restart** control the native animation clock. The source path is freed after the synchronous loader returns, and the draw buffer stays alive with the widget. Initial missing or invalid JSON produces an error. Studio Stop discards the complete runner. For manual uploads, select `translation-opacity.json` as a resource before uploading `lottie.js`; the [Lottie playback limitations](#lottie-playback) also apply to this sample.

Built-in examples load their required files before starting. **Assets** lists these as **Sample** alongside user **Upload** files; browsing another language or sample does not change the running application's resources. Both sources share the resource name, count, and byte limits, and duplicate names are rejected. **Clear uploads** removes user files and restarts the selected application with its required sample resources. To upload a compiled example manually, upload the resource files shown in its toolchain details as well; uploading a `.js` file does not infer its dependencies. For the PNG example, select `rgba.png` as a resource before uploading `png.js`.

## Other hosts

```sh
bun run test
env CARGO_TARGET_DIR=target/rust cargo run --manifest-path bindings/rust/Cargo.toml --locked -- target/wasm/liblvgl.wasm
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/examples/browser/` after starting the server. The browser example renders a button and a BMP resource; pointer input changes the button label. The Rust example checks rendering, resource pixels, input, callbacks, and shutdown.

Studio's Rust toolchain includes **Rust host · LVGL API**, with the terminal command and source files for `bindings/rust/src/main.rs`. This executable calls the generated `lv_*` APIs through Wasmtime and prints its check results in the terminal. Run `./scripts/build.sh` first to generate the matching core and bindings, and use Rust 1.92+ from the repository root. The **Load Rust sample** button runs the independent `lvw_app` application template in the central canvas.

Select the C toolchain in Studio and open **C API preview**. The Studio workspace shifts left to show the preview panel. Opening `direct_api.c` shifts the workspace and preview left again, with the source in a second panel on the right. [`examples/c/direct_api.c`](examples/c/direct_api.c) creates the button and handles its click with native `lv_*` calls. `scripts/build.sh` links that C source and LVGL into a separate Wasm module at `target/wasm/examples/c/liblvgl-c-demo.wasm`. The preview shows this module's actual loaded SHA-256 and bridge ABI; it has its own instance and does not use the central canvas's library selection. Closing, cancelling, or failing the preview clears its identity. Guest failures stop input and drawing without entering the failed instance again. This linked module is separate from Studio's uploaded application ABI, which uses `lvw_app` imports.

### TypeScript raw API

`LvglRuntime.unsafe` exposes every supported function under its original `lv_*` name. The generated bindings map aggregate functions to their `lvw_api_*` exports. `i64` arguments and results use `bigint`; raw `i32` results retain Wasm's signed JavaScript representation.

```ts
const api = runtime.unsafe;
const button = api.lv_button_create(screen.handle);
api.lv_obj_set_size(button, 180, 64);
const value = api.lv_pow(10n, 6); // 1000000n
```

`UnsafePointer` is an offset in the selected core's memory. The caller supplies valid bounds, alignment, initialization, and lifetimes. Read the target layouts in `api.json` when allocating aggregate storage: `lv_color_hex(out, rgb)` writes to `out`, while `lv_obj_set_style_bg_color(object, color, selector)` reads a color through a pointer. Strings use NUL-terminated bytes in core memory. `api.memory` exposes that memory; recreate views after calls that may grow it. Pair scratch allocations from `api.lvw_alloc` with `api.lvw_free` and check for a zero allocation result. `UnsafeFunctionPointer` represents a Wasm table index returned by callback getters; it is not a memory address or a callable JavaScript function.

Generated calls require the exact core SHA-256 embedded in `bindingIdentity`. Loading snapshots the supplied bytes before hashing and compilation. A different bridge-compatible core can use the existing convenience API; accessing `unsafe` reports a binding mismatch. Generate matching bindings when rebuilding a core. Every generated call checks runtime state, including methods saved before shutdown. Use `LvglRuntime` for initialization, shutdown, and bridge-managed display/input lifetimes; raw lifecycle calls can invalidate its bookkeeping.

`runtime.identity` is a frozen snapshot containing `bridgeAbi`, the loaded `coreSha256`, and `sdk` with its required `coreSha256`, `apiSha256`, `verifiedFunctions`, and `status`. Status is `matched`, `core-mismatch`, or `values-mismatch`, using the same checks as `unsafe`. Reading this diagnostic snapshot does not call the guest and remains valid after shutdown. It describes the host SDK; an uploaded application that bundles its own constants or layouts must also compare its `valuesIdentity` with these core and API hashes before using them.

Guest traps and synchronous handler exceptions poison the TypeScript runtime. The original exception propagates, and subsequent calls, scratch allocation, event getters, and access through `unsafe` or its memory getter are rejected. Capturing a nested guest failure inside a handler does not recover the instance. Release the failed runtime and its saved API/memory references; cleanup does not reenter failed guest code. Previously obtained raw memory views cannot be revoked.

Normal event handlers can update UI synchronously. Calling `step` or `shutdown` while a guest call is active is rejected before entering the core; catching that rejection lets the outer handler finish normally. Shutdown enters a closing state before invoking guest cleanup. DELETE handlers still receive notifications, but during closing they can only update host data or read static constants; guest calls and memory access through the SDK are rejected. When guest cleanup returns normally, the runtime closes; a nonzero status is reported as an error, and a trap leaves it poisoned. The bridge also rejects `lvw_step` and `lvw_shutdown` from synchronous event callbacks.

`object.on(code, handler)` and `runtime.onEvent(object, code, handler)` return an unsubscribe function. Repeated calls are harmless, and a handler can unsubscribe itself or another handler during dispatch. Unsubscribing removes both the guest event descriptor and the host handler. After deletion, shutdown, or a guest failure, unsubscribe only releases host records and does not enter the guest.

Object aliases share a lifetime. DELETE invalidates them before user handlers run, preserves DELETE and ALL notifications, then releases host subscriptions when the outer guest call returns. Parent and display deletion also invalidate their children; asynchronous LVGL deletion uses the same path. Create pointer inputs with `runtime.createPointer(display)`: they retain their owning display's lifetime, so old inputs remain invalid after a replacement display is created. Managed references reject use across runtimes. Raw removal of internal event watchers or manual core deinitialization can invalidate these guarantees.

The TypeScript runtime and Studio require the `lvw_event_remove` export for managed subscriptions and reject cores without it before initialization. This is an additional ABI 1 export; existing bridge signatures are unchanged. Rust callers can use `call_raw("lvw_event_remove", (object, callback_id))` with a core that provides it.

`bun run generate:ts` generates bindings, constants, and layouts from the existing API report, core, and signature verification record. Missing or stale verification stops generation and removes the affected previous generated source. `build:ts`, `build:browser`, `build:studio-worker`, `build:ts-app`, and `build:ts-samples` run this check before bundling. `bun run typecheck` checks the generated sources, runtime, Studio, browser example, and TypeScript applications using the pinned TypeScript compiler, with separate DOM and Worker environments. The bundle includes SHA-256 from `@noble/hashes`, allowing core checks in Studio's isolated worker without WebCrypto. The generated sources are self-contained, and `index.js` can be copied with its matching core; the repository runtime source imports generated files and requires the repository build layout.

### Rust host library

`bindings/rust` provides the `liblvgl-wasm-host` library and a CLI that uses it. Add the library as a Cargo path dependency:

```toml
[dependencies]
liblvgl-wasm-host = { path = "/path/to/liblvgl-wasm/bindings/rust" }
```

```rust
use liblvgl_wasm_host::{Result, Runtime, UnsafePointer, values};

fn main() -> Result<()> {
    let mut runtime = Runtime::from_file("target/wasm/liblvgl.wasm")?;
    let display: u32 = runtime.call_raw("lvw_display_create", (320u32, 240u32, 1u32))?;
    let mut api = runtime.raw()?;
    let screen = api.lv_display_get_screen_active(UnsafePointer(display))?;
    let button = api.lv_button_create(screen)?;
    api.lv_obj_set_size(button, 180, 64)?;
    runtime.set_event_handler_with_context(|context, event| {
        context.raw()?.lv_obj_set_width(UnsafePointer(event.object), 200)
    })?;
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_event_add", (button.0, values::LV_EVENT_CLICKED, 1u32))?,
        0
    );
    runtime.raw()?.lv_obj_send_event(button, values::LV_EVENT_CLICKED as i32, UnsafePointer(0))?;
    runtime.shutdown()
}
```

`scripts/build.sh` generates the Rust bindings before building the hosts. `bun run generate:rust` regenerates them from an existing core, API report, and matching signature verification record. The Cargo build script copies the generated source into `OUT_DIR`; it does not download tools or build LVGL. Set `LVW_RUST_BINDINGS` to select a generated `raw.rs` outside the repository. Relative paths are resolved from the library's Cargo manifest directory.

`Runtime::raw()` exposes all supported original `lv_*` names after checking the core SHA-256 against `BINDING_IDENTITY`. Its mutable borrow prevents other runtime access while the API remains in use. Methods return `Result` and share the runtime's failure guards. `UnsafePointer` holds a `u32` memory offset; `UnsafeFunctionPointer` holds a Wasm table index. These separate types do not check pointer validity or ownership. Aggregate shims take storage pointers, including an initial output pointer for aggregate results; use the layouts in `api.json`. Scalars retain the actual Wasm `i32`, `i64`, `f32`, and `f64` types. Calls are safe Rust methods; the caller maintains LVGL's guest-side preconditions.

`Runtime::load` accepts Wasm bytes. Loading validates imports, initializes the reactor, and checks bridge ABI 1. The runtime owns the Wasmtime store and keeps instances isolated. `call_raw` checks the Wasm export type; it does not validate LVGL pointers, layouts, ownership, or lifecycle operations. Use `shutdown` for runtime cleanup. `alloc`/`free` manage scratch storage, and `read_memory`/`write_memory` copy bytes with bounds checks. Guest pointers are `u32` offsets, never host addresses.

`RawApi` also provides `alloc`, `free`, `read_memory`, and `write_memory` using `UnsafePointer`. Core bytes are hashed and compiled from the same input. A different bridge-compatible core can use the generic `call_raw` interface, but obtaining this generated API reports a binding mismatch. The Rust crate needs the generated source at compile time; a relocated copy can use `LVW_RUST_BINDINGS` to locate it.

`set_event_handler` receives synchronous `Event { callback_id, object, code }` notifications for IDs registered with `lvw_event_add` and accepts an `FnMut` closure. `set_event_handler_with_context` adds a borrowed `CallbackContext` with `raw`, `call_raw`, scratch allocation, and checked memory copies. It accepts `Fn + Send + Sync`, allowing the same handler to receive nested notifications while calling LVGL. Use atomics or a mutex for mutable captured state, and release application locks before guest calls. Either setter replaces the current handler.

Guest traps, handler errors, and handler panics poison the Rust runtime. Catching an inner failure does not recover it; all later calls and memory access are rejected. Export lookup, signature mismatch, and checked memory range errors leave the instance usable. Calling `lvw_step` or `lvw_shutdown` during a guest call is rejected before guest entry. Shutdown DELETE handlers can update host data, but context calls and memory access are rejected while closing. Normal cleanup closes the runtime, including a nonzero cleanup status; a trap or panic poisons it. Calling `lvw_shutdown` through `call_raw` applies the same closing rules. Dropping a runtime releases its store without executing guest code or user callbacks.

### Native event parameters and drawing

`runtime.eventPointer()` in TypeScript and `CallbackContext::event_pointer()` in Rust return the native `lv_event_t` pointer for the innermost active bridge event. Use the generated `lv_event_*` methods to read its original target, current target, parameters, draw layer, or draw task, and to stop processing or bubbling. Nested events restore the outer pointer when they return. A non-event callback nested inside an event can still access that active event.

Drawing uses the existing event subscription API. For example, after allocating and initializing a rectangle descriptor and area in core memory:

```ts
screen.on(LV_EVENT_DRAW_MAIN_END, () => {
  const event = runtime.eventPointer();
  const layer = runtime.unsafe.lv_event_get_layer(event);
  runtime.unsafe.lv_draw_rect(layer, rectangleDescriptor, area);
});
```

```rust
runtime.set_event_handler_with_context(move |context, event| {
    if event.code == values::LV_EVENT_DRAW_MAIN_END as u32 {
        let pointer = context.event_pointer()?;
        let mut api = context.raw()?;
        let layer = api.lv_event_get_layer(pointer)?;
        api.lv_draw_rect(layer, rectangle_descriptor, area)?;
    }
    Ok(())
})?;
```

The Rust handler receives IDs registered with `lvw_event_add`. Allocate descriptors with the generated size/layout constants and initialize them with `lv_draw_rect_dsc_init`. Enable `lv_obj_set_send_draw_task_events` to receive `LV_EVENT_DRAW_TASK_ADDED`; `lv_event_get_draw_task` and the generated task getters expose the descriptor for synchronous changes before dispatch.

Event, layer, task, and parameter pointers are borrowed for the synchronous event call. Do not retain them or memory views into their storage after that call. Returned `UnsafePointer` values do not enforce this lifetime. During drawing, do not change the object tree, styles, or layout, delete objects, or reenter refresh. Do not force draw-task dispatch while handling `LV_EVENT_DRAW_TASK_ADDED`. These interfaces use LVGL's software renderer; they do not install custom draw units or image decoders.

Event handlers must finish synchronously. TypeScript rejects Promise and thenable results and poisons the runtime. The pointer getter rejects calls with no active event and cores without `lvw_event_current`, leaving the runtime usable. Closing, closed, and poisoned runtimes reject access. This optional export preserves the existing three-argument `lvw.event` import and bridge ABI 1; older cores retain ordinary event notifications.

### Native timers

`runtime.createTimer(periodMs, callback, userData = 0)` creates a TypeScript `Timer`. Its callback receives that timer and runs synchronously during LVGL timer handling. `timer.handle` returns its active native pointer; `timer.cancel()` and `runtime.cancelTimer(timer)` cancel it. Promise and thenable callback results are rejected and poison the runtime.

```ts
let ticks = 0;
const timer = runtime.createTimer(100, () => { ticks++; });
runtime.unsafe.lv_timer_set_repeat_count(timer.handle, 3);
runtime.step(100);
timer.cancel();
```

Rust exposes `Runtime::create_timer` and `CallbackContext::create_timer`. The handler receives its execution context and `&Timer`; `Timer::pointer()` returns a checked `UnsafePointer`. A cloned `Timer` shares the original lifetime. Dropping a handle alone does not cancel it.

```rust
let timer = runtime.create_timer(100, UnsafePointer(0), |context, timer| {
    context.raw()?.lv_timer_set_period(timer.pointer()?, 200)
})?;
runtime.raw()?.lv_timer_set_repeat_count(timer.pointer()?, 3)?;
runtime.cancel_timer(&timer)?;
```

Timers use the core's tick and native `lv_timer_handler`, advanced by `lvw_step`; they do not use host clocks. Generated `lv_timer_*` methods control period, pause, resume, repeat count, auto-delete, and user data. The native `user_data` field is independent of the host callback ID. A finite repeat count with auto-delete enabled releases the host handler and invalidates the timer, including repeat count zero. Disabling auto-delete preserves a paused timer that can be configured and resumed.

Cancellation is idempotent and rejects timers from another runtime. Callbacks can delete themselves or other timers and create new timers. Native `lv_timer_delete`, shutdown, and runtime failure also invalidate managed handles and release host handlers; Rust runtime drop does the same without calling guest cleanup. Cancellation after invalidation does not enter the guest. During shutdown, cancellation only releases host records. Saved raw pointers remain subject to LVGL's lifetime rules.

Managed timers use the external-data destructor slot when available. Without that slot, `cmake/timer.cmake` verifies the native source SHA-256 and compiles a build-directory copy that notifies the bridge before `lv_timer_delete` frees memory. This path supports the verified 9.0.0 and 9.6.0 sources and requires the bridge's strong `lvw_timer_release_native` hook when linking the adapted static archive. Source checkouts and native user data are unchanged. Do not replace the reserved destructor or callback trampoline, or manually deinitialize a managed runtime; shutdown deletes managed timers before LVGL clears its timer list. Function-pointer setters remain unsupported in the raw bindings; supported callback getters return Wasm table indices.

The core imports `lvw.timer(callback_id, timer)` for synchronous execution and `lvw.timer_release(callback_id)` for host bookkeeping. Hosts must implement both imports when loading this core. Updated hosts can still load older bridge-compatible cores; timer creation requires both `lvw_timer_create` and `lvw_timer_delete` and reports missing exports before registering a handler. The bridge ABI remains `1`, with existing signatures unchanged.

### Native animations

Initialize an `lv_anim_t` descriptor in core memory and configure it with the generated `lv_anim_*` setters. `startAnimation` / `start_animation` copies that descriptor into a native animation and attaches synchronous host callbacks. The input descriptor can be freed after creation. Native `var`, `user_data`, timing, and available playback controls are preserved.

LVGL 9.0.0 applies the starting value directly during early apply; its path callback first runs on a native animation tick. Its start notification runs once per animation, reverse playback uses the `lv_anim_set_playback_*` names, and per-animation pause APIs are absent. LVGL 9.6.0 queries the path during early apply, repeats start notifications for playback segments, and provides `lv_anim_set_reverse_*` and pause APIs. Generated SDKs expose the functions declared by the selected source.

Without external data, `cmake/animation.cmake` verifies the 9.0.0 or 9.6.0 source SHA-256 and compiles a build-directory copy. Native creation binds the copied descriptor before early callbacks; native deletion and completion release the host registration. The 9.0.0 clear-all path sends deletion notifications to managed animations while preserving its original behavior for ordinary C/C++ callbacks. These archives require the bridge's strong animation hooks. User data and native variables remain independent of registration IDs.

```ts
import { LV_ANIM_T_SIZE } from "./target/typescript/index.js";

const api = runtime.unsafe;
const descriptor = api.lvw_alloc(LV_ANIM_T_SIZE);
if (!descriptor) throw new Error("animation allocation failed");
api.lv_anim_init(descriptor);
api.lv_anim_set_var(descriptor, button.handle);
api.lv_anim_set_values(descriptor, 0, 120);
api.lv_anim_set_duration(descriptor, 600);
const animation = runtime.startAnimation(descriptor, {
  exec(_current, x) { api.lv_obj_set_x(button.handle, x); },
  path(current) { return api.lv_anim_path_ease_in_out(current.handle); },
});
api.lvw_free(descriptor);
// runtime.step(elapsedMs) advances the animation.
animation.cancel();
```

```rust
use liblvgl_wasm_host::{AnimationCallbacks, values};

let descriptor = {
    let mut api = runtime.raw()?;
    let descriptor = api.alloc(values::LV_ANIM_T_SIZE)?;
    api.lv_anim_init(descriptor)?;
    api.lv_anim_set_var(descriptor, button)?;
    api.lv_anim_set_values(descriptor, 0, 120)?;
    api.lv_anim_set_duration(descriptor, 600)?;
    descriptor
};
let animation = runtime.start_animation(
    descriptor,
    AnimationCallbacks::new(move |context, _current, x| {
        context.raw()?.lv_obj_set_x(button, x)
    }).path(|context, current| {
        context.raw()?.lv_anim_path_ease_in_out(current.pointer()?)
    }),
)?;
runtime.free(descriptor.0)?;
runtime.cancel_animation(&animation)?;
```

`exec` is required. Optional `path`, `getValue` / `get_value`, `start`, `completed`, and `deleted` callbacks receive the actual running animation. Query callbacks return a signed 32-bit integer synchronously; TypeScript rejects thenables, fractional values, and out-of-range results. Natural completion delivers completed, then deleted. Explicit deletion delivers deleted. Native deletion of the `var` object also releases its animations.

Each active animation owns a distinct exec table slot, so cancellation affects only that animation even when several share the same `var`. Deleted handles become invalid, and repeated cancellation is harmless. Runtime shutdown, guest failure, and Rust runtime drop invalidate handles and release stored callbacks. Slots are cleared on release and reused after the outer guest call returns; cached wrappers retain no application callbacks. Closing notifications may update host data, and cancellation while closing only releases host records.

Native query, start, and early exec code continues reading the current animation after the callback returns. Managed cancellation of active animations is rejected during those phases and terminal notifications; cancelling the already finishing animation is harmless. Ordinary tick exec callbacks can cancel themselves or other animations. The SDK rejects `lv_anim_refr_now` and `lv_anim_delete_all` inside animation callbacks. Raw callers must not delete the current animation, its `var` object or ancestors during query/start/early exec, or mutate animation lists from terminal notifications. Callback pointers and any external-data slot on a managed animation belong to the bridge and must not be replaced or copied into another descriptor.

Animation creation requires `lvw_anim_start`, `lvw_anim_delete`, `lvw_anim_exec`, and the exported growable `__indirect_function_table`. Missing capabilities are reported before registration. The core imports `lvw.anim_exec(id, animation, value)`, `lvw.anim_query(id, animation, kind)`, `lvw.anim_notify(id, animation, kind)`, and `lvw.anim_release(id)`. Query kinds are 1 for path and 2 for get-value; notification kinds are 1 for start, 2 for completed, and 3 for deleted. The bridge keeps ABI 1 and existing signatures. Exporting the table also retains libc's WASI `fd_seek` import; browser hosts report unseekable standard streams, and the Rust host uses its WASI implementation.

### Native observers

`observe` subscribes to a native subject and invokes its handler synchronously before returning. Subject creation, values, previous values, buffers, and groups use the generated `lv_subject_*` functions. Observer `user_data` is independent of registration identity. LVGL 9.6.0 exposes getters and setters; 9.0.0 exposes the public struct field through the generated layout.

LVGL 9.0.0 requires caller-allocated `LV_SUBJECT_T_SIZE` storage initialized with `lv_subject_init_*`; its subject create/delete/deinit APIs are absent. Remove all observers and widget bindings before freeing or reinitializing that storage. Integer assignment notifies even when the value is unchanged. The examples below use the 9.6.0 subject allocation API.

```ts
import { LV_SUBJECT_TYPE_INT } from "./target/typescript/index.js";

const api = runtime.unsafe;
const subject = api.lv_subject_create(LV_SUBJECT_TYPE_INT);
if (!subject) throw new Error("subject allocation failed");
const observer = runtime.observe(subject, (_current, source) => {
  api.lv_obj_set_x(button.handle, api.lv_subject_get_int(source));
});
api.lv_subject_set_int(subject, 40);
observer.cancel();
api.lv_subject_delete(subject);
```

```rust
use liblvgl_wasm_host::{UnsafePointer, values};

let subject = runtime.raw()?.lv_subject_create(values::LV_SUBJECT_TYPE_INT)?;
let observer = runtime.observe(subject, UnsafePointer(0), move |context, _current, source| {
    let mut api = context.raw()?;
    let x = api.lv_subject_get_int(source)?;
    api.lv_obj_set_x(button, x)
})?;
runtime.raw()?.lv_subject_set_int(subject, 40)?;
runtime.cancel_observer(&observer)?;
runtime.raw()?.lv_subject_delete(subject)?;
```

TypeScript handlers receive `(observer, subject)`; Rust handlers receive `(context, observer, subject)` and return `Result<()>`. `Observer.handle` / `pointer()` is available during the initial callback. Ordinary observers can cancel themselves during that callback; the registration call then returns an already invalid handle. Value changes retain native notification rules. Creating another observer on the same subject and updating a different subject can invoke handlers on the same stack. TypeScript rejects thenables; Rust handlers must release application locks before guest calls.

`observeTarget` / `observe_target` stores an arbitrary target pointer without tying the registration to an object. `observeObject` / `observe_object` ties it to native object cleanup. TypeScript requires a live `ObjectRef` from the same runtime; Rust object pointers retain the raw caller's ownership obligations.

Individual cancellation of a non-null object-bound observer is rejected with a recoverable error because native deletion affects shared widget event bindings. Delete the object, use available subject cleanup, or call `lv_obj_remove_from_subject(object, subject)` to remove all bindings for that pair. On 9.0.0 use `lv_subject_remove_all_obj(subject, object)`; the adapted implementation preserves other subjects and unrelated events and removes slider bindings as well. Raw 9.6.0 `lv_observer_delete` retains the shared-binding side effect; raw 9.0.0 `lv_observer_remove` must only remove observers without object bindings, because it leaves the object's deletion event attached. Ordinary cancellation is idempotent; native observer deletion, available subject cleanup, shutdown, failure, and Rust runtime drop invalidate managed handles and release handlers.

`cmake/observer.cmake` verifies the source SHA-256 before adapting either the 9.0.0 `src/others/observer` implementation or the 9.6.0 `src/core` implementation. The bridge selects the native deletion function from that verified source. Both archives notify `lvw_observer_release_native` before freeing an observer; source checkouts remain unchanged.

Raw calls must not recursively notify a subject already being notified, including indirect cycles, or delete, deinitialize, or reinitialize its storage during notification. Subject, target, and user-data pointers must remain valid for their native uses. The observer adapter does not replace these raw preconditions. Closing suppresses observer user notifications; cancellation while closing releases only host records.

The core imports `lvw.observer(id, observer, subject)` and `lvw.observer_release(id)`. Registration requires `lvw_observer_create` and `lvw_observer_delete`; older bridge-compatible cores can still load, but missing observer capabilities are reported before registration. ABI 1 and existing signatures are unchanged. Native function-pointer entry points, `lv_obj_bind_*` setter callbacks, subject destructor callbacks, and variadic functions retain their reported binding status.

### Native image decoders

TypeScript `runtime.createImageDecoder(callbacks, userData = 0)` and Rust `create_image_decoder(user_data, ImageDecoderCallbacks)` register a native image decoder. `info` and `open` are required; `getArea` / `get_area` and `close` are optional. `ImageDecoder.handle` / `pointer()` returns its native pointer. Cancellation uses `decoder.cancel()` or `runtime.cancelImageDecoder(decoder)` in TypeScript and `cancel_image_decoder(&decoder)` in Rust.

| Callback | Arguments after the Rust execution context | Result |
| --- | --- | --- |
| `info` | Borrowed session, writable image header pointer | `LV_RESULT_OK` to accept the format, `LV_RESULT_INVALID` to try another decoder |
| `open` | Borrowed session | `LV_RESULT_OK` after preparing complete or incremental decoding; `LV_RESULT_INVALID` on failure |
| `getArea` / `get_area` | Borrowed session, full area pointer, writable decoded area pointer | `LV_RESULT_OK` for a decoded area; `LV_RESULT_INVALID` when finished |
| `close` | Borrowed session | No value; Rust returns `Result<()>` |

Rust handlers receive `&mut CallbackContext` before these arguments and return `Result<i32>` for the three queries. Build their callbacks with `ImageDecoderCallbacks::new(info, open).get_area(handler).close(handler)`. `LV_RESULT_OK` is `1` and `LV_RESULT_INVALID` is `0`. A rejected format is normal control flow. An accepted format whose `open` fails does not fall back to another decoder and does not receive an automatic `close`; the open handler must release its partial allocations.

`DecoderSession.read()` in TypeScript and `read(context)` in Rust return a `DecoderView` snapshot containing the source/type, header pointer, decoded draw buffer, palette, session and decoder user data, file pointer, decoding argument flags, timing, error message pointer, and phase. `write(output)` / `write(context, output)` publish a `DecoderOutput` during open, area, or close. Set `decoded` to a native `lv_draw_buf_t` created or initialized with the generated draw-buffer API. Output fields also include palette/count, session user data, open time, and error message; omitted TypeScript fields and Rust `Default` fields are zero. Writes replace those output fields rather than merging them.

The session is borrowed only during its callback. Reads and writes require the current innermost session and the owning runtime; nested callbacks restore the outer session when they return. Pointer values in a copied view do not extend guest storage lifetimes. The info callback's header is its actual output argument, which can differ from the session's internal header. A nonzero file pointer is usable only during file info; open the source separately for later reads. Info runs before the requested decoding arguments are copied. Argument bits are `1` for stride alignment, `2` for premultiplication, `4` for no decoded cache, `8` for indexed pixels, and `16` for cache flushing.

LVGL 9.0.0 passes a source pointer to info instead of a decoder session. Its adapter provides a callback-local descriptor for the host view, with the real source/type and output header. `file` is zero; open and close the source explicitly with the generated filesystem API when reading its header. The cache-flush argument is absent and its flag remains zero. Native open/area/close descriptors retain their original layout and lifetimes. The fixed-source adaptation releases the copied file path when open fails and clears cached headers before managed cancellation. Both versions notify the bridge on native deletion and decoder deinitialization; source checkouts remain unchanged.

For complete images, open publishes a draw buffer containing the decoded pixels. For incremental images, open leaves `decoded` zero; each area callback publishes the buffer for its returned rectangle. The first decoded-area input contains `LV_COORD_MIN` coordinates. Native incremental drawing does not support scaling or rotation. `info` must not retain resources expecting a later close. Buffers, palettes, and session-owned allocations remain the application's responsibility: release them in close after a successful open, or before returning failure from open. Reusable application-owned buffers can outlive individual sessions.

Managed decoders do not insert their buffers into LVGL's decoded-image cache. Native decoders retain their own cache behavior. File header caching is supported; managed cancellation invalidates header entries before deleting a decoder. Cancellation is idempotent and rejects foreign handles, any active decoder callback, and a decoder with an open session. Native deletion, shutdown, failure, and Rust runtime drop invalidate managed handles and release handlers. Raw callers must close externally opened sessions before shutdown; shutdown does not dereference saved session pointers to run cleanup.

Use managed cancellation to unregister decoders that may have cached headers. Raw deletion requires no active session or header-cache reference; its release notification only invalidates host handles and handlers. Do not replace managed callback pointers, add a managed decoder to the decoded-image cache, recursively operate on the same session, or manually deinitialize a managed runtime. Pointer bounds, image header fields, draw-buffer geometry, and palette contents retain their native preconditions. TypeScript rejects thenables and query results other than `0` or `1`; Rust rejects other query results. Callback failures poison the runtime through the existing guest-call guards.

The core imports `lvw.decoder_info`, `lvw.decoder_open`, `lvw.decoder_area`, `lvw.decoder_close`, and `lvw.decoder_release`. Creating a decoder requires `lvw_decoder_create`, `lvw_decoder_delete`, `lvw_decoder_read`, and `lvw_decoder_write`; older cores can load and report missing capabilities before registration. The snapshot protocol is a 64-byte version-1 record defined in `bridge/lvw.h`. Existing ABI 1 signatures remain unchanged. Direct function-pointer setters retain their unsupported raw-binding classification.

### Constants and layouts

TypeScript exports constants and layouts from the SDK entry point; Rust exposes them through `liblvgl_wasm_host::values`. Integer constants retain their target C values. TypeScript uses `number` up to 32 bits and `bigint` for wider integers; Rust uses the corresponding signed or unsigned integer type. For example, `LV_ANIM_REPEAT_INFINITE` remains `4294967295`; a Rust raw method with an `i32` parameter needs an explicit `as i32` conversion.

String constants such as `LV_SYMBOL_OK` are immutable byte sequences, including their recorded NUL bytes. They can be copied directly into guest memory. Non-UTF-8 bytes and embedded NULs are preserved; C string calls stop at the first NUL.

```ts
import { LV_COLOR_T_SIZE, LV_PART_MAIN } from "./target/typescript/index.js";

const api = runtime.unsafe;
const color = api.lvw_alloc(LV_COLOR_T_SIZE);
if (!color) throw new Error("allocation failed");
api.lv_color_hex(color, 0x123456);
api.lv_obj_set_style_bg_color(button, color, LV_PART_MAIN);
api.lvw_free(color);
```

```rust
use liblvgl_wasm_host::values::{LV_COLOR_T_SIZE, LV_PART_MAIN};

let mut api = runtime.raw()?;
let color = api.alloc(LV_COLOR_T_SIZE)?;
api.lv_color_hex(color, 0x123456)?;
api.lv_obj_set_style_bg_color(button, color, LV_PART_MAIN)?;
api.free(color)?;
```

Named LVGL types provide `_STATUS`, and complete types provide `_SIZE` and `_ALIGN` in bytes. Complete records also provide `_FIELDS` with field names, type IDs, bit offsets, and optional bit widths. Typedef layouts retain their own alignment. Tag names use `STRUCT_` or `UNION_` prefixes; aliases use their uppercase names. Anonymous fields retain null names. Bitfields require masks or C wrappers. Opaque types such as `lv_obj_t` expose a status without a size, alignment, or field table.

Use these values with the matching generated API. TypeScript checks `valuesIdentity` against the raw binding identity before exposing `unsafe`; Rust emits both in the same generated file. Values are separate static exports, so importing a constant does not require the full field inventory. Function macros, empty macros, and unsupported expressions remain classified in `api.json` without fabricated SDK values.

## Interface

The bridge ABI version is `1`. A Wasm instance owns one LVGL runtime and may create multiple displays. `lvw_step(elapsed_ms, out_result_ptr)` advances LVGL time and writes the next timer interval and frame count into `lvw_step_result_t`. Frames use XRGB8888 bytes in blue, green, red, unused order. Hosts must read or copy frame data before a call that can change the framebuffer. Each host must call `_initialize` before `lvw_init`.

`lvw_timer_create(period_ms, user_data, callback_id)` returns a native timer pointer, or `0` for an uninitialized runtime, zero or duplicate active callback ID, or allocation failure. `lvw_timer_delete(timer, callback_id)` matches both pointer and ID; it returns `0` when the pair is already absent, `-1` before initialization, and `-2` for zero arguments. Host IDs must be nonzero `u32` values and must not be reused during an instance's lifetime.

`lvw_event_remove(object, callback_id)` removes event descriptors registered by `lvw_event_add` for that object and callback ID. It returns `0` even when no matching descriptor remains, `-1` before initialization, and `-2` for a zero object or ID. The object must still be valid in that instance; raw hosts retain responsibility for its lifetime.

The generated API report classifies declarations as `direct_export`, `abi_shim`, `compile_disabled`, or `unsupported`. Direct functions keep their `lv_*` export names. Aggregate values and inline functions use generated `lvw_api_lv_*` wrappers: aggregate arguments are pointers into Wasm memory, and aggregate returns use an output pointer. Aggregate classification uses canonical types, including qualified records and typedef chains; wrapper storage preserves the record layout while removing top-level C qualifiers. `target/wasm/api.json` records each export name, wrapper signature, and unsupported reason. Installing host callbacks through raw function pointers and calling variadic functions remain unsupported by the generator. TypeScript and Rust provide typed raw calls for all supported APIs.

The report also includes `constants` and `constant_summary` for active `LV_*` and `LVGL_*` enums and macros visible through the configured public header. Values are evaluated by the same Wasm target compiler as the core. Integers include the C type, bit width, signedness, and a decimal string value to preserve 64-bit precision. Strings include exact bytes in `bytes_hex`, their length and termination flag, and UTF-8 text when valid. Function macros, empty macros, and unsupported expressions have separate classifications; symbol addresses require an instance-specific accessor and are not exported as numeric constants. Private `_LV_*` names and declarations hidden by disabled configuration are outside this inventory. Function counts in `summary` remain separate from constant counts.

`types` describes the types reachable from public function declarations, including aliases, pointers, arrays, records, enums, and callback signatures. Each reference contains a stable `id` and its C qualifiers. Complete object layouts record byte sizes and alignments; record fields record bit offsets and optional bit widths. Opaque records, incomplete arrays, functions, and `void` have explicit layout statuses and null sizes. Hosts must use the target layouts when allocating aggregate values; `lv_color_t`, for example, occupies three bytes. Bitfields require masks or accessors, and opaque records expose no fields. `function_types` records both declared C signatures and canonical signatures with adjusted array and function parameters. These are C type descriptions, not Wasm function signatures. `type_summary` counts nodes, record layout statuses, and bitfields. The generator rejects disagreement between the compiler inventories and omits machine-specific paths from identifiers.

Each supported declaration has a `wasm_signature` with the parameter and result types emitted by the target compiler. Aggregate shims record their exported wrapper ABI. A separate compilation of function-address probes supplies these signatures; the build checks every supported API against the linked core before building host bundles. `i64` values require `bigint` in JavaScript. Unsupported declarations have null signatures. `api-verification.json` records the SHA-256 of both inputs and the number of verified API exports; failed builds clear the previous verification record. Bridge exports and `_initialize` are outside this API count. The quality checks also link a generated consumer against every supported export, letting the Wasm engine check the metadata independently.

`callback_types` records the target Wasm signature of each function-pointer typedef reachable in the type graph, keyed by its alias type ID. Each entry includes a `function_type` reference and a compiler-derived `wasm_signature`; `callback_summary` counts typedefs, C function types, and distinct Wasm signatures. The generator compiles typedef address probes with the configured SDK and validates their complete import inventory. Quality checks link typed Wasm functions against that compiler output. Anonymous function pointers are outside this typedef inventory. A recorded signature describes the calling convention; it does not install host callbacks or change the corresponding API's support classification.

## Software rendering

The software configuration enables PNG, BMP, GIF, SVG geometry, Lottie playback, TinyTTF, FreeType fonts, and ThorVG vector rendering. Native windows and hardware drawing backends are disabled. The Wasm linear memory maximum is 256 MiB.

### PNG resources

The built-in LodePNG decoder reads uploaded `W:` resources. TypeScript and Rust checks use the same PNG files and source pixels in `tests/fixtures/png/`: RGB8, RGBA8, packed indexed color with `tRNS` transparency, and Adam7 interlacing. Rendering preserves opaque pixels and composites transparent pixels onto the display background; the XRGB8888 display output is opaque.

```ts
runtime.putResource("icon.png", pngBytes);
const image = runtime.createImage(runtime.screen(display));
runtime.setImageSource(image, "W:icon.png");
runtime.step(33);
```

Upload copies the supplied bytes. Resource names cannot be replaced, resources can be shared by multiple images, and deleting an image does not remove its resource. Uploaded resources remain available until runtime shutdown. Rust uses `lvw_resource_put` and the generated `lv_image_create` / `lv_image_set_src` methods for the same path.

This decoder rejects 16-bit-per-channel PNG. Decoding reads the complete file and allocates the complete pixel buffer, so compressed file size does not describe its memory cost. PNG profiles and gamma metadata do not apply color correction. Setting a source or reading its header only establishes the initial format and dimensions; corrupt CRCs or truncated pixel data can fail later during rendering. Failed decoding leaves the image undrawn, and assigning a valid source restores rendering without recreating the runtime.

### GIF playback

GIF playback uses `lv_gif_create` and `lv_gif_set_src`, available through the generated TypeScript and Rust raw APIs. Upload the GIF as a `W:` resource before setting its source. Native C code uses the same functions:

```c
lv_obj_t * gif = lv_gif_create(lv_screen_active());
lv_gif_set_src(gif, "W:animation.gif");
lv_gif_set_loop_count(gif, 0);
```

The GIF widget borrows its source pointer. Keep a guest filename allocation, or a variable image descriptor and its GIF bytes, alive until the source is replaced or the widget is deleted. `lv_gif_is_loaded` reports whether the source opened; it does not validate every subsequent frame. Clearing the source or failing to open a replacement stops playback; a valid replacement can then load on the same widget.

Setting a source decodes its first frame synchronously. `step(ms)` advances the clock and runs the timer handler once; use steps no larger than the desired frame interval for playback. A large step does not replay every missed frame. `lv_gif_get_frame_count` scans the resource while preserving playback position. The native frame index starts at `1` after the first frame and returns to `0` when the last frame is decoded.

`lv_gif_set_loop_count(gif, 0)` repeats indefinitely; a positive count limits the number of playback cycles. `LV_EVENT_READY` fires when the last frame is decoded, after updating its pixels and loop state. Its handler can delete the widget, replace its source, pause, or restart playback. A single-frame GIF can deliver this event inside `lv_gif_set_src`. `lv_gif_restart` rewinds, clears the canvas, and resets the loop count to `-1`; set the required loop count again. Pause/resume preserves the timer's elapsed time.

Both hosts verify the same three-frame resource with distinct 80/120/160 ms delays, palette transparency, and disposal mode 2, plus a single-frame resource for synchronous completion. Disposal mode 3 (restore to previous) is unsupported. Automatic pausing when invisible requires an explicit resume after showing the widget. GIF decoding is synchronous, and `is_loaded` or `READY` is not a full-file integrity check.

### TinyTTF fonts

The generated TypeScript and Rust APIs expose `lv_tiny_ttf_create_data`, `lv_tiny_ttf_create_data_ex`, `lv_tiny_ttf_set_size`, and `lv_tiny_ttf_destroy`. Copy a complete TrueType font into guest memory and keep that allocation alive while any font created from it exists. A font can be shared by multiple labels; creating a label does not transfer ownership of the font.

```ts
import { LV_PART_MAIN, LV_STYLE_TEXT_FONT } from "./target/typescript/index.js";

const raw = runtime.unsafe;
const bytes = new Uint8Array(await (await fetch("fonts/app.ttf")).arrayBuffer());
const data = raw.lvw_alloc(bytes.length);
if (!data) throw new Error("Cannot allocate font data");
new Uint8Array(raw.memory.buffer, data, bytes.length).set(bytes);
const font = raw.lv_tiny_ttf_create_data(data, bytes.length, 24);
if (!font) {
  raw.lvw_free(data);
  throw new Error("Cannot load font");
}
const label = runtime.createLabel(screen);
raw.lv_obj_set_style_text_font(label.handle, font, LV_PART_MAIN);
runtime.setText(label, "Hello");
runtime.step(33);

raw.lv_tiny_ttf_set_size(font, 32);
raw.lv_obj_refresh_style(label.handle, LV_PART_MAIN, LV_STYLE_TEXT_FONT);
runtime.step(33);

label.delete();
raw.lv_tiny_ttf_destroy(font);
raw.lvw_free(data);
```

Font size is measured against the font's units per em; line height and baseline also depend on its vertical metrics. Changing size clears glyph, bitmap, and kerning caches. Refresh each label that uses the changed font so its layout is recalculated. The `_ex` constructor accepts a kerning mode and a glyph/bitmap cache entry count; a count of zero disables those two caches, while the separate kerning cache remains enabled.

Release any manually acquired glyph draw data before changing size or destroying a font. Remove all label, style, and fallback references before calling `lv_tiny_ttf_destroy`; then free its borrowed bytes. Deleting labels or shutting down LVGL does not automatically destroy fonts created through these raw constructors. A fallback font must remain alive until its references and acquired glyphs have been released.

Both hosts check geometric glyph pixels, fractional coverage, composite characters, kerning, fallback resolution, size changes, and shared font lifetimes. The default configuration disables TinyTTF file streaming, so `lv_tiny_ttf_create_file` is absent. The enabled memory parser ignores `data_size` and does not validate arbitrary malformed or truncated fonts; provide valid, complete font data. OpenType shaping is not supplied by this API.

### FreeType fonts

FreeType reads uploaded fonts through `W:` resources. The generated TypeScript and Rust APIs expose `lv_freetype_font_create`, `lv_freetype_init_font_info`, `lv_freetype_font_create_with_info`, and `lv_freetype_font_delete`. Runtime initialization and shutdown manage the FreeType library; application-created fonts require explicit deletion.

```ts
import {
  LV_FREETYPE_FONT_RENDER_MODE_BITMAP, LV_FREETYPE_FONT_STYLE_NORMAL, LV_PART_MAIN,
} from "./target/typescript/index.js";

runtime.putResource("app.ttf", fontBytes);
const raw = runtime.unsafe;
const pathBytes = new TextEncoder().encode("W:app.ttf\0");
const path = raw.lvw_alloc(pathBytes.length);
if (!path) throw new Error("Cannot allocate font path");
new Uint8Array(raw.memory.buffer, path, pathBytes.length).set(pathBytes);
const font = raw.lv_freetype_font_create(path, LV_FREETYPE_FONT_RENDER_MODE_BITMAP, 32, LV_FREETYPE_FONT_STYLE_NORMAL);
raw.lvw_free(path);
if (!font) throw new Error("Cannot load font");
const label = runtime.createLabel(screen);
raw.lv_obj_set_style_text_font(label.handle, font, LV_PART_MAIN);
runtime.setText(label, "Hello");
runtime.step(33);

label.delete();
raw.lv_freetype_font_delete(font);
```

Resource upload copies the font bytes, and font creation copies its path. Resources remain available until shutdown. Fonts using the same path, style, render mode, and weight share a face and caches; create separate fonts for different sizes. Remove all label, style, and fallback references and release manually acquired glyph draw data before deleting a font. Deleting a label does not delete its font.

The simple constructor disables kerning. To enable it, initialize an `lv_font_info_t`, set its `name`, `size`, and `kerning = LV_FONT_KERNING_NORMAL`, then call `lv_freetype_font_create_with_info`; generated layouts describe this structure. `lv_font_set_kerning` can toggle a font created with kerning enabled. FreeType's hinted metrics and small-size kerning can differ from TinyTTF.

Both hosts verify TrueType glyph metrics, fractional bitmap coverage, composite characters, fallback, different sizes sharing a face, and recovery after missing or malformed font resources. Bitmap rendering does not synthesize bold outlines for ordinary non-variable fonts. Embedded PNG glyphs, WOFF2, and complex text shaping are not provided by this configuration.

Use `LV_FREETYPE_FONT_RENDER_MODE_OUTLINE` to render glyph paths through ThorVG. For `lv_font_info_t`, set `render_mode` to this value before creation. Outline and bitmap fonts can coexist, including fallback chains across modes. Outline checks cover TrueType quadratic curves, OpenType/CFF cubic curves, fractional pixel coverage, text opacity, shared paths, and 16, 17, and 32 pixel sizes. The software renderer uses the exact size ratio; the public `lv_freetype_outline_get_scale` still returns an integer F26DOT6 ratio and can lose precision.

Outline glyph draw data is a borrowed native vector path, not an A8 bitmap or `lv_draw_buf_t`. Refresh a label before manually acquiring outline draw data so that the software renderer has installed its native outline callback. Release it with `lv_font_glyph_release_draw_data` using the same glyph descriptor before deleting any referenced font. Do not replace the renderer's callback with `lv_freetype_outline_add_event`. Runtime initialization and shutdown form one lifecycle; raw deinitialization and reinitialization inside the same runtime are not supported.

### Vector drawing

The software backend uses ThorVG 0.15.3 from the pinned LVGL archive, with one draw unit and no worker threads. Generated TypeScript and Rust methods expose the original `lv_vector_path_*`, `lv_draw_vector_dsc_*`, `lv_draw_vector`, and `lv_matrix_*` APIs. A native C draw callback can submit paths directly:

```c
static void draw_vector(lv_event_t *event) {
    lv_draw_vector_dsc_t *draw = lv_draw_vector_dsc_create(lv_event_get_layer(event));
    lv_vector_path_t *path = lv_vector_path_create(LV_VECTOR_PATH_QUALITY_HIGH);
    lv_vector_path_append_rectangle(path, 8.0f, 12.0f, 32.0f, 20.0f, 0, 0);
    lv_draw_vector_dsc_set_fill_color(draw, lv_color_hex(0xd45024));
    lv_draw_vector_dsc_set_stroke_opa(draw, LV_OPA_TRANSP);
    lv_draw_vector_dsc_add_path(draw, path);
    lv_vector_path_delete(path);
    lv_draw_vector(draw);
    lv_draw_vector_dsc_delete(draw);
}

/* Register on the object that owns the drawing. */
lv_obj_add_event_cb(object, draw_vector, LV_EVENT_DRAW_MAIN_END, NULL);
```

In host callbacks, obtain the event with TypeScript `runtime.eventPointer()` or Rust `context.event_pointer()`, then use `lv_event_get_layer`. The layer is borrowed only for that synchronous draw event. Drawing callbacks must obey the object and layout restrictions described under native drawing events.

`lv_draw_vector_dsc_add_path` copies the path and current drawing state. Gradient stops are copied by the setter. Source paths can be cleared or deleted after insertion, and a descriptor can be deleted after `lv_draw_vector` submits its tasks. Image fill descriptors still borrow their image source through rendering. Delete unused descriptors to release their pending tasks.

Both hosts verify actual framebuffer pixels for solid and antialiased paths, alpha compositing, nonzero/even-odd fills, fractional transforms, and two-stop linear gradients. The fixed backend uses integer opacity and gradient quantization: solid fill opacity mixes the color alpha and requested opacity with a right shift by eight, including `255 × 255 → 254`. Blend modes `SRC_IN`, `DST_OVER`, `DST_IN`, and `SUBTRACTIVE` fall back to normal blending in this backend.

`LV_USE_FLOAT=1` makes `lv_value_precise_t` and the coordinate fields of `lv_point_precise_t` floating-point values; arc angle arguments and results use `f32`. Regenerate bindings when changing this configuration and keep the generated core identity checks enabled. `lv_matrix_transform_point` preserves fractional coordinates; `lv_matrix_transform_precise_point` rounds its result despite the floating-point fields.

ThorVG is distributed under its [MIT license](third_party/thorvg/LICENSE.txt), with component notices in [NOTICES.txt](third_party/thorvg/NOTICES.txt). Its enabled loaders include RapidJSON 1.1.0, Samsung MIT and EFL BSD code, and an MPL-2.0 interpolation source. Preserve the complete `third_party/thorvg/` directory, including both additional license texts and the supplied interpolation source, when distributing the core or C demo.

### SVG geometry

SVG uses LVGL's native parser and vector renderer with ThorVG rasterization. Upload an `.svg` file as a `W:` resource, then use the ordinary image APIs. Native C code calls:

```c
lv_obj_t * image = lv_image_create(lv_screen_active());
lv_image_set_src(image, "W:artwork.svg");
```

The generated TypeScript and Rust APIs also expose `lv_svg_load_data`, `lv_svg_node_create`, `lv_svg_node_delete`, and `lv_draw_svg`. Loading a document copies its parsed data; the input bytes may be released after loading returns. Pass the document to `lv_draw_svg` only with a layer borrowed from the current synchronous drawing event. Submitted vector tasks retain their geometry, so the document may be deleted after that call. Keep a document alive if it will be used for later redraws.

Both hosts check rectangles, straight and quadratic/cubic paths, group translation, viewBox scaling with `preserveAspectRatio="none"`, nonzero/even-odd fills, fill opacity, and two-stop linear gradients against mathematical pixel bounds. ViewBox scaling is independent of XML attribute order. Percentage gradient stops are normalized to `0..1`. The decoder reads the complete file to determine its dimensions, including roots whose attributes exceed 512 bytes; invalid roots, mismatched tags, incomplete documents, and multiple roots are rejected. Empty closed and self-closing roots are accepted. A valid replacement renders on the same image after a failed source.

Uploaded resource bytes remain available until shutdown, and file paths are copied by `lv_image_set_src`. Variable image descriptors and their SVG bytes are borrowed: keep both alive until the image source is replaced or the image is deleted. The default image and header caches are disabled. File dimensions come from the parsed viewport; variable sources retain the descriptor's dimensions. Image width is limited to 16,383 and height to 65,535 by the header's 16-bit ARGB stride and dimension fields.

SVG image transforms preserve the final scaled pixel cells and use the current layer's clip. Both hosts verify scale, unequal scale, quarter-turn rotation, custom pivots, parent clipping, transparent child layers, and drawing with no object attached to the image descriptor. Transformed image bounds include a rounding margin for drawing and invalidation. SVG source coordinates stay unchanged until the vector transform; child layers use absolute coordinates.

SVG text and embedded images have no rendering callbacks installed. Preserve-aspect-ratio meet/slice, group opacity, gradient transforms, spread modes, and external resources are unsupported. The parser accepts a subset of XML syntax. Fixed-source adaptations in `cmake/svg.cmake` operate on build-directory copies; the pinned LVGL source remains unchanged.

### Lottie playback

Lottie uses the pinned ThorVG 0.15.3 loader and LVGL animation clock. The generated TypeScript and Rust APIs expose the original `lv_lottie_*` names. Upload a JSON resource, allocate a pixel buffer, and set the source with native C calls:

```c
lv_draw_buf_t * pixels = lv_draw_buf_create(32, 24, LV_COLOR_FORMAT_ARGB8888, 0);
if(pixels) {
    lv_obj_t * lottie = lv_lottie_create(lv_screen_active());
    lv_lottie_set_draw_buf(lottie, pixels);
    lv_lottie_set_src_file(lottie, "W:animation.json");

    /* Keep lottie and pixels alive during playback. On removal: */
    lv_obj_delete(lottie);
    lv_draw_buf_destroy(pixels);
}
```

Both `lv_lottie_set_src_data` and `lv_lottie_set_src_file` read and parse the complete JSON synchronously. Shape type fields may appear after their properties. Data input is copied; its guest allocation can be released after the call. A temporary filename can also be released after the file setter returns. File loading uses LVGL resource drivers, including `W:`, without host filesystem imports. Uploaded resource bytes remain available until shutdown. A successful replacement displays its first frame, resets the clock, and resumes playback. A failed load retains the existing scene and timing; these void setters have no success result.

The caller owns the pixel storage. `lv_lottie_set_buffer` needs enough space for the configured alignment and stride; `lv_lottie_set_draw_buf` accepts an initialized ARGB8888 or ARGB8888_PREMULTIPLIED draw buffer with a nonzero size and stride divisible by four, then marks its output as premultiplied. Invalid target dimensions or stride leave the existing canvas unchanged. Keep the active buffer alive until replacement or widget deletion, then release it. Rebinding a buffer preserves the current frame and playback position. Buffer dimensions determine the rendered size.

`lv_lottie_get_anim` returns a borrowed native animation pointer. Use it for `lv_anim_pause`, `lv_anim_resume`, duration, repeat count, and repeat delay controls. Do not copy/start that descriptor or replace its variable and private callbacks. Playback repeats indefinitely by default. A finite repeat count includes the current pass; on completion the animation is removed and the getter returns null. A successful source assignment then creates another animation. Discard earlier borrowed pointers after completion, deletion, or widget removal. The final visible frame precedes the composition's exclusive out frame; repeat delay holds that final frame before restarting.

`step(ms)` advances the clock and performs one timer-handler pass; it does not replay every missed frame. Both hosts verify the same original rectangle animation against independently calculated position, opacity, and composited pixels, including pause/resume, repeat delay, finite completion, source replacement, truncated-input recovery, shared resources, and buffer ownership. Expressions are disabled. External assets, fonts, effects, and general Lottie format conformance are outside this verified playback contract. Fixed-source adaptations in `cmake/lottie.cmake` operate only on build-directory copies.

### FreeType license

Portions of this software are copyright © 2026 The FreeType Project (https://freetype.org). All rights reserved. FreeType is used under the [FreeType License](third_party/freetype/FTL.TXT); [additional notices](third_party/freetype/NOTICES.txt) cover its included components. Preserve these notices when distributing the core or C demo.

The build excludes FreeType's default system implementation, selects LVGL's allocator and resource streams, disables environment properties, and uses standard Wasm exception handling. FreeType source files are unchanged.
