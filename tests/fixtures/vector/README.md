# Vector paths, fills, and transforms

[expected.json](expected.json) defines a scene on an opaque RGB `[24, 32, 40]` background. It supplies the geometric inputs used by the TypeScript and Rust rendering tests. Each pixel is the unit square from `(x, y)` to `(x+1, y+1)`.

| Shape | Expected result |
| --- | --- |
| Solid rectangle | Integer edges cover whole pixels. |
| Right triangle | With perpendicular sides of length 16, local cells with `x+y < 15` are full; `x+y = 15` gives half coverage. |
| Nested rectangles | Same winding direction and 1.5× scale. Nonzero fills the outer rectangle; even-odd cuts out the inner one. Boundary coverage is the area inside each pixel. |
| Horizontal gradient | Interpolate straight RGB and opacity between two stops at the pixel center, then composite over the background. |
| Quarter turn | The matrix `[0, −1, 24; 1, 0, 8; 0, 0, 1]` maps `(2, 3)` to `(21, 10)` and the rectangle `[2, 8] × [3, 7]` to `[17, 21] × [10, 16]`. The transform in a drawing descriptor places the same shape 32 pixels farther right. |

## Comparing channels

For solid fills, LVGL combines color alpha 255 with the requested opacity as `floor(255 × opacity / 256)`. Multiply by pixel coverage, then composite each channel with `floor((source × alpha + background × (255 − alpha)) / 255)`. Solid and fill-rule cells allow one level for the renderer's separate premultiplication and blending; untouched background is exact.

Gradient cells allow three levels. For example, at x = 36 the ideal gradient gives blue 198.125 and alpha 206.5, or blue 168 after composition. Entry 911 in the renderer's 1024-entry lookup table samples at `911.5/1024`; its 8-bit interpolation gives blue 197 and alpha 205. Premultiplication contributes 158 and the background contributes 7, giving 165.

On LVGL 9.0.0 and 9.1.0, the ThorVG 0.11.99 reference uses `floor(coverage × 255)` and computes premultiplication and blending with `(value × alpha + 255) >> 8`. The tolerances are unchanged. The point/path rotation case requires the corresponding transform functions.

## Clipping and layers

The clipping case draws beyond a 24 × 20 child at (7, 5), directly and through a layer with opacity 128. The translucent variant uses fill opacity 159 over background opacity 96 before applying layer opacity. Painted pixels allow three levels for premultiplication, unpremultiplication, and blending. Pixels outside the child retain the background color.
