# liblvgl-wasm

`liblvgl.wasm` embeds LVGL 9.6.0 as a WASIp1 reactor. The `lvw_*` bridge accepts input, advances time, provides resources, and returns software-rendered frames. Browser/Bun and Rust hosts load the same module.

## Build

Requires CMake 3.25+, Ninja, Python 3, Bun, and wasi-sdk 34. `scripts/build.sh` uses `.local/wasi-sdk-34.0-arm64-macos` by default. Set `WASI_SDK_PATH` for another installation. LVGL is fetched at the commit pinned in `CMakeLists.txt`; set `LVGL_SOURCE_DIR` to use an existing checkout.

```sh
WASI_SDK_PATH=/path/to/wasi-sdk ./scripts/build.sh
```

Generated files stay under `target/`:

| Path | Content |
| --- | --- |
| `target/wasm/liblvgl.wasm` | WASIp1 library module |
| `target/wasm/api.json` | Enabled public declarations and binding status |
| `target/wasm/api-exports.txt` | Generated linker export flags |
| `target/browser/main.js` | Browser example bundle |
| `target/typescript/index.js` | TypeScript host adapter bundle |
| `target/rust/` | Rust host build cache |

## Run

```sh
bun test
CARGO_TARGET_DIR=target/rust cargo run --manifest-path bindings/rust/Cargo.toml
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/examples/browser/` after starting the server. The browser example renders a button and a BMP resource; pointer input changes the button label. The Rust example checks rendering, resource pixels, input, callbacks, and shutdown.

## Interface

The bridge ABI version is `1`. A Wasm instance owns one LVGL runtime and may create multiple displays. `lvw_step(elapsed_ms)` advances LVGL time and returns the next timer interval and frame count. Frames use XRGB8888 bytes in blue, green, red, unused order. Hosts must read or copy frame data before a call that can change the framebuffer. Each host must call `_initialize` before `lvw_init`.

The generated API inventory classifies declarations as `direct_export`, `compile_disabled`, or `unsupported`. `direct_export` functions are included in the Wasm export list. Unsupported entries retain a reason in `target/wasm/api.json`; function pointer callbacks and aggregate value ABI require dedicated wrappers. The TypeScript adapter provides a typed interface for the bridge and the APIs used by its example.

The software configuration enables PNG, BMP, GIF, and TinyTTF. ThorVG, FreeType, SVG, Lottie, native windows, and hardware drawing backends are disabled. The Wasm linear memory maximum is 256 MiB.
