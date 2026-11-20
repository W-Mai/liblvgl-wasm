# Changelog

## [Unreleased]

### Studio

- Run LVGL in the browser with the bundled core or a custom bridge core. Upload an application, its resources, or standalone firmware. Load a core's capability manifest to see its LVGL version and enabled features.
- Run a multi-module application by selecting its manifest and Wasm files together. Studio shows the library load order, checks the requested host interfaces, and displays the result of each `app_run(i32)` call. The bundled C example shows a click reaching an app through a separate library.
- Edit and run JavaScript beside the preview, or open the source and build script for a JavaScript, TypeScript, C, C++, or Rust example. The native C preview calls LVGL directly. Samples cover images, fonts, SVG, and Lottie playback.

### Runtime and SDKs

- Run the same LVGL 9.6.0 WASI Preview 1 core from TypeScript or Rust. Both hosts provide displays, pointer input, frame output, and an in-memory resource filesystem.
- Call native `lv_*` functions with bindings generated for the selected core. Both SDKs include constants and C type layouts; TypeScript uses `bigint` for 64-bit integers and Rust distinguishes memory pointers from function-table indices.
- Subscribe to synchronous LVGL events, timers, animations, and observers, or supply an image decoder that returns a whole image or a region. Drawing callbacks can access the active native event.
- Run one application with a graph of Wasm libraries in either host. Each module owns its memory; the host resolves declared imports, starts libraries before their consumers, and shuts them down in reverse order. Supported interfaces include numeric calls, restricted WASI services, and LVGL labels and click events.
- Inspect module dependencies, Wasm features, interface signatures, and memory requirements before starting a graph. A portable feature validator is available for TypeScript hosts.

### Building and packaging

- Select an LVGL source tree and configuration, prepare the compiler tools with `lvw.py`, and export a relocatable development package. It includes the native C/C++ SDK, a Zig example, matching TypeScript and Rust SDKs, source, dependency notices, and a capability manifest for the built core.
- The default configuration includes PNG and GIF images, TinyTTF and FreeType fonts, software vector drawing, SVG, and Lottie. See the [LVGL version table](docs/build.md#build-a-different-core) when selecting an older source tree.

Custom bridge cores used with Studio or the TypeScript runtime must export `lvw_event_remove` for event unsubscription. Generated native API bindings require the core they were built for.

### Fixes

- Stopping a Studio load or a failed C preview stops its input and frame callbacks. Reapplying the active resolution preserves the frame.
- GIF playback honors the final frame's delay and allows completion handlers to replace or delete the animation. SVG rendering clips transformed images correctly, and vector layers preserve the background beneath transparent shapes.
- Rebuilding with a different WASI SDK refreshes the compiler configuration. The Rust SDK can rebuild from a read-only package.
