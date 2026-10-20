use std::path::Path;
use std::sync::{Arc, Mutex};

use liblvgl_wasm_host::{Result, Runtime};

#[test]
fn removing_subscriptions_is_idempotent_and_scoped_to_object_and_callback_id() -> Result<()> {
    let mut runtime = Runtime::from_file(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"),
    )?;
    let display: u32 = runtime.call_raw("lvw_display_create", (80u32, 60u32, 1u32))?;
    assert_ne!(display, 0);
    let screen: u32 = runtime.call_raw("lv_display_get_screen_active", display)?;
    let first: u32 = runtime.call_raw("lv_button_create", screen)?;
    let second: u32 = runtime.call_raw("lv_button_create", screen)?;
    assert_ne!(first, 0);
    assert_ne!(second, 0);
    let code: u32 = runtime.call_raw("lvw_event_clicked", ())?;
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&events);
    runtime.set_event_handler(move |event| {
        assert_eq!(event.code, code);
        observed
            .lock()
            .unwrap()
            .push((event.object, event.callback_id));
        Ok(())
    })?;

    for (object, id) in [(first, 7u32), (first, 7), (first, 8), (second, 7)] {
        assert_eq!(
            runtime.call_raw::<_, i32>("lvw_event_add", (object, code, id))?,
            0
        );
    }
    for object in [first, second] {
        runtime.call_raw::<_, i32>("lv_obj_send_event", (object, code, 0u32))?;
    }
    assert_eq!(
        *events.lock().unwrap(),
        [(first, 7), (first, 7), (first, 8), (second, 7)]
    );

    for pair in [(0u32, 7u32), (first, 0)] {
        assert_eq!(runtime.call_raw::<_, i32>("lvw_event_remove", pair)?, -2);
    }
    for pair in [(first, 7u32), (first, 7), (first, 9)] {
        assert_eq!(runtime.call_raw::<_, i32>("lvw_event_remove", pair)?, 0);
    }
    events.lock().unwrap().clear();
    for object in [first, second] {
        runtime.call_raw::<_, i32>("lv_obj_send_event", (object, code, 0u32))?;
    }
    assert_eq!(*events.lock().unwrap(), [(first, 8), (second, 7)]);

    for pair in [(first, 8u32), (second, 7)] {
        assert_eq!(runtime.call_raw::<_, i32>("lvw_event_remove", pair)?, 0);
    }
    events.lock().unwrap().clear();
    for object in [first, second] {
        runtime.call_raw::<_, i32>("lv_obj_send_event", (object, code, 0u32))?;
    }
    assert!(events.lock().unwrap().is_empty());
    runtime.shutdown()?;
    Ok(())
}
