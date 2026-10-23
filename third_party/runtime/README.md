# Runtime and component notices

This directory contains the license and attribution material for the code that is linked into the WASI reactor and for the LVGL components enabled by the default configuration.

The WASI libc files are from commit `2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13` in `WebAssembly/wasi-libc`. The linked allocator notice is kept with the complete upstream source file. The musl, cloudlibc, and musl-fts texts are preserved as separate files.

The LLVM runtime files are from commit `895aa2c896ada719451be2e3673c83da8ddf1141` in `llvm/llvm-project`. `llvm/source-notices.json` records the SHA-256 and the complete notice blocks found in the selected compiler-rt, libc++, libc++abi, and libunwind source ranges. It is an attribution index, not a claim that every indexed source file is linked into every configuration.

The LVGL tree preserves the original license files and font notices from commit `80ca777e37a2b176770726a02e07a6fb79ef0b39` in `lvgl/lvgl`. FreeType and ThorVG have additional source and license trees under `third_party/freetype` and `third_party/thorvg`.

Git preserves third-party file bytes without line-ending conversion. The manifest hashes apply to the original bytes in both source checkouts and exported packages.

`manifest.json` records every file hash in this directory and the fixed upstream identities used to collect it. The build does not download or regenerate these materials.
