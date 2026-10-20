# Changelog

## [Unreleased]

### Added

- LVGL 9.6.0 WASIp1 reactor with a versioned host bridge for display, input, time, resources, events, and frame output.
- Generated public API inventory and linker exports for directly callable functions.
- Generated ABI wrappers for aggregate values and inline LVGL functions, with export coverage checks.
- Generated enum and macro constants evaluated by the Wasm target compiler, including integer types and widths, exact string bytes, and explicit classifications for unsupported expressions.
- Generated target type graphs with record sizes, alignments, field offsets, bitfields, opaque types, aliases, and declared and canonical C function signatures.
- Compiler-derived Wasm function signatures, linked-core signature checks, and verification records tied to API and core hashes.
- Generated TypeScript `lv_*` calls with aggregate pointer semantics, bigint arguments and results, exact-core identity checks, and guards after runtime shutdown.
- Shared TypeScript guest-call failure guards, explicit closing state, and lifecycle reentry checks in the host and event bridge.
- Idempotent event unsubscription, automatic host callback release on deletion, shared object lifetimes, and input references tied to their owning display. TypeScript and Studio require the `lvw_event_remove` core export.
- Strict TypeScript checks for generated bindings and the runtime, with locked JavaScript dependencies.
- Browser/Bun and Rust hosts using the same Wasm module, with resource and pointer interaction checks.
- Reusable Rust host library with checked memory copies, synchronous event handlers, and runtime shutdown and failure guards.
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

- Aggregate ABI wrappers recognize qualified record types and typedef chains through the canonical type graph.
- Builds recover from missing cached LVGL sources and resolve SDK, source, and generator configuration paths when invoked outside the repository.
- LVGL source downloads use a SHA-256-verified release archive with a GitHub API download fallback.
- Bun test discovery is restricted to repository tests, excluding copies under build directories.
