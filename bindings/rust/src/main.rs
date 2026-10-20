use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use liblvgl_wasm_host::{Result, Runtime, UnsafePointer};

fn put_u32(runtime: &mut Runtime, pointer: u32, offset: u32, value: u32) -> Result<()> {
    runtime.write_memory(pointer + offset, &value.to_le_bytes())
}

fn get_u32(runtime: &Runtime, pointer: u32, offset: u32) -> Result<u32> {
    let mut bytes = [0; 4];
    runtime.read_memory(pointer + offset, &mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/wasm/liblvgl.wasm"));
    let mut runtime = Runtime::from_file(path)?;
    let clicks = Arc::new(AtomicU32::new(0));
    let event_clicks = Arc::clone(&clicks);
    runtime.set_event_handler(move |event| {
        if event.callback_id == 1 {
            event_clicks.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    })?;

    let display = runtime.call_raw::<(u32, u32, u32), u32>("lvw_display_create", (320, 240, 1))?;
    assert_ne!(display, 0);
    let pointer = runtime.call_raw::<(u32, u32), u32>("lvw_indev_create", (display, 1))?;
    assert_ne!(pointer, 0);
    let screen = runtime
        .raw()?
        .lv_display_get_screen_active(UnsafePointer(display))?;
    let resource = include_bytes!("../../../examples/browser/red.bmp");
    let name = runtime.alloc(8)?;
    runtime.write_memory(name, b"red.bmp\0")?;
    let data = runtime.alloc(resource.len() as u32)?;
    runtime.write_memory(data, resource)?;
    assert_eq!(
        runtime.call_raw::<(u32, u32, u32, u32), i32>(
            "lvw_resource_put",
            (name, 7, data, resource.len() as u32)
        )?,
        0
    );
    runtime.free(data)?;
    runtime.free(name)?;
    let image_path = runtime.alloc(10)?;
    runtime.write_memory(image_path, b"W:red.bmp\0")?;
    let image = runtime.raw()?.lv_image_create(screen)?;
    runtime
        .raw()?
        .lv_image_set_src(image, UnsafePointer(image_path))?;
    runtime.raw()?.lv_obj_set_pos(image, 8, 8)?;
    let button = runtime.raw()?.lv_button_create(screen)?;
    runtime.raw()?.lv_obj_set_size(button, 140, 60)?;
    runtime.raw()?.lv_obj_set_pos(button, 90, 80)?;
    let clicked_code = runtime.call_raw::<(), u32>("lvw_event_clicked", ())?;
    assert_eq!(
        runtime.call_raw::<(u32, u32, u32), i32>("lvw_event_add", (button.0, clicked_code, 1))?,
        0
    );

    let result = runtime.alloc(16)?;
    put_u32(&mut runtime, result, 0, 16)?;
    put_u32(&mut runtime, result, 4, 1)?;
    for _ in 0..5 {
        assert_eq!(
            runtime.call_raw::<(u32, u32), i32>("lvw_step", (50, result))?,
            0
        );
    }

    let packet = runtime.alloc(32)?;
    runtime.write_memory(packet, &[0; 32])?;
    put_u32(&mut runtime, packet, 0, 32)?;
    put_u32(&mut runtime, packet, 4, 1)?;
    put_u32(&mut runtime, packet, 8, 1)?;
    put_u32(&mut runtime, packet, 12, 120)?;
    put_u32(&mut runtime, packet, 16, 100)?;
    put_u32(&mut runtime, packet, 20, 1)?;
    assert_eq!(
        runtime.call_raw::<(u32, u32, u32), i32>("lvw_indev_push", (pointer, packet, 32))?,
        0
    );
    assert_eq!(
        runtime.call_raw::<(u32, u32), i32>("lvw_step", (50, result))?,
        0
    );
    put_u32(&mut runtime, packet, 20, 0)?;
    assert_eq!(
        runtime.call_raw::<(u32, u32, u32), i32>("lvw_indev_push", (pointer, packet, 32))?,
        0
    );
    assert_eq!(
        runtime.call_raw::<(u32, u32), i32>("lvw_step", (50, result))?,
        0
    );
    assert_eq!(clicks.load(Ordering::Relaxed), 1);

    let frame = runtime.alloc(48)?;
    put_u32(&mut runtime, frame, 0, 48)?;
    put_u32(&mut runtime, frame, 4, 1)?;
    assert_eq!(
        runtime.call_raw::<(u32, u32), i32>("lvw_frame_get", (display, frame))?,
        0
    );
    assert!(get_u32(&runtime, frame, 44)? > 0);
    let pixels = get_u32(&runtime, frame, 8)?;
    let length = get_u32(&runtime, frame, 12)?;
    assert_eq!(length, 320 * 240 * 4);
    let mut pixels_bytes = vec![0; length as usize];
    runtime.read_memory(pixels, &mut pixels_bytes)?;
    assert!(pixels_bytes.iter().any(|byte| *byte != 0));
    let red = (8 * 320 + 8) * 4;
    assert_eq!(&pixels_bytes[red..red + 3], &[0, 0, 255]);

    runtime.free(frame)?;
    runtime.free(packet)?;
    runtime.free(result)?;
    assert_eq!(
        runtime.call_raw::<u32, i32>("lvw_display_destroy", display)?,
        0
    );
    runtime.free(image_path)?;
    runtime.shutdown()?;
    println!(
        "rust host passed: click count {}",
        clicks.load(Ordering::Relaxed)
    );
    Ok(())
}
