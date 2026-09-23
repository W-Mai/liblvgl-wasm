# Changelog

## [Unreleased]

### Added

- LVGL 9.6.0 WASIp1 reactor with a versioned host bridge for display, input, time, resources, events, and frame output.
- Generated public API inventory and linker exports for directly callable functions.
- Browser/Bun and Rust hosts using the same Wasm module, with resource and pointer interaction checks.
- LVGL Studio with default or user-selected cores, application and resource uploads, interactive preview, console, and isolated browser runner.
- JavaScript, TypeScript, C, C++, and Rust application samples and build commands. Compiled Wasm applications use a versioned host ABI.
- Light and dark gray Studio themes with square controls and persistent theme selection.
- Native LVGL application colors and styles in the Studio preview, with a multicolor Studio mark in the header and favicon.
- Preview frame resizing with animation and aspect-correct display for each resolution preset.
- C demo linked with LVGL that calls native `lv_*` APIs for UI creation and events in a Studio side panel.
