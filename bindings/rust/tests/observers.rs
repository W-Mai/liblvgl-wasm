use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use liblvgl_wasm_host::{Error, Observer, Result, Runtime, UnsafePointer, values};

fn load() -> Result<Runtime> {
    Runtime::from_file(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"))
}

fn int_subject(runtime: &mut Runtime, value: i32) -> Result<UnsafePointer> {
    let mut raw = runtime.raw()?;
    let subject = raw.lv_subject_create(values::LV_SUBJECT_TYPE_INT)?;
    assert_ne!(subject.0, 0);
    raw.lv_subject_set_int(subject, value)?;
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
            let value = {
                let mut raw = context.raw()?;
                assert_eq!(
                    raw.lv_observer_get_target(pointer)?,
                    UnsafePointer(0xf123_4567)
                );
                assert_eq!(
                    raw.lv_observer_get_user_data(pointer)?,
                    UnsafePointer(if count == 0 { 0xfedc_ba98 } else { 7 })
                );
                raw.lv_observer_set_user_data(pointer, UnsafePointer(7))?;
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
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    runtime.raw()?.lv_subject_set_int(subject, 9)?;
    runtime.raw()?.lv_subject_notify(subject)?;
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    let text = runtime.raw()?.lv_label_get_text(label)?;
    let mut bytes = [0; 2];
    runtime.read_memory(text.0, &mut bytes)?;
    assert_eq!(&bytes, b"9\0");

    let pointer_subject = runtime
        .raw()?
        .lv_subject_create(values::LV_SUBJECT_TYPE_POINTER)?;
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
    let native = runtime.observe(subject, UnsafePointer(0), move |_, _, _| {
        let _keep_capture = &held;
        Ok(())
    })?;
    let old_pointer = native.pointer()?;
    runtime.raw()?.lv_observer_delete(old_pointer)?;
    assert!(native.pointer().is_err());
    assert_eq!(Arc::strong_count(&capture), 1);
    let mut reused = false;
    for _ in 0..8 {
        let successor = runtime.observe(subject, UnsafePointer(0), |_, _, _| Ok(()))?;
        reused |= successor.pointer()? == old_pointer;
        runtime.cancel_observer(&native)?;
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
    runtime.raw()?.lv_subject_delete(subject)?;
    assert!(remaining.pointer().is_err());
    assert_eq!(Arc::strong_count(&capture), 1);
    let legacy = UnsafePointer(runtime.alloc(values::LV_SUBJECT_T_SIZE)?);
    runtime.raw()?.lv_subject_init_int(legacy, 3)?;
    let observer =
        runtime.observe_object(legacy, UnsafePointer(0), UnsafePointer(0), |_, _, _| Ok(()))?;
    runtime.raw()?.lv_subject_deinit(legacy)?;
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
            let mut raw = context.raw()?;
            assert_eq!(raw.lv_observer_get_target_obj(observer.pointer()?)?, slider);
            assert_eq!(
                raw.lv_observer_get_user_data(observer.pointer()?)?,
                UnsafePointer(42)
            );
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
    raw.lv_obj_remove_from_subject(slider, subject)?;
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
    runtime.raw()?.lv_subject_delete(subject)?;
    assert!(observer.pointer().is_err());
    runtime.raw()?.lv_obj_delete(object)?;
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
