use std::path::Path;

use liblvgl_wasm_host::{Result, Runtime, UnsafePointer, values};
use serde_json::Value;
use sha2::{Digest, Sha256};

const WIDTH: u32 = 80;
const HEIGHT: u32 = 40;
const FIRST: (u32, u32) = (4, 4);
const SECOND: (u32, u32) = (44, 8);

fn expected() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/lottie/expected.json")).unwrap()
}

fn number(value: &Value) -> u32 {
    value.as_u64().unwrap() as u32
}

fn fixture(expected: &Value) -> Result<Vec<u8>> {
    let bytes = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/lottie")
            .join(expected["source"]["file"].as_str().unwrap()),
    )?;
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        expected["source"]["sha256"].as_str().unwrap()
    );
    Ok(bytes)
}

fn background(expected: &Value) -> [u8; 4] {
    std::array::from_fn(|channel| {
        if channel == 3 {
            255
        } else {
            number(&expected["background"][channel]) as u8
        }
    })
}

fn load(expected: &Value) -> Result<(Runtime, u32, UnsafePointer)> {
    assert_eq!(number(&expected["source"]["width"]), 32);
    assert_eq!(number(&expected["source"]["height"]), 24);
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

fn widget(runtime: &mut Runtime, screen: UnsafePointer, at: (u32, u32)) -> Result<UnsafePointer> {
    let mut raw = runtime.raw()?;
    let object = raw.lv_lottie_create(screen)?;
    assert_ne!(object.0, 0);
    raw.lv_obj_set_style_image_opa(object, values::LV_OPA_COVER, values::LV_PART_MAIN)?;
    raw.lv_obj_set_pos(object, at.0 as i32, at.1 as i32)?;
    Ok(object)
}

fn draw_buffer(runtime: &mut Runtime) -> Result<UnsafePointer> {
    let buffer = runtime
        .raw()?
        .lv_draw_buf_create(32, 24, values::LV_COLOR_FORMAT_ARGB8888, 0)?;
    assert_ne!(buffer.0, 0);
    Ok(buffer)
}

fn raw_buffer(runtime: &mut Runtime) -> Result<UnsafePointer> {
    let stride = runtime
        .raw()?
        .lv_draw_buf_width_to_stride(32, values::LV_COLOR_FORMAT_ARGB8888_PREMULTIPLIED)?;
    Ok(UnsafePointer(runtime.alloc(
        stride as u32 * 24 + values::LV_DRAW_BUF_ALIGN as u32,
    )?))
}

fn assert_buffer(runtime: &mut Runtime, object: UnsafePointer) -> Result<()> {
    let buffer = runtime.raw()?.lv_canvas_get_draw_buf(object)?;
    assert_ne!(buffer.0, 0);
    let header = values::LV_DRAW_BUF_T_FIELDS
        .iter()
        .find(|field| field.name == Some("header"))
        .unwrap();
    assert_eq!(header.bit_width, None);
    assert_eq!(header.bit_offset % 8, 0);
    let mut bytes = vec![0; values::LV_IMAGE_HEADER_T_SIZE as usize];
    runtime.read_memory(buffer.0 + (header.bit_offset / 8) as u32, &mut bytes)?;
    let field = |name| {
        let field = values::LV_IMAGE_HEADER_T_FIELDS
            .iter()
            .find(|field| field.name == Some(name))
            .unwrap();
        (0..field.bit_width.unwrap()).fold(0u32, |value, bit| {
            let position = (field.bit_offset + bit) as usize;
            value | (u32::from((bytes[position / 8] >> (position % 8)) & 1) << bit)
        })
    };
    assert_eq!(
        field("cf"),
        values::LV_COLOR_FORMAT_ARGB8888_PREMULTIPLIED as u32
    );
    assert_ne!(
        field("flags") & values::LV_IMAGE_FLAGS_PREMULTIPLIED as u32,
        0
    );
    assert_eq!((field("w"), field("h")), (32, 24));
    Ok(())
}

fn set_data(runtime: &mut Runtime, object: UnsafePointer, bytes: &[u8]) -> Result<()> {
    // Only the declared JSON bytes are supplied; the loader owns its terminator and copy.
    let input = runtime.alloc(bytes.len() as u32)?;
    runtime.write_memory(input, bytes)?;
    runtime
        .raw()?
        .lv_lottie_set_src_data(object, UnsafePointer(input), bytes.len() as i32)?;
    runtime.write_memory(input, &vec![0x78; bytes.len()])?;
    runtime.free(input)
}

fn upload(runtime: &mut Runtime, name: &str, bytes: &[u8]) -> Result<()> {
    let key = runtime.alloc(name.len() as u32)?;
    let input = runtime.alloc(bytes.len() as u32)?;
    runtime.write_memory(key, name.as_bytes())?;
    runtime.write_memory(input, bytes)?;
    assert_eq!(
        runtime.call_raw::<_, i32>(
            "lvw_resource_put",
            (key, name.len() as u32, input, bytes.len() as u32)
        )?,
        0
    );
    runtime.write_memory(input, &vec![0; bytes.len()])?;
    runtime.free(input)?;
    runtime.free(key)
}

fn set_file(runtime: &mut Runtime, object: UnsafePointer, name: &str) -> Result<()> {
    let path = format!("W:{name}\0");
    let input = runtime.alloc(path.len() as u32)?;
    runtime.write_memory(input, path.as_bytes())?;
    runtime
        .raw()?
        .lv_lottie_set_src_file(object, UnsafePointer(input))?;
    runtime.write_memory(input, &vec![0x78; path.len()])?;
    runtime.free(input)
}

fn step(runtime: &mut Runtime, elapsed: u32) -> Result<()> {
    let pointer = runtime.alloc(16)?;
    let mut bytes = [0; 16];
    bytes[..4].copy_from_slice(&16u32.to_le_bytes());
    bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
    runtime.write_memory(pointer, &bytes)?;
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_step", (elapsed, pointer))?,
        0
    );
    runtime.free(pointer)
}

fn assert_frame(
    runtime: &mut Runtime,
    display: u32,
    expected: &Value,
    placements: &[(&Value, (u32, u32))],
) -> Result<()> {
    runtime.raw()?.lv_refr_now(UnsafePointer(display))?;
    let pointer = runtime.alloc(48)?;
    let mut descriptor = [0; 48];
    descriptor[..4].copy_from_slice(&48u32.to_le_bytes());
    descriptor[4..8].copy_from_slice(&1u32.to_le_bytes());
    runtime.write_memory(pointer, &descriptor)?;
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_frame_get", (display, pointer))?,
        0
    );
    runtime.read_memory(pointer, &mut descriptor)?;
    let word = |offset| u32::from_le_bytes(descriptor[offset..offset + 4].try_into().unwrap());
    assert_eq!(
        (word(16), word(20), word(24), word(28)),
        (WIDTH, HEIGHT, WIDTH * 4, 1)
    );
    let mut pixels = vec![0; word(12) as usize];
    runtime.read_memory(word(8), &mut pixels)?;
    runtime.free(pointer)?;
    let background = background(expected);
    for (checkpoint, _) in placements {
        assert_eq!(checkpoint["rgba_min"].as_array().unwrap().len(), 32 * 24);
        assert_eq!(checkpoint["rgba_max"].as_array().unwrap().len(), 32 * 24);
    }
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let offset = ((y * WIDTH + x) * 4) as usize;
            // ABI 1 XRGB8888 exposes BGRX bytes; the composed output is opaque.
            let actual = [pixels[offset + 2], pixels[offset + 1], pixels[offset], 255];
            let sample = placements.iter().find(|(_, (left, top))| {
                x >= *left && x < *left + 32 && y >= *top && y < *top + 24
            });
            let Some((checkpoint, (left, top))) = sample else {
                assert_eq!(actual, background, "background ({x}, {y})");
                continue;
            };
            let index = ((y - top) * 32 + x - left) as usize;
            let minimum = &checkpoint["rgba_min"][index];
            let maximum = &checkpoint["rgba_max"][index];
            let clear = (0..4).all(|channel| {
                number(&minimum[channel]) == u32::from(background[channel])
                    && number(&maximum[channel]) == u32::from(background[channel])
            });
            let tolerance = if clear {
                0
            } else {
                number(&checkpoint["tolerance"]) as i32
            };
            for channel in 0..3 {
                let lower = number(&minimum[channel]) as i32;
                let upper = number(&maximum[channel]) as i32;
                let observed = i32::from(actual[channel]);
                assert!(lower <= upper);
                assert!(
                    observed >= lower - tolerance && observed <= upper + tolerance,
                    "frame {}, pixel ({}, {}), channel {channel}: {observed} outside {lower}..{upper} ± {tolerance}",
                    checkpoint["rendered_frame"],
                    x - left,
                    y - top
                );
            }
            assert_eq!(number(&minimum[3]), 255);
            assert_eq!(number(&maximum[3]), 255);
        }
    }
    Ok(())
}

fn recolored(source: &[u8], expected: &Value) -> Result<(Vec<u8>, Value)> {
    let mut json: Value = serde_json::from_slice(source)?;
    json["layers"][0]["shapes"][1]["c"]["k"] = serde_json::json!([0, 0.5, 1, 1]);
    let mut reference = expected.clone();
    let background = background(expected);
    for checkpoint in reference["checkpoints"].as_array_mut().unwrap() {
        let alpha = number(&checkpoint["opacity"]);
        let rectangle: [u32; 4] =
            std::array::from_fn(|index| number(&checkpoint["rectangle"][index]));
        let pixels: Vec<[u8; 4]> = (0..32 * 24)
            .map(|index| {
                let (x, y) = (index % 32, index / 32);
                if x < rectangle[0]
                    || x >= rectangle[0] + rectangle[2]
                    || y < rectangle[1]
                    || y >= rectangle[1] + rectangle[3]
                {
                    return background;
                }
                let mut color = background;
                for channel in 0..3 {
                    color[channel] = (([0, 128, 255][channel] * alpha
                        + u32::from(background[channel]) * (255 - alpha))
                        / 255) as u8;
                }
                color
            })
            .collect();
        checkpoint["rgba_min"] = serde_json::to_value(&pixels)?;
        checkpoint["rgba_max"] = serde_json::to_value(&pixels)?;
    }
    Ok((serde_json::to_vec(&json)?, reference))
}

#[test]
fn lottie_frames_pause_repeat_and_animation_recreation_preserve_pixels() -> Result<()> {
    let expected = expected();
    let source = fixture(&expected)?;
    let checkpoints = &expected["checkpoints"];
    let (mut runtime, display, screen) = load(&expected)?;
    let baseline = runtime.raw()?.lv_anim_count_running()?;
    let object = widget(&mut runtime, screen, FIRST)?;
    let buffer = draw_buffer(&mut runtime)?;
    runtime.raw()?.lv_lottie_set_draw_buf(object, buffer)?;
    set_data(&mut runtime, object, &source)?;
    assert_buffer(&mut runtime, object)?;
    let anim = runtime.raw()?.lv_lottie_get_anim(object)?;
    assert_ne!(anim.0, 0);
    assert_eq!(runtime.raw()?.lv_anim_get_time(anim)?, 1000);
    assert_eq!(
        runtime.raw()?.lv_anim_get_repeat_count(anim)? as u32,
        values::LV_ANIM_REPEAT_INFINITE
    );
    runtime.raw()?.lv_anim_set_repeat_delay(anim, 250)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[0], FIRST)],
    )?;
    for index in 1..5 {
        step(&mut runtime, 250)?;
        assert_frame(
            &mut runtime,
            display,
            &expected,
            &[(&checkpoints[index], FIRST)],
        )?;
    }
    step(&mut runtime, 125)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[4], FIRST)],
    )?;
    step(&mut runtime, 125)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[0], FIRST)],
    )?;
    step(&mut runtime, 250)?;
    runtime.raw()?.lv_anim_pause(anim)?;
    assert_eq!(runtime.raw()?.lv_anim_is_paused(anim)?, 1);
    step(&mut runtime, 250)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[1], FIRST)],
    )?;
    runtime.raw()?.lv_anim_resume(anim)?;
    step(&mut runtime, 250)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[2], FIRST)],
    )?;
    runtime.raw()?.lv_anim_set_repeat_count(anim, 1)?;
    step(&mut runtime, 500)?;
    assert_eq!(runtime.raw()?.lv_lottie_get_anim(object)?.0, 0);
    assert_eq!(runtime.raw()?.lv_anim_count_running()?, baseline);
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[4], FIRST)],
    )?;
    step(&mut runtime, 250)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[4], FIRST)],
    )?;
    set_data(&mut runtime, object, &source)?;
    assert_ne!(runtime.raw()?.lv_lottie_get_anim(object)?.0, 0);
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[0], FIRST)],
    )?;
    runtime.raw()?.lv_anim_delete_all()?;
    assert_eq!(runtime.raw()?.lv_lottie_get_anim(object)?.0, 0);
    step(&mut runtime, 250)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[0], FIRST)],
    )?;
    set_data(&mut runtime, object, &source)?;
    assert_ne!(runtime.raw()?.lv_lottie_get_anim(object)?.0, 0);
    step(&mut runtime, 250)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[1], FIRST)],
    )?;
    runtime.raw()?.lv_obj_delete(object)?;
    runtime.raw()?.lv_draw_buf_destroy(buffer)?;
    step(&mut runtime, 250)?;
    assert_frame(&mut runtime, display, &expected, &[])?;
    runtime.shutdown()
}

#[test]
fn lottie_copied_resources_source_replacement_and_failed_loads_keep_playback_valid() -> Result<()> {
    let expected = expected();
    let source = fixture(&expected)?;
    let (blue_source, blue_expected) = recolored(&source, &expected)?;
    let checkpoints = &expected["checkpoints"];
    let blue = &blue_expected["checkpoints"];
    let (mut runtime, display, screen) = load(&expected)?;
    upload(&mut runtime, "motion.json", &source)?;
    upload(&mut runtime, "blue.json", &blue_source)?;
    let object = widget(&mut runtime, screen, FIRST)?;
    let buffer = draw_buffer(&mut runtime)?;
    runtime.raw()?.lv_lottie_set_draw_buf(object, buffer)?;
    set_file(&mut runtime, object, "motion.json")?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[0], FIRST)],
    )?;
    step(&mut runtime, 250)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[1], FIRST)],
    )?;
    let anim = runtime.raw()?.lv_lottie_get_anim(object)?;
    runtime.raw()?.lv_anim_pause(anim)?;
    set_data(&mut runtime, object, &blue_source)?;
    let anim = runtime.raw()?.lv_lottie_get_anim(object)?;
    assert_eq!(runtime.raw()?.lv_anim_is_paused(anim)?, 0);
    assert_frame(&mut runtime, display, &expected, &[(&blue[0], FIRST)])?;
    step(&mut runtime, 250)?;
    assert_frame(&mut runtime, display, &expected, &[(&blue[1], FIRST)])?;
    for rejected in 0..3 {
        set_file(&mut runtime, object, "blue.json")?;
        step(&mut runtime, 250)?;
        let anim = runtime.raw()?.lv_lottie_get_anim(object)?;
        match rejected {
            0 => set_data(&mut runtime, object, b"not json")?,
            1 => set_data(&mut runtime, object, &source[..source.len() / 2])?,
            _ => set_file(&mut runtime, object, "missing.json")?,
        }
        assert_eq!(runtime.raw()?.lv_lottie_get_anim(object)?, anim);
        assert_eq!(runtime.raw()?.lv_anim_get_time(anim)?, 1000);
        assert_frame(&mut runtime, display, &expected, &[(&blue[1], FIRST)])?;
        step(&mut runtime, 250)?;
        assert_frame(&mut runtime, display, &expected, &[(&blue[2], FIRST)])?;
    }
    set_file(&mut runtime, object, "motion.json")?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[0], FIRST)],
    )?;
    step(&mut runtime, 250)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[1], FIRST)],
    )?;
    runtime.raw()?.lv_obj_delete(object)?;
    runtime.raw()?.lv_draw_buf_destroy(buffer)?;
    let replacement = widget(&mut runtime, screen, FIRST)?;
    let buffer = draw_buffer(&mut runtime)?;
    runtime.raw()?.lv_lottie_set_draw_buf(replacement, buffer)?;
    set_file(&mut runtime, replacement, "motion.json")?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[0], FIRST)],
    )?;
    runtime.raw()?.lv_obj_delete(replacement)?;
    runtime.raw()?.lv_draw_buf_destroy(buffer)?;
    runtime.shutdown()
}

#[test]
fn lottie_buffers_and_widget_lifetimes_keep_independent_clocks_and_single_alpha() -> Result<()> {
    let expected = expected();
    let source = fixture(&expected)?;
    let checkpoints = &expected["checkpoints"];
    let (mut runtime, display, screen) = load(&expected)?;
    // Loader sharing must follow the parsed format even when the extension is uppercase.
    upload(&mut runtime, "shared.JSON", &source)?;
    let first = widget(&mut runtime, screen, FIRST)?;
    let first_buffer = draw_buffer(&mut runtime)?;
    runtime.raw()?.lv_lottie_set_draw_buf(first, first_buffer)?;
    set_file(&mut runtime, first, "shared.JSON")?;
    step(&mut runtime, 250)?;
    let second = widget(&mut runtime, screen, SECOND)?;
    let second_buffer = raw_buffer(&mut runtime)?;
    // Deliberately start unaligned; the allocation includes the public alignment allowance.
    let second_data = UnsafePointer(second_buffer.0 + 1);
    set_file(&mut runtime, second, "shared.JSON")?;
    runtime
        .raw()?
        .lv_lottie_set_buffer(second, 32, 24, second_data)?;
    assert_buffer(&mut runtime, first)?;
    assert_buffer(&mut runtime, second)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[1], FIRST), (&checkpoints[0], SECOND)],
    )?;
    step(&mut runtime, 250)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[2], FIRST), (&checkpoints[1], SECOND)],
    )?;
    let anim = runtime.raw()?.lv_lottie_get_anim(first)?;
    runtime.raw()?.lv_anim_pause(anim)?;
    step(&mut runtime, 250)?;
    let raw_replacement = raw_buffer(&mut runtime)?;
    runtime
        .raw()?
        .lv_lottie_set_buffer(first, 32, 24, raw_replacement)?;
    runtime.raw()?.lv_draw_buf_destroy(first_buffer)?;
    assert_buffer(&mut runtime, first)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[2], FIRST), (&checkpoints[2], SECOND)],
    )?;
    let replacement = draw_buffer(&mut runtime)?;
    runtime.raw()?.lv_lottie_set_draw_buf(first, replacement)?;
    runtime.free(raw_replacement.0)?;
    assert_eq!(runtime.raw()?.lv_anim_is_paused(anim)?, 1);
    let invalid =
        runtime
            .raw()?
            .lv_draw_buf_create(32, 24, values::LV_COLOR_FORMAT_ARGB8888, 130)?;
    assert_ne!(invalid.0, 0);
    let previous = runtime.raw()?.lv_canvas_get_draw_buf(second)?;
    runtime.raw()?.lv_lottie_set_draw_buf(second, invalid)?;
    assert_eq!(runtime.raw()?.lv_canvas_get_draw_buf(second)?, previous);
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[2], FIRST), (&checkpoints[2], SECOND)],
    )?;
    runtime.raw()?.lv_draw_buf_destroy(invalid)?;
    for _ in 0..2 {
        runtime.raw()?.lv_lottie_set_draw_buf(first, replacement)?;
        runtime
            .raw()?
            .lv_lottie_set_buffer(second, 32, 24, second_data)?;
        assert_buffer(&mut runtime, first)?;
        assert_buffer(&mut runtime, second)?;
        assert_frame(
            &mut runtime,
            display,
            &expected,
            &[(&checkpoints[2], FIRST), (&checkpoints[2], SECOND)],
        )?;
    }
    runtime.raw()?.lv_obj_delete(first)?;
    runtime.raw()?.lv_draw_buf_destroy(replacement)?;
    step(&mut runtime, 250)?;
    assert_frame(
        &mut runtime,
        display,
        &expected,
        &[(&checkpoints[3], SECOND)],
    )?;
    runtime.raw()?.lv_obj_delete(second)?;
    runtime.free(second_buffer.0)?;
    step(&mut runtime, 250)?;
    assert_frame(&mut runtime, display, &expected, &[])?;
    runtime.shutdown()
}
