use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use liblvgl_wasm_host::{RawApi, Result, Runtime, UnsafePointer, values};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/vector/expected.json")).unwrap()
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
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"),
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

fn append_rectangle(api: &mut RawApi<'_>, path: UnsafePointer, rectangle: &Value) -> Result<()> {
    api.lv_vector_path_append_rectangle(
        path,
        number(&rectangle[0]) as f32,
        number(&rectangle[1]) as f32,
        number(&rectangle[2]) as f32,
        number(&rectangle[3]) as f32,
        0.0,
        0.0,
    )
}

fn fill(api: &mut RawApi<'_>, descriptor: UnsafePointer, rgb: &Value, opacity: i32) -> Result<()> {
    let pointer = color(api, rgb)?;
    api.lv_draw_vector_dsc_set_fill_color(descriptor, pointer)?;
    api.lv_draw_vector_dsc_set_fill_opa(descriptor, opacity)?;
    api.free(pointer)
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
    draw: fn(&mut RawApi<'_>, UnsafePointer, &Value) -> Result<()>,
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
        let mut api = context.raw()?;
        let layer = api.lv_event_get_layer(event)?;
        assert_ne!(layer.0, 0);
        draw(&mut api, layer, &captured)?;
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

fn draw_solid(api: &mut RawApi<'_>, layer: UnsafePointer, data: &Value) -> Result<()> {
    let rectangle = &data["solid"]["rectangle"];
    let triangle = &data["solid"]["triangle"];
    let descriptor = api.lv_draw_vector_dsc_create(layer)?;
    let path = api.lv_vector_path_create(values::LV_VECTOR_PATH_QUALITY_HIGH)?;
    assert_ne!(descriptor.0, 0);
    assert_ne!(path.0, 0);
    api.lv_vector_path_append_rectangle(
        path,
        number(&rectangle["x"]) as f32,
        number(&rectangle["y"]) as f32,
        number(&rectangle["width"]) as f32,
        number(&rectangle["height"]) as f32,
        0.0,
        0.0,
    )?;
    fill(
        api,
        descriptor,
        &rectangle["color"],
        number(&rectangle["opacity"]) as i32,
    )?;
    api.lv_draw_vector_dsc_add_path(descriptor, path)?;
    // add_path snapshots geometry and style before the original path is reused.
    api.lv_vector_path_clear(path)?;
    let point = api.alloc(values::LV_FPOINT_T_SIZE)?;
    for (index, coordinates) in triangle["points"].as_array().unwrap().iter().enumerate() {
        for (axis, field) in ["x", "y"].into_iter().enumerate() {
            api.write_memory(
                UnsafePointer(point.0 + offset(values::LV_FPOINT_T_FIELDS, field)),
                &(number(&coordinates[axis]) as f32).to_le_bytes(),
            )?;
        }
        if index == 0 {
            api.lv_vector_path_move_to(path, point)?;
        } else {
            api.lv_vector_path_line_to(path, point)?;
        }
    }
    api.free(point)?;
    api.lv_vector_path_close(path)?;
    fill(
        api,
        descriptor,
        &triangle["color"],
        number(&triangle["opacity"]) as i32,
    )?;
    api.lv_draw_vector_dsc_add_path(descriptor, path)?;
    api.lv_vector_path_clear(path)?;
    api.lv_vector_path_delete(path)?;
    fill(api, descriptor, &data["background"], 0)?;
    api.lv_draw_vector(descriptor)?;
    api.lv_draw_vector_dsc_delete(descriptor)
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
            composite(
                &data["background"],
                rgb(&rectangle["color"]),
                coverage * (255.0 * number(&rectangle["opacity"]) / 256.0).floor(),
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
        composite(
            &data["background"],
            rgb(&triangle["color"]),
            coverage * (255.0 * number(&triangle["opacity"]) / 256.0).floor(),
        ),
        if coverage == 0.0 { 0.0 } else { 1.0 },
    )
}

#[test]
fn vector_paths_snapshot_geometry_style_and_render_transparent_edges() -> Result<()> {
    verify_scene(draw_solid, solid_reference)
}

fn draw_fill_rules(api: &mut RawApi<'_>, layer: UnsafePointer, data: &Value) -> Result<()> {
    let fill_data = &data["fill"];
    let descriptor = api.lv_draw_vector_dsc_create(layer)?;
    let path = api.lv_vector_path_create(values::LV_VECTOR_PATH_QUALITY_HIGH)?;
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
        api.lv_draw_vector_dsc_identity(descriptor)?;
        api.lv_draw_vector_dsc_translate(
            descriptor,
            number(&translation[0]) as f32,
            number(&translation[1]) as f32,
        )?;
        api.lv_draw_vector_dsc_scale(
            descriptor,
            number(&fill_data["scale"][0]) as f32,
            number(&fill_data["scale"][1]) as f32,
        )?;
        api.lv_draw_vector_dsc_set_fill_rule(descriptor, rule)?;
        api.lv_draw_vector_dsc_add_path(descriptor, path)?;
    }
    api.lv_vector_path_delete(path)?;
    api.lv_draw_vector(descriptor)?;
    api.lv_draw_vector_dsc_delete(descriptor)
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
        composite(
            &data["background"],
            rgb(&fill["color"]),
            coverage * (255.0 * number(&fill["opacity"]) / 256.0).floor(),
        ),
        if coverage == 0.0 { 0.0 } else { 1.0 },
    )
}

#[test]
fn vector_fill_rules_and_fractional_transforms_match_pixel_coverage() -> Result<()> {
    verify_scene(draw_fill_rules, fill_reference)
}

fn draw_gradient(api: &mut RawApi<'_>, layer: UnsafePointer, data: &Value) -> Result<()> {
    let gradient = &data["gradient"];
    let descriptor = api.lv_draw_vector_dsc_create(layer)?;
    let path = api.lv_vector_path_create(values::LV_VECTOR_PATH_QUALITY_HIGH)?;
    assert_ne!(descriptor.0, 0);
    assert_ne!(path.0, 0);
    append_rectangle(api, path, &gradient["rectangle"])?;
    let stops = api.alloc(2 * values::LV_GRAD_STOP_T_SIZE)?;
    for (index, stop) in gradient["stops"].as_array().unwrap().iter().enumerate() {
        let base = stops.0 + index as u32 * values::LV_GRAD_STOP_T_SIZE;
        let rgb = &stop["color"];
        api.lv_color_hex(
            UnsafePointer(base + offset(values::LV_GRAD_STOP_T_FIELDS, "color")),
            ((number(&rgb[0]) as i32) << 16)
                | ((number(&rgb[1]) as i32) << 8)
                | number(&rgb[2]) as i32,
        )?;
        api.write_memory(
            UnsafePointer(base + offset(values::LV_GRAD_STOP_T_FIELDS, "opa")),
            &[number(&stop["opacity"]) as u8],
        )?;
        api.write_memory(
            UnsafePointer(base + offset(values::LV_GRAD_STOP_T_FIELDS, "frac")),
            &[number(&stop["fraction"]) as u8],
        )?;
    }
    api.lv_draw_vector_dsc_set_fill_linear_gradient(
        descriptor,
        number(&gradient["start"][0]) as f32,
        number(&gradient["start"][1]) as f32,
        number(&gradient["end"][0]) as f32,
        number(&gradient["end"][1]) as f32,
    )?;
    api.lv_draw_vector_dsc_set_fill_gradient_color_stops(descriptor, stops, 2)?;
    // The setter copies the stop array; rendering must not retain guest scratch.
    api.write_memory(stops, &vec![0; 2 * values::LV_GRAD_STOP_T_SIZE as usize])?;
    api.free(stops)?;
    api.lv_draw_vector_dsc_add_path(descriptor, path)?;
    api.lv_vector_path_delete(path)?;
    api.lv_draw_vector(descriptor)?;
    api.lv_draw_vector_dsc_delete(descriptor)
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
fn float_configuration_preserves_fractional_arc_and_matrix_values() -> Result<()> {
    let data = fixture();
    let (mut runtime, _, screen) = load(&data)?;
    let mut api = runtime.raw()?;
    let arc = api.lv_arc_create(screen)?;
    api.lv_arc_set_bg_angles(arc, 10.25, 280.75)?;
    api.lv_arc_set_angles(arc, 20.5, 190.25)?;
    assert_eq!(api.lv_arc_get_bg_angle_start(arc)?, 10.25);
    assert_eq!(api.lv_arc_get_bg_angle_end(arc)?, 280.75);
    assert_eq!(api.lv_arc_get_angle_start(arc)?, 20.5);
    assert_eq!(api.lv_arc_get_angle_end(arc)?, 190.25);
    let matrix = api.alloc(values::LV_MATRIX_T_SIZE)?;
    let point = api.alloc(values::LV_POINT_PRECISE_T_SIZE)?;
    let result = api.alloc(values::LV_POINT_PRECISE_T_SIZE)?;
    api.lv_matrix_identity(matrix)?;
    api.lv_matrix_translate(matrix, 1.25, -2.5)?;
    api.lv_matrix_scale(matrix, 1.5, 0.5)?;
    for (name, value) in [("x", 2.25f32), ("y", 7.5)] {
        api.write_memory(
            UnsafePointer(point.0 + offset(values::LV_POINT_PRECISE_T_FIELDS, name)),
            &value.to_le_bytes(),
        )?;
    }
    api.lv_matrix_transform_precise_point(result, matrix, point)?;
    // The native precise-point aggregate API rounds coordinates with roundf.
    for (name, expected) in [("x", 5.0f32), ("y", 1.0)] {
        let mut bytes = [0; 4];
        api.read_memory(
            UnsafePointer(result.0 + offset(values::LV_POINT_PRECISE_T_FIELDS, name)),
            &mut bytes,
        )?;
        assert_eq!(f32::from_le_bytes(bytes), expected);
    }
    api.free(result)?;
    api.free(point)?;
    let point = api.alloc(values::LV_FPOINT_T_SIZE)?;
    for (name, value) in [("x", 2.25f32), ("y", 7.5)] {
        api.write_memory(
            UnsafePointer(point.0 + offset(values::LV_FPOINT_T_FIELDS, name)),
            &value.to_le_bytes(),
        )?;
    }
    api.lv_matrix_transform_point(matrix, point)?;
    for (name, expected) in [("x", 4.625f32), ("y", 1.25)] {
        let mut bytes = [0; 4];
        api.read_memory(
            UnsafePointer(point.0 + offset(values::LV_FPOINT_T_FIELDS, name)),
            &mut bytes,
        )?;
        assert_eq!(f32::from_le_bytes(bytes), expected);
    }
    api.free(point)?;
    api.free(matrix)?;
    api.lv_obj_delete(arc)?;
    runtime.shutdown()
}
