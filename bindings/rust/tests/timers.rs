use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use liblvgl_wasm_host::{Error, Result, Runtime, Timer, UnsafePointer};

fn load() -> Result<Runtime> {
    Runtime::from_file(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"))
}

fn step(runtime: &mut Runtime, milliseconds: u32) -> Result<()> {
    // lvw_step_result_t starts with its byte size and bridge ABI version.
    let pointer = runtime.alloc(16)?;
    let mut bytes = [0; 16];
    bytes[..4].copy_from_slice(&16u32.to_le_bytes());
    bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
    runtime.write_memory(pointer, &bytes)?;
    let status = runtime.call_raw::<_, i32>("lvw_step", (milliseconds, pointer))?;
    runtime.free(pointer)?;
    assert_eq!(status, 0);
    Ok(())
}

#[test]
fn timers_use_instance_clocks_and_update_ui_and_user_data_synchronously() -> Result<()> {
    let mut first = load()?;
    let mut second = load()?;
    let display: u32 = first.call_raw("lvw_display_create", (80u32, 60u32, 1u32))?;
    let mut raw = first.raw()?;
    let screen = raw.lv_display_get_screen_active(UnsafePointer(display))?;
    let label = raw.lv_label_create(screen)?;
    let user_data = first.alloc(4)?;
    let first_calls = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&first_calls);
    let timer = first.create_timer(10, UnsafePointer(user_data), move |context, current| {
        let count = observed.fetch_add(1, Ordering::SeqCst);
        let pointer = current.pointer()?;
        {
            let mut api = context.raw()?;
            assert_eq!(
                api.lv_timer_get_user_data(pointer)?,
                UnsafePointer(user_data + u32::from(count != 0))
            );
            api.lv_timer_set_user_data(pointer, UnsafePointer(user_data + 1))?;
            let text = api.alloc(5)?;
            api.write_memory(text, b"tick\0")?;
            api.lv_label_set_text(label, text)?;
            api.free(text)?;
        }
        assert!(
            context
                .call_raw::<_, i32>("lvw_step", (1u32, 0u32))
                .is_err()
        );
        assert!(context.call_raw::<_, i32>("lvw_shutdown", ()).is_err());
        Ok(())
    })?;
    let second_calls = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&second_calls);
    second.create_timer(10, UnsafePointer(0), move |_, _| {
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })?;
    step(&mut first, 5)?;
    assert_eq!(first_calls.load(Ordering::SeqCst), 0);
    step(&mut second, 10)?;
    assert_eq!(second_calls.load(Ordering::SeqCst), 1);
    assert_eq!(first_calls.load(Ordering::SeqCst), 0);
    step(&mut first, 5)?;
    step(&mut first, 10)?;
    assert_eq!(first_calls.load(Ordering::SeqCst), 2);
    assert_eq!(second_calls.load(Ordering::SeqCst), 1);
    let mut raw = first.raw()?;
    let text = raw.lv_label_get_text(label)?;
    let mut bytes = [0; 5];
    raw.read_memory(text, &mut bytes)?;
    assert_eq!(&bytes, b"tick\0");
    assert!(second.cancel_timer(&timer).is_err());
    first.cancel_timer(&timer)?;
    first.cancel_timer(&timer)?;
    first.free(user_data)?;
    first.shutdown()?;
    second.shutdown()
}

#[test]
fn native_repeat_and_delete_release_handlers_and_preserve_paused_timers() -> Result<()> {
    let mut runtime = load()?;
    let counts = Arc::new([AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)]);
    let mut timers = Vec::new();
    let mut captures = Vec::new();
    for index in 0..3 {
        let capture = Arc::new(());
        let held = Arc::clone(&capture);
        let observed = Arc::clone(&counts);
        timers.push(runtime.create_timer(10, UnsafePointer(0), move |_, _| {
            let _keep_capture = &held;
            observed[index].fetch_add(1, Ordering::SeqCst);
            Ok(())
        })?);
        captures.push(capture);
    }
    let alias = timers[0].clone();
    {
        let mut raw = runtime.raw()?;
        raw.lv_timer_set_repeat_count(timers[0].pointer()?, 1)?;
        raw.lv_timer_set_repeat_count(timers[1].pointer()?, 0)?;
        raw.lv_timer_set_repeat_count(timers[2].pointer()?, 1)?;
        raw.lv_timer_set_auto_delete(timers[2].pointer()?, 0)?;
    }
    step(&mut runtime, 10)?;
    assert_eq!(
        counts.each_ref().map(|count| count.load(Ordering::SeqCst)),
        [1, 0, 1]
    );
    assert!(timers[0].pointer().is_err());
    assert!(alias.pointer().is_err());
    assert!(timers[1].pointer().is_err());
    assert_eq!(Arc::strong_count(&captures[0]), 1);
    assert_eq!(Arc::strong_count(&captures[1]), 1);
    assert_eq!(Arc::strong_count(&captures[2]), 2);
    assert_eq!(runtime.raw()?.lv_timer_get_paused(timers[2].pointer()?)?, 1);
    step(&mut runtime, 100)?;
    assert_eq!(counts[2].load(Ordering::SeqCst), 1);
    {
        let mut raw = runtime.raw()?;
        raw.lv_timer_set_repeat_count(timers[2].pointer()?, 1)?;
        raw.lv_timer_resume(timers[2].pointer()?)?;
    }
    step(&mut runtime, 10)?;
    assert_eq!(counts[2].load(Ordering::SeqCst), 2);
    runtime.raw()?.lv_timer_delete(timers[2].pointer()?)?;
    assert_eq!(Arc::strong_count(&captures[2]), 1);
    for timer in &timers {
        assert!(timer.pointer().is_err());
        runtime.cancel_timer(timer)?;
        runtime.cancel_timer(timer)?;
    }
    let held = Arc::new(());
    let captured = Arc::clone(&held);
    let remaining = runtime.create_timer(10, UnsafePointer(0), move |_, _| {
        let _keep_capture = &captured;
        Ok(())
    })?;
    let display: u32 = runtime.call_raw("lvw_display_create", (80u32, 60u32, 1u32))?;
    let mut raw = runtime.raw()?;
    let screen = raw.lv_display_get_screen_active(UnsafePointer(display))?;
    let object = raw.lv_button_create(screen)?;
    assert_eq!(
        runtime.call_raw::<_, i32>(
            "lvw_event_add",
            (object.0, liblvgl_wasm_host::values::LV_EVENT_DELETE, 900u32)
        )?,
        0
    );
    let closing_notifications = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&closing_notifications);
    let remaining_alias = remaining.clone();
    let captured = Arc::downgrade(&held);
    runtime.set_event_handler_with_context(move |context, event| {
        assert_eq!(event.callback_id, 900);
        observed.fetch_add(1, Ordering::SeqCst);
        assert!(remaining_alias.pointer().is_err());
        context.cancel_timer(&remaining_alias)?;
        context.cancel_timer(&remaining_alias)?;
        assert_eq!(captured.strong_count(), 1);
        Ok(())
    })?;
    runtime.shutdown()?;
    assert_eq!(closing_notifications.load(Ordering::SeqCst), 1);
    assert!(remaining.pointer().is_err());
    assert_eq!(Arc::strong_count(&held), 1);
    runtime.cancel_timer(&remaining)?;
    let captured = Arc::clone(&held);
    let dropped = {
        let mut owner = load()?;
        owner.create_timer(10, UnsafePointer(0), move |_, _| {
            let _keep_capture = &captured;
            Ok(())
        })?
    };
    assert!(dropped.pointer().is_err());
    assert_eq!(Arc::strong_count(&held), 1);
    Ok(())
}

#[test]
fn callbacks_can_cancel_timers_and_create_a_successor_in_the_same_context() -> Result<()> {
    let mut runtime = load()?;
    let calls = Arc::new([AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)]);
    let observed = Arc::clone(&calls);
    let victim = runtime.create_timer(50, UnsafePointer(0), move |_, _| {
        observed[1].fetch_add(1, Ordering::SeqCst);
        Ok(())
    })?;
    let victim_alias = victim.clone();
    let successor = Arc::new(Mutex::new(None::<Timer>));
    let created = Arc::clone(&successor);
    let observed = Arc::clone(&calls);
    let current = runtime.create_timer(10, UnsafePointer(0), move |context, timer| {
        observed[0].fetch_add(1, Ordering::SeqCst);
        context.cancel_timer(&victim_alias)?;
        context.cancel_timer(timer)?;
        assert!(timer.pointer().is_err());
        let successor_calls = Arc::clone(&observed);
        let child = context.create_timer(20, UnsafePointer(0), move |_, _| {
            successor_calls[2].fetch_add(1, Ordering::SeqCst);
            Ok(())
        })?;
        context
            .raw()?
            .lv_timer_set_repeat_count(child.pointer()?, 1)?;
        *created.lock().unwrap() = Some(child);
        Ok(())
    })?;
    step(&mut runtime, 10)?;
    assert!(current.pointer().is_err());
    assert!(victim.pointer().is_err());
    assert_eq!(
        calls.each_ref().map(|count| count.load(Ordering::SeqCst)),
        [1, 0, 0]
    );
    step(&mut runtime, 20)?;
    assert!(
        successor
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .pointer()
            .is_err()
    );
    step(&mut runtime, 100)?;
    assert_eq!(
        calls.each_ref().map(|count| count.load(Ordering::SeqCst)),
        [1, 0, 1]
    );
    runtime.shutdown()
}

#[derive(Clone, Copy)]
enum Failure {
    Error,
    Panic,
    CaughtTrap,
}

#[test]
fn timer_errors_panics_and_caught_traps_poison_the_instance_and_release_handlers() -> Result<()> {
    for failure in [Failure::Error, Failure::Panic, Failure::CaughtTrap] {
        let mut runtime = load()?;
        let held = Arc::new(());
        let captured = Arc::clone(&held);
        let timer = runtime.create_timer(10, UnsafePointer(0), move |context, _| {
            let _keep_capture = &captured;
            match failure {
                Failure::Error => Err(Error::msg("timer callback failure")),
                Failure::Panic => panic!("timer callback panic"),
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
        let outcome = catch_unwind(AssertUnwindSafe(|| step(&mut runtime, 10)));
        match failure {
            Failure::Panic => assert_eq!(
                outcome.unwrap_err().downcast_ref::<&str>(),
                Some(&"timer callback panic")
            ),
            Failure::Error => {
                assert!(
                    format!("{:#}", outcome.unwrap().unwrap_err())
                        .contains("timer callback failure")
                );
            }
            Failure::CaughtTrap => assert!(outcome.unwrap().is_err()),
        }
        assert_eq!(Arc::strong_count(&held), 1);
        assert!(timer.pointer().is_err());
        assert!(
            runtime
                .call_raw::<_, u32>("lvw_abi_version", ())
                .unwrap_err()
                .to_string()
                .contains("poisoned")
        );
        assert!(
            runtime
                .create_timer(10, UnsafePointer(0), |_, _| Ok(()))
                .err()
                .expect("poisoned timer creation succeeded")
                .to_string()
                .contains("poisoned")
        );
        runtime.cancel_timer(&timer)?;
        assert!(runtime.shutdown().is_err());
    }
    Ok(())
}
