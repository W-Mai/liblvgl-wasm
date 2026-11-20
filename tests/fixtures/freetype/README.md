# FreeType: geometric glyphs

[expected.json](expected.json) describes the original [primary](../tinyttf/geometry.ttf) and [fallback](../tinyttf/fallback.ttf) fonts shared with the TinyTTF fixtures. The primary font contains space, A, B, and Á. The fallback supplies Ω. Use the [curved glyph fixtures](../freetype-outline/) for quadratic and cubic outlines.

## Metrics

Both fonts use 1024 units per em, ascent 896, descent −128, and zero line gap. The AB kerning pair subtracts 128 font units. The reference records the resulting reduction as a positive pixel count under `kerning`.

| Size (ppem) | Line height | Baseline | Normal advance | Space advance | AB reduction |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 16 | 16 | 2 | 12 | 8 | 1 |
| 32 | 32 | 4 | 24 | 16 | 4 |

The 16 ppem kerning value includes FreeType's `FT_KERNING_DEFAULT` adjustment below 25 ppem. LVGL 9.0.0's native bitmap font callbacks use the same geometry without kerning.

## Pixel reference

Clip each scaled polygon to a unit pixel square, compute the intersection area as a fraction, and round to 8-bit coverage. The glyph box extends from the floor to the ceiling of the scaled contour; a space has a zero-sized bitmap. Transparent and opaque coverage are exact. Intermediate coverage allows one A8 level and blended channels allow two.

In outline mode, LVGL uses `floor(255 × text_opacity / 256)` before multiplying by coverage. The reference composites once over an opaque background. The fonts contain no hinting programs.

## Damaged inputs

`rejected` contains an invalid signature and a truncated SFNT header; both fail to load. In `cmap_recovery`, the format 4 character map declares more segments than its table holds. FreeType recovers the map from glyph names, so A and Á still have their original outlines.
