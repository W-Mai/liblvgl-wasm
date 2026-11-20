# Run a module project

A module project combines one Wasm app with the libraries it needs. Each module owns its memory. Libraries can depend on other libraries; the host starts providers before consumers and closes them in reverse order.

## Try the C event example

Open **Workspace → Modules** in Studio. The built-in example contains three separately compiled files:

| File | Role |
| --- | --- |
| `liblvgl.wasm` | Owns LVGL and the display. |
| `events.wasm` | Creates a label and registers a C callback for `LV_EVENT_CLICKED`. See the [library source](../validator/lvgl-event-lib.c). |
| `app.wasm` | Calls the library's `middle_update` function. See the [app source](../validator/lvgl-label-lib-app.c). |

Click **Send CLICKED**. The C callback updates the label from `READY` to `CLICKED`. The event controls show the current count and callback order; the module inspector shows the selected module's interface and preflight results.

To try the upload path, choose **Open files…** and select `project.json` and the three `.wasm` files from `target/studio/modules/`. The module build command is `bun run build:studio-modules`. Once preflight passes, select **Run project**, enter `1` and click **Call**. On the first call the example sends a clicked event and a nested clicked event, then returns `2`. Calling `app_run` is explicit for uploaded projects; an app without a display returns its value in the same panel.

## Write a project manifest

Use the generated `target/studio/modules/project.json` as a complete example. A project file has `kind: "studio-module-project"`, `schema_version: 1`, a `modules` array with a manifest for each binary, and a `hosts` array describing the services used by the modules. The build also records file hashes in `files`.

| Module manifest field | What to put there |
| --- | --- |
| `kind`, `schema_version`, `id`, `role` | `"wasm-module"`, `1`, a unique module ID, and either `"app"` or `"lib"`. |
| `artifact` | The Wasm filename and its SHA-256. For local upload, use a filename without directories. |
| `interface` | The name and version that consumers depend on. |
| `target`, `memory_model` | ABI `"wasip1"`, the allowed Wasm features for this module, and `"isolated"`. |
| `requires` | One entry per dependency, with its provider ID, interface, version and import bindings. |
| `exports` | The binary's exports, including signatures and declared limits for memory or tables. |
| `runtime_verification` | `"not-run"` for the input manifest. Studio reports the result of running it separately. |

For example, the app imports the library's `middle_update` as `middle.middle_update`. This entry goes inside the app's `requires` array:

```json
{
  "provider": "middle", "interface": "middle", "version": 1,
  "imports": [
    { "module": "middle", "name": "middle_update", "provider_export": "middle_update",
      "kind": "function", "params": ["i32"], "results": ["i32"] }
  ]
}
```

Include every import the binary uses. Rebuild the manifest when the binary changes: Studio compares each file to its own `artifact.sha256`, checks the signatures and dependency graph, and matches requested services to host implementations. The inspector names the missing interface when Studio can read a graph but cannot run it.

## Choose the interface between modules

For an ordinary library, export numeric functions that take `i32` values and return one `i32`. For example, pass a counter or a command number. A memory offset is meaningful only inside the module that owns the storage. To put text on screen from a library, use the label service: it copies the string from the caller's memory and returns opaque object tokens for use in LVGL calls.

Studio chooses the runtime profile from the requested interfaces (version 1):

| Profile | Available operations |
| --- | --- |
| `numeric-v1` | Call numeric library functions and return a value from the app. |
| `lvgl-core-v1` | Start a bridge ABI 1 core and query its initialization state or ticks. |
| `lvgl-label-v1` | Get the active screen, create labels and set text from one designated app or library. The host can read back the display. |
| `lvgl-event-v1` | Register, send and remove synchronous clicked events for labels. The consumer exports `app_event_dispatch(i32, i32) -> ()` and dispatches the callback using its own table. |

The host interface names are `lvw` for the bridge, `lvgl` for labels and clicked events, `trace` for `lifecycle(i32)`, and `wasi` for Preview 1 services. Studio's WASI provider recognizes `environ_get`, `environ_sizes_get`, `clock_time_get`, `fd_close`, `fd_seek`, `fd_write` and `proc_exit`; it supplies an empty environment and no output file descriptors. For the exact host policy, see [Studio's interface registry](../studio/modules/profile.ts).

## Start, call and stop

Ordinary libraries and the app export `module_init() -> i32` and `module_close() -> i32`. Return `0` on success. The app also exports `app_run(i32) -> i32`; its result is application data. A bridge core uses `lvw_init` and `lvw_shutdown` for its lifecycle.

If initialization returns an error, the failing module must release its own partial work; the host closes modules that have already started. A guest trap ends that instance. On a normal stop, the app closes while its libraries are still available. Event callbacks and their userdata belong to the registered consumer; keep its callback slot stable until unsubscription, and use the event token only during its callback.

## Run the graph outside Studio

The TypeScript SDK's optional `liblvgl-wasm/feature-validator` entry provides `preflightNumericEnvironment(input, options)` and `loadNumericEnvironment(input, options)`. Export the SDK with `--with-validator` to include it. Pass the bytes and manifests in `input`; in `options`, choose the profile, allowed module identities and interfaces, host implementations, features and resource limits. Use `env.run(value)`, `env.readFrame?.()` and `env.close()` on the loaded environment. The [TypeScript event consumer](../tests/fixtures/feature-sdk/event-consumer.ts) shows the calls.

The Rust SDK runs the same project with Wasmtime. See the [Rust library event consumer](../tests/fixtures/host-sdk/event-lib-runtime.rs) for `load_lvgl_event_environment_for_consumer`, frame reads and shutdown. For a C library that links its own LVGL and exposes a numeric API, see the [bar widget example](../examples/c/multimodule/provider.c) and its [app](../examples/c/multimodule/app.c).
