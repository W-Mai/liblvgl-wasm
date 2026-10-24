# Changelog

## [Unreleased]

- LVGL 9.1.0 GIF playback with native header-cache invalidation, both LZW configurations, callback-safe cleanup, and PNG/GIF package checks.

- LVGL 9.1.0 PNG decoding with bounded headers, native path borrowing, cache-key ownership, failure cleanup, and relocated native/host SDK checks.

- LVGL 9.0.0 vector drawing with original API signatures, resource-backed ThorVG loading, object clipping, layer offsets, and source-matched NDK/host SDK packages.
- Correct straight-alpha vector composition in LVGL 9.0.0 and 9.6.0 transparent layers while preserving existing target pixels.

- LVGL 9.0.0 FreeType bitmap fonts with copied resource paths, shared font caches, resolved-font glyph release, and relocated native/host SDK checks.
- Source inspection includes component configuration macros outside `LV_USE_*`, preserving file-support and filesystem-port checks.
- LVGL 9.0.0 TinyTTF fonts with cache invalidation scoped to each font, glyph release through the resolved font, original API signatures, and relocated native/host SDK checks.
- LVGL 9.0.0 GIF playback with native loop semantics, transparent frames, exact frame deadlines, callback-safe cleanup, and both LZW decoder configurations.
- LVGL 9.0.0 PNG decoding with bounded headers, aligned-stride validation, cache invalidation, failure cleanup, and relocated native/host SDK checks.
- NDK and host SDK attribution from selected LVGL sources, with original source bytes, verified font supplements, and dependency material identities.
- LVGL 9.5.0 base and managed callbacks, with external data enabled or disabled, subject-owned data cleanup, and verified NDK/host SDK consumers.
- LVGL 9.4.0 base and managed callbacks, with subject-scoped cleanup across split widget sources and verified NDK/host SDK consumers.

- LVGL 9.3.0 base and managed callbacks, including observer cleanup during event dispatch and relocated NDK consumers.

- LVGL 9.2.2 base and managed callbacks, including subject cleanup and decoder sessions.

- LVGL 9.1.0 base and managed callback builds, with relocated C/C++/Zig consumers and matching TS/Rust SDKs.

- Preserve third-party notice bytes across Git checkouts and source packages.

- Managed image decoders for verified LVGL 9.0.0 sources, with borrowed info views, failed-open path cleanup, header-cache invalidation, and TS/Rust lifecycle checks.

- Managed observers for verified LVGL 9.0.0 sources, with native deletion tracking, subject-scoped widget cleanup, and TS/Rust lifecycle checks on exported SDKs.

- Managed animations for verified LVGL 9.0.0 and 9.6.0 sources without external data, with native descriptor binding, deletion tracking, and lifecycle checks for each version.

- Managed timers for verified LVGL 9.0.0 and 9.6.0 sources without external data, with native deletion tracking and shared TS/Rust lifecycle checks on exported SDKs.
- Rust SDK rebuilds replace generated bindings from read-only packages without copying their file permissions.

- ThorVG software vector rendering with generated floating-point APIs, path snapshots, fill rules, transforms, and gradient pixel checks in both hosts.
- Standard Wasm C++ exception support, empty WASI environments, and instance-local process exit errors.

### Added

- Configurable LVGL source, configuration, build directory, and managed bridge adapters, with v9.0.0 and v9.6.0 base-core consumer checks.
- Native SDK exports containing the libraries enabled by the selected configuration and self-contained public-header validation.
- Read-only LVGL v9+ source inspection with shared public header discovery, target-evaluated configuration, and declaration diagnostics.
- Verified source snapshots and project initialization with preserved executable files and isolated build outputs.
- Native Zig applications with configured C header translation, CMake reactor linking, and ABI and relocation checks.
- Independent TypeScript ESM/type packages and Rust crates with bundled bindings, exact core identities, file manifests, and relocation checks.
- Relocatable native C/C++ development kits with public headers, static libraries, CMake reactor targets, generators, and file integrity manifests.
- Runtime notice trees for wasi-libc, LLVM runtimes, LVGL components, bundled fonts, and the Zig example, installed with the NDK and checked by file hash.
- Complete development package export with source, NDK, core-specific host SDK, semantic compatibility manifest, and whole-package file inventory.
- Locked compiler preparation and read-only environment diagnostics with project-local caches, archive and installation integrity checks, and offline reuse.
- Rust native host commands and source links, plus independent C preview module identities in Studio.
- Lottie application sample with JSON resource loading, vector scaling, and native playback controls in Studio.
- SVG application sample with geometry/gradient switching, vector scaling, and SVG/XML source highlighting in Studio.
- TinyTTF application sample with font resource loading, native resizing, and label layout updates in Studio.
- FreeType application sample with native bitmap/outline glyphs, rendering mode switching, and 16/32 px font replacement in Studio.
- GIF application sample with native playback, pause, resume, and restart controls in Studio.
- PNG application sample with background switching, bound sample resources, shared upload limits, and resource conflict recovery in Studio.
- TypeScript application sample with generated LVGL calls, constants, color layouts, managed click callbacks, and application identity checks.
- Studio library details with core and SDK identities, generated build configuration, and strict checks for browser and Worker code.
- Immutable TypeScript runtime identity snapshots using the same core and values checks as generated API access.
- Native Lottie playback from memory and uploaded resources, with generated APIs, timing controls, source replacement, premultiplied buffers, and lifetime checks in both hosts.
- SVG geometry through native LVGL document and image APIs, with checks for pixels, source lifetimes, and recovery after decoding errors in both hosts.
- FreeType outline checks in both hosts for TrueType and CFF curves, text opacity, font sizes, shared paths, and bitmap/outline fallback chains.
- FreeType 2.14.3 bitmap fonts from uploaded resources, with generated APIs, shared font caches, and glyph, kerning, fallback, and lifetime checks in both hosts.
- Standard WebAssembly exception handling for font validation, Wasmtime configuration, and exception tag metadata parsing.
- TinyTTF rendering checks in both hosts for glyph coverage, metrics, kerning, fallback, cache invalidation, and font resource lifetimes.
- GIF playback checks in both hosts for frame pixels, timing, queries, loops, source changes, and completion callbacks.
- PNG rendering checks for RGB8, RGBA8, indexed transparency, and Adam7 input in both hosts, including malformed-image recovery and shared resource lifetimes.
- Native image decoder callbacks in TypeScript and Rust, with synchronous session access, complete and incremental pixel buffers, managed cancellation, and native deletion tracking.
- Native event parameters in TypeScript and Rust callbacks for synchronous drawing, draw-task changes, and event propagation control, with nested event context and synchronous TypeScript handler checks.
- LVGL 9.6.0 WASIp1 reactor with a versioned host bridge for display, input, time, resources, events, and frame output.
- Generated public API inventory and linker exports for directly callable functions.
- Generated ABI wrappers for aggregate values and inline LVGL functions, with export coverage checks.
- Generated enum and macro constants evaluated by the Wasm target compiler, including integer types and widths, exact string bytes, and explicit classifications for unsupported expressions.
- Generated target type graphs with record sizes, alignments, field offsets, bitfields, opaque types, aliases, and declared and canonical C function signatures.
- Compiler-derived Wasm function signatures, linked-core signature checks, and verification records tied to API and core hashes.
- Compiler-derived Wasm signatures for public callback typedefs, with type-graph references and engine-checked probe imports.
- Managed native animations in TypeScript and Rust with synchronous path and get-value queries, native timing, completion notifications, and precise cancellation.
- Reusable animation exec table slots that preserve native `var` and release application callbacks on deletion, shutdown, or failure.
- Managed native observers in TypeScript and Rust with immediate synchronous notification, ordinary and object-bound registrations, native deletion tracking, and shared lifetime invalidation.
- Generated TypeScript `lv_*` calls with aggregate pointer semantics, bigint arguments and results, exact-core identity checks, and guards after runtime shutdown.
- Shared TypeScript guest-call failure guards, explicit closing state, and lifecycle reentry checks in the host and event bridge.
- Idempotent event unsubscription, automatic host callback release on deletion, shared object lifetimes, and input references tied to their owning display. TypeScript and Studio require the `lvw_event_remove` core export.
- Strict TypeScript checks for generated bindings and the runtime, with locked JavaScript dependencies.
- Browser/Bun and Rust hosts using the same Wasm module, with resource and pointer interaction checks.
- Reusable Rust host library with checked memory copies, synchronous event handlers, and runtime shutdown and failure guards.
- Rust callback contexts with generated LVGL methods, synchronous nested notifications, shared failure state, and shutdown reentry guards.
- Native LVGL timers in TypeScript and Rust, with independent user data, synchronous callbacks, idempotent cancellation, and handler release on explicit or automatic deletion. The core enables external-data destructors and imports `lvw.timer` and `lvw.timer_release`.
- Generated Rust `lv_*` methods with core identity checks, separate memory and function pointer types, and a configurable generated source path.
- TypeScript and Rust constants and named type layouts with exact integer and string values, field and bitfield metadata, and explicit opaque types.
- LVGL Studio with default or user-selected cores, application and resource uploads, interactive preview, console, and isolated browser runner.
- JavaScript, TypeScript, C, C++, and Rust application samples and build commands. Compiled Wasm applications use a versioned host ABI.
- Light and dark gray Studio themes with square controls and persistent theme selection.
- Native LVGL application colors and styles in the Studio preview, with a multicolor Studio mark in the header and favicon.
- Preview frame resizing with animation and aspect-correct display for each resolution preset.
- C demo linked with LVGL that calls native `lv_*` APIs for UI creation and events in a Studio side panel.
- Toolchain source files and build scripts open in the Studio side panel; C demo source opens in a second panel that pushes the preview left.
- Syntax highlighting for source files in both Studio side panels, with light and dark color palettes.
- Open source panels refresh from repository files on localhost.
- Build scripts resolve wasi-sdk from `WASI_SDK_PATH`, the existing CMake cache, or `PATH` instead of a machine-specific path.
- Unified quality command that rebuilds all artifacts, validates Wasm modules, runs Bun tests, and checks both Rust packages and the Rust host.
- GitHub Actions quality workflow with pinned Bun, Rust, wasi-sdk, and wasm-tools versions and verified tool downloads.

### Fixed

- Refresh cached CMake compiler configuration when selecting a different wasi-sdk.
- Stop C preview input and frame callbacks after guest errors without calling back into the failed instance.
- Reapplying the current Studio resolution preserves the displayed frame.
- SVG image transform clipping, child-layer coordinates, and image drawing without an attached object; transformed bounds include complete pixel cells for invalidation.
- Cancelled Studio loads remain stopped, retired runners cannot restore stale library details, and closing details restores keyboard focus after application errors.
- SVG viewBox attribute ordering, percentage gradient stops, long root headers, document completion checks, and decoder failure cleanup.
- Premultiplied alpha compositing and exact font-size scaling for software outline glyphs.
- GIF playback stops before releasing a source, applies the final frame's delay, preserves decoder state during frame-count queries, and finishes frame processing before completion callbacks can delete or replace the widget.
- Initialize the Rust example's complete input packet before sending it to the bridge.

- Aggregate ABI wrappers recognize qualified record types and typedef chains through the canonical type graph.
- Builds recover from missing cached LVGL sources and resolve SDK, source, and generator configuration paths when invoked outside the repository.
- LVGL source downloads use a SHA-256-verified release archive with a GitHub API download fallback.
- Bun test discovery is restricted to repository tests, excluding copies under build directories.
