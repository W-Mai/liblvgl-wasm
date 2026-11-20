# Lottie: translation and opacity

[translation-opacity.json](translation-opacity.json) is an original, self-contained 32 × 24 animation. An orange rectangle moves right and fades in over one second. [expected.json](expected.json) contains the source hash and expected RGBA pixels for five points in that animation.

| Time (ms) | Visible frame | Rectangle left edge | Alpha |
| ---: | ---: | ---: | ---: |
| 0 | 0 | 4 | 63 |
| 250 | 4 | 8 | 111 |
| 500 | 8 | 12 | 159 |
| 750 | 12 | 16 | 207 |
| 1000 | 15 | 19 | 243 |

## Reading the pixel reference

At frame `f`, the rectangle covers `[4+f, 12+f) × [4, 12)`. The composition runs at 16 fps over `[0, 16)`; at the end of playback LVGL requests frame 16 and the renderer holds frame 15. Every edge falls on a whole pixel at these checkpoints.

The fill is RGB `[255, 128, 0]` with alpha `floor(63 + 192 × f / 16)`. Composite each channel over the background `[16, 32, 48]` with `floor((foreground × alpha + background × (255 − alpha)) / 255)`. Painted channels allow two levels for premultiplication and rounding; background channels are exact. The recolored variant substitutes `[0, 128, 255]`. The display's XRGB output is opaque.
