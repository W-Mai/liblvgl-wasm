use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use liblvgl_wasm_host::{Result, Runtime, UnsafePointer, values};

fn load() -> Result<(Runtime, u32, UnsafePointer)> {
    let mut runtime = Runtime::from_file(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"),
    )?;
    let display = runtime.call_raw("lvw_display_create", (64u32, 48u32, 1u32))?;
    let screen = runtime
        .raw()?
        .lv_display_get_screen_active(UnsafePointer(display))?;
    Ok((runtime, display, screen))
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

fn subscribe(runtime: &mut Runtime, object: UnsafePointer, code: i32, id: u32) -> Result<()> {
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_event_add", (object.0, code, id))?,
        0
    );
    Ok(())
}

fn step(runtime: &mut Runtime) -> Result<()> {
    let result = runtime.alloc(16)?;
    let mut bytes = [0; 16];
    bytes[..4].copy_from_slice(&16u32.to_le_bytes());
    bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
    runtime.write_memory(result, &bytes)?;
    assert_eq!(runtime.call_raw::<_, i32>("lvw_step", (50u32, result))?, 0);
    runtime.free(result)
}

fn pixel(runtime: &mut Runtime, display: u32, x: u32, y: u32) -> Result<[u8; 3]> {
    // Bridge ABI 1 frame descriptor: size/version, pixels, length, dimensions, stride.
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

#[test]
fn native_draw_layers_and_task_descriptors_change_actual_frame_pixels() -> Result<()> {
    let (mut runtime, display, screen) = load()?;
    let rectangle_descriptor = UnsafePointer(runtime.alloc(values::LV_DRAW_RECT_DSC_T_SIZE)?);
    let area = UnsafePointer(runtime.alloc(values::LV_AREA_T_SIZE)?);
    {
        let mut api = runtime.raw()?;
        let color = api.alloc(values::LV_COLOR_T_SIZE)?;
        api.lv_color_hex(color, 0x101010)?;
        api.lv_obj_set_style_bg_color(screen, color, values::LV_PART_MAIN)?;
        api.lv_obj_set_style_bg_opa(screen, values::LV_OPA_COVER, values::LV_PART_MAIN)?;
        api.free(color)?;
        api.lv_draw_rect_dsc_init(rectangle_descriptor)?;
        api.lv_color_hex(
            UnsafePointer(
                rectangle_descriptor.0 + offset(values::LV_DRAW_RECT_DSC_T_FIELDS, "bg_color"),
            ),
            0x2255aa,
        )?;
        api.write_memory(
            UnsafePointer(
                rectangle_descriptor.0 + offset(values::LV_DRAW_RECT_DSC_T_FIELDS, "bg_opa"),
            ),
            &[values::LV_OPA_COVER as u8],
        )?;
        for (name, value) in [("x1", 8i32), ("y1", 8), ("x2", 23), ("y2", 23)] {
            api.write_memory(
                UnsafePointer(area.0 + offset(values::LV_AREA_T_FIELDS, name)),
                &value.to_le_bytes(),
            )?;
        }
        api.lv_obj_set_send_draw_task_events(screen, 1)?;
    }
    let calls = Arc::new([AtomicU32::new(0), AtomicU32::new(0)]);
    let observed = Arc::clone(&calls);
    runtime.set_event_handler_with_context(move |context, event| {
        if event.code == values::LV_EVENT_DRAW_MAIN_END as u32 {
            let pointer = context.event_pointer()?;
            let mut api = context.raw()?;
            let layer = api.lv_event_get_layer(pointer)?;
            assert_ne!(layer.0, 0);
            api.lv_draw_rect(layer, rectangle_descriptor, area)?;
            observed[0].fetch_add(1, Ordering::SeqCst);
        } else if event.code == values::LV_EVENT_DRAW_TASK_ADDED as u32 {
            let pointer = context.event_pointer()?;
            let mut api = context.raw()?;
            let task = api.lv_event_get_draw_task(pointer)?;
            if api.lv_draw_task_get_type(task)? == values::LV_DRAW_TASK_TYPE_FILL {
                let fill = api.lv_draw_task_get_fill_dsc(task)?;
                let mut object = [0; 4];
                api.read_memory(
                    UnsafePointer(
                        fill.0
                            + offset(values::LV_DRAW_FILL_DSC_T_FIELDS, "base")
                            + offset(values::LV_DRAW_DSC_BASE_T_FIELDS, "obj"),
                    ),
                    &mut object,
                )?;
                if u32::from_le_bytes(object) == screen.0 {
                    api.lv_color_hex(
                        UnsafePointer(fill.0 + offset(values::LV_DRAW_FILL_DSC_T_FIELDS, "color")),
                        0x11bb55,
                    )?;
                    observed[1].fetch_add(1, Ordering::SeqCst);
                }
            }
        }
        Ok(())
    })?;
    subscribe(&mut runtime, screen, values::LV_EVENT_DRAW_MAIN_END, 1)?;
    subscribe(&mut runtime, screen, values::LV_EVENT_DRAW_TASK_ADDED, 2)?;
    step(&mut runtime)?;
    assert!(calls.iter().all(|count| count.load(Ordering::SeqCst) > 0));
    assert_eq!(pixel(&mut runtime, display, 12, 12)?, [0xaa, 0x55, 0x22]);
    assert_eq!(pixel(&mut runtime, display, 40, 30)?, [0x55, 0xbb, 0x11]);
    assert_eq!(runtime.call_raw::<_, u32>("lvw_event_current", ())?, 0);
    let previous = calls.each_ref().map(|count| count.load(Ordering::SeqCst));
    for id in [1u32, 2] {
        assert_eq!(
            runtime.call_raw::<_, i32>("lvw_event_remove", (screen.0, id))?,
            0
        );
    }
    runtime.raw()?.lv_obj_invalidate(screen)?;
    step(&mut runtime)?;
    assert_eq!(
        calls.each_ref().map(|count| count.load(Ordering::SeqCst)),
        previous
    );
    assert_eq!(pixel(&mut runtime, display, 12, 12)?, [0x10; 3]);
    assert_eq!(pixel(&mut runtime, display, 40, 30)?, [0x10; 3]);
    runtime.free(rectangle_descriptor.0)?;
    runtime.free(area.0)?;
    runtime.shutdown()
}

#[test]
fn nested_events_restore_native_targets_parameters_and_processing_control() -> Result<()> {
    let (mut runtime, _, screen) = load()?;
    let parent = runtime.raw()?.lv_obj_create(screen)?;
    let child = runtime.raw()?.lv_button_create(parent)?;
    runtime.raw()?.lv_obj_set_event_bubble(child, 1)?;
    let param = UnsafePointer(runtime.alloc(4)?);
    runtime.write_memory(param.0, &10u32.to_le_bytes())?;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&calls);
    let outer_pointer = Arc::new(AtomicU32::new(0));
    let outer = Arc::clone(&outer_pointer);
    runtime.set_event_handler_with_context(move |context, event| {
        let pointer = context.event_pointer()?;
        observed.lock().unwrap().push(event.callback_id);
        assert_eq!(event.object, parent.0);
        let mut api = context.raw()?;
        assert_eq!(api.lv_event_get_current_target_obj(pointer)?, parent);
        assert_eq!(api.lv_event_get_param(pointer)?, param);
        assert_eq!(api.lv_event_get_code(pointer)?, event.code as i32);
        if event.callback_id == 10 {
            assert_eq!(api.lv_event_get_target_obj(pointer)?, child);
            outer.store(pointer.0, Ordering::SeqCst);
            api.write_memory(param, &42u32.to_le_bytes())?;
            api.lv_obj_send_event(parent, values::LV_EVENT_VALUE_CHANGED, param)?;
            assert_eq!(context.event_pointer()?, pointer);
            let mut api = context.raw()?;
            let mut bytes = [0; 4];
            api.read_memory(param, &mut bytes)?;
            assert_eq!(u32::from_le_bytes(bytes), 75);
            api.lv_event_stop_processing(pointer)?;
        } else {
            assert_eq!(event.callback_id, 20, "stopped callbacks must not run");
            assert_ne!(pointer.0, outer.load(Ordering::SeqCst));
            assert_eq!(api.lv_event_get_target_obj(pointer)?, parent);
            let mut bytes = [0; 4];
            api.read_memory(param, &mut bytes)?;
            assert_eq!(u32::from_le_bytes(bytes), 42);
            api.write_memory(param, &75u32.to_le_bytes())?;
            api.lv_event_stop_processing(pointer)?;
        }
        Ok(())
    })?;
    subscribe(&mut runtime, parent, values::LV_EVENT_CLICKED, 10)?;
    subscribe(&mut runtime, parent, values::LV_EVENT_CLICKED, 11)?;
    subscribe(&mut runtime, parent, values::LV_EVENT_VALUE_CHANGED, 20)?;
    subscribe(&mut runtime, parent, values::LV_EVENT_VALUE_CHANGED, 21)?;
    runtime
        .raw()?
        .lv_obj_send_event(child, values::LV_EVENT_CLICKED, param)?;
    assert_eq!(*calls.lock().unwrap(), [10, 20]);
    assert_eq!(runtime.call_raw::<_, u32>("lvw_event_current", ())?, 0);
    let mut bytes = [0; 4];
    runtime.read_memory(param.0, &mut bytes)?;
    assert_eq!(u32::from_le_bytes(bytes), 75);
    runtime.free(param.0)?;
    runtime.shutdown()
}

#[test]
fn event_pointer_errors_obey_callback_and_runtime_state_boundaries() -> Result<()> {
    let (mut runtime, _, screen) = load()?;
    assert_eq!(runtime.call_raw::<_, u32>("lvw_event_current", ())?, 0);
    let calls = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&calls);
    runtime.create_timer(1, UnsafePointer(0), move |context, timer| {
        assert!(
            context
                .event_pointer()
                .unwrap_err()
                .to_string()
                .contains("no active")
        );
        assert_eq!(context.raw()?.lv_pow(2, 3)?, 8);
        observed.fetch_add(1, Ordering::SeqCst);
        context.cancel_timer(timer)
    })?;
    step(&mut runtime)?;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let closing = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&closing);
    runtime.set_event_handler_with_context(move |context, _| {
        assert!(
            context
                .event_pointer()
                .unwrap_err()
                .to_string()
                .contains("closing")
        );
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })?;
    subscribe(&mut runtime, screen, values::LV_EVENT_DELETE, 1)?;
    runtime.shutdown()?;
    assert_eq!(closing.load(Ordering::SeqCst), 1);

    let (mut runtime, _, screen) = load()?;
    runtime.set_event_handler_with_context(|context, _| {
        context.event_pointer()?;
        let error = context
            .raw()?
            .lv_color_to_int(UnsafePointer(u32::MAX))
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<wasmtime::Trap>(),
            Some(&wasmtime::Trap::MemoryOutOfBounds)
        );
        assert!(
            context
                .event_pointer()
                .unwrap_err()
                .to_string()
                .contains("poisoned")
        );
        Ok(())
    })?;
    subscribe(&mut runtime, screen, values::LV_EVENT_CLICKED, 1)?;
    assert!(
        runtime
            .raw()?
            .lv_obj_send_event(screen, values::LV_EVENT_CLICKED, UnsafePointer(0))
            .is_err()
    );
    assert!(
        runtime
            .call_raw::<_, u32>("lvw_event_current", ())
            .unwrap_err()
            .to_string()
            .contains("poisoned")
    );
    Ok(())
}
