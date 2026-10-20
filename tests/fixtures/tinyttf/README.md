# TinyTTF fixtures

`geometry.ttf` and `fallback.ttf` contain original geometric test outlines. No third-party font outlines are included. `expected.json` records their SHA-256 hashes, source contours, character mappings, font metrics, and coverage at 16, 24, and 32 pixels per em.

The primary font contains space, A, B, and a composite Á made from A and an acute triangle. Its legacy kerning table adjusts AB by -128 font units. The fallback font contains Ω. Both fonts use 1024 units per em, ascent 896, descent -128, and zero line gap.

Expected coverage comes from clipping the source polygons against pixel squares and calculating their intersection area. Coverage is quantized to 8 bits independently of TinyTTF. The recorded bitmap boxes include the pinned LVGL implementation's extra transparent row and column. Tests compare intermediate coverage with a one-level tolerance and blended pixels with a two-level tolerance; fully transparent and opaque pixels must match exactly.
