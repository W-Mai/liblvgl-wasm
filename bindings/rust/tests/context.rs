use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use liblvgl_wasm_host::values::{LV_EVENT_CLICKED, LV_EVENT_DELETE, LV_RESULT_OK};
use liblvgl_wasm_host::{Error, Result, Runtime, UnsafePointer};

fn setup() -> Result<(Runtime, UnsafePointer, UnsafePointer, UnsafePointer)> {
    let mut runtime = Runtime::from_file(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"),
    )?;
    let display: u32 = runtime.call_raw("lvw_display_create", (80u32, 60u32, 1u32))?;
    assert_ne!(display, 0);
    let (first, second, label) = {
        let mut api = runtime.raw()?;
        let screen = api.lv_display_get_screen_active(UnsafePointer(display))?;
        let first = api.lv_button_create(screen)?;
        let second = api.lv_button_create(screen)?;
        let label = api.lv_label_create(first)?;
        (first, second, label)
    };
    Ok((runtime, first, second, label))
}

fn subscribe(runtime: &mut Runtime, object: UnsafePointer, code: i32, id: u32) -> Result<()> {
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_event_add", (object.0, code, id))?,
        0
    );
    Ok(())
}

#[test]
fn context_updates_ui_and_delivers_nested_events_to_the_same_handler() -> Result<()> {
    let (mut runtime, first, second, label) = setup()?;
    subscribe(&mut runtime, first, LV_EVENT_CLICKED, 1)?;
    subscribe(&mut runtime, second, LV_EVENT_CLICKED, 2)?;
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&events);
    runtime.set_event_handler_with_context(move |context, event| {
        assert_eq!(event.code, LV_EVENT_CLICKED as u32);
        observed.lock().unwrap().push(("enter", event.callback_id));
        if event.callback_id == 1 {
            assert_eq!(event.object, first.0);
            let text = b"updated\0";
            let pointer = context.alloc(text.len() as u32)?;
            context.write_memory(pointer, text)?;
            let mut copied = [0; 8];
            context.read_memory(pointer, &mut copied)?;
            assert_eq!(&copied, text);
            {
                let mut api = context.raw()?;
                api.lv_label_set_text(label, UnsafePointer(pointer))?;
                assert_eq!(
                    api.lv_obj_send_event(second, LV_EVENT_CLICKED, UnsafePointer(0))?,
                    LV_RESULT_OK
                );
            }
            context.free(pointer)?;
        } else {
            assert_eq!(event.callback_id, 2);
            assert_eq!(event.object, second.0);
            context.call_raw::<_, ()>("lv_obj_set_pos", (second.0, 4i32, 6i32))?;
        }
        observed.lock().unwrap().push(("exit", event.callback_id));
        Ok(())
    })?;
    assert_eq!(
        runtime
            .raw()?
            .lv_obj_send_event(first, LV_EVENT_CLICKED, UnsafePointer(0))?,
        LV_RESULT_OK
    );
    assert_eq!(
        *events.lock().unwrap(),
        [("enter", 1), ("enter", 2), ("exit", 2), ("exit", 1)]
    );
    {
        let mut api = runtime.raw()?;
        let stored = api.lv_label_get_text(label)?;
        let mut text = [0; 8];
        api.read_memory(stored, &mut text)?;
        assert_eq!(&text, b"updated\0");
        api.lv_obj_update_layout(second)?;
        assert_eq!(api.lv_obj_get_x(second)?, 4);
        assert_eq!(api.lv_obj_get_y(second)?, 6);
    }
    runtime.shutdown()
}

#[test]
fn context_preconditions_are_recoverable_without_entering_the_guest() -> Result<()> {
    let (mut runtime, first, _, _) = setup()?;
    subscribe(&mut runtime, first, LV_EVENT_CLICKED, 1)?;
    runtime.set_event_handler_with_context(|context, _| {
        assert!(context.call_raw::<_, ()>("missing_export", ()).is_err());
        assert!(context.call_raw::<_, ()>("lvw_abi_version", ()).is_err());
        assert!(context.read_memory(u32::MAX, &mut [0]).is_err());
        assert!(context.write_memory(u32::MAX, &[1]).is_err());
        assert!(
            context
                .call_raw::<_, i32>("lvw_step", (1u32, 0u32))
                .is_err()
        );
        assert!(context.call_raw::<_, i32>("lvw_shutdown", ()).is_err());
        assert_eq!(context.raw()?.lv_pow(2, 3)?, 8);
        Ok(())
    })?;
    assert_eq!(
        runtime
            .raw()?
            .lv_obj_send_event(first, LV_EVENT_CLICKED, UnsafePointer(0))?,
        LV_RESULT_OK
    );
    assert_eq!(runtime.raw()?.lv_pow(3, 2)?, 9);
    runtime.shutdown()
}

#[derive(Clone, Copy)]
enum Failure {
    Trap,
    Error,
    Panic,
}

#[test]
fn caught_nested_guest_failures_still_poison_the_outer_call_and_all_access() -> Result<()> {
    for failure in [Failure::Trap, Failure::Error, Failure::Panic] {
        let (mut runtime, first, second, _) = setup()?;
        subscribe(&mut runtime, first, LV_EVENT_CLICKED, 1)?;
        subscribe(&mut runtime, second, LV_EVENT_CLICKED, 2)?;
        let caught = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&caught);
        runtime.set_event_handler_with_context(move |context, event| {
            if event.callback_id == 2 {
                if matches!(failure, Failure::Panic) {
                    panic!("nested context panic");
                }
                return Err(Error::msg("nested context failure"));
            }
            let mut api = context.raw()?;
            let outcome = catch_unwind(AssertUnwindSafe(|| match failure {
                Failure::Trap => api.lv_color_to_int(UnsafePointer(u32::MAX)),
                _ => api.lv_obj_send_event(second, LV_EVENT_CLICKED, UnsafePointer(0)),
            }));
            match failure {
                Failure::Trap => assert_eq!(
                    outcome
                        .unwrap()
                        .unwrap_err()
                        .downcast_ref::<wasmtime::Trap>(),
                    Some(&wasmtime::Trap::MemoryOutOfBounds)
                ),
                Failure::Error => assert!(
                    format!("{:#}", outcome.unwrap().unwrap_err())
                        .contains("nested context failure")
                ),
                Failure::Panic => assert_eq!(
                    outcome.unwrap_err().downcast_ref::<&str>(),
                    Some(&"nested context panic")
                ),
            }
            observed.store(true, Ordering::SeqCst);
            assert!(
                api.lv_pow(2, 3)
                    .unwrap_err()
                    .to_string()
                    .contains("poisoned")
            );
            Ok(())
        })?;
        {
            let mut api = runtime.raw()?;
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                api.lv_obj_send_event(first, LV_EVENT_CLICKED, UnsafePointer(0))
            }));
            assert!(!matches!(outcome, Ok(Ok(_))));
            assert!(
                api.lv_pow(2, 3)
                    .unwrap_err()
                    .to_string()
                    .contains("poisoned")
            );
        }
        assert!(caught.load(Ordering::SeqCst));
        assert!(runtime.raw().is_err());
        let errors = [
            runtime
                .call_raw::<_, u32>("lvw_abi_version", ())
                .unwrap_err(),
            runtime.alloc(4).unwrap_err(),
            runtime.read_memory(0, &mut [0]).unwrap_err(),
            runtime.write_memory(0, &[0]).unwrap_err(),
            runtime
                .set_event_handler_with_context(|_, _| Ok(()))
                .unwrap_err(),
            runtime.shutdown().unwrap_err(),
        ];
        for error in errors {
            assert!(error.to_string().contains("poisoned"), "{error}");
        }
    }
    Ok(())
}

#[test]
fn shutdown_contexts_deliver_host_notifications_and_reject_guest_access() -> Result<()> {
    for raw_shutdown in [false, true] {
        let (mut runtime, first, second, _) = setup()?;
        let scratch = runtime.alloc(4)?;
        subscribe(&mut runtime, first, LV_EVENT_DELETE, 1)?;
        subscribe(&mut runtime, second, LV_EVENT_DELETE, 2)?;
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&events);
        runtime.set_event_handler_with_context(move |context, event| {
            assert_eq!(event.code, LV_EVENT_DELETE as u32);
            observed.lock().unwrap().push(event.object);
            let error = context.raw().err().expect("closing raw API accepted");
            assert!(error.to_string().contains("closing"));
            let errors = [
                context
                    .call_raw::<_, u32>("lvw_abi_version", ())
                    .unwrap_err(),
                context.alloc(4).unwrap_err(),
                context.free(scratch).unwrap_err(),
                context.read_memory(scratch, &mut [0]).unwrap_err(),
                context.write_memory(scratch, &[0]).unwrap_err(),
            ];
            for error in errors {
                assert!(error.to_string().contains("closing"), "{error}");
            }
            Ok(())
        })?;
        if raw_shutdown {
            assert_eq!(runtime.call_raw::<_, i32>("lvw_shutdown", ())?, 0);
        } else {
            runtime.shutdown()?;
        }
        let mut expected = [first.0, second.0];
        expected.sort();
        events.lock().unwrap().sort();
        assert_eq!(*events.lock().unwrap(), expected);
        assert!(runtime.raw().is_err());
        assert!(
            runtime
                .read_memory(scratch, &mut [0])
                .unwrap_err()
                .to_string()
                .contains("closed")
        );
    }
    Ok(())
}

#[test]
fn notification_and_context_handlers_replace_each_other() -> Result<()> {
    let (mut runtime, first, _, _) = setup()?;
    subscribe(&mut runtime, first, LV_EVENT_CLICKED, 1)?;
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&events);
    let mut count = 0;
    runtime.set_event_handler(move |_| {
        count += 1;
        observed.lock().unwrap().push(("notification", count));
        Ok(())
    })?;
    for _ in 0..2 {
        runtime
            .raw()?
            .lv_obj_send_event(first, LV_EVENT_CLICKED, UnsafePointer(0))?;
    }
    let observed = Arc::clone(&events);
    runtime.set_event_handler_with_context(move |context, _| {
        let value = context.raw()?.lv_pow(2, 3)?;
        observed.lock().unwrap().push(("context", value));
        Ok(())
    })?;
    runtime
        .raw()?
        .lv_obj_send_event(first, LV_EVENT_CLICKED, UnsafePointer(0))?;
    let observed = Arc::clone(&events);
    runtime.set_event_handler(move |event| {
        observed
            .lock()
            .unwrap()
            .push(("replacement", i64::from(event.callback_id)));
        Ok(())
    })?;
    runtime
        .raw()?
        .lv_obj_send_event(first, LV_EVENT_CLICKED, UnsafePointer(0))?;
    assert_eq!(
        *events.lock().unwrap(),
        [
            ("notification", 1),
            ("notification", 2),
            ("context", 8),
            ("replacement", 1)
        ]
    );
    runtime.shutdown()
}
