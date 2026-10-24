use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use liblvgl_wasm_host::{Result, Runtime, UnsafePointer, values};
use serde_json::Value;

fn expected() -> Value {
    serde_json::from_slice(&fixture("expected.json").unwrap()).unwrap()
}

fn fixture(name: &str) -> Result<Vec<u8>> {
    Ok(std::fs::read(
        std::env::var_os("LVW_TEST_GIF_FIXTURES")
            .map_or_else(
                || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/gif"),
                std::path::PathBuf::from,
            )
            .join(name),
    )?)
}

fn background(expected: &Value) -> [u8; 4] {
    [
        expected["background"][0].as_u64().unwrap() as u8,
        expected["background"][1].as_u64().unwrap() as u8,
        expected["background"][2].as_u64().unwrap() as u8,
        255,
    ]
}

fn load(expected: &Value) -> Result<(Runtime, u32, UnsafePointer)> {
    let mut runtime = Runtime::from_file(std::env::var_os("LVW_TEST_CORE").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"),
        std::path::PathBuf::from,
    ))?;
    let display = runtime.call_raw("lvw_display_create", (48u32, 32u32, 1u32))?;
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

fn path(runtime: &mut Runtime, name: &str) -> Result<UnsafePointer> {
    let bytes = format!("W:{name}\0");
    let pointer = runtime.alloc(bytes.len() as u32)?;
    runtime.write_memory(pointer, bytes.as_bytes())?;
    Ok(UnsafePointer(pointer))
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
    runtime.free(key)?;
    runtime.free(data)?;
    // GIF stores this pointer; keep it allocated until every borrowing widget is deleted.
    path(runtime, name)
}

fn gif(runtime: &mut Runtime, screen: UnsafePointer, x: i32) -> Result<UnsafePointer> {
    let mut raw = runtime.raw()?;
    let object = raw.lv_gif_create(screen)?;
    raw.lv_obj_set_pos(object, x, 4)?;
    Ok(object)
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

fn assert_pixels(
    runtime: &mut Runtime,
    display: u32,
    expected: &Value,
    index: Option<usize>,
    x: u32,
) -> Result<()> {
    // Refresh independently of display-timer ordering without advancing the GIF clock.
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
    assert_eq!((word(16), word(20), word(24), word(28)), (48, 32, 192, 1));
    let mut pixels = vec![0; word(12) as usize];
    runtime.read_memory(word(8), &mut pixels)?;
    runtime.free(pointer)?;
    let width = expected["width"].as_u64().unwrap() as u32;
    let height = expected["height"].as_u64().unwrap() as u32;
    for row in 0..height {
        for column in 0..width {
            let mut color = background(expected);
            if let Some(index) = index {
                let entry = expected["frames"][index]["indices"][(row * width + column) as usize]
                    .as_u64()
                    .unwrap() as usize;
                let palette = &expected["palette"][entry];
                if palette[3].as_u64().unwrap() != 0 {
                    color = std::array::from_fn(|channel| palette[channel].as_u64().unwrap() as u8);
                }
            }
            let offset = ((row + 4) * word(24) + (column + x) * 4) as usize;
            let actual = [pixels[offset + 2], pixels[offset + 1], pixels[offset], 255];
            assert_eq!(actual, color, "frame {index:?}, pixel ({column}, {row})");
        }
    }
    Ok(())
}

fn subscribe(runtime: &mut Runtime, object: UnsafePointer, id: u32) -> Result<()> {
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_event_add", (object.0, values::LV_EVENT_READY, id))?,
        0
    );
    Ok(())
}

#[test]
fn gif_frame_deadlines_queries_finite_loops_and_restart_preserve_pixels() -> Result<()> {
    if values::LVGL_VERSION_MINOR == 0 {
        return Ok(());
    }
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    let name = expected["file"].as_str().unwrap();
    let source = upload(&mut runtime, name, &fixture(name)?)?;
    let size = UnsafePointer(runtime.alloc(4)?);
    assert_eq!(
        runtime.call_raw::<_, u32>("lv_gif_get_size", (source.0, size.0, size.0 + 2))?,
        1
    );
    let mut bytes = [0; 4];
    runtime.read_memory(size.0, &mut bytes)?;
    assert_eq!(
        u16::from_le_bytes(bytes[..2].try_into().unwrap()) as u64,
        expected["width"].as_u64().unwrap()
    );
    assert_eq!(
        u16::from_le_bytes(bytes[2..].try_into().unwrap()) as u64,
        expected["height"].as_u64().unwrap()
    );
    runtime.free(size.0)?;
    let object = gif(&mut runtime, screen, 5)?;
    let ready = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&ready);
    runtime.set_event_handler_with_context(move |context, event| {
        assert_eq!(event.object, object.0);
        assert_eq!(
            context.call_raw::<_, i32>("lv_gif_get_current_frame_index", (object.0,))?,
            0
        );
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })?;
    subscribe(&mut runtime, object, 1)?;
    runtime.raw()?.lv_gif_set_src(object, source)?;
    assert_eq!(
        runtime.call_raw::<_, i32>("lv_gif_is_loaded", (object.0,))?,
        1
    );
    assert_eq!(
        runtime.call_raw::<_, i32>("lv_gif_get_loop_count", (object.0,))?,
        0
    );
    assert_eq!(
        runtime.call_raw::<_, i32>("lv_gif_get_current_frame_index", (object.0,))?,
        1
    );
    assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
    // Absolute deadlines: 0, 79, 80, 199, 200, 359, 360 ms.
    for (elapsed, index, completed) in [
        (79, 0, 0),
        (1, 1, 0),
        (119, 1, 0),
        (1, 2, 1),
        (159, 2, 1),
        (1, 0, 1),
    ] {
        assert_eq!(
            runtime.call_raw::<_, i32>("lv_gif_get_frame_count", (object.0,))?,
            3
        );
        step(&mut runtime, elapsed)?;
        assert_pixels(&mut runtime, display, &expected, Some(index), 5)?;
        assert_eq!(ready.load(Ordering::SeqCst), completed);
        assert_eq!(
            runtime.call_raw::<_, i32>("lv_gif_get_current_frame_index", (object.0,))?,
            [1, 2, 0][index]
        );
    }
    runtime.call_raw::<_, ()>("lv_gif_set_loop_count", (object.0, 1))?;
    step(&mut runtime, 80)?;
    step(&mut runtime, 120)?;
    assert_eq!(ready.load(Ordering::SeqCst), 2);
    step(&mut runtime, 500)?;
    assert_pixels(&mut runtime, display, &expected, Some(2), 5)?;
    assert_eq!(ready.load(Ordering::SeqCst), 2);
    runtime.raw()?.lv_gif_restart(object)?;
    assert_eq!(
        runtime.call_raw::<_, i32>("lv_gif_get_loop_count", (object.0,))?,
        -1
    );
    assert_eq!(
        runtime.call_raw::<_, i32>("lv_gif_get_current_frame_index", (object.0,))?,
        0
    );
    runtime.call_raw::<_, ()>("lv_gif_set_loop_count", (object.0, 1))?;
    step(&mut runtime, 159)?;
    assert_eq!(ready.load(Ordering::SeqCst), 2);
    step(&mut runtime, 1)?;
    assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
    step(&mut runtime, 80)?;
    step(&mut runtime, 120)?;
    assert_eq!(ready.load(Ordering::SeqCst), 3);
    assert_pixels(&mut runtime, display, &expected, Some(2), 5)?;
    runtime.raw()?.lv_obj_delete(object)?;
    runtime.free(source.0)?;
    runtime.shutdown()
}

#[test]
fn gif_widgets_sharing_a_resource_keep_independent_clocks_and_controls() -> Result<()> {
    if values::LVGL_VERSION_MINOR == 0 {
        return Ok(());
    }
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    let name = expected["file"].as_str().unwrap();
    let source = upload(&mut runtime, name, &fixture(name)?)?;
    let first = gif(&mut runtime, screen, 5)?;
    runtime.raw()?.lv_gif_set_src(first, source)?;
    step(&mut runtime, 40)?;
    let second = gif(&mut runtime, screen, 25)?;
    runtime.raw()?.lv_gif_set_src(second, source)?;
    assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
    assert_pixels(&mut runtime, display, &expected, Some(0), 25)?;
    for (elapsed, left, right) in [(40, 1, 0), (40, 1, 1), (80, 2, 1), (40, 2, 2)] {
        step(&mut runtime, elapsed)?;
        assert_pixels(&mut runtime, display, &expected, Some(left), 5)?;
        assert_pixels(&mut runtime, display, &expected, Some(right), 25)?;
    }
    runtime.raw()?.lv_gif_pause(first)?;
    step(&mut runtime, 120)?;
    step(&mut runtime, 40)?;
    assert_pixels(&mut runtime, display, &expected, Some(2), 5)?;
    assert_pixels(&mut runtime, display, &expected, Some(0), 25)?;
    runtime.raw()?.lv_gif_resume(first)?;
    step(&mut runtime, 0)?;
    assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
    step(&mut runtime, 80)?;
    assert_pixels(&mut runtime, display, &expected, Some(1), 5)?;
    assert_pixels(&mut runtime, display, &expected, Some(1), 25)?;
    runtime.raw()?.lv_gif_restart(first)?;
    runtime.call_raw::<_, ()>("lv_gif_set_loop_count", (first.0, 0))?;
    step(&mut runtime, 119)?;
    assert_pixels(&mut runtime, display, &expected, Some(1), 25)?;
    step(&mut runtime, 1)?;
    assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
    assert_pixels(&mut runtime, display, &expected, Some(2), 25)?;
    runtime.raw()?.lv_obj_delete(first)?;
    step(&mut runtime, 160)?;
    assert_pixels(&mut runtime, display, &expected, None, 5)?;
    assert_pixels(&mut runtime, display, &expected, Some(0), 25)?;
    runtime.raw()?.lv_obj_delete(second)?;
    runtime.free(source.0)?;
    runtime.shutdown()
}

#[test]
fn gif_source_failures_and_synchronous_ready_mutations_leave_no_stale_work() -> Result<()> {
    if values::LVGL_VERSION_MINOR == 0 {
        return Ok(());
    }
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    let name = expected["file"].as_str().unwrap();
    let source = upload(&mut runtime, name, &fixture(name)?)?;
    let still_name = expected["still"]["file"].as_str().unwrap();
    let still = upload(&mut runtime, still_name, &fixture(still_name)?)?;
    let bad = upload(&mut runtime, "bad.gif", b"invalid GIF resource")?;
    let missing = path(&mut runtime, "missing.gif")?;
    let object = gif(&mut runtime, screen, 5)?;
    runtime.raw()?.lv_gif_set_src(object, source)?;
    for invalid in [UnsafePointer(0), missing, bad] {
        runtime.raw()?.lv_gif_set_src(object, invalid)?;
        assert_eq!(
            runtime.call_raw::<_, i32>("lv_gif_is_loaded", (object.0,))?,
            0
        );
        step(&mut runtime, 240)?;
        assert_pixels(&mut runtime, display, &expected, None, 5)?;
        runtime.raw()?.lv_gif_set_src(object, source)?;
        assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
        step(&mut runtime, 80)?;
        assert_pixels(&mut runtime, display, &expected, Some(1), 5)?;
    }
    runtime.raw()?.lv_obj_delete(object)?;
    let ready = Arc::new([AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)]);
    let timer_calls = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&ready);
    let timer_observed = Arc::clone(&timer_calls);
    runtime.set_event_handler_with_context(move |context, event| {
        let object = UnsafePointer(event.object);
        let previous = observed[(event.callback_id - 1) as usize].fetch_add(1, Ordering::SeqCst);
        match event.callback_id {
            1 => {
                context.raw()?.lv_obj_delete(object)?;
                let timer_observed = Arc::clone(&timer_observed);
                context.create_timer(1, UnsafePointer(0), move |context, timer| {
                    timer_observed.fetch_add(1, Ordering::SeqCst);
                    context.cancel_timer(timer)
                })?;
            }
            2 if previous == 0 => {
                context.raw()?.lv_gif_set_src(object, source)?;
                context.call_raw::<_, ()>("lv_gif_set_loop_count", (object.0, 1))?;
            }
            3 if previous == 0 => {
                assert_eq!(
                    context.call_raw::<_, i32>("lv_gif_get_loop_count", (object.0,))?,
                    1
                );
                context.raw()?.lv_gif_restart(object)?;
                context.call_raw::<_, ()>("lv_gif_set_loop_count", (object.0, 1))?;
            }
            _ => {}
        }
        Ok(())
    })?;
    let deleted = gif(&mut runtime, screen, 5)?;
    subscribe(&mut runtime, deleted, 1)?;
    runtime.raw()?.lv_gif_set_src(deleted, still)?;
    assert_eq!(ready[0].load(Ordering::SeqCst), 1);
    step(&mut runtime, 1)?;
    assert_eq!(timer_calls.load(Ordering::SeqCst), 1);
    assert_pixels(&mut runtime, display, &expected, None, 5)?;
    let replaced = gif(&mut runtime, screen, 5)?;
    subscribe(&mut runtime, replaced, 2)?;
    runtime.raw()?.lv_gif_set_src(replaced, still)?;
    assert_eq!(ready[1].load(Ordering::SeqCst), 1);
    assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
    step(&mut runtime, 79)?;
    assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
    step(&mut runtime, 1)?;
    assert_pixels(&mut runtime, display, &expected, Some(1), 5)?;
    runtime.raw()?.lv_obj_delete(replaced)?;
    let restarted = gif(&mut runtime, screen, 5)?;
    subscribe(&mut runtime, restarted, 3)?;
    runtime.raw()?.lv_gif_set_src(restarted, source)?;
    runtime.call_raw::<_, ()>("lv_gif_set_loop_count", (restarted.0, 1))?;
    step(&mut runtime, 80)?;
    step(&mut runtime, 120)?;
    assert_eq!(ready[2].load(Ordering::SeqCst), 1);
    step(&mut runtime, 159)?;
    assert_eq!(ready[2].load(Ordering::SeqCst), 1);
    step(&mut runtime, 1)?;
    assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
    step(&mut runtime, 80)?;
    step(&mut runtime, 120)?;
    assert_eq!(ready[2].load(Ordering::SeqCst), 2);
    assert_pixels(&mut runtime, display, &expected, Some(2), 5)?;
    runtime.raw()?.lv_obj_delete(restarted)?;
    step(&mut runtime, 160)?;
    assert_pixels(&mut runtime, display, &expected, None, 5)?;
    for pointer in [source, still, bad, missing] {
        runtime.free(pointer.0)?;
    }
    runtime.shutdown()
}

#[test]
fn legacy_gif_frames_loops_callbacks_and_sources_preserve_native_lifetimes() -> Result<()> {
    if values::LVGL_VERSION_MINOR != 0 {
        return Ok(());
    }
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    let bytes = fixture(expected["file"].as_str().unwrap())?;
    let source = upload(&mut runtime, "playback.gif", &bytes)?;
    let single = upload(
        &mut runtime,
        "single-pass.gif",
        &fixture("single-pass.gif")?,
    )?;
    let twice = upload(
        &mut runtime,
        "repeat-once.gif",
        &fixture("repeat-once.gif")?,
    )?;
    let pixel = upload(&mut runtime, "pixel.gif", &fixture("pixel.gif")?)?;
    let object = gif(&mut runtime, screen, 5)?;
    let ready = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&ready);
    runtime.set_event_handler(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })?;
    subscribe(&mut runtime, object, 1)?;
    runtime.raw()?.lv_gif_set_src(object, source)?;
    let mut previous = 0;
    for (deadline, index) in [
        (0, 0),
        (37, 0),
        (79, 0),
        (80, 1),
        (199, 1),
        (200, 2),
        (359, 2),
        (360, 0),
    ] {
        step(&mut runtime, deadline - previous)?;
        previous = deadline;
        assert_pixels(&mut runtime, display, &expected, Some(index), 5)?;
    }
    assert_eq!(ready.load(Ordering::SeqCst), 0);
    step(&mut runtime, 40)?;
    let other = gif(&mut runtime, screen, 25)?;
    runtime.raw()?.lv_gif_set_src(other, source)?;
    step(&mut runtime, 40)?;
    assert_pixels(&mut runtime, display, &expected, Some(1), 5)?;
    assert_pixels(&mut runtime, display, &expected, Some(0), 25)?;
    step(&mut runtime, 40)?;
    assert_pixels(&mut runtime, display, &expected, Some(1), 25)?;
    runtime.raw()?.lv_gif_pause(object)?;
    step(&mut runtime, 200)?;
    assert_pixels(&mut runtime, display, &expected, Some(1), 5)?;
    assert_pixels(&mut runtime, display, &expected, Some(2), 25)?;
    runtime.raw()?.lv_gif_resume(object)?;
    step(&mut runtime, 0)?;
    assert_pixels(&mut runtime, display, &expected, Some(2), 5)?;
    runtime.raw()?.lv_obj_delete(other)?;
    for (path, cycles) in [(single, 1), (twice, 2)] {
        let before = ready.load(Ordering::SeqCst);
        runtime.raw()?.lv_gif_set_src(object, path)?;
        for _ in 0..cycles {
            assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
            step(&mut runtime, 80)?;
            assert_pixels(&mut runtime, display, &expected, Some(1), 5)?;
            step(&mut runtime, 120)?;
            assert_pixels(&mut runtime, display, &expected, Some(2), 5)?;
            step(&mut runtime, 159)?;
            assert_pixels(&mut runtime, display, &expected, Some(2), 5)?;
            assert_eq!(ready.load(Ordering::SeqCst), before);
            step(&mut runtime, 1)?;
        }
        assert_eq!(ready.load(Ordering::SeqCst), before + 1);
        step(&mut runtime, 500)?;
        assert_pixels(&mut runtime, display, &expected, Some(2), 5)?;
    }
    runtime.raw()?.lv_gif_restart(object)?;
    step(&mut runtime, 159)?;
    assert_pixels(&mut runtime, display, &expected, Some(2), 5)?;
    step(&mut runtime, 1)?;
    assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
    runtime.raw()?.lv_obj_delete(object)?;

    let managed = match runtime.create_timer(1000, UnsafePointer(0), |_, _| Ok(())) {
        Ok(timer) => {
            runtime.cancel_timer(&timer)?;
            true
        }
        Err(error) => {
            assert!(error.to_string().contains("lvw_timer_create"));
            false
        }
    };
    let counts = Arc::new([AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)]);
    let ticks = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&counts);
    let timer_observed = Arc::clone(&ticks);
    runtime.set_event_handler_with_context(move |context, event| {
        let object = UnsafePointer(event.object);
        if observed[(event.callback_id - 1) as usize].fetch_add(1, Ordering::SeqCst) != 0 {
            return Ok(());
        }
        match event.callback_id {
            1 => {
                context.raw()?.lv_obj_delete(object)?;
                if managed {
                    let calls = Arc::clone(&timer_observed);
                    context.create_timer(5, UnsafePointer(0), move |_, _| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    })?;
                }
            }
            2 => context.raw()?.lv_gif_set_src(object, source)?,
            3 => context.raw()?.lv_gif_restart(object)?,
            _ => unreachable!(),
        }
        Ok(())
    })?;
    for id in 1..=3 {
        let object = gif(&mut runtime, screen, 5)?;
        subscribe(&mut runtime, object, id)?;
        runtime.raw()?.lv_gif_set_src(object, single)?;
        step(&mut runtime, 80)?;
        step(&mut runtime, 120)?;
        step(&mut runtime, 160)?;
        assert_eq!(counts[(id - 1) as usize].load(Ordering::SeqCst), 1);
        if id == 1 {
            step(&mut runtime, 5)?;
            step(&mut runtime, 5)?;
            assert_eq!(ticks.load(Ordering::SeqCst), if managed { 2 } else { 0 });
            assert_pixels(&mut runtime, display, &expected, None, 5)?;
        } else {
            let delay = if id == 2 { 80 } else { 160 };
            let index = if id == 2 { 0 } else { 2 };
            assert_pixels(&mut runtime, display, &expected, Some(index), 5)?;
            step(&mut runtime, delay - 1)?;
            assert_pixels(&mut runtime, display, &expected, Some(index), 5)?;
            step(&mut runtime, 1)?;
            assert_pixels(
                &mut runtime,
                display,
                &expected,
                Some(if id == 2 { 1 } else { 0 }),
                5,
            )?;
            runtime.raw()?.lv_obj_delete(object)?;
        }
    }

    let descriptor = runtime.alloc(values::LV_IMAGE_DSC_T_SIZE)?;
    let data = runtime.alloc(bytes.len() as u32)?;
    runtime.write_memory(data, &bytes)?;
    runtime.write_memory(descriptor, &vec![0; values::LV_IMAGE_DSC_T_SIZE as usize])?;
    for (name, value) in [("data", data), ("data_size", bytes.len() as u32)] {
        let field = values::LV_IMAGE_DSC_T_FIELDS
            .iter()
            .find(|field| field.name == Some(name))
            .unwrap();
        assert_eq!(field.bit_offset % 8, 0);
        runtime.write_memory(
            descriptor + field.bit_offset as u32 / 8,
            &value.to_le_bytes(),
        )?;
    }
    let object = gif(&mut runtime, screen, 5)?;
    runtime
        .raw()?
        .lv_gif_set_src(object, UnsafePointer(descriptor))?;
    assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
    step(&mut runtime, 80)?;
    assert_pixels(&mut runtime, display, &expected, Some(1), 5)?;
    runtime.raw()?.lv_gif_set_src(object, pixel)?;
    runtime.raw()?.lv_obj_update_layout(object)?;
    assert_eq!(runtime.raw()?.lv_obj_get_width(object)?, 1);
    assert_eq!(runtime.raw()?.lv_obj_get_height(object)?, 1);
    let mut small = expected.clone();
    small["width"] = 1.into();
    small["height"] = 1.into();
    small["frames"][0]["indices"] = serde_json::json!([1]);
    assert_pixels(&mut runtime, display, &small, Some(0), 5)?;
    runtime.raw()?.lv_gif_set_src(object, source)?;
    runtime.raw()?.lv_obj_update_layout(object)?;
    assert_eq!(runtime.raw()?.lv_obj_get_width(object)?, 9);
    assert_eq!(runtime.raw()?.lv_obj_get_height(object)?, 7);
    assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
    let mut zero_width = bytes.clone();
    zero_width[6..8].fill(0);
    let truncated = upload(&mut runtime, "truncated.gif", &bytes[..13])?;
    let zero_width = upload(&mut runtime, "zero-width.gif", &zero_width)?;
    let bad = upload(&mut runtime, "bad.gif", &[0; 32])?;
    let missing = path(&mut runtime, "missing.gif")?;
    for invalid in [UnsafePointer(0), truncated, zero_width, bad, missing] {
        runtime.raw()?.lv_gif_set_src(object, invalid)?;
        assert_eq!(runtime.raw()?.lv_image_get_src(object)?, UnsafePointer(0));
        step(&mut runtime, 1000)?;
        assert_pixels(&mut runtime, display, &expected, None, 5)?;
        runtime.raw()?.lv_gif_set_src(object, source)?;
        assert_pixels(&mut runtime, display, &expected, Some(0), 5)?;
    }
    runtime.raw()?.lv_obj_delete(object)?;
    for pointer in [
        source.0,
        single.0,
        twice.0,
        pixel.0,
        descriptor,
        data,
        truncated.0,
        zero_width.0,
        bad.0,
        missing.0,
    ] {
        runtime.free(pointer)?;
    }
    step(&mut runtime, 1000)?;
    assert_pixels(&mut runtime, display, &expected, None, 5)?;
    runtime.shutdown()
}
