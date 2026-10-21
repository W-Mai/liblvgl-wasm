use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use liblvgl_wasm_host::{Result, Runtime, UnsafePointer, values};
use serde_json::Value;
use sha2::{Digest, Sha256};

const WIDTH: u32 = 80;
const HEIGHT: u32 = 40;
const FIRST: (u32, u32) = (4, 4);
const SECOND: (u32, u32) = (44, 8);

fn expected() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/svg/expected.json")).unwrap()
}

fn fixture(name: &str) -> Result<Vec<u8>> {
    Ok(std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/svg")
            .join(name),
    )?)
}

fn number(value: &Value) -> u32 {
    value.as_u64().unwrap() as u32
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
    // The registered resource must own its bytes independently of upload memory.
    runtime.write_memory(data, &vec![0; bytes.len()])?;
    runtime.free(data)?;
    runtime.free(key)?;
    let path = format!("W:{name}\0");
    let pointer = runtime.alloc(path.len() as u32)?;
    runtime.write_memory(pointer, path.as_bytes())?;
    Ok(UnsafePointer(pointer))
}

fn image(runtime: &mut Runtime, screen: UnsafePointer, at: (u32, u32)) -> Result<UnsafePointer> {
    let mut raw = runtime.raw()?;
    let image = raw.lv_image_create(screen)?;
    raw.lv_obj_remove_style_all(image)?;
    raw.lv_obj_set_style_image_opa(image, values::LV_OPA_COVER, values::LV_PART_MAIN)?;
    raw.lv_obj_set_style_image_recolor_opa(image, values::LV_OPA_TRANSP, values::LV_PART_MAIN)?;
    raw.lv_obj_set_pos(image, at.0 as i32, at.1 as i32)?;
    Ok(image)
}

fn dimensions(runtime: &mut Runtime, image: UnsafePointer, case: &Value) -> Result<()> {
    let mut raw = runtime.raw()?;
    assert_eq!(
        raw.lv_image_get_src_width(image)?,
        number(&case["width"]) as i32
    );
    assert_eq!(
        raw.lv_image_get_src_height(image)?,
        number(&case["height"]) as i32
    );
    Ok(())
}

struct Frame {
    id: u32,
    bytes: Vec<u8>,
}

impl Frame {
    fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let start = ((y * WIDTH + x) * 4) as usize;
        // ABI 1 XRGB8888 uses little-endian BGRX bytes and an opaque output alpha.
        [
            self.bytes[start + 2],
            self.bytes[start + 1],
            self.bytes[start],
            255,
        ]
    }
}

fn frame(runtime: &mut Runtime, display: u32, screen: UnsafePointer) -> Result<Frame> {
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
    let word = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    assert_eq!(
        (word(16), word(20), word(24), word(28), word(32)),
        (WIDTH, HEIGHT, WIDTH * 4, 1, 0)
    );
    assert!(word(44) > 0);
    let mut pixels = vec![0; word(12) as usize];
    runtime.read_memory(word(8), &mut pixels)?;
    runtime.free(pointer)?;
    Ok(Frame {
        id: word(44),
        bytes: pixels,
    })
}

fn assert_frame(frame: &Frame, expected: &Value, placements: &[(&Value, (u32, u32))]) {
    let background = background(expected);
    for &(case, _) in placements {
        let size = (number(&case["width"]) * number(&case["height"])) as usize;
        assert_eq!(case["rgba_min"].as_array().unwrap().len(), size);
        assert_eq!(case["rgba_max"].as_array().unwrap().len(), size);
    }
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let actual = frame.pixel(x, y);
            let sample = placements.iter().find(|(case, (left, top))| {
                x >= *left
                    && x < *left + number(&case["width"])
                    && y >= *top
                    && y < *top + number(&case["height"])
            });
            let Some((case, (left, top))) = sample else {
                assert_eq!(actual, background, "background pixel ({x}, {y})");
                continue;
            };
            let index = ((y - top) * number(&case["width"]) + x - left) as usize;
            let minimum = &case["rgba_min"][index];
            let maximum = &case["rgba_max"][index];
            let is_background = (0..4).all(|channel| {
                number(&minimum[channel]) == u32::from(background[channel])
                    && number(&maximum[channel]) == u32::from(background[channel])
            });
            let tolerance = if is_background {
                0
            } else {
                number(&case["tolerance"]) as i32
            };
            for channel in 0..3 {
                let lower = number(&minimum[channel]) as i32;
                let upper = number(&maximum[channel]) as i32;
                let observed = i32::from(actual[channel]);
                assert!(lower <= upper);
                assert!(
                    observed >= lower - tolerance && observed <= upper + tolerance,
                    "{} pixel ({}, {}), channel {channel}: {observed} outside {lower}..{upper} ± {tolerance}",
                    case["file"],
                    x - left,
                    y - top
                );
            }
            assert_eq!(number(&minimum[3]), 255);
            assert_eq!(number(&maximum[3]), 255);
            assert_eq!(actual[3], 255);
        }
    }
}

#[test]
fn svg_files_and_dom_draws_follow_analytic_pixels_after_source_and_dom_release() -> Result<()> {
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    for case in expected["cases"].as_array().unwrap() {
        let name = case["file"].as_str().unwrap();
        let bytes = fixture(name)?;
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            case["sha256"].as_str().unwrap()
        );
        let source = upload(&mut runtime, name, &bytes)?;
        let object = image(&mut runtime, screen, FIRST)?;
        runtime.raw()?.lv_image_set_src(object, source)?;
        runtime.free(source.0)?;
        dimensions(&mut runtime, object, case)?;
        let mut previous = 0;
        for _ in 0..2 {
            let snapshot = frame(&mut runtime, display, screen)?;
            assert!(snapshot.id > previous);
            previous = snapshot.id;
            assert_frame(&snapshot, &expected, &[(case, FIRST)]);
        }
        runtime.raw()?.lv_obj_delete(object)?;

        let calls = Arc::new(AtomicU32::new(0));
        let observed = Arc::clone(&calls);
        runtime.set_event_handler_with_context(move |context, event| {
            assert_eq!(event.callback_id, 1);
            let event = context.event_pointer()?;
            let mut raw = context.raw()?;
            let input = raw.alloc(bytes.len() as u32)?;
            raw.write_memory(input, &bytes)?;
            let dom = raw.lv_svg_load_data(input, bytes.len() as i32)?;
            assert_ne!(dom.0, 0);
            raw.write_memory(input, &vec![0; bytes.len()])?;
            raw.free(input)?;
            let layer = raw.lv_event_get_layer(event)?;
            assert_ne!(layer.0, 0);
            raw.lv_draw_svg(layer, dom)?;
            // Queued vector tasks must retain their data after the DOM is deleted.
            raw.lv_svg_node_delete(dom)?;
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
        for _ in 0..2 {
            assert_frame(
                &frame(&mut runtime, display, screen)?,
                &expected,
                &[(case, (0, 0))],
            );
        }
        assert!(calls.load(Ordering::SeqCst) >= 2);
        assert_eq!(
            runtime.call_raw::<_, i32>("lvw_event_remove", (screen.0, 1u32))?,
            0
        );
        let before = calls.load(Ordering::SeqCst);
        assert_frame(&frame(&mut runtime, display, screen)?, &expected, &[]);
        assert_eq!(calls.load(Ordering::SeqCst), before);
    }
    runtime.shutdown()
}

#[test]
fn svg_uploads_remain_owned_across_shared_images_source_changes_and_deletion() -> Result<()> {
    let expected = expected();
    let cases = expected["cases"].as_array().unwrap();
    let first_case = &cases[0];
    let other_case = cases
        .iter()
        .find(|case| case["rgba_min"] != first_case["rgba_min"])
        .unwrap();
    let (mut runtime, display, screen) = load(&expected)?;
    let mut bytes = fixture(first_case["file"].as_str().unwrap())?;
    let source = upload(&mut runtime, "shared.svg", &bytes)?;
    bytes.fill(0);
    let other = upload(
        &mut runtime,
        "other.svg",
        &fixture(other_case["file"].as_str().unwrap())?,
    )?;
    let first = image(&mut runtime, screen, FIRST)?;
    let second = image(&mut runtime, screen, SECOND)?;
    runtime.raw()?.lv_image_set_src(first, source)?;
    runtime.raw()?.lv_image_set_src(second, source)?;
    assert_frame(
        &frame(&mut runtime, display, screen)?,
        &expected,
        &[(first_case, FIRST), (first_case, SECOND)],
    );
    runtime.raw()?.lv_obj_delete(first)?;
    assert_frame(
        &frame(&mut runtime, display, screen)?,
        &expected,
        &[(first_case, SECOND)],
    );
    runtime.raw()?.lv_image_set_src(second, other)?;
    dimensions(&mut runtime, second, other_case)?;
    assert_frame(
        &frame(&mut runtime, display, screen)?,
        &expected,
        &[(other_case, SECOND)],
    );
    runtime.raw()?.lv_image_set_src(second, source)?;
    assert_frame(
        &frame(&mut runtime, display, screen)?,
        &expected,
        &[(first_case, SECOND)],
    );
    runtime.raw()?.lv_obj_delete(second)?;
    let recreated = image(&mut runtime, screen, FIRST)?;
    runtime.raw()?.lv_image_set_src(recreated, source)?;
    runtime.free(source.0)?;
    runtime.free(other.0)?;
    assert_frame(
        &frame(&mut runtime, display, screen)?,
        &expected,
        &[(first_case, FIRST)],
    );
    runtime.raw()?.lv_obj_delete(recreated)?;
    assert_frame(&frame(&mut runtime, display, screen)?, &expected, &[]);
    runtime.shutdown()
}

#[test]
fn rejected_svg_documents_leave_background_and_valid_sources_recover() -> Result<()> {
    let expected = expected();
    let valid_case = &expected["cases"][0];
    let (mut runtime, display, screen) = load(&expected)?;
    let valid = upload(
        &mut runtime,
        "recovery.svg",
        &fixture(valid_case["file"].as_str().unwrap())?,
    )?;
    let object = image(&mut runtime, screen, FIRST)?;
    let header = UnsafePointer(runtime.alloc(values::LV_IMAGE_HEADER_T_SIZE)?);
    let rejected = expected["rejected"].as_array().unwrap();
    assert!(!rejected.is_empty());
    for case in rejected {
        let name = case["file"].as_str().unwrap();
        let bytes = fixture(name)?;
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            case["sha256"].as_str().unwrap()
        );
        let input = UnsafePointer(runtime.alloc(bytes.len() as u32)?);
        runtime.write_memory(input.0, &bytes)?;
        assert_eq!(
            runtime.raw()?.lv_svg_load_data(input, bytes.len() as i32)?,
            UnsafePointer(0),
            "parser accepted {name}"
        );
        runtime.free(input.0)?;
        let source = upload(&mut runtime, name, &bytes)?;
        assert_eq!(
            runtime.raw()?.lv_image_decoder_get_info(source, header)?,
            values::LV_RESULT_INVALID,
            "file decoder accepted {name}"
        );
        runtime.raw()?.lv_image_set_src(object, source)?;
        runtime.free(source.0)?;
        assert_eq!(runtime.raw()?.lv_image_get_src(object)?, UnsafePointer(0));
        assert_frame(&frame(&mut runtime, display, screen)?, &expected, &[]);
        runtime.raw()?.lv_image_set_src(object, valid)?;
        dimensions(&mut runtime, object, valid_case)?;
        assert_frame(
            &frame(&mut runtime, display, screen)?,
            &expected,
            &[(valid_case, FIRST)],
        );
    }
    runtime.free(header.0)?;
    runtime.free(valid.0)?;
    runtime.raw()?.lv_obj_delete(object)?;
    assert_frame(&frame(&mut runtime, display, screen)?, &expected, &[]);
    runtime.shutdown()
}
