# FreeType: quadratic and cubic outlines

[quadratic.ttf](quadratic.ttf) and [cubic.otf](cubic.otf) are original fonts. Both draw the same glyph, C (U+0043), as a parabola closed by a horizontal chord. One encodes its outline as TrueType quadratic curves; the other uses CFF cubic curves. Neither font contains hint instructions or third-party outlines.

[expected.json](expected.json) records the font hashes, control points, and pixel coverage at 16, 17, and 32 ppem. For polygon outlines, kerning, and fallback, see the [geometric glyph fixtures](../freetype/).

## Reference shape

The quadratic runs from (128, 128) to (896, 128) through (512, 896). Degree elevation gives cubic control points (384, 640) and (640, 640). Both fonts use 1024 units per em, ascent 896, descent −128, zero line gap, and advance 1024. FreeType rounds the descender down, so the baseline distances are 2, 3, and 4 pixels at the three sizes.

At scale `s = size / 1024`, the lower boundary is `128s` and the upper boundary is `512s − (x − 512s)² / (384s)`, for x between `128s` and `896s`. Integrating the area between them gives total coverage `196608s²`. The `alpha` grid stores each unit pixel's share of this area multiplied by 255.

## Rendering bounds

ThorVG flattens the curve into straight segments. Its subdivision threshold is approximately 1/6 pixel from a control point to the chord; the curve deviates by at most 3/4 of that distance. These contours reach depth 3 at 16 and 17 ppem and depth 3 or 4 at 32 ppem. All subdivision midpoints lie on the 1/256 pixel grid. At depth `d`, the maximum vertical error is `3 × size / (8 × 4ᵈ)`, giving the common bound `curve_deviation_pixels = 3 × size / 512`.

Rasterizer intersection rounding contributes another 1/64 pixel: coordinate differences are at most 1344 subpixels, slopes at most two, and `2 × (1 + 1344 / 65536) / 256 < 1/64`. To construct the lower envelope, move the parabola down by `curve_deviation_pixels + 1/64`; for the upper envelope, move it up by `1/64`. Keep the horizontal range and bottom chord fixed. Integrate each clipped pixel against both envelopes. The stored A8 limits are `floor(256 × lower_area)` and `ceil(256 × upper_area)`, clamped to [0, 255].

The text color uses effective alpha `floor(255 × opacity / 256)` before compositing. Pixels outside the upper envelope are exact background. Inside that envelope the reference allows two channel levels for integer premultiplication and blending.
