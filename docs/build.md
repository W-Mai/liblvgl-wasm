# Build and package liblvgl-wasm

To try LVGL without installing a compiler, [open Studio](https://w-mai.github.io/liblvgl-wasm/studio/). Build locally to change the LVGL configuration, link C code with LVGL, or run a host outside the browser.

## Build Studio locally

From the repository root, you need Python 3.9+, CMake 3.25+, Ninja, Bun, and Rust with rustup. The tool installer supports macOS arm64 and Linux x86_64. On Ubuntu, install `libtinfo6`, `libstdc++6`, and `libgcc-s1` so Python can load the compiler's shared libraries.

```sh
rustup toolchain install 1.92.0 --profile minimal --target wasm32-unknown-unknown
bun install --frozen-lockfile
python3 toolchains/lvw.py prepare
```

`prepare` installs wasi-sdk 34 and wasm-tools under `target/toolchains/` and prints their directories. Set the paths below to those two directories (or select an existing wasi-sdk 34 with `WASI_SDK_PATH`).

```sh
export WASI_SDK_PATH=/path/to/wasi-sdk
export PATH="/path/to/wasm-tools-directory:$PATH"
export RUSTUP_TOOLCHAIN=1.92.0
./scripts/build.sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Open [localhost:8765/studio/](http://127.0.0.1:8765/studio/). The build downloads the default LVGL and FreeType sources and creates the core, bindings, Studio, and sample apps under `target/`. The core is `target/wasm/liblvgl.wasm`; its functions, constants, and type layouts are in `target/wasm/api.json`.

## Build a different core

For a core without the website or host packages, run `./scripts/build-core.sh`. To select another LVGL v9 source tree, inspect its version and enabled features, then build it in its own output directory:

```sh
python3 toolchains/lvw.py inspect-lvgl --source /path/to/lvgl --config config/base/lv_conf.h --json
LVGL_SOURCE_DIR=/path/to/lvgl LVGL_CONFIG_PATH=config/base/lv_conf.h \
    LVW_BRIDGE_FEATURES='' LVW_BUILD_DIR=target/custom ./scripts/build-core.sh
```

This produces `target/custom/liblvgl.wasm` with the base bridge for displays, input, events, resources, and frame access. Use it as a custom core in [Studio](studio.md). The full build uses [config/lv_conf.h](../config/lv_conf.h) and adds the managed callback adapters: `timer;animation;observer;decoder`. Select the adapters your host uses; a source change may require a different adapter.

| Capability | Supported source revisions |
| --- | --- |
| Base bridge and managed callback adapters | 9.0.0, 9.1.0, 9.2.2, 9.3.0, 9.4.0, 9.5.0, 9.6.0 |
| PNG | 9.0.0, 9.1.0, 9.2.2, 9.6.0 |
| GIF, TinyTTF, FreeType bitmap fonts, vector drawing | 9.0.0, 9.1.0, 9.6.0 |
| FreeType outlines, SVG, Lottie | Default 9.6.0 configuration |

To use the core as a library in an isolated [multi-module project](modules.md), build the bounded variant with `LVW_BUILD_DIR=target/custom ./scripts/build-bounded-core.sh`. It writes `liblvgl-bounded.wasm` and its own signature report. Its function table has a fixed size; use the ordinary core for managed animations that allocate callback slots.

## Link a native app

Use the NDK to compile C or C++ against LVGL headers and link both into one Wasm module. A complete [C example](../examples/c/direct_api.c) registers a native event callback and changes a label when the button is clicked.

```sh
python3 toolchains/lvw.py export-ndk
cmake -S target/ndk/examples/c -B target/native-c -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK_PATH/share/cmake/wasi-sdk-p1.cmake" \
    -DCMAKE_PREFIX_PATH="$PWD/target/ndk" -DCMAKE_BUILD_TYPE=Release
cmake --build target/native-c
```

The result, `target/native-c/lvgl_native_example.wasm`, contains LVGL and the demo. A host creates a display and calls the module's exported `lvw_demo_create(display)`. In a CMake project, enable C and C++, call `find_package(liblvgl-wasm CONFIG REQUIRED)`, then `lvw_add_reactor(my_app main.c)`. Use the same helper with a `.cpp` file for C++.

For Zig, run `python3 toolchains/lvw.py prepare --with-zig`. Configure `target/ndk/examples/zig` instead of the C example and pass `-DLVW_ZIG=/path/to/zig` with the executable from that installation. The [Zig example](../examples/zig/) calls LVGL through its C ABI.

## Export a development package

From a clean checkout with the build dependencies installed:

```sh
python3 toolchains/lvw.py export-package --output target/package
python3 toolchains/lvw.py verify-package --package target/package
```

The resulting directory can be copied to another machine. After unpacking, run `python3 package/source/toolchains/lvw.py verify-package --package package` from its parent directory.

| In the package | Use it for |
| --- | --- |
| `host-sdk/` | Load the included core from [TypeScript or Rust](hosts.md). |
| `ndk/` | Link C, C++, or Zig code against the same LVGL configuration. |
| `source/` | Create a writable checkout layout with `python3 package/source/toolchains/lvw.py init --source package/source --output my-app`. |
| `liblvgl.manifest.json` | Show build identity and capabilities in Studio alongside `host-sdk/runtime/liblvgl.wasm`. |

To export **only the host SDK** after building the NDK, run `python3 toolchains/lvw.py export-sdk`. This writes `target/host-sdk/`. For a newly linked reactor, select its NDK and its actual bytes: `python3 toolchains/lvw.py export-sdk --ndk target/ndk --core target/native-c/lvgl_native_example.wasm --output target/native-sdk`. Choose a new output directory for each export.

For multi-module validation outside Studio, add `--with-validator` to `export-sdk` or `export-package`. Before exporting, populate Cargo's cache with `cargo fetch --locked --manifest-path validator/Cargo.toml`. To share source alone, use `export-source` and `init`. Run `python3 toolchains/lvw.py --help` for the command list.

## Check a change

`bun run quality` rebuilds and tests the core, Studio, and the native and host packages. Install Rust's `rustfmt` and `clippy` components for 1.92.0, prepare Zig with `prepare --with-zig`, and set `LVW_ZIG` to its executable. Set `LVW_TEST_BROWSER` if Chromium or Chrome is outside the usual locations. To rerun just the Bun tests against an existing build, use `bun run test`. For changes that affect older LVGL sources, run `bun run check:compatibility` or `bun run check:software`.
