# liblvgl-wasm

Run an LVGL interface in a browser or drive it from a test. The same `liblvgl.wasm` draws the widgets in both cases. In Studio you click the preview; in a TypeScript or Rust host you send pointer input, advance time, and read back the pixels.

**[Open LVGL Studio](https://w-mai.github.io/liblvgl-wasm/studio/)** — the demo starts with a C application, an event library, and LVGL. Send a click to see the label change and the callback appear in the trace.

## Make a clickable button

In Studio, switch to **Application**, choose **JavaScript**, and open the editor. Paste this function and select **Run code**. Each click updates the label:

```js
function main({ runtime, screen }) {
  const button = runtime.createButton(screen);
  button.setSize(160, 64);
  const label = runtime.createLabel(button);
  let count = 0;
  runtime.setText(label, "Clicks: 0");
  button.on(runtime.clickedEvent, () => {
    runtime.setText(label, `Clicks: ${++count}`);
  });
}
```

For the same idea in C, open **Application → C → C API preview**. The [C source](examples/c/direct_api.c) creates the button and registers its callback with LVGL's own `lv_*` functions.

## Use it in a project

| I want to… | Start here |
| --- | --- |
| Run my app, firmware, or a different LVGL core in Studio | [Studio: choose what to upload](docs/studio.md) |
| Run one app with several Wasm libraries | [Multi-module projects](docs/modules.md) |
| Render a frame or test input from TypeScript or Rust | [Host SDKs](docs/hosts.md) |
| Build LVGL from source, link C/C++ or Zig, or export an SDK | [Build and package](docs/build.md) |

The default core uses LVGL 9.6.0. For another v9 source tree or a custom `lv_conf.h`, see [Build a different core](docs/build.md#build-a-different-core). See the [changelog](CHANGELOG.md) for release details.

## Third-party notices

Portions of this software are copyright © 2026 The FreeType Project (https://freetype.org). All rights reserved. Distributions that include FreeType must retain the [FreeType License](third_party/freetype/FTL.TXT) and [additional notices](third_party/freetype/NOTICES.txt). See also the [runtime component notices](third_party/runtime/README.md).
