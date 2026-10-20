use std::path::Path;

use liblvgl_wasm_host::{Result, Runtime, UnsafePointer, values};
use serde_json::Value;

const WIDTH: u32 = 48;
const HEIGHT: u32 = 32;
const X: u32 = 5;
const Y: u32 = 4;

fn expected() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/png/expected.json")).unwrap()
}

fn fixture(name: &str) -> Result<Vec<u8>> {
    Ok(std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/png")
            .join(name),
    )?)
}

fn background(expected: &Value) -> [u8; 4] {
    std::array::from_fn(|index| {
        if index == 3 {
            255
        } else {
            expected["background"][index].as_u64().unwrap() as u8
        }
    })
}

fn load(expected: &Value) -> Result<(Runtime, u32, UnsafePointer)> {
    let mut runtime = Runtime::from_file(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"),
    )?;
    let display = runtime.call_raw("lvw_display_create", (WIDTH, HEIGHT, 1u32))?;
    let mut raw = runtime.raw()?;
    let screen = raw.lv_display_get_screen_active(UnsafePointer(display))?;
    let color = raw.alloc(values::LV_COLOR_T_SIZE)?;
    let [red, green, blue, _] = background(expected);
    raw.lv_color_hex(
        color,
        ((red as i32) << 16) | ((green as i32) << 8) | blue as i32,
    )?;
    raw.lv_obj_set_style_bg_color(screen, color, values::LV_PART_MAIN)?;
    raw.lv_obj_set_style_bg_opa(screen, values::LV_OPA_COVER, values::LV_PART_MAIN)?;
    raw.free(color)?;
    Ok((runtime, display, screen))
}

fn upload(runtime: &mut Runtime, name: &str, bytes: &[u8]) -> Result<UnsafePointer> {
    let key = runtime.alloc(name.len() as u32)?;
    let data = runtime.alloc(bytes.len() as u32)?;
    runtime.write_memory(key, name.as_bytes())?;
    runtime.write_memory(data, bytes)?;
    assert_eq!(
        runtime.call_raw::<_, i32>(
            "lvw_resource_put",
            (key, name.len() as u32, data, bytes.len() as u32)
        )?,
        0
    );
    // Resource storage must own a copy independently of the upload buffers.
    runtime.write_memory(data, &vec![0; bytes.len()])?;
    runtime.free(data)?;
    runtime.free(key)?;
    let path = format!("W:{name}\0");
    let pointer = runtime.alloc(path.len() as u32)?;
    runtime.write_memory(pointer, path.as_bytes())?;
    Ok(UnsafePointer(pointer))
}

fn image(runtime: &mut Runtime, screen: UnsafePointer, x: u32, y: u32) -> Result<UnsafePointer> {
    let mut raw = runtime.raw()?;
    let image = raw.lv_image_create(screen)?;
    raw.lv_obj_remove_style_all(image)?;
    raw.lv_obj_set_style_image_opa(image, values::LV_OPA_COVER, values::LV_PART_MAIN)?;
    raw.lv_obj_set_style_image_recolor_opa(image, values::LV_OPA_TRANSP, values::LV_PART_MAIN)?;
    raw.lv_obj_set_pos(image, x as i32, y as i32)?;
    Ok(image)
}

fn step(runtime: &mut Runtime) -> Result<()> {
    let pointer = runtime.alloc(16)?;
    let mut bytes = [0; 16];
    bytes[..4].copy_from_slice(&16u32.to_le_bytes());
    bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
    runtime.write_memory(pointer, &bytes)?;
    assert_eq!(runtime.call_raw::<_, i32>("lvw_step", (50u32, pointer))?, 0);
    runtime.free(pointer)
}

struct Frame {
    id: u32,
    stride: usize,
    bytes: Vec<u8>,
}

impl Frame {
    fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let start = y as usize * self.stride + x as usize * 4;
        // ABI 1 exposes XRGB8888 in little-endian BGRX order; output is opaque.
        [
            self.bytes[start + 2],
            self.bytes[start + 1],
            self.bytes[start],
            255,
        ]
    }
}

fn frame(runtime: &mut Runtime, display: u32) -> Result<Frame> {
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
    let word = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    assert_eq!(
        (word(16), word(20), word(28), word(32)),
        (WIDTH, HEIGHT, 1, 0)
    );
    assert!(word(44) > 0);
    assert_eq!(word(24), WIDTH * 4);
    let mut pixels = vec![0; word(12) as usize];
    runtime.read_memory(word(8), &mut pixels)?;
    runtime.free(pointer)?;
    Ok(Frame {
        id: word(44),
        stride: word(24) as usize,
        bytes: pixels,
    })
}

fn assert_image(frame: &Frame, expected: &Value, alpha: bool, x: u32, y: u32) {
    let width = expected["width"].as_u64().unwrap() as u32;
    let height = expected["height"].as_u64().unwrap() as u32;
    let background = background(expected);
    for row in 0..height {
        for column in 0..width {
            let source = &expected["rgba"][(row * width + column) as usize];
            let opacity = if alpha {
                source[3].as_u64().unwrap() as u32
            } else {
                255
            };
            let actual = frame.pixel(x + column, y + row);
            for channel in 0..3 {
                let foreground = source[channel].as_u64().unwrap() as u32;
                // Independent source-over reference rounded down; LVGL blending may differ by 1 LSB.
                let mixed = ((foreground * opacity + background[channel] as u32 * (255 - opacity))
                    / 255) as i16;
                let tolerance = i16::from(opacity != 0 && opacity != 255);
                assert!(
                    (actual[channel] as i16 - mixed).abs() <= tolerance,
                    "pixel ({column}, {row}), channel {channel}: {} != {mixed}, alpha {opacity}",
                    actual[channel]
                );
            }
            assert_eq!(actual[3], 255);
        }
    }
    for column in x - 1..=x + width {
        assert_eq!(frame.pixel(column, y - 1), background);
        assert_eq!(frame.pixel(column, y + height), background);
    }
    for row in 0..height {
        assert_eq!(frame.pixel(x - 1, y + row), background);
        assert_eq!(frame.pixel(x + width, y + row), background);
    }
}

fn assert_background(frame: &Frame, expected: &Value, x: u32, y: u32) {
    for row in 0..expected["height"].as_u64().unwrap() as u32 {
        for column in 0..expected["width"].as_u64().unwrap() as u32 {
            assert_eq!(frame.pixel(x + column, y + row), background(expected));
        }
    }
}

#[test]
fn png_formats_preserve_dimensions_pixels_alpha_and_redraws() -> Result<()> {
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    let image = image(&mut runtime, screen, X, Y)?;
    let mut previous_frame = 0;
    for case in expected["cases"].as_array().unwrap() {
        let name = case["file"].as_str().unwrap();
        let source = upload(&mut runtime, name, &fixture(name)?)?;
        runtime.raw()?.lv_image_set_src(image, source)?;
        runtime.free(source.0)?;
        assert_eq!(
            runtime.raw()?.lv_image_get_src_width(image)?,
            expected["width"].as_i64().unwrap() as i32
        );
        assert_eq!(
            runtime.raw()?.lv_image_get_src_height(image)?,
            expected["height"].as_i64().unwrap() as i32
        );
        for _ in 0..2 {
            runtime.raw()?.lv_obj_invalidate(image)?;
            step(&mut runtime)?;
            let frame = frame(&mut runtime, display)?;
            assert!(frame.id > previous_frame);
            previous_frame = frame.id;
            assert_image(&frame, &expected, case["alpha"].as_bool().unwrap(), X, Y);
        }
    }
    runtime.shutdown()
}

#[test]
fn rejected_png_data_leaves_background_and_valid_source_recovers() -> Result<()> {
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    let image = image(&mut runtime, screen, X, Y)?;
    let good = fixture("rgba.png")?;
    let valid = upload(&mut runtime, "valid.png", &good)?;
    let output = UnsafePointer(runtime.alloc(values::LV_IMAGE_HEADER_T_SIZE)?);
    for rejected in expected["rejected"].as_array().unwrap() {
        let name = rejected.as_str().unwrap();
        let source = upload(&mut runtime, name, &fixture(name)?)?;
        assert_eq!(
            runtime.raw()?.lv_image_decoder_get_info(source, output)?,
            values::LV_RESULT_OK
        );
        runtime.raw()?.lv_image_set_src(image, source)?;
        runtime.free(source.0)?;
        step(&mut runtime)?;
        assert_background(&frame(&mut runtime, display)?, &expected, X, Y);
        runtime.raw()?.lv_image_set_src(image, valid)?;
        step(&mut runtime)?;
        assert_image(&frame(&mut runtime, display)?, &expected, true, X, Y);
    }
    let short = upload(&mut runtime, "signature.png", &good[..8])?;
    assert_eq!(
        runtime.raw()?.lv_image_decoder_get_info(short, output)?,
        values::LV_RESULT_INVALID
    );
    runtime.raw()?.lv_image_set_src(image, short)?;
    step(&mut runtime)?;
    assert_background(&frame(&mut runtime, display)?, &expected, X, Y);
    runtime.raw()?.lv_image_set_src(image, valid)?;
    step(&mut runtime)?;
    assert_image(&frame(&mut runtime, display)?, &expected, true, X, Y);
    runtime.free(short.0)?;
    runtime.free(valid.0)?;
    runtime.free(output.0)?;
    runtime.shutdown()
}

#[test]
fn uploaded_png_is_owned_and_shared_across_image_deletion_and_recreation() -> Result<()> {
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    let mut bytes = fixture("rgba.png")?;
    let source = upload(&mut runtime, "shared.png", &bytes)?;
    bytes.fill(0);
    let first = image(&mut runtime, screen, X, Y)?;
    let second = image(&mut runtime, screen, 25, Y)?;
    runtime.raw()?.lv_image_set_src(first, source)?;
    runtime.raw()?.lv_image_set_src(second, source)?;
    step(&mut runtime)?;
    let snapshot = frame(&mut runtime, display)?;
    assert_image(&snapshot, &expected, true, X, Y);
    assert_image(&snapshot, &expected, true, 25, Y);
    runtime.raw()?.lv_obj_delete(first)?;
    step(&mut runtime)?;
    let snapshot = frame(&mut runtime, display)?;
    assert_background(&snapshot, &expected, X, Y);
    assert_image(&snapshot, &expected, true, 25, Y);
    runtime.raw()?.lv_obj_delete(second)?;
    let recreated = image(&mut runtime, screen, X, Y)?;
    runtime.raw()?.lv_image_set_src(recreated, source)?;
    step(&mut runtime)?;
    let snapshot = frame(&mut runtime, display)?;
    assert_image(&snapshot, &expected, true, X, Y);
    assert_background(&snapshot, &expected, 25, Y);
    runtime.free(source.0)?;
    runtime.shutdown()?;
    assert!(runtime.raw().err().unwrap().to_string().contains("closed"));
    Ok(())
}
