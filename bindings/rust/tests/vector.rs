use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};

use liblvgl_wasm_host::{CallbackContext, RawApi, Result, Runtime, UnsafePointer, values};
use serde_json::Value;

fn fixture() -> Value {
    let directory = std::env::var_os("LVW_TEST_VECTOR_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/vector")
        });
    serde_json::from_slice(&std::fs::read(directory.join("expected.json")).unwrap()).unwrap()
}

const LEGACY: bool = matches!(values::LVGL_VERSION_MINOR, 0 | 1);

fn metadata() -> &'static Value {
    static API: OnceLock<Value> = OnceLock::new();
    API.get_or_init(|| {
        let path = std::env::var_os("LVW_TEST_API")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/api.json")
            });
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    })
}

fn record(name: &str) -> &'static Value {
    metadata()["types"]
        .as_object()
        .unwrap()
        .values()
        .find(|node| node["kind"] == "record" && node["name"] == name)
        .unwrap()
}

fn field(record: &Value, name: &str) -> u32 {
    let field = record["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["name"] == name)
        .unwrap();
    assert!(field["bit_width"].is_null());
    let bits = field["bit_offset"].as_u64().unwrap();
    assert_eq!(bits % 8, 0);
    (bits / 8) as u32
}

fn vector_name(method: &str) -> String {
    let name = format!(
        "{}{}",
        if LEGACY {
            "lv_vector_dsc_"
        } else {
            "lv_draw_vector_dsc_"
        },
        method
    );
    export_name(&name).to_owned()
}

fn export_name(name: &str) -> &'static str {
    metadata()["declarations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == name)
        .unwrap()["export_name"]
        .as_str()
        .unwrap()
}

macro_rules! vector {
    ($context:expr, $method:literal, $params:expr) => {
        $context.call_raw::<_, ()>(&vector_name($method), $params)
    };
}

fn vector_create(context: &mut CallbackContext<'_>, layer: UnsafePointer) -> Result<UnsafePointer> {
    context
        .call_raw(&vector_name("create"), (layer.0,))
        .map(UnsafePointer)
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

fn offset(fields: &[values::FieldLayout], name: &str) -> u32 {
    let field = fields
        .iter()
        .find(|field| field.name == Some(name))
        .unwrap();
    assert!(field.bit_width.is_none());
    assert_eq!(field.bit_offset % 8, 0);
    u32::try_from(field.bit_offset / 8).unwrap()
}

fn color(api: &mut RawApi<'_>, rgb: &Value) -> Result<UnsafePointer> {
    let pointer = api.alloc(values::LV_COLOR_T_SIZE)?;
    api.lv_color_hex(
        pointer,
        ((number(&rgb[0]) as i32) << 16) | ((number(&rgb[1]) as i32) << 8) | number(&rgb[2]) as i32,
    )?;
    Ok(pointer)
}

fn load(data: &Value) -> Result<(Runtime, u32, UnsafePointer)> {
    let mut runtime = Runtime::from_file(
        std::env::var_os("LVW_TEST_CORE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm")
            }),
    )?;
    let display = runtime.call_raw(
        "lvw_display_create",
        (
            number(&data["width"]) as u32,
            number(&data["height"]) as u32,
            1u32,
        ),
    )?;
    let mut api = runtime.raw()?;
    let screen = api.lv_display_get_screen_active(UnsafePointer(display))?;
    let background = color(&mut api, &data["background"])?;
    api.lv_obj_set_style_bg_color(screen, background, values::LV_PART_MAIN)?;
    api.lv_obj_set_style_bg_opa(screen, values::LV_OPA_COVER, values::LV_PART_MAIN)?;
    api.free(background)?;
    Ok((runtime, display, screen))
}

fn frame(runtime: &mut Runtime, display: u32, screen: UnsafePointer) -> Result<Vec<u8>> {
    runtime.raw()?.lv_obj_invalidate(screen)?;
    runtime.raw()?.lv_refr_now(UnsafePointer(display))?;
    let pointer = runtime.alloc(48)?;
    let mut bytes = [0; 48];
    bytes[..4].copy_from_slice(&48u32.to_le_bytes());
    bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
    runtime.write_memory(pointer, &bytes)?;
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_frame_get", (display, pointer))?,
        0
    );
    runtime.read_memory(pointer, &mut bytes)?;
    let pixels = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let length = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
    let width = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
    let stride = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
    assert_eq!(stride, width * 4);
    let mut image = vec![0; length as usize];
    runtime.read_memory(pixels, &mut image)?;
    runtime.free(pointer)?;
    Ok(image)
}

fn append_rectangle(
    api: &mut CallbackContext<'_>,
    path: UnsafePointer,
    rectangle: &Value,
) -> Result<()> {
    let [x, y, w, h] = std::array::from_fn(|index| number(&rectangle[index]) as f32);
    if !LEGACY {
        return api.call_raw(
            "lv_vector_path_append_rectangle",
            (path.0, x, y, w, h, 0f32, 0f32),
        );
    }
    let area = api.alloc(values::LV_AREA_T_SIZE)?;
    for (name, value) in ["x1", "y1", "x2", "y2"]
        .into_iter()
        .zip([x, y, x + w - 1.0, y + h - 1.0])
    {
        assert_eq!(value.fract(), 0.0);
        api.write_memory(
            area + offset(values::LV_AREA_T_FIELDS, name),
            &(value as i32).to_le_bytes(),
        )?;
    }
    api.call_raw::<_, ()>("lv_vector_path_append_rect", (path.0, area, 0f32, 0f32))?;
    api.free(area)
}

fn fill(
    api: &mut CallbackContext<'_>,
    descriptor: UnsafePointer,
    rgb: &Value,
    opacity: i32,
) -> Result<()> {
    let pointer = color(&mut api.raw()?, rgb)?;
    vector!(api, "set_fill_color", (descriptor.0, pointer.0))?;
    vector!(api, "set_fill_opa", (descriptor.0, opacity))?;
    api.free(pointer.0)
}

fn assert_pixel(image: &[u8], width: usize, x: usize, y: usize, rgb: [f64; 3], tolerance: f64) {
    for (channel, expected) in rgb.into_iter().enumerate() {
        let actual = image[(y * width + x) * 4 + 2 - channel];
        assert!(
            (f64::from(actual) - expected).abs() <= tolerance,
            "({x}, {y}) channel {channel}: {actual}, expected {expected} ± {tolerance}"
        );
    }
}

fn composite(background: &Value, foreground: [f64; 3], alpha: f64) -> [f64; 3] {
    std::array::from_fn(|channel| {
        ((foreground[channel] * alpha + number(&background[channel]) * (255.0 - alpha)) / 255.0)
            .floor()
    })
}

fn solid_composite(
    background: &Value,
    foreground: [f64; 3],
    opacity: f64,
    coverage: f64,
) -> [f64; 3] {
    if !LEGACY || coverage == 0.0 {
        return composite(background, foreground, opacity * coverage);
    }
    // ThorVG 0.11.99 rounds each premultiplication and blend term upward.
    let multiply = |value: f64, factor: f64| ((value * factor + 255.0) / 256.0).floor();
    let byte = (coverage * 255.0).floor();
    let alpha = if coverage == 1.0 {
        opacity
    } else {
        multiply(opacity, byte)
    };
    std::array::from_fn(|channel| {
        let color = multiply(foreground[channel], opacity);
        let color = if coverage == 1.0 {
            color
        } else {
            multiply(color, byte)
        };
        color + multiply(number(&background[channel]), 255.0 - alpha)
    })
}

fn rgb(value: &Value) -> [f64; 3] {
    std::array::from_fn(|channel| number(&value[channel]))
}

fn rectangle_coverage(x: usize, y: usize, rectangle: [f64; 4]) -> f64 {
    let [left, top, width, height] = rectangle;
    let horizontal = ((x as f64 + 1.0).min(left + width) - (x as f64).max(left)).max(0.0);
    let vertical = ((y as f64 + 1.0).min(top + height) - (y as f64).max(top)).max(0.0);
    horizontal * vertical
}

fn verify_scene(
    draw: fn(&mut CallbackContext<'_>, UnsafePointer, &Value) -> Result<()>,
    reference: fn(usize, usize, &Value) -> ([f64; 3], f64),
) -> Result<()> {
    let data = fixture();
    let (mut runtime, display, screen) = load(&data)?;
    let captured = data.clone();
    let calls = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&calls);
    runtime.set_event_handler_with_context(move |context, event| {
        assert_eq!(event.callback_id, 1);
        let event = context.event_pointer()?;
        let layer = context.raw()?.lv_event_get_layer(event)?;
        assert_ne!(layer.0, 0);
        draw(context, layer, &captured)?;
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })?;
    assert_eq!(
        runtime.call_raw::<_, i32>(
            "lvw_event_add",
            (screen.0, values::LV_EVENT_DRAW_MAIN_END, 1u32)
        )?,
        0
    );
    let width = number(&data["width"]) as usize;
    let height = number(&data["height"]) as usize;
    let mut previous = None;
    for _ in 0..2 {
        let image = frame(&mut runtime, display, screen)?;
        for y in 0..height {
            for x in 0..width {
                let (expected, tolerance) = reference(x, y, &data);
                assert_pixel(&image, width, x, y, expected, tolerance);
            }
        }
        if let Some(previous) = previous.as_ref() {
            assert_eq!(
                &image, previous,
                "redraw must not borrow deleted paths or descriptors"
            );
        }
        previous = Some(image);
    }
    assert!(calls.load(Ordering::SeqCst) >= 2);
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_event_remove", (screen.0, 1u32))?,
        0
    );
    let count = calls.load(Ordering::SeqCst);
    let cleared = frame(&mut runtime, display, screen)?;
    for y in 0..height {
        for x in 0..width {
            assert_pixel(&cleared, width, x, y, rgb(&data["background"]), 0.0);
        }
    }
    assert_eq!(calls.load(Ordering::SeqCst), count);
    assert_eq!(runtime.raw()?.lv_pow(2, 7)?, 128);
    runtime.shutdown()
}

fn draw_solid(api: &mut CallbackContext<'_>, layer: UnsafePointer, data: &Value) -> Result<()> {
    let rectangle = &data["solid"]["rectangle"];
    let triangle = &data["solid"]["triangle"];
    let descriptor = vector_create(api, layer)?;
    let path = api
        .raw()?
        .lv_vector_path_create(values::LV_VECTOR_PATH_QUALITY_HIGH)?;
    assert_ne!(descriptor.0, 0);
    assert_ne!(path.0, 0);
    append_rectangle(
        api,
        path,
        &serde_json::json!([
            rectangle["x"],
            rectangle["y"],
            rectangle["width"],
            rectangle["height"]
        ]),
    )?;
    fill(
        api,
        descriptor,
        &rectangle["color"],
        number(&rectangle["opacity"]) as i32,
    )?;
    vector!(api, "add_path", (descriptor.0, path.0))?;
    // add_path snapshots geometry and style before the original path is reused.
    api.raw()?.lv_vector_path_clear(path)?;
    let point = api.raw()?.alloc(values::LV_FPOINT_T_SIZE)?;
    for (index, coordinates) in triangle["points"].as_array().unwrap().iter().enumerate() {
        for (axis, field) in ["x", "y"].into_iter().enumerate() {
            api.raw()?.write_memory(
                UnsafePointer(point.0 + offset(values::LV_FPOINT_T_FIELDS, field)),
                &(number(&coordinates[axis]) as f32).to_le_bytes(),
            )?;
        }
        if index == 0 {
            api.raw()?.lv_vector_path_move_to(path, point)?;
        } else {
            api.raw()?.lv_vector_path_line_to(path, point)?;
        }
    }
    api.raw()?.free(point)?;
    api.raw()?.lv_vector_path_close(path)?;
    fill(
        api,
        descriptor,
        &triangle["color"],
        number(&triangle["opacity"]) as i32,
    )?;
    vector!(api, "add_path", (descriptor.0, path.0))?;
    api.raw()?.lv_vector_path_clear(path)?;
    api.raw()?.lv_vector_path_delete(path)?;
    fill(api, descriptor, &data["background"], 0)?;
    api.raw()?.lv_draw_vector(descriptor)?;
    vector!(api, "delete", (descriptor.0,))
}

fn solid_reference(x: usize, y: usize, data: &Value) -> ([f64; 3], f64) {
    let rectangle = &data["solid"]["rectangle"];
    let coverage = rectangle_coverage(
        x,
        y,
        [
            number(&rectangle["x"]),
            number(&rectangle["y"]),
            number(&rectangle["width"]),
            number(&rectangle["height"]),
        ],
    );
    if coverage != 0.0 {
        return (
            solid_composite(
                &data["background"],
                rgb(&rectangle["color"]),
                (255.0 * number(&rectangle["opacity"]) / 256.0).floor(),
                coverage,
            ),
            1.0,
        );
    }
    let triangle = &data["solid"]["triangle"];
    let sx = x as f64 - number(&triangle["points"][0][0]);
    let sy = y as f64 - number(&triangle["points"][0][1]);
    let extent = number(&triangle["points"][1][0]) - number(&triangle["points"][0][0]);
    let coverage = if sx < 0.0 || sy < 0.0 || sx + sy >= extent {
        0.0
    } else if sx + sy == extent - 1.0 {
        0.5
    } else {
        1.0
    };
    (
        solid_composite(
            &data["background"],
            rgb(&triangle["color"]),
            (255.0 * number(&triangle["opacity"]) / 256.0).floor(),
            coverage,
        ),
        if coverage == 0.0 { 0.0 } else { 1.0 },
    )
}

#[test]
fn vector_paths_snapshot_geometry_style_and_render_transparent_edges() -> Result<()> {
    verify_scene(draw_solid, solid_reference)
}

fn draw_fill_rules(
    api: &mut CallbackContext<'_>,
    layer: UnsafePointer,
    data: &Value,
) -> Result<()> {
    let fill_data = &data["fill"];
    let descriptor = vector_create(api, layer)?;
    let path = api
        .raw()?
        .lv_vector_path_create(values::LV_VECTOR_PATH_QUALITY_HIGH)?;
    assert_ne!(descriptor.0, 0);
    assert_ne!(path.0, 0);
    append_rectangle(api, path, &fill_data["outer"])?;
    append_rectangle(api, path, &fill_data["inner"])?;
    fill(
        api,
        descriptor,
        &fill_data["color"],
        number(&fill_data["opacity"]) as i32,
    )?;
    for (index, rule) in [
        values::LV_VECTOR_FILL_NONZERO,
        values::LV_VECTOR_FILL_EVENODD,
    ]
    .into_iter()
    .enumerate()
    {
        let translation = &fill_data["translations"][index];
        vector!(api, "identity", (descriptor.0,))?;
        vector!(
            api,
            "translate",
            (
                descriptor.0,
                number(&translation[0]) as f32,
                number(&translation[1]) as f32
            )
        )?;
        vector!(
            api,
            "scale",
            (
                descriptor.0,
                number(&fill_data["scale"][0]) as f32,
                number(&fill_data["scale"][1]) as f32
            )
        )?;
        vector!(api, "set_fill_rule", (descriptor.0, rule))?;
        vector!(api, "add_path", (descriptor.0, path.0))?;
    }
    api.raw()?.lv_vector_path_delete(path)?;
    api.raw()?.lv_draw_vector(descriptor)?;
    vector!(api, "delete", (descriptor.0,))
}

fn fill_reference(x: usize, y: usize, data: &Value) -> ([f64; 3], f64) {
    let fill = &data["fill"];
    let mut coverage = 0.0;
    for (index, translation) in fill["translations"].as_array().unwrap().iter().enumerate() {
        let transformed = |name: &str| {
            [
                number(&translation[0]) + number(&fill[name][0]) * number(&fill["scale"][0]),
                number(&translation[1]) + number(&fill[name][1]) * number(&fill["scale"][1]),
                number(&fill[name][2]) * number(&fill["scale"][0]),
                number(&fill[name][3]) * number(&fill["scale"][1]),
            ]
        };
        coverage += rectangle_coverage(x, y, transformed("outer"));
        if index == 1 {
            coverage -= rectangle_coverage(x, y, transformed("inner"));
        }
    }
    (
        solid_composite(
            &data["background"],
            rgb(&fill["color"]),
            (255.0 * number(&fill["opacity"]) / 256.0).floor(),
            coverage,
        ),
        if coverage == 0.0 { 0.0 } else { 1.0 },
    )
}

#[test]
fn vector_fill_rules_and_fractional_transforms_match_pixel_coverage() -> Result<()> {
    verify_scene(draw_fill_rules, fill_reference)
}

fn draw_gradient(api: &mut CallbackContext<'_>, layer: UnsafePointer, data: &Value) -> Result<()> {
    let gradient = &data["gradient"];
    let descriptor = vector_create(api, layer)?;
    let path = api
        .raw()?
        .lv_vector_path_create(values::LV_VECTOR_PATH_QUALITY_HIGH)?;
    assert_ne!(descriptor.0, 0);
    assert_ne!(path.0, 0);
    append_rectangle(api, path, &gradient["rectangle"])?;
    let stop_type = record(if LEGACY {
        "lv_gradient_stop_t"
    } else {
        "lv_grad_stop_t"
    });
    let stop_size = stop_type["layout"]["size"].as_u64().unwrap() as u32;
    let grad_type = record("lv_grad_dsc_t");
    let bytes = if LEGACY {
        grad_type["layout"]["size"].as_u64().unwrap() as u32
    } else {
        2 * stop_size
    };
    let storage = api.alloc(bytes)?;
    api.write_memory(storage, &vec![0; bytes as usize])?;
    let stops = storage + if LEGACY { field(grad_type, "stops") } else { 0 };
    for (index, stop) in gradient["stops"].as_array().unwrap().iter().enumerate() {
        let base = stops + index as u32 * stop_size;
        let rgb = &stop["color"];
        api.raw()?.lv_color_hex(
            UnsafePointer(base + field(stop_type, "color")),
            ((number(&rgb[0]) as i32) << 16)
                | ((number(&rgb[1]) as i32) << 8)
                | number(&rgb[2]) as i32,
        )?;
        api.write_memory(
            base + field(stop_type, "opa"),
            &[number(&stop["opacity"]) as u8],
        )?;
        api.write_memory(
            base + field(stop_type, "frac"),
            &[number(&stop["fraction"]) as u8],
        )?;
    }
    if LEGACY {
        api.write_memory(storage + field(grad_type, "stops_count"), &[2])?;
        let direction = grad_type["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == "dir")
            .unwrap();
        assert_eq!(direction["bit_width"], 3);
        let bit = direction["bit_offset"].as_u64().unwrap() as u32;
        api.write_memory(
            storage + bit / 8,
            &[(values::LV_GRAD_DIR_HOR as u8) << (bit % 8)],
        )?;
        vector!(
            api,
            "set_fill_linear_gradient",
            (descriptor.0, storage, values::LV_VECTOR_GRADIENT_SPREAD_PAD)
        )?;
    } else {
        vector!(
            api,
            "set_fill_linear_gradient",
            (
                descriptor.0,
                number(&gradient["start"][0]) as f32,
                number(&gradient["start"][1]) as f32,
                number(&gradient["end"][0]) as f32,
                number(&gradient["end"][1]) as f32
            )
        )?;
        vector!(
            api,
            "set_fill_gradient_color_stops",
            (descriptor.0, stops, 2i32)
        )?;
    }
    // Both native gradient setters copy the supplied storage.
    api.write_memory(storage, &vec![0; bytes as usize])?;
    api.free(storage)?;
    vector!(api, "add_path", (descriptor.0, path.0))?;
    api.raw()?.lv_vector_path_delete(path)?;
    api.raw()?.lv_draw_vector(descriptor)?;
    vector!(api, "delete", (descriptor.0,))
}

fn gradient_reference(x: usize, y: usize, data: &Value) -> ([f64; 3], f64) {
    let gradient = &data["gradient"];
    let coverage = rectangle_coverage(
        x,
        y,
        std::array::from_fn(|index| number(&gradient["rectangle"][index])),
    );
    if coverage == 0.0 {
        return (rgb(&data["background"]), 0.0);
    }
    let t = ((x as f64 + 0.5 - number(&gradient["start"][0]))
        / (number(&gradient["end"][0]) - number(&gradient["start"][0])))
    .clamp(0.0, 1.0);
    let first = &gradient["stops"][0];
    let second = &gradient["stops"][1];
    let foreground = std::array::from_fn(|channel| {
        number(&first["color"][channel]) * (1.0 - t) + number(&second["color"][channel]) * t
    });
    let alpha = number(&first["opacity"]) * (1.0 - t) + number(&second["opacity"]) * t;
    (
        composite(&data["background"], foreground, alpha * coverage),
        3.0,
    )
}

#[test]
fn vector_linear_gradient_interpolates_color_alpha_and_copies_stops() -> Result<()> {
    verify_scene(draw_gradient, gradient_reference)
}

#[test]
fn vector_drawing_preserves_clipping_and_translated_transparent_layers() -> Result<()> {
    for (opacity, backdrop_opacity) in [(255, 0), (128, 0), (128, 96)] {
        let data = fixture();
        let (mut runtime, display, screen) = load(&data)?;
        let object = runtime.raw()?.lv_obj_create(screen)?;
        runtime.raw()?.lv_obj_remove_style_all(object)?;
        runtime.raw()?.lv_obj_set_pos(object, 7, 5)?;
        runtime.raw()?.lv_obj_set_size(object, 24, 20)?;
        runtime
            .raw()?
            .lv_obj_set_style_opa_layered(object, opacity, values::LV_PART_MAIN)?;
        let backdrop = color(&mut runtime.raw()?, &data["fill"]["color"])?;
        runtime
            .raw()?
            .lv_obj_set_style_bg_color(object, backdrop, values::LV_PART_MAIN)?;
        runtime.raw()?.free(backdrop)?;
        runtime
            .raw()?
            .lv_obj_set_style_bg_opa(object, backdrop_opacity, values::LV_PART_MAIN)?;
        let captured = data.clone();
        runtime.set_event_handler_with_context(move |context, event| {
            assert_eq!(event.callback_id, 1);
            let event = context.event_pointer()?;
            let layer = context.raw()?.lv_event_get_layer(event)?;
            let descriptor = vector_create(context, layer)?;
            let path = context
                .raw()?
                .lv_vector_path_create(values::LV_VECTOR_PATH_QUALITY_HIGH)?;
            append_rectangle(context, path, &serde_json::json!([0, 0, 50, 40]))?;
            fill(
                context,
                descriptor,
                &captured["solid"]["rectangle"]["color"],
                160,
            )?;
            vector!(context, "add_path", (descriptor.0, path.0))?;
            context.raw()?.lv_vector_path_delete(path)?;
            context.raw()?.lv_draw_vector(descriptor)?;
            vector!(context, "delete", (descriptor.0,))
        })?;
        assert_eq!(
            runtime.call_raw::<_, i32>(
                "lvw_event_add",
                (object.0, values::LV_EVENT_DRAW_MAIN_END, 1u32)
            )?,
            0
        );
        let width = number(&data["width"]) as usize;
        let height = number(&data["height"]) as usize;
        for _ in 0..2 {
            let image = frame(&mut runtime, display, screen)?;
            for y in 0..height {
                for x in 0..width {
                    let painted = (7..31).contains(&x) && (5..25).contains(&y);
                    let expected = if painted {
                        let a = 159.0 / 255.0;
                        let b = f64::from(backdrop_opacity) / 255.0 * (1.0 - a);
                        let foreground = std::array::from_fn(|channel| {
                            (number(&data["solid"]["rectangle"]["color"][channel]) * a
                                + number(&data["fill"]["color"][channel]) * b)
                                / (a + b)
                        });
                        composite(
                            &data["background"],
                            foreground,
                            (a + b) * f64::from(opacity),
                        )
                    } else {
                        rgb(&data["background"])
                    };
                    assert_pixel(
                        &image,
                        width,
                        x,
                        y,
                        expected,
                        if painted { 3.0 } else { 0.0 },
                    );
                }
            }
        }
        runtime.call_raw::<_, i32>("lvw_event_remove", (object.0, 1u32))?;
        runtime.raw()?.lv_obj_delete(object)?;
        runtime.shutdown()?;
    }
    Ok(())
}

#[test]
fn point_and_path_transforms_agree_with_the_drawing_matrix_under_rotation() -> Result<()> {
    if values::LVGL_VERSION_MINOR == 0 {
        return Ok(());
    }
    fn draw(api: &mut CallbackContext<'_>, layer: UnsafePointer, data: &Value) -> Result<()> {
        let sample = &data["rotation"];
        let matrix = api.alloc(values::LV_MATRIX_T_SIZE)?;
        let mut entries: Vec<_> = sample["matrix"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| number(v) as f32)
            .collect();
        let bytes: Vec<_> = entries.iter().flat_map(|v| v.to_le_bytes()).collect();
        api.write_memory(matrix, &bytes)?;
        let point = api.alloc(values::LV_FPOINT_T_SIZE)?;
        for (index, name) in ["x", "y"].into_iter().enumerate() {
            api.write_memory(
                point + offset(values::LV_FPOINT_T_FIELDS, name),
                &(number(&sample["point"][index]) as f32).to_le_bytes(),
            )?;
        }
        api.call_raw::<_, ()>("lv_matrix_transform_point", (matrix, point))?;
        for (index, name) in ["x", "y"].into_iter().enumerate() {
            let mut bytes = [0; 4];
            api.read_memory(point + offset(values::LV_FPOINT_T_FIELDS, name), &mut bytes)?;
            assert_eq!(
                f32::from_le_bytes(bytes),
                number(&sample["point_expected"][index]) as f32
            );
        }
        api.free(point)?;
        let descriptor = vector_create(api, layer)?;
        let path = api
            .raw()?
            .lv_vector_path_create(values::LV_VECTOR_PATH_QUALITY_HIGH)?;
        append_rectangle(api, path, &sample["rectangle"])?;
        api.call_raw::<_, ()>("lv_matrix_transform_path", (matrix, path.0))?;
        fill(
            api,
            descriptor,
            &sample["color"],
            number(&sample["opacity"]) as i32,
        )?;
        vector!(api, "set_stroke_opa", (descriptor.0, 0i32))?;
        vector!(api, "add_path", (descriptor.0, path.0))?;
        api.raw()?.lv_vector_path_clear(path)?;
        append_rectangle(api, path, &sample["rectangle"])?;
        entries[2] += number(&sample["separation"]) as f32;
        let bytes: Vec<_> = entries.iter().flat_map(|v| v.to_le_bytes()).collect();
        api.write_memory(matrix, &bytes)?;
        vector!(api, "set_transform", (descriptor.0, matrix))?;
        vector!(api, "add_path", (descriptor.0, path.0))?;
        api.raw()?.lv_vector_path_delete(path)?;
        api.free(matrix)?;
        api.raw()?.lv_draw_vector(descriptor)?;
        vector!(api, "delete", (descriptor.0,))
    }
    fn reference(x: usize, y: usize, data: &Value) -> ([f64; 3], f64) {
        let sample = &data["rotation"];
        let rect = std::array::from_fn(|i| number(&sample["result"][i]));
        let covered = rectangle_coverage(x, y, rect)
            + rectangle_coverage(
                x,
                y,
                [
                    rect[0] + number(&sample["separation"]),
                    rect[1],
                    rect[2],
                    rect[3],
                ],
            );
        let alpha = (255.0 * number(&sample["opacity"]) / 256.0).floor();
        (
            solid_composite(&data["background"], rgb(&sample["color"]), alpha, covered),
            if covered > 0.0 { 1.0 } else { 0.0 },
        )
    }
    verify_scene(draw, reference)
}

#[test]
fn float_configuration_preserves_fractional_arc_and_matrix_values() -> Result<()> {
    let data = fixture();
    let (mut runtime, _, screen) = load(&data)?;
    let arc = runtime.raw()?.lv_arc_create(screen)?;
    runtime.raw()?.lv_arc_set_bg_angles(arc, 10.25, 280.75)?;
    runtime.raw()?.lv_arc_set_angles(arc, 20.5, 190.25)?;
    assert_eq!(runtime.raw()?.lv_arc_get_bg_angle_start(arc)?, 10.25);
    assert_eq!(runtime.raw()?.lv_arc_get_bg_angle_end(arc)?, 280.75);
    assert_eq!(runtime.raw()?.lv_arc_get_angle_start(arc)?, 20.5);
    assert_eq!(runtime.raw()?.lv_arc_get_angle_end(arc)?, 190.25);
    let matrix = runtime.raw()?.alloc(values::LV_MATRIX_T_SIZE)?;
    runtime.raw()?.lv_matrix_identity(matrix)?;
    runtime.raw()?.lv_matrix_translate(matrix, 1.25, -2.5)?;
    runtime.raw()?.lv_matrix_scale(matrix, 1.5, 0.5)?;
    if values::LVGL_VERSION_MINOR == 0 {
        let mut bytes = [0u8; 36];
        runtime.read_memory(matrix.0, &mut bytes)?;
        let entries: Vec<_> = bytes
            .chunks_exact(4)
            .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
            .collect();
        assert_eq!(entries, [1.5, 0.0, 1.25, 0.0, 0.5, -2.5, 0.0, 0.0, 1.0]);
        runtime.free(matrix.0)?;
        runtime.raw()?.lv_obj_delete(arc)?;
        return runtime.shutdown();
    }
    if !LEGACY {
        let point = runtime.raw()?.alloc(values::LV_POINT_PRECISE_T_SIZE)?;
        let result = runtime.raw()?.alloc(values::LV_POINT_PRECISE_T_SIZE)?;
        for (name, value) in [("x", 2.25f32), ("y", 7.5)] {
            runtime.raw()?.write_memory(
                UnsafePointer(point.0 + offset(values::LV_POINT_PRECISE_T_FIELDS, name)),
                &value.to_le_bytes(),
            )?;
        }
        runtime.call_raw::<_, ()>(
            export_name("lv_matrix_transform_precise_point"),
            (result.0, matrix.0, point.0),
        )?;
        // The native precise-point aggregate API rounds coordinates with roundf.
        for (name, expected) in [("x", 5.0f32), ("y", 1.0)] {
            let mut bytes = [0; 4];
            runtime.raw()?.read_memory(
                UnsafePointer(result.0 + offset(values::LV_POINT_PRECISE_T_FIELDS, name)),
                &mut bytes,
            )?;
            assert_eq!(f32::from_le_bytes(bytes), expected);
        }
        runtime.raw()?.free(result)?;
        runtime.raw()?.free(point)?;
    }
    let point = runtime.raw()?.alloc(values::LV_FPOINT_T_SIZE)?;
    for (name, value) in [("x", 2.25f32), ("y", 7.5)] {
        runtime.raw()?.write_memory(
            UnsafePointer(point.0 + offset(values::LV_FPOINT_T_FIELDS, name)),
            &value.to_le_bytes(),
        )?;
    }
    runtime.call_raw::<_, ()>("lv_matrix_transform_point", (matrix.0, point.0))?;
    for (name, expected) in [("x", 4.625f32), ("y", 1.25)] {
        let mut bytes = [0; 4];
        runtime.raw()?.read_memory(
            UnsafePointer(point.0 + offset(values::LV_FPOINT_T_FIELDS, name)),
            &mut bytes,
        )?;
        assert_eq!(f32::from_le_bytes(bytes), expected);
    }
    runtime.raw()?.free(point)?;
    runtime.raw()?.free(matrix)?;
    runtime.raw()?.lv_obj_delete(arc)?;
    runtime.shutdown()
}
