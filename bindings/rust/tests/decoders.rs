use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use liblvgl_wasm_host::{
    CallbackContext, DecoderOutput, Error, ImageDecoderCallbacks, Result, Runtime, UnsafePointer,
    values,
};

fn load() -> Result<Runtime> {
    Runtime::from_file(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"))
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

fn resource(runtime: &mut Runtime, name: &str, bytes: &[u8]) -> Result<UnsafePointer> {
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
    let path = format!("W:{name}\0");
    let pointer = runtime.alloc(path.len() as u32)?;
    runtime.write_memory(pointer, path.as_bytes())?;
    Ok(UnsafePointer(pointer))
}

fn header(runtime: &mut Runtime) -> Result<Vec<u8>> {
    let buffer = runtime
        .raw()?
        .lv_draw_buf_create(2, 2, values::LV_COLOR_FORMAT_ARGB8888, 0)?;
    assert_ne!(buffer.0, 0);
    let mut bytes = vec![0; values::LV_IMAGE_HEADER_T_SIZE as usize];
    runtime.read_memory(
        buffer.0 + offset(values::LV_DRAW_BUF_T_FIELDS, "header"),
        &mut bytes,
    )?;
    runtime.raw()?.lv_draw_buf_destroy(buffer)?;
    Ok(bytes)
}

fn display(runtime: &mut Runtime) -> Result<(u32, UnsafePointer)> {
    let display = runtime.call_raw("lvw_display_create", (64u32, 48u32, 1u32))?;
    let screen = runtime
        .raw()?
        .lv_display_get_screen_active(UnsafePointer(display))?;
    Ok((display, screen))
}

fn image(
    runtime: &mut Runtime,
    screen: UnsafePointer,
    src: UnsafePointer,
    x: i32,
) -> Result<UnsafePointer> {
    let mut raw = runtime.raw()?;
    let image = raw.lv_image_create(screen)?;
    raw.lv_image_set_src(image, src)?;
    raw.lv_obj_set_pos(image, x, 8)?;
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

fn pixel(runtime: &mut Runtime, display: u32, x: u32, y: u32) -> Result<[u8; 3]> {
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
    let stride = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
    let mut color = [0; 3];
    runtime.read_memory(pixels + y * stride + x * 4, &mut color)?;
    runtime.free(pointer)?;
    Ok(color)
}

fn fill_row(
    context: &mut CallbackContext<'_>,
    buffer: UnsafePointer,
    row: i32,
    color: [u8; 4],
) -> Result<()> {
    let pixels = context.raw()?.lv_draw_buf_goto_xy(buffer, 0, row)?;
    context.write_memory(pixels.0, &[color, color].concat())
}

fn area(context: &CallbackContext<'_>, pointer: UnsafePointer) -> Result<[i32; 4]> {
    let mut result = [0; 4];
    for (index, name) in ["x1", "y1", "x2", "y2"].iter().enumerate() {
        let mut bytes = [0; 4];
        context.read_memory(
            pointer.0 + offset(values::LV_AREA_T_FIELDS, name),
            &mut bytes,
        )?;
        result[index] = i32::from_le_bytes(bytes);
    }
    Ok(result)
}

#[test]
fn full_and_block_decoders_render_pixels_with_synchronous_session_ownership() -> Result<()> {
    let mut runtime = load()?;
    let (display, screen) = display(&mut runtime)?;
    let source = resource(&mut runtime, "custom.image", b"custom")?;
    let header = header(&mut runtime)?;
    for block in [false, true] {
        let counts = Arc::new([
            AtomicU32::new(0),
            AtomicU32::new(0),
            AtomicU32::new(0),
            AtomicU32::new(0),
        ]);
        let info_counts = Arc::clone(&counts);
        let header = header.clone();
        let open_counts = Arc::clone(&counts);
        let area_counts = Arc::clone(&counts);
        let close_counts = Arc::clone(&counts);
        let decoder = runtime.create_image_decoder(
            UnsafePointer(0xf123_4567),
            ImageDecoderCallbacks::new(
                move |context, session, output| {
                    let view = session.read(context)?;
                    assert_eq!(view.phase, 1);
                    assert_eq!(view.header, output);
                    assert_eq!(view.source_type, values::LV_IMAGE_SRC_FILE as u32);
                    assert_eq!(view.decoder_user_data.0, 0xf123_4567);
                    assert!(session.write(context, DecoderOutput::default()).is_err());
                    assert!(
                        context
                            .cancel_image_decoder(session.decoder())
                            .unwrap_err()
                            .to_string()
                            .contains("(-3)")
                    );
                    context.write_memory(output.0, &header)?;
                    info_counts[0].fetch_add(1, Ordering::SeqCst);
                    Ok(values::LV_RESULT_OK)
                },
                move |context, session| {
                    assert_eq!(session.read(context)?.phase, 2);
                    let buffer = context.raw()?.lv_draw_buf_create(
                        2,
                        if block { 1 } else { 2 },
                        values::LV_COLOR_FORMAT_ARGB8888,
                        0,
                    )?;
                    assert_ne!(buffer.0, 0);
                    if !block {
                        fill_row(context, buffer, 0, [0x33, 0x66, 0xcc, 0xff])?;
                        fill_row(context, buffer, 1, [0x77, 0xbb, 0x22, 0xff])?;
                    }
                    session.write(
                        context,
                        DecoderOutput {
                            decoded: if block { UnsafePointer(0) } else { buffer },
                            user_data: buffer,
                            time_to_open: 7,
                            ..Default::default()
                        },
                    )?;
                    assert_eq!(session.read(context)?.time_to_open, 7);
                    open_counts[1].fetch_add(1, Ordering::SeqCst);
                    Ok(values::LV_RESULT_OK)
                },
            )
            .get_area(move |context, session, full, decoded| {
                assert!(block);
                let view = session.read(context)?;
                assert_eq!(view.phase, 3);
                let full = area(context, full)?;
                let previous = area(context, decoded)?;
                let row = if previous[1] == values::LV_COORD_MIN {
                    full[1]
                } else {
                    previous[1] + 1
                };
                if row > full[3] {
                    return Ok(values::LV_RESULT_INVALID);
                }
                fill_row(
                    context,
                    view.user_data,
                    0,
                    if row == 0 {
                        [0x33, 0x66, 0xcc, 0xff]
                    } else {
                        [0x77, 0xbb, 0x22, 0xff]
                    },
                )?;
                context
                    .raw()?
                    .lv_area_set(decoded, full[0], row, full[2], row)?;
                session.write(
                    context,
                    DecoderOutput {
                        decoded: view.user_data,
                        user_data: view.user_data,
                        ..Default::default()
                    },
                )?;
                area_counts[2].fetch_add(1, Ordering::SeqCst);
                Ok(values::LV_RESULT_OK)
            })
            .close(move |context, session| {
                let view = session.read(context)?;
                assert_eq!(view.phase, 4);
                assert!(context.cancel_image_decoder(session.decoder()).is_err());
                context.raw()?.lv_draw_buf_destroy(view.user_data)?;
                session.write(context, DecoderOutput::default())?;
                close_counts[3].fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        )?;
        let image = image(&mut runtime, screen, source, 8)?;
        step(&mut runtime)?;
        assert_eq!(pixel(&mut runtime, display, 8, 8)?, [0x33, 0x66, 0xcc]);
        assert_eq!(pixel(&mut runtime, display, 9, 9)?, [0x77, 0xbb, 0x22]);
        assert!(counts[0].load(Ordering::SeqCst) > 0);
        assert!(counts[1].load(Ordering::SeqCst) > 0);
        assert_eq!(
            counts[1].load(Ordering::SeqCst),
            counts[3].load(Ordering::SeqCst)
        );
        assert_eq!(counts[2].load(Ordering::SeqCst) > 0, block);
        runtime.raw()?.lv_obj_delete(image)?;
        runtime.cancel_image_decoder(&decoder)?;
        runtime.cancel_image_decoder(&decoder)?;
        assert!(decoder.pointer().is_err());
    }
    runtime.free(source.0)?;
    runtime.shutdown()
}

#[test]
fn format_rejection_falls_back_to_bmp_and_open_failure_rolls_back_without_close() -> Result<()> {
    let mut runtime = load()?;
    let (display, screen) = display(&mut runtime)?;
    let bitmap = resource(
        &mut runtime,
        "red.bmp",
        include_bytes!("../../../examples/browser/red.bmp"),
    )?;
    let rejected = resource(&mut runtime, "fail.image", b"custom")?;
    let header = header(&mut runtime)?;
    let counts = Arc::new([AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)]);
    let info_count = Arc::clone(&counts);
    let open_count = Arc::clone(&counts);
    let close_count = Arc::clone(&counts);
    let decoder = runtime.create_image_decoder(
        UnsafePointer(0),
        ImageDecoderCallbacks::new(
            move |context, session, output| {
                let mut prefix = [0; 6];
                let source = session.read(context)?.src;
                context.read_memory(source.0, &mut prefix)?;
                if prefix == *b"W:red." {
                    info_count[0].fetch_add(1, Ordering::SeqCst);
                    return Ok(values::LV_RESULT_INVALID);
                }
                context.write_memory(output.0, &header)?;
                Ok(values::LV_RESULT_OK)
            },
            move |context, session| {
                let buffer =
                    context
                        .raw()?
                        .lv_draw_buf_create(2, 2, values::LV_COLOR_FORMAT_ARGB8888, 0)?;
                context.raw()?.lv_draw_buf_destroy(buffer)?;
                session.write(context, DecoderOutput::default())?;
                open_count[1].fetch_add(1, Ordering::SeqCst);
                Ok(values::LV_RESULT_INVALID)
            },
        )
        .close(move |_, _| {
            close_count[2].fetch_add(1, Ordering::SeqCst);
            Ok(())
        }),
    )?;
    image(&mut runtime, screen, bitmap, 8)?;
    image(&mut runtime, screen, rejected, 20)?;
    step(&mut runtime)?;
    assert_eq!(pixel(&mut runtime, display, 8, 8)?, [0, 0, 255]);
    assert!(counts[0].load(Ordering::SeqCst) > 0);
    assert!(counts[1].load(Ordering::SeqCst) > 0);
    assert_eq!(counts[2].load(Ordering::SeqCst), 0);
    runtime.cancel_image_decoder(&decoder)?;
    runtime.free(bitmap.0)?;
    runtime.free(rejected.0)?;
    runtime.shutdown()
}

fn idle_callbacks(capture: Arc<()>) -> ImageDecoderCallbacks {
    ImageDecoderCallbacks::new(
        move |_, _, _| {
            let _ = &capture;
            Ok(values::LV_RESULT_INVALID)
        },
        |_, _| Ok(values::LV_RESULT_INVALID),
    )
}

#[test]
fn decoder_lifetimes_release_captures_on_native_delete_closing_and_store_drop() -> Result<()> {
    let mut runtime = load()?;
    let mut foreign = load()?;
    let capture = Arc::new(());
    let weak = Arc::downgrade(&capture);
    let decoder = runtime.create_image_decoder(UnsafePointer(0), idle_callbacks(capture))?;
    let alias = decoder.clone();
    assert!(
        foreign
            .cancel_image_decoder(&decoder)
            .unwrap_err()
            .to_string()
            .contains("another runtime")
    );
    runtime.raw()?.lv_image_decoder_delete(decoder.pointer()?)?;
    assert!(alias.pointer().is_err());
    assert!(weak.upgrade().is_none());
    runtime.cancel_image_decoder(&decoder)?;
    let capture = Arc::new(());
    let weak = Arc::downgrade(&capture);
    let closing = runtime.create_image_decoder(UnsafePointer(0), idle_callbacks(capture))?;
    let (_, screen) = display(&mut runtime)?;
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_event_add", (screen.0, values::LV_EVENT_DELETE, 1u32))?,
        0
    );
    let handle = closing.clone();
    let observed = weak.clone();
    runtime.set_event_handler_with_context(move |context, _| {
        assert!(handle.pointer().is_err());
        context.cancel_image_decoder(&handle)?;
        context.cancel_image_decoder(&handle)?;
        assert!(observed.upgrade().is_none());
        Ok(())
    })?;
    runtime.shutdown()?;
    assert!(weak.upgrade().is_none());
    assert!(closing.pointer().is_err());
    let capture = Arc::new(());
    let weak = Arc::downgrade(&capture);
    let dropped = foreign.create_image_decoder(UnsafePointer(0), idle_callbacks(capture))?;
    drop(foreign);
    assert!(dropped.pointer().is_err());
    assert!(weak.upgrade().is_none());
    Ok(())
}

#[test]
fn invalid_results_errors_and_caught_guest_traps_poison_decoder_registrations() -> Result<()> {
    for mode in 0..3 {
        let mut runtime = load()?;
        let source = resource(&mut runtime, "failure.image", b"custom")?;
        let output = UnsafePointer(runtime.alloc(values::LV_IMAGE_HEADER_T_SIZE)?);
        let capture = Arc::new(());
        let weak = Arc::downgrade(&capture);
        let decoder = runtime.create_image_decoder(
            UnsafePointer(0),
            ImageDecoderCallbacks::new(
                move |context, _, _| {
                    let _ = &capture;
                    match mode {
                        0 => Ok(2),
                        1 => Err(Error::msg("decoder callback failed")),
                        _ => {
                            assert!(
                                context
                                    .raw()?
                                    .lv_obj_get_width(UnsafePointer(0x4000_0000))
                                    .is_err()
                            );
                            Ok(values::LV_RESULT_INVALID)
                        }
                    }
                },
                |_, _| Ok(values::LV_RESULT_INVALID),
            ),
        )?;
        assert!(
            runtime
                .raw()?
                .lv_image_decoder_get_info(source, output)
                .is_err()
        );
        assert!(
            runtime
                .raw()
                .err()
                .unwrap()
                .to_string()
                .contains("poisoned")
        );
        assert!(decoder.pointer().is_err());
        assert!(weak.upgrade().is_none());
        runtime.cancel_image_decoder(&decoder)?;
    }
    Ok(())
}
