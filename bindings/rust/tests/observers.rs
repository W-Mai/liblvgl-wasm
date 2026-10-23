use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use liblvgl_wasm_host::{
    API_EXPORTS, CallbackContext, Error, Observer, Result, Runtime, UnsafePointer, values,
};

const UNCHANGED_NOTIFIES: bool = values::LVGL_VERSION_MINOR < 3;

fn has(name: &str) -> bool {
    API_EXPORTS.iter().any(|entry| entry.0 == name)
}

fn native(name: &str) -> &'static str {
    API_EXPORTS.iter().find(|entry| entry.0 == name).unwrap().1
}

fn user_data(
    context: &mut CallbackContext<'_>,
    pointer: UnsafePointer,
    update: Option<u32>,
) -> Result<u32> {
    if has("lv_observer_get_user_data") {
        let previous = context.call_raw(native("lv_observer_get_user_data"), pointer.0)?;
        if let Some(value) = update {
            context.call_raw::<_, ()>(native("lv_observer_set_user_data"), (pointer.0, value))?;
        }
        return Ok(previous);
    }
    static OFFSET: OnceLock<u32> = OnceLock::new();
    let offset = *OFFSET.get_or_init(|| {
        let path =
            std::env::var_os("LVW_TEST_API").expect("legacy checks require matching metadata");
        let report: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let types = report["types"].as_object().unwrap();
        let alias = types
            .values()
            .find(|node| node["name"] == "lv_observer_t" && node["kind"] == "alias")
            .unwrap();
        let record = &types[alias["underlying"]["id"].as_str().unwrap()];
        assert_eq!(record["layout"]["status"], "complete");
        let field = record["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|field| field["name"] == "user_data")
            .unwrap();
        assert!(field["bit_width"].is_null());
        let offset = field["bit_offset"].as_u64().unwrap();
        assert_eq!(offset % 8, 0);
        (offset / 8) as u32
    });
    let mut bytes = [0; 4];
    context.read_memory(pointer.0 + offset, &mut bytes)?;
    if let Some(value) = update {
        context.write_memory(pointer.0 + offset, &value.to_le_bytes())?;
    }
    Ok(u32::from_le_bytes(bytes))
}

fn unbind(runtime: &mut Runtime, object: UnsafePointer, subject: UnsafePointer) -> Result<()> {
    if !has("lv_obj_remove_from_subject") {
        runtime.call_raw(native("lv_subject_remove_all_obj"), (subject.0, object.0))
    } else {
        runtime.call_raw(native("lv_obj_remove_from_subject"), (object.0, subject.0))
    }
}

fn subject(runtime: &mut Runtime, pointer: bool) -> Result<UnsafePointer> {
    if !has("lv_subject_create") {
        let mut raw = runtime.raw()?;
        let subject = raw.alloc(values::LV_SUBJECT_T_SIZE)?;
        assert_ne!(subject.0, 0);
        if pointer {
            raw.lv_subject_init_pointer(subject, UnsafePointer(0))?;
        } else {
            raw.lv_subject_init_int(subject, 0)?;
        }
        Ok(subject)
    } else {
        let kind = if pointer {
            values::LV_SUBJECT_TYPE_POINTER
        } else {
            values::LV_SUBJECT_TYPE_INT
        };
        let subject = runtime.call_raw(native("lv_subject_create"), kind)?;
        assert_ne!(subject, 0);
        Ok(UnsafePointer(subject))
    }
}

fn load() -> Result<Runtime> {
    Runtime::from_file(std::env::var_os("LVW_TEST_CORE").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"),
        std::path::PathBuf::from,
    ))
}

fn int_subject(runtime: &mut Runtime, value: i32) -> Result<UnsafePointer> {
    let subject = subject(runtime, false)?;
    runtime.raw()?.lv_subject_set_int(subject, value)?;
    Ok(subject)
}

fn display(runtime: &mut Runtime) -> Result<(u32, UnsafePointer)> {
    let display: u32 = runtime.call_raw("lvw_display_create", (80u32, 60u32, 1u32))?;
    let screen = runtime
        .raw()?
        .lv_display_get_screen_active(UnsafePointer(display))?;
    Ok((display, screen))
}

#[test]
fn initial_callbacks_preserve_native_values_and_allow_nested_observers() -> Result<()> {
    let mut runtime = load()?;
    let subject = int_subject(&mut runtime, 4)?;
    let other = int_subject(&mut runtime, 0)?;
    let (_, screen) = display(&mut runtime)?;
    let label = runtime.raw()?.lv_label_create(screen)?;
    let trace = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&trace);
    runtime.observe(other, UnsafePointer(0), move |context, _, current| {
        assert_eq!(current, other);
        observed
            .lock()
            .unwrap()
            .push(("other", context.raw()?.lv_subject_get_int(current)?));
        Ok(())
    })?;
    let calls = Arc::new(AtomicU32::new(0));
    let count = Arc::clone(&calls);
    let observed = Arc::clone(&trace);
    let observer = runtime.observe_target(
        subject,
        UnsafePointer(0xf123_4567),
        UnsafePointer(0xfedc_ba98),
        move |context, observer, current| {
            assert_eq!(current, subject);
            let count = count.fetch_add(1, Ordering::SeqCst);
            let pointer = observer.pointer()?;
            let writable = !has("lv_observer_get_user_data") || has("lv_observer_set_user_data");
            assert_eq!(
                user_data(context, pointer, writable.then_some(7))?,
                if count == 0 || !writable {
                    0xfedc_ba98
                } else {
                    7
                }
            );
            let value = {
                let mut raw = context.raw()?;
                assert_eq!(
                    raw.lv_observer_get_target(pointer)?,
                    UnsafePointer(0xf123_4567)
                );
                let value = raw.lv_subject_get_int(current)?;
                let text = format!("{value}\0");
                let buffer = raw.alloc(text.len() as u32)?;
                raw.write_memory(buffer, text.as_bytes())?;
                raw.lv_label_set_text(label, buffer)?;
                raw.free(buffer)?;
                value
            };
            observed.lock().unwrap().push(("target", value));
            if count == 0 {
                let nested = Arc::clone(&observed);
                let cancelled = context.observe(
                    current,
                    UnsafePointer(0),
                    move |context, observer, current| {
                        nested
                            .lock()
                            .unwrap()
                            .push(("initial", context.raw()?.lv_subject_get_int(current)?));
                        context.cancel_observer(observer)?;
                        context.cancel_observer(observer)?;
                        assert!(observer.pointer().is_err());
                        Ok(())
                    },
                )?;
                assert!(cancelled.pointer().is_err());
                context.raw()?.lv_subject_set_int(other, 17)?;
            }
            assert!(context.call_raw::<_, i32>("lvw_shutdown", ()).is_err());
            assert!(
                context
                    .call_raw::<_, i32>("lvw_step", (1u32, 0u32))
                    .is_err()
            );
            Ok(())
        },
    )?;
    assert_eq!(
        *trace.lock().unwrap(),
        [("other", 0), ("target", 4), ("initial", 4), ("other", 17)]
    );
    runtime.raw()?.lv_subject_set_int(subject, 4)?;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        if UNCHANGED_NOTIFIES { 2 } else { 1 }
    );
    runtime.raw()?.lv_subject_set_int(subject, 9)?;
    runtime.raw()?.lv_subject_notify(subject)?;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        if UNCHANGED_NOTIFIES { 4 } else { 3 }
    );
    let text = runtime.raw()?.lv_label_get_text(label)?;
    let mut bytes = [0; 2];
    runtime.read_memory(text.0, &mut bytes)?;
    assert_eq!(&bytes, b"9\0");

    let pointer_subject = self::subject(&mut runtime, true)?;
    let calls = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&calls);
    runtime.observe(
        pointer_subject,
        UnsafePointer(0),
        move |context, observer, subject| {
            observed.fetch_add(1, Ordering::SeqCst);
            assert_eq!(
                context.raw()?.lv_observer_get_target(observer.pointer()?)?,
                UnsafePointer(0)
            );
            assert_eq!(
                context.raw()?.lv_subject_get_pointer(subject)?,
                UnsafePointer(0)
            );
            Ok(())
        },
    )?;
    runtime
        .raw()?
        .lv_subject_set_pointer(pointer_subject, UnsafePointer(0))?;
    runtime
        .raw()?
        .lv_subject_set_pointer(pointer_subject, UnsafePointer(0))?;
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    runtime.cancel_observer(&observer)?;
    runtime.shutdown()
}

#[test]
fn native_deletion_and_callback_cancellation_release_shared_registration_lifetimes() -> Result<()> {
    let mut runtime = load()?;
    let mut foreign = load()?;
    let subject = int_subject(&mut runtime, 0)?;
    let calls = Arc::new([AtomicU32::new(0), AtomicU32::new(0)]);
    let target = Arc::new(Mutex::new(None::<Observer>));
    let to_cancel = Arc::clone(&target);
    let counts = Arc::clone(&calls);
    let actor = runtime.observe(
        subject,
        UnsafePointer(0),
        move |context, observer, subject| {
            counts[0].fetch_add(1, Ordering::SeqCst);
            if context.raw()?.lv_subject_get_int(subject)? != 0 {
                let victim = to_cancel.lock().unwrap().clone().unwrap();
                context.cancel_observer(&victim)?;
                context.cancel_observer(observer)?;
                assert!(observer.pointer().is_err());
            }
            Ok(())
        },
    )?;
    let capture = Arc::new(());
    let held = Arc::clone(&capture);
    let counts = Arc::clone(&calls);
    let victim = runtime.observe(subject, UnsafePointer(0), move |_, _, _| {
        let _keep_capture = &held;
        counts[1].fetch_add(1, Ordering::SeqCst);
        Ok(())
    })?;
    let alias = victim.clone();
    *target.lock().unwrap() = Some(victim.clone());
    assert!(foreign.cancel_observer(&victim).is_err());
    runtime.raw()?.lv_subject_set_int(subject, 1)?;
    assert_eq!(
        calls.each_ref().map(|count| count.load(Ordering::SeqCst)),
        [2, 1]
    );
    assert_eq!(Arc::strong_count(&capture), 1);
    for observer in [&actor, &victim, &alias] {
        assert!(observer.pointer().is_err());
        runtime.cancel_observer(observer)?;
        runtime.cancel_observer(observer)?;
        assert!(foreign.cancel_observer(observer).is_err());
    }

    let held = Arc::clone(&capture);
    let raw_deleted = runtime.observe(subject, UnsafePointer(0), move |_, _, _| {
        let _keep_capture = &held;
        Ok(())
    })?;
    let old_pointer = raw_deleted.pointer()?;
    runtime.call_raw::<_, ()>(
        native(if has("lv_observer_delete") {
            "lv_observer_delete"
        } else {
            "lv_observer_remove"
        }),
        old_pointer.0,
    )?;
    assert!(raw_deleted.pointer().is_err());
    assert_eq!(Arc::strong_count(&capture), 1);
    let mut reused = false;
    for _ in 0..8 {
        let successor = runtime.observe(subject, UnsafePointer(0), |_, _, _| Ok(()))?;
        reused |= successor.pointer()? == old_pointer;
        runtime.cancel_observer(&raw_deleted)?;
        successor.pointer()?;
        runtime.cancel_observer(&successor)?;
    }
    assert!(
        reused,
        "native allocator did not reuse the released observer"
    );

    let held = Arc::clone(&capture);
    let remaining = runtime.observe(subject, UnsafePointer(0), move |_, _, _| {
        let _keep_capture = &held;
        Ok(())
    })?;
    if !has("lv_subject_delete") {
        if has("lv_subject_deinit") {
            runtime.call_raw::<_, ()>(native("lv_subject_deinit"), subject.0)?;
        } else {
            runtime.cancel_observer(&remaining)?;
        }
        runtime.free(subject.0)?;
    } else {
        runtime.call_raw::<_, ()>(native("lv_subject_delete"), subject.0)?;
    }
    assert!(remaining.pointer().is_err());
    assert_eq!(Arc::strong_count(&capture), 1);
    let legacy = UnsafePointer(runtime.alloc(values::LV_SUBJECT_T_SIZE)?);
    runtime.raw()?.lv_subject_init_int(legacy, 3)?;
    let observer =
        runtime.observe_object(legacy, UnsafePointer(0), UnsafePointer(0), |_, _, _| Ok(()))?;
    if !has("lv_subject_deinit") {
        runtime.cancel_observer(&observer)?;
    } else {
        runtime.call_raw::<_, ()>(native("lv_subject_deinit"), legacy.0)?;
    }
    assert!(observer.pointer().is_err());
    runtime.free(legacy.0)?;
    runtime.shutdown()?;
    foreign.shutdown()
}

#[test]
fn object_bound_observers_preserve_widget_bindings_until_native_cleanup() -> Result<()> {
    let mut runtime = load()?;
    let subject = int_subject(&mut runtime, 10)?;
    let (display, screen) = display(&mut runtime)?;
    let slider = runtime.raw()?.lv_slider_create(screen)?;
    runtime.raw()?.lv_slider_bind_value(slider, subject)?;
    let capture = Arc::new(());
    let held = Arc::clone(&capture);
    let observer = runtime.observe_object(
        subject,
        slider,
        UnsafePointer(42),
        move |context, observer, current| {
            let _keep_capture = &held;
            assert_eq!(current, subject);
            assert_eq!(user_data(context, observer.pointer()?, None)?, 42);
            let mut raw = context.raw()?;
            assert_eq!(raw.lv_observer_get_target_obj(observer.pointer()?)?, slider);
            Ok(())
        },
    )?;
    assert!(
        runtime
            .cancel_observer(&observer)
            .unwrap_err()
            .to_string()
            .contains("(-3)")
    );
    observer.pointer()?;
    let mut raw = runtime.raw()?;
    raw.lv_subject_set_int(subject, 20)?;
    assert_eq!(raw.lv_slider_get_value(slider)?, 20);
    raw.lv_slider_set_value(slider, 30, values::LV_ANIM_OFF)?;
    raw.lv_obj_send_event(slider, values::LV_EVENT_VALUE_CHANGED, UnsafePointer(0))?;
    assert_eq!(raw.lv_subject_get_int(subject)?, 30);
    unbind(&mut runtime, slider, subject)?;
    assert!(observer.pointer().is_err());
    assert_eq!(Arc::strong_count(&capture), 1);
    runtime.cancel_observer(&observer)?;

    let parent = runtime.raw()?.lv_obj_create(screen)?;
    let child = runtime.raw()?.lv_button_create(parent)?;
    let observer = runtime.observe_object(subject, child, UnsafePointer(0), |_, _, _| Ok(()))?;
    runtime.raw()?.lv_obj_delete(parent)?;
    assert!(observer.pointer().is_err());
    let observer = runtime.observe_object(subject, slider, UnsafePointer(0), |_, _, _| Ok(()))?;
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_display_destroy", display)?,
        0
    );
    assert!(observer.pointer().is_err());
    let (_, screen) = self::display(&mut runtime)?;
    let object = runtime.raw()?.lv_button_create(screen)?;
    let observer = runtime.observe_object(subject, object, UnsafePointer(0), |_, _, _| Ok(()))?;
    if !has("lv_subject_delete") {
        if has("lv_subject_deinit") {
            runtime.call_raw::<_, ()>(native("lv_subject_deinit"), subject.0)?;
        } else {
            unbind(&mut runtime, object, subject)?;
        }
        runtime.free(subject.0)?;
    } else {
        runtime.call_raw::<_, ()>(native("lv_subject_delete"), subject.0)?;
    }
    assert!(observer.pointer().is_err());
    runtime.raw()?.lv_obj_delete(object)?;
    runtime.shutdown()
}

#[test]
fn unbinding_and_deinit_preserve_other_subjects_and_release_object_subscriptions() -> Result<()> {
    for cleanup in ["unbind", "deinit"] {
        if cleanup == "deinit" && !has("lv_subject_deinit") {
            continue;
        }
        let mut runtime = load()?;
        let first = int_subject(&mut runtime, 0)?;
        let second = int_subject(&mut runtime, 0)?;
        let (_, screen) = display(&mut runtime)?;
        let slider = runtime.raw()?.lv_slider_create(screen)?;
        for subject in [first, second] {
            runtime.raw()?.lv_slider_bind_value(slider, subject)?;
        }
        let removed = runtime.observe_object(first, slider, UnsafePointer(0), |_, _, _| Ok(()))?;
        let capture = Arc::new(());
        let held = Arc::clone(&capture);
        let retained =
            runtime.observe_object(second, slider, UnsafePointer(0), move |_, _, _| {
                let _keep_capture = &held;
                Ok(())
            })?;
        runtime.set_event_handler_with_context(move |context, event| {
            assert_eq!(event.callback_id, 902);
            if cleanup == "deinit" {
                context.call_raw::<_, ()>(native("lv_subject_deinit"), first.0)?;
            } else if has("lv_obj_remove_from_subject") {
                context
                    .call_raw::<_, ()>(native("lv_obj_remove_from_subject"), (slider.0, first.0))?;
            } else {
                context
                    .call_raw::<_, ()>(native("lv_subject_remove_all_obj"), (first.0, slider.0))?;
            }
            Ok(())
        })?;
        assert_eq!(
            runtime.call_raw::<_, i32>(
                "lvw_event_add",
                (slider.0, values::LV_EVENT_CLICKED, 902u32)
            )?,
            0
        );
        runtime
            .raw()?
            .lv_obj_send_event(slider, values::LV_EVENT_CLICKED, UnsafePointer(0))?;
        assert_eq!(
            runtime.call_raw::<_, i32>("lvw_event_remove", (slider.0, 902u32))?,
            0
        );
        assert!(removed.pointer().is_err());
        retained.pointer()?;
        runtime
            .raw()?
            .lv_slider_set_value(slider, 7, values::LV_ANIM_OFF)?;
        runtime.raw()?.lv_obj_send_event(
            slider,
            values::LV_EVENT_VALUE_CHANGED,
            UnsafePointer(0),
        )?;
        assert_eq!(runtime.raw()?.lv_subject_get_int(first)?, 0);
        assert_eq!(runtime.raw()?.lv_subject_get_int(second)?, 7);
        if has("lv_obj_remove_from_subject") {
            runtime.call_raw::<_, ()>(native("lv_obj_remove_from_subject"), (slider.0, 0u32))?;
            assert!(retained.pointer().is_err());
            runtime
                .raw()?
                .lv_slider_set_value(slider, 9, values::LV_ANIM_OFF)?;
            runtime.raw()?.lv_obj_send_event(
                slider,
                values::LV_EVENT_VALUE_CHANGED,
                UnsafePointer(0),
            )?;
            assert_eq!(runtime.raw()?.lv_subject_get_int(second)?, 7);
        }
        runtime.raw()?.lv_obj_delete(slider)?;
        assert!(retained.pointer().is_err());
        assert_eq!(Arc::strong_count(&capture), 1);
        runtime.raw()?.lv_subject_set_int(second, 8)?;
        runtime.shutdown()?;
    }
    Ok(())
}

#[test]
fn initial_object_deletion_does_not_revive_a_released_observer() -> Result<()> {
    let mut runtime = load()?;
    let subject = int_subject(&mut runtime, 0)?;
    let (_, screen) = display(&mut runtime)?;
    let object = runtime.raw()?.lv_button_create(screen)?;
    let observer =
        runtime.observe_object(subject, object, UnsafePointer(0), move |context, _, _| {
            context.raw()?.lv_obj_delete(object)
        })?;
    assert!(observer.pointer().is_err());
    runtime.cancel_observer(&observer)?;
    runtime.raw()?.lv_subject_set_int(subject, 1)?;
    if !has("lv_subject_create") {
        for name in ["lv_subject_create", "lv_subject_delete"] {
            assert!(!API_EXPORTS.iter().any(|entry| entry.0 == name));
        }
        if values::LVGL_VERSION_MINOR < 2 {
            assert!(!has("lv_subject_deinit"));
            assert!(!has("lv_observer_get_user_data"));
        } else if values::LVGL_VERSION_MINOR <= 5 {
            assert!(has("lv_subject_deinit"));
            assert!(has("lv_observer_get_user_data"));
            assert!(!has("lv_observer_set_user_data"));
        }
        if has("lv_subject_deinit") {
            runtime.call_raw::<_, ()>(native("lv_subject_deinit"), subject.0)?;
        }
        runtime.free(subject.0)?;
    }
    runtime.shutdown()
}

#[test]
fn shutdown_and_store_drop_release_observers_without_running_value_handlers() -> Result<()> {
    let mut runtime = load()?;
    let legacy = UnsafePointer(runtime.alloc(values::LV_SUBJECT_T_SIZE)?);
    runtime.raw()?.lv_subject_init_int(legacy, 0)?;
    let capture = Arc::new(());
    let held = Arc::clone(&capture);
    let calls = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&calls);
    let observer = runtime.observe(legacy, UnsafePointer(0), move |_, _, _| {
        let _keep_capture = &held;
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })?;
    let (_, screen) = display(&mut runtime)?;
    let object = runtime.raw()?.lv_button_create(screen)?;
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_event_add", (object.0, values::LV_EVENT_DELETE, 901u32))?,
        0
    );
    let alias = observer.clone();
    let held = Arc::downgrade(&capture);
    let notices = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&notices);
    runtime.set_event_handler_with_context(move |context, event| {
        assert_eq!(event.callback_id, 901);
        observed.fetch_add(1, Ordering::SeqCst);
        assert!(alias.pointer().is_err());
        context.cancel_observer(&alias)?;
        context.cancel_observer(&alias)?;
        assert_eq!(held.strong_count(), 1);
        assert!(context.raw().is_err());
        Ok(())
    })?;
    runtime.shutdown()?;
    assert_eq!(notices.load(Ordering::SeqCst), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(observer.pointer().is_err());
    assert_eq!(Arc::strong_count(&capture), 1);
    runtime.cancel_observer(&observer)?;
    let held = Arc::clone(&capture);
    let dropped = {
        let mut owner = load()?;
        let subject = int_subject(&mut owner, 0)?;
        owner.observe(subject, UnsafePointer(0), move |_, _, _| {
            let _keep_capture = &held;
            Ok(())
        })?
    };
    assert!(dropped.pointer().is_err());
    assert_eq!(Arc::strong_count(&capture), 1);
    Ok(())
}

#[derive(Clone, Copy)]
enum Failure {
    Error,
    Panic,
    CaughtTrap,
}

#[test]
fn observer_failures_in_creation_and_notification_permanently_poison_the_runtime() -> Result<()> {
    for failure in [Failure::Error, Failure::Panic, Failure::CaughtTrap] {
        let mut runtime = load()?;
        let subject = int_subject(&mut runtime, 0)?;
        let capture = Arc::new(());
        let held = Arc::clone(&capture);
        let keeper = runtime.observe(subject, UnsafePointer(0), move |_, _, _| {
            let _keep_capture = &held;
            Ok(())
        })?;
        let held = Arc::clone(&capture);
        let saved = Arc::new(Mutex::new(None::<Observer>));
        let saved_callback = Arc::clone(&saved);
        let armed = Arc::new(AtomicBool::new(matches!(failure, Failure::Error)));
        let enabled = Arc::clone(&armed);
        let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<()> {
            runtime.observe(subject, UnsafePointer(0), move |context, observer, _| {
                let _keep_capture = &held;
                *saved_callback.lock().unwrap() = Some(observer.clone());
                if !enabled.load(Ordering::SeqCst) {
                    return Ok(());
                }
                match failure {
                    Failure::Error => Err(Error::msg("observer callback failure")),
                    Failure::Panic => panic!("observer callback panic"),
                    Failure::CaughtTrap => {
                        let error = context
                            .raw()?
                            .lv_color_to_int(UnsafePointer(u32::MAX))
                            .unwrap_err();
                        assert_eq!(
                            error.downcast_ref::<wasmtime::Trap>(),
                            Some(&wasmtime::Trap::MemoryOutOfBounds)
                        );
                        Ok(())
                    }
                }
            })?;
            armed.store(true, Ordering::SeqCst);
            runtime.raw()?.lv_subject_set_int(subject, 1)
        }));
        match failure {
            Failure::Error => assert!(
                format!("{:#}", outcome.unwrap().unwrap_err())
                    .contains("observer callback failure")
            ),
            Failure::Panic => assert_eq!(
                outcome.unwrap_err().downcast_ref::<&str>(),
                Some(&"observer callback panic")
            ),
            Failure::CaughtTrap => assert!(outcome.unwrap().is_err()),
        }
        assert_eq!(Arc::strong_count(&capture), 1);
        assert!(keeper.pointer().is_err());
        let observer = saved.lock().unwrap().clone().unwrap();
        assert!(observer.pointer().is_err());
        runtime.cancel_observer(&observer)?;
        runtime.cancel_observer(&keeper)?;
        assert!(
            runtime
                .call_raw::<_, u32>("lvw_abi_version", ())
                .unwrap_err()
                .to_string()
                .contains("poisoned")
        );
        assert!(
            runtime
                .observe(subject, UnsafePointer(0), |_, _, _| Ok(()))
                .err()
                .unwrap()
                .to_string()
                .contains("poisoned")
        );
        assert!(runtime.shutdown().is_err());
    }
    Ok(())
}
