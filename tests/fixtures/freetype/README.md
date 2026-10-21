# FreeType fixtures

`expected.json` references the original geometric fonts in `../tinyttf/`. It records their SHA-256 hashes, source contours, character mappings, and bitmap expectations at 16 and 32 pixels per em. Font bytes are shared between both backends.

Coverage is computed by clipping each scaled source polygon against pixel squares and measuring the intersection area with exact rational arithmetic. Values are rounded to 8 bits. Bitmap bounds use the floor and ceiling of the scaled contours; empty space has a zero-sized bitmap. No renderer output is used to generate expected pixels. Tests require exact transparent and opaque coverage, allow one level for intermediate A8 coverage, and allow two levels for partially covered framebuffer pixels.

Both fonts use 1024 units per em, ascent 896, descent -128, and zero line gap. At the tested sizes, line heights are 16 and 32, baselines are 2 and 4, normal advances are 12 and 24, and space advances are 8 and 16. The AB pair has -128 font units of kerning. FreeType's `FT_KERNING_DEFAULT` scales kerning below 25 pixels per em before pixel rounding, giving reductions of 1 pixel at size 16 and 4 pixels at size 32. The `kerning` field stores these positive reductions.

The `rejected` entries define a fixed invalid signature and a truncated SFNT header. Tests upload their actual byte lengths through the resource filesystem and verify that font creation fails without preventing subsequent valid font loading.

`cmap_recovery` changes the format 4 character map's segment count to exceed its table length. FreeType's validator rejects that map through its exception-based `longjmp` path, then builds a replacement map from the font's glyph names. Font creation and the original A and Á geometry must remain valid, followed by a successful load of the unmodified font.

Outline tests reuse the same polygon coverage and metrics at 16 and 32 pixels. The fonts contain no TrueType glyph programs or font-wide hint programs. LVGL combines the color alpha of 255 with text opacity using `floor(255 * opacity / 256)` before rasterization; the reference multiplies this effective opacity by the geometric coverage and performs one source-over composition. Uncovered background is exact, and covered framebuffer channels allow two levels for coverage and blending quantization. Tests include opacity 255 and 128, mixed bitmap/outline fallback, shared fonts at different sizes, manual opaque path borrowing after a label refresh, and releasing glyph draw data before deleting fonts. Outline glyph pointers are not A8 buffers.
