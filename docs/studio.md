# Run an application in Studio

[Open Studio](https://w-mai.github.io/liblvgl-wasm/studio/). Choose **Application** for a single app or firmware image. Choose **Modules** when an app calls into separately compiled Wasm libraries.

| What you have | Where it goes |
| --- | --- |
| A JavaScript app or compiled TypeScript bundle | Drop the `.js` file into **Application**. Its entry point is `main(api)`. |
| A C, C++, or Rust app that uses the Studio app ABI | Drop the compiled `.wasm` into **Application**. Studio supplies the selected LVGL core. |
| Standalone firmware | Drop the compiled `.wasm` into **Application**. Firmware supplies its own RGBA8888 frame and receives pointer input. |
| A replacement for the default LVGL core | Select **My own .wasm** under **LVGL library**. Choose a core built with bridge ABI 1; then load the app as usual. |
| A project manifest and several Wasm files | In **Modules**, use **Open files…** to select them together. See [Multi-module projects](modules.md). |

Uploads run locally in the browser. For a custom core, open **Library details** to see its bridge version and SDK match. If you have its `liblvgl.manifest.json`, select **Load capability manifest** to see which LVGL version and features it contains.

## Build a Studio app

Start with a working sample in the language you use. Run the command from a [configured checkout](build.md#build-studio-locally), then upload the file in the last column.

| Sample | Build command | File to upload |
| --- | --- | --- |
| [JavaScript](../toolchains/js/app.js) | Use the source directly | `toolchains/js/app.js` |
| [TypeScript](../toolchains/ts/app.ts) | `bun run build:ts-app` | `target/apps/ts/app.js` |
| [C](../toolchains/c/app.c) | `./toolchains/c/build.sh` | `target/apps/c/app.wasm` |
| [C++](../toolchains/cpp/app.cpp) | `./toolchains/cpp/build.sh` | `target/apps/cpp/app.wasm` |
| [Rust](../toolchains/rust/src/lib.rs) | `./toolchains/rust/build.sh` | `target/apps/rust/app.wasm` |
| [C firmware](../toolchains/firmware/app.c) | `./toolchains/firmware/build.sh` | `target/apps/firmware/app.wasm` |

For a new language, use the [app ABI header](../toolchains/include/lvw_app.h) for import names and signatures. Export `memory`, `app_abi_version`, `app_init`, and `app_event`. If the firmware already renders its own screen, implement the [firmware ABI](../toolchains/include/lvw_firmware.h) instead.

## Call LVGL directly

In the JavaScript editor, enable **Advanced LVGL API** and run the code again. With the default core, you can add `lv_obj_center(button.handle);` after creating the button in the [README example](../README.md#make-a-clickable-button). The switch makes the generated `lv_*` names available in editor scope. These bindings depend on the exact core; a bridge-compatible replacement can still run ordinary apps when its SDK differs.

For native C callbacks, open the C toolchain's **C API preview**. It runs a [C program linked with LVGL](../examples/c/direct_api.c). To link a program this way, use the [native development kit](build.md#link-a-native-app).

## Images and fonts

In **Application → TypeScript**, choose a sample such as PNG, GIF, FreeType, SVG, or Lottie and select **Load**. The sample loads its own assets. When uploading an app, add its files under **Assets** and open them from LVGL as `W:filename`. For instance, the [PNG sample](../toolchains/ts/samples/png.ts) reads `W:rgba.png`. See the [TypeScript samples](../toolchains/ts/samples/) for playback, font sizing, and resource handling.
