# SVG geometry and transforms

These original SVGs exercise the LVGL parser and software vector renderer. [expected.json](expected.json) pairs the source hashes with row-major RGBA bounds on a `[16, 32, 48]` background. [transforms.json](transforms.json) gives the expected results after scaling, rotating, and clipping the same geometry.

| Input | What to look for |
| --- | --- |
| [geometry.svg](geometry.svg) | A translated rectangle and right triangle. The [reordered attributes](geometry-viewbox-first.svg) and [long root header](geometry-long-header.svg) produce the same image. |
| [fills.svg](fills.svg) | Two pairs of nested rectangular contours with the same winding. Nonzero fills the center; even-odd leaves it empty. |
| [gradient.svg](gradient.svg) | A horizontal gradient that varies both color and opacity. |
| [quadratic.svg](quadratic.svg), [cubic.svg](cubic.svg) | Two encodings of the same parabola, with the same coverage as the [16 ppem font outline](../freetype-outline/). |
| [empty-closed.svg](empty-closed.svg), [empty-self-closing.svg](empty-self-closing.svg) | Valid 32 × 24 documents; every pixel is background. |

The `rejected` entries in `expected.json` identify malformed documents: a wrong root name, mismatched group, unclosed root, two roots, and a truncated root. Each fails to load, unlike the two valid empty documents.

## Shape and color reference

The 32 × 24 viewport in `geometry.svg` maps `viewBox="0 0 16 12"` with `preserveAspectRatio="none"`. After translating the group by (1, 1), the rectangle occupies `[4, 14) × [4, 10)`. The triangle vertices are (4, 12), (16, 12), and (4, 24); cells on its diagonal have half coverage.

The renderer converts solid opacity with `floor(255 × opacity / 256)`. Opaque paint reaches alpha 254; SVG fill opacity 0.5 truncates to 127 and then becomes 126. Compute each channel as `floor((foreground × alpha + background × (255 − alpha)) / 255)`. Solid painted channels allow one level for rounding; background is exact.

The gradient fills `[4, 28) × [4, 20)`. Interpolate straight color and alpha between the stops `[220, 40, 20, 63]` and `[20, 100, 220, 223]` at `t = (x + 0.5 − 4) / 24`, then composite. Its three-level allowance accounts for gradient-table sampling, interpolation, premultiplication, and blending.

The quadratic and cubic references use the analytically integrated bounds in the [font fixture](../freetype-outline/expected.json). Multiply coverage by 254/255, then composite the foreground `[224, 192, 160]`. Colors within the coverage bounds allow two levels of rounding.

## Transforms and clipping

Each 80 × 40 case in `transforms.json` contains an affine matrix `[a,b,c,d,e,f]` mapping `(x,y)` to `(ax+cy+e,bx+dy+f)`. Row-major runs have the form `[length, rgba_min, rgba_max, tolerance]`. Clip each transformed polygon against its parent and each unit pixel square. The rectangle uses alpha 254 and the triangle 126. A child layer also multiplies opacity by 128/255, increasing the painted-pixel allowance from one level to two.

For quarter turns, move the polygon edges inward and outward by 1/32 pixel per coordinate to obtain the coverage bounds. Within these fixtures, coordinates stay within 96 pixels and slopes are at most two. ThorVG truncates vertices to 1/64 pixel; floating-point error stays below 1/4096 pixel, and reciprocal intersections add less than `2 × (1 + 6144/65536) / 256`. Their sum fits within 1/32 pixel. Pixels outside this narrow edge band keep their original bounds.
