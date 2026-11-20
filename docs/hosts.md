# Embed LVGL in a host

An LVGL core owns the widget tree, input devices and framebuffers. The host supplies elapsed time and input, then reads back pixels. Use the TypeScript SDK for a browser or Bun application, or the Rust SDK to run the same core through Wasmtime. Both SDKs come with the core they were built for.

## Draw a frame in TypeScript

In the application directory, install the TypeScript package from an exported host SDK:

```sh
bun add /path/to/host-sdk/typescript
```

Serve the SDK's `runtime/liblvgl.wasm` as `/liblvgl.wasm`. Put `<canvas id="screen" width="320" height="240"></canvas>` in the page, then run this code from the browser bundle:

```ts
import { LvglRuntime } from "liblvgl-wasm";

const canvas = document.querySelector<HTMLCanvasElement>("#screen")!;
const ctx = canvas.getContext("2d")!;
const core = await fetch("/liblvgl.wasm").then(response => response.arrayBuffer());
const runtime = await LvglRuntime.load(core);
const display = runtime.createDisplay(canvas.width, canvas.height);
const label = runtime.createLabel(runtime.screen(display));
runtime.setText(label, "Hello, LVGL");
runtime.step(40);
const frame = runtime.readFrame(display);
ctx.putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
runtime.shutdown();
```

For an interactive view, keep the runtime alive. Call `step(elapsedMs)` from the animation loop, redraw when `framesChanged` is nonzero, and forward pointer coordinates in display pixels to `runtime.createPointer(display)`. The [browser example](../examples/browser/main.ts) wires up a button, pointer input and a canvas.

## Use LVGL from Rust

Add the exported crate to the application's `Cargo.toml` (Rust 1.92 or later):

```toml
[dependencies]
liblvgl-wasm-host = { path = "/path/to/host-sdk/rust" }
```

Use `call_raw` for bridge exports and `raw()?` for generated LVGL functions. This program takes the path to the SDK's `runtime/liblvgl.wasm` as its first argument:

```rust
use liblvgl_wasm_host::{Result, Runtime, UnsafePointer};

fn main() -> Result<()> {
    let path = std::env::args().nth(1).expect("pass the core Wasm path");
    let mut runtime = Runtime::from_file(path)?;
    let display: u32 = runtime.call_raw("lvw_display_create", (320u32, 240u32, 1u32))?;
    let mut lv = runtime.raw()?;
    let screen = lv.lv_display_get_screen_active(UnsafePointer(display))?;
    let button = lv.lv_button_create(screen)?;
    lv.lv_obj_set_size(button, 140, 60)?;
    lv.lv_obj_center(button)?;
    runtime.shutdown()
}
```

For input, event dispatch and pixel reads, see the [Rust CLI](../bindings/rust/src/main.rs). To run it from a built checkout:

```sh
env CARGO_TARGET_DIR=target/rust cargo run --locked --manifest-path bindings/rust/Cargo.toml -- target/wasm/liblvgl.wasm
```

## Call native APIs

Use `runtime.unsafe.lv_*` in TypeScript or `runtime.raw()?.lv_*` in Rust. In Studio's JavaScript editor, switching on **Advanced LVGL API** also makes names such as `lv_obj_center(button.handle)` available directly. These bindings require the matching core; check `runtime.identity.sdk.status` in TypeScript, or regenerate the SDK for a custom core.

The SDK includes constants, type layouts and C signatures for the selected configuration in `metadata/api.json`. A pointer is an offset into **that core's memory**; a function pointer indexes its function table. Allocate strings and structures in the core, use the generated sizes and alignments, and release the storage after LVGL has finished using it. For example, `lv_color_hex(out, rgb)` writes to storage supplied by the caller. In TypeScript, recreate typed array views after memory growth and use `bigint` for Wasm `i64`.

| To… | TypeScript | Rust |
| --- | --- | --- |
| Subscribe to an object event | `object.on(code, handler)`; call the returned function to unsubscribe | `set_event_handler_with_context` and `lvw_event_add` |
| Run a periodic callback | `createTimer` | `create_timer` |
| Animate a value | `startAnimation` with an initialized `lv_anim_t` | `start_animation` |
| Observe a subject | `observe`, `observeTarget`, `observeObject` | `observe`, `observe_target`, `observe_object` |
| Decode a custom image format | `createImageDecoder` | `create_image_decoder` |

Callbacks run synchronously. Ordinary event handlers can update widgets; draw handlers use the current event's layer to draw. Event pointers and decoder sessions are borrowed for the current callback. Advance time and shut down from outside callbacks. A guest trap or handler failure ends the runtime; load a fresh instance to restart. The [bridge header](../bridge/lvw.h) describes the ABI for implementing a host in another language.

## Images, animation and fonts

Copy an asset into the runtime with `runtime.putResource("icon.png", bytes)`, then pass `"W:icon.png"` to `runtime.setImageSource`. Resources live until shutdown; use a new name for new bytes. For native APIs that borrow a buffer, keep it alive as long as the widget or font uses it.

The default core includes software rendering. Use the Studio TypeScript samples for working examples:

| Asset | Example | Detail |
| --- | --- | --- |
| PNG or BMP | [PNG](../toolchains/ts/samples/png.ts) · [BMP](../examples/browser/main.ts) | Use up to 8 bits per channel for PNG. |
| GIF | [Playback](../toolchains/ts/samples/gif.ts) | Advance time with `step`; keep the source path alive until replacement or widget deletion. |
| SVG | [Geometry](../toolchains/ts/samples/svg.ts) | Use paths, fills and linear gradients. Convert text to paths; this renderer skips SVG text and embedded images. |
| Lottie | [Animation](../toolchains/ts/samples/lottie.ts) | Use shape animations without expressions. Keep the ARGB draw buffer alive while the widget uses it. |
| TrueType | [TinyTTF](../toolchains/ts/samples/tinyttf.ts) · [FreeType](../toolchains/ts/samples/freetype.ts) | Detach a font from widgets before freeing it. |

To connect separate Wasm libraries to an app, see [Run a module project](modules.md).
