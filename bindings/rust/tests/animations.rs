use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use liblvgl_wasm_host::{
    API_EXPORTS, Animation, AnimationCallbacks, CallbackContext, Error, Result, Runtime,
    UnsafePointer, values,
};

fn native(name: &str) -> &'static str {
    API_EXPORTS.iter().find(|entry| entry.0 == name).unwrap().1
}

fn load() -> Result<Runtime> {
    let mut runtime = Runtime::from_file(std::env::var_os("LVW_TEST_CORE").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"),
        std::path::PathBuf::from,
    ))?;
    let mut raw = runtime.raw()?;
    let timer = raw.lv_anim_get_timer()?;
    raw.lv_timer_set_period(timer, 1)?;
    Ok(runtime)
}

fn descriptor(runtime: &mut Runtime, var: UnsafePointer, early: bool) -> Result<UnsafePointer> {
    let mut raw = runtime.raw()?;
    let descriptor = raw.alloc(values::LV_ANIM_T_SIZE)?;
    raw.lv_anim_init(descriptor)?;
    raw.lv_anim_set_var(descriptor, var)?;
    raw.lv_anim_set_values(descriptor, 10, 20)?;
    raw.lv_anim_set_duration(descriptor, 100)?;
    raw.lv_anim_set_early_apply(descriptor, i32::from(early))?;
    Ok(descriptor)
}

fn step(runtime: &mut Runtime, milliseconds: u32) -> Result<()> {
    let pointer = runtime.alloc(16)?;
    let mut bytes = [0; 16];
    bytes[..4].copy_from_slice(&16u32.to_le_bytes());
    bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
    runtime.write_memory(pointer, &bytes)?;
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_step", (milliseconds, pointer))?,
        0
    );
    runtime.free(pointer)
}

fn slot_offset() -> u32 {
    let field = values::LV_ANIM_T_FIELDS
        .iter()
        .find(|field| field.name == Some("exec_cb"))
        .unwrap();
    assert!(field.bit_width.is_none());
    assert_eq!(field.bit_offset % 8, 0);
    (field.bit_offset / 8) as u32
}

fn slot(runtime: &Runtime, animation: &Animation) -> Result<u32> {
    let mut bytes = [0; 4];
    runtime.read_memory(animation.pointer()?.0 + slot_offset(), &mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn protected(context: &mut CallbackContext<'_>, animation: &Animation) -> Result<()> {
    assert!(
        context
            .cancel_animation(animation)
            .unwrap_err()
            .to_string()
            .contains("(-3)")
    );
    assert!(context.raw()?.lv_anim_refr_now().is_err());
    assert!(context.raw()?.lv_anim_delete_all().is_err());
    assert!(context.call_raw::<_, i32>("lvw_shutdown", ()).is_err());
    assert!(
        context
            .call_raw::<_, i32>("lvw_step", (1u32, 0u32))
            .is_err()
    );
    Ok(())
}

#[test]
fn queries_and_notifications_follow_native_early_and_delayed_lifetimes() -> Result<()> {
    let mut runtime = load()?;
    let descriptor = descriptor(&mut runtime, UnsafePointer(0x8000_0011), true)?;
    runtime
        .raw()?
        .lv_anim_set_user_data(descriptor, UnsafePointer(0xf123_4567))?;
    let trace = Arc::new(Mutex::new(Vec::<(&str, i32)>::new()));
    let value = Arc::new(AtomicI32::new(-17));
    let early = Arc::new(AtomicBool::new(true));
    let observed = Arc::clone(&trace);
    let early_exec = Arc::clone(&early);
    let mut callbacks = AnimationCallbacks::new(move |context, current, value| {
        assert_ne!(current.pointer()?, descriptor);
        assert_eq!(
            context.raw()?.lv_anim_get_user_data(current.pointer()?)?,
            UnsafePointer(0xf123_4567)
        );
        if early_exec.load(Ordering::SeqCst) {
            protected(context, current)?;
        }
        observed.lock().unwrap().push(("exec", value));
        Ok(())
    });
    let observed = Arc::clone(&trace);
    callbacks = callbacks.get_value(move |context, current| {
        protected(context, current)?;
        observed.lock().unwrap().push(("get", 1000));
        Ok(1000)
    });
    let observed = Arc::clone(&trace);
    let result = Arc::clone(&value);
    callbacks = callbacks.path(move |context, current| {
        protected(context, current)?;
        let native = context.raw()?.lv_anim_path_linear(current.pointer()?)?;
        assert!((1010..=1020).contains(&native));
        let value = result.load(Ordering::SeqCst);
        observed.lock().unwrap().push(("path", value));
        Ok(value)
    });
    let observed = Arc::clone(&trace);
    callbacks = callbacks.start(move |context, current| {
        protected(context, current)?;
        observed.lock().unwrap().push(("start", 0));
        Ok(())
    });
    let observed = Arc::clone(&trace);
    callbacks = callbacks.completed(move |context, current| {
        current.pointer()?;
        context.cancel_animation(current)?;
        observed.lock().unwrap().push(("completed", 0));
        Ok(())
    });
    let observed = Arc::clone(&trace);
    callbacks = callbacks.deleted(move |context, current| {
        current.pointer()?;
        context.cancel_animation(current)?;
        observed.lock().unwrap().push(("deleted", 0));
        Ok(())
    });
    let animation = runtime.start_animation(descriptor, callbacks)?;
    let first = if values::LVGL_VERSION_MINOR < 3 {
        1010
    } else {
        -17
    };
    let initial = if values::LVGL_VERSION_MINOR < 3 {
        vec![("get", 1000), ("exec", first)]
    } else {
        vec![("get", 1000), ("path", -17), ("exec", first)]
    };
    assert_eq!(*trace.lock().unwrap(), initial);
    runtime.free(descriptor.0)?;
    early.store(false, Ordering::SeqCst);
    value.store(23, Ordering::SeqCst);
    step(&mut runtime, 40)?;
    step(&mut runtime, 60)?;
    assert!(animation.pointer().is_err());
    let events = trace.lock().unwrap().clone();
    assert_eq!(
        events
            .iter()
            .filter(|entry| entry.0 == "exec")
            .copied()
            .collect::<Vec<_>>(),
        [("exec", first), ("exec", 23)]
    );
    assert_eq!(
        &events[events.len() - 2..],
        &[("completed", 0), ("deleted", 0)]
    );
    runtime.cancel_animation(&animation)?;

    let descriptor = self::descriptor(&mut runtime, UnsafePointer(2), false)?;
    {
        let mut raw = runtime.raw()?;
        raw.lv_anim_set_delay(descriptor, 30)?;
        raw.lv_anim_set_duration(descriptor, 20)?;
    }
    let observed = Arc::clone(&trace);
    trace.lock().unwrap().clear();
    let delayed = runtime.start_animation(
        descriptor,
        AnimationCallbacks::new(move |_, _, value| {
            observed.lock().unwrap().push(("delayed", value));
            Ok(())
        }),
    )?;
    runtime.free(descriptor.0)?;
    assert!(trace.lock().unwrap().is_empty());
    step(&mut runtime, 10)?;
    assert!(trace.lock().unwrap().is_empty());
    step(&mut runtime, 20)?;
    assert_eq!(*trace.lock().unwrap(), [("delayed", 10)]);
    step(&mut runtime, 20)?;
    assert!(delayed.pointer().is_err());
    runtime.shutdown()
}

#[test]
fn precise_cancellation_native_repeat_and_object_deletion_release_captures() -> Result<()> {
    let mut runtime = load()?;
    let display: u32 = runtime.call_raw("lvw_display_create", (80u32, 60u32, 1u32))?;
    let screen = runtime
        .raw()?
        .lv_display_get_screen_active(UnsafePointer(display))?;
    let object = runtime.raw()?.lv_obj_create(screen)?;
    let counts = Arc::new([AtomicU32::new(0), AtomicU32::new(0)]);
    let captures = [Arc::new(()), Arc::new(())];
    let mut animations = Vec::new();
    for index in 0..2 {
        let descriptor = descriptor(&mut runtime, object, false)?;
        let observed = Arc::clone(&counts);
        let captured = Arc::clone(&captures[index]);
        animations.push(runtime.start_animation(
            descriptor,
            AnimationCallbacks::new(move |_, _, _| {
                let _capture = &captured;
                observed[index].fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        )?);
        runtime.free(descriptor.0)?;
    }
    assert_ne!(
        slot(&runtime, &animations[0])?,
        slot(&runtime, &animations[1])?
    );
    runtime.cancel_animation(&animations[0])?;
    runtime.cancel_animation(&animations[0])?;
    assert_eq!(Arc::strong_count(&captures[0]), 1);
    assert!(animations[1].pointer().is_ok());
    step(&mut runtime, 10)?;
    assert_eq!(counts[0].load(Ordering::SeqCst), 0);
    assert_eq!(counts[1].load(Ordering::SeqCst), 1);
    let pointer = animations[1].pointer()?;
    let can_pause = API_EXPORTS.iter().any(|entry| entry.0 == "lv_anim_pause");
    if can_pause {
        runtime.call_raw::<_, ()>(native("lv_anim_pause"), (pointer.0,))?;
        step(&mut runtime, 200)?;
        assert_eq!(
            runtime.call_raw::<_, i32>(native("lv_anim_is_paused"), (pointer.0,))?,
            1
        );
        assert_eq!(counts[1].load(Ordering::SeqCst), 1);
    }
    {
        let mut raw = runtime.raw()?;
        raw.lv_anim_set_duration(pointer, 20)?;
        raw.lv_anim_set_repeat_count(pointer, 2)?;
        raw.lv_anim_set_repeat_delay(pointer, 5)?;
    }
    let reverse = if API_EXPORTS
        .iter()
        .any(|entry| entry.0 == "lv_anim_set_reverse_duration")
    {
        "reverse"
    } else {
        "playback"
    };
    runtime.call_raw::<_, ()>(
        native(&format!("lv_anim_set_{reverse}_duration")),
        (pointer.0, 20u32),
    )?;
    runtime.call_raw::<_, ()>(
        native(&format!("lv_anim_set_{reverse}_delay")),
        (pointer.0, 5u32),
    )?;
    if can_pause {
        runtime.call_raw::<_, ()>(native("lv_anim_resume"), (pointer.0,))?;
    }
    for _ in 0..12 {
        step(&mut runtime, 10)?;
    }
    assert!(animations[1].pointer().is_err());
    assert!(counts[1].load(Ordering::SeqCst) > 3);
    assert_eq!(Arc::strong_count(&captures[1]), 1);
    let descriptor = descriptor(&mut runtime, object, false)?;
    let captured = Arc::clone(&captures[0]);
    let deleted = runtime.start_animation(
        descriptor,
        AnimationCallbacks::new(move |_, _, _| {
            let _capture = &captured;
            Ok(())
        }),
    )?;
    runtime.free(descriptor.0)?;
    runtime.raw()?.lv_obj_delete(object)?;
    assert!(deleted.pointer().is_err());
    assert_eq!(Arc::strong_count(&captures[0]), 1);
    runtime.shutdown()
}

#[test]
fn tick_exec_can_cancel_and_replace_without_reusing_slots_on_the_callback_stack() -> Result<()> {
    let mut runtime = load()?;
    let victim_descriptor = descriptor(&mut runtime, UnsafePointer(3), false)?;
    let victim =
        runtime.start_animation(victim_descriptor, AnimationCallbacks::new(|_, _, _| Ok(())))?;
    runtime.free(victim_descriptor.0)?;
    let victim_slot = slot(&runtime, &victim)?;
    let actor_descriptor = descriptor(&mut runtime, UnsafePointer(3), false)?;
    let actor_slot = Arc::new(AtomicU32::new(0));
    let expected_actor_slot = Arc::clone(&actor_slot);
    let successor = Arc::new(Mutex::new(None::<Animation>));
    let saved = Arc::clone(&successor);
    let victim_alias = victim.clone();
    let actor = runtime.start_animation(
        actor_descriptor,
        AnimationCallbacks::new(move |context, current, _| {
            context.cancel_animation(&victim_alias)?;
            context.cancel_animation(current)?;
            assert!(current.pointer().is_err());
            let mut raw = context.raw()?;
            let descriptor = raw.alloc(values::LV_ANIM_T_SIZE)?;
            raw.lv_anim_init(descriptor)?;
            raw.lv_anim_set_early_apply(descriptor, 0)?;
            let child =
                context.start_animation(descriptor, AnimationCallbacks::new(|_, _, _| Ok(())))?;
            context.free(descriptor.0)?;
            let mut bytes = [0; 4];
            context.read_memory(child.pointer()?.0 + slot_offset(), &mut bytes)?;
            let child_slot = u32::from_le_bytes(bytes);
            assert_ne!(child_slot, victim_slot);
            assert_ne!(child_slot, expected_actor_slot.load(Ordering::SeqCst));
            *saved.lock().unwrap() = Some(child);
            Ok(())
        }),
    )?;
    actor_slot.store(slot(&runtime, &actor)?, Ordering::SeqCst);
    runtime.free(actor_descriptor.0)?;
    step(&mut runtime, 10)?;
    assert!(actor.pointer().is_err());
    assert!(victim.pointer().is_err());
    let child = successor.lock().unwrap().take().unwrap();
    let child_slot = slot(&runtime, &child)?;
    runtime.cancel_animation(&child)?;
    let descriptor = descriptor(&mut runtime, UnsafePointer(3), false)?;
    let replacement =
        runtime.start_animation(descriptor, AnimationCallbacks::new(|_, _, _| Ok(())))?;
    runtime.free(descriptor.0)?;
    assert_eq!(slot(&runtime, &replacement)?, child_slot);
    runtime.cancel_animation(&actor)?;
    assert!(replacement.pointer().is_ok());
    runtime.raw()?.lv_anim_delete_all()?;
    assert!(replacement.pointer().is_err());
    runtime.shutdown()
}

#[test]
fn animation_failures_poison_and_runtime_shutdown_and_drop_release_handlers() -> Result<()> {
    for failure in 0..3 {
        let mut runtime = load()?;
        let descriptor = descriptor(&mut runtime, UnsafePointer(4), true)?;
        let captured = Arc::new(());
        let held = Arc::clone(&captured);
        let animation = Arc::new(Mutex::new(None::<Animation>));
        let saved = Arc::clone(&animation);
        let callbacks = AnimationCallbacks::new(|_, _, _| Ok(())).path(move |context, current| {
            let _capture = &held;
            *saved.lock().unwrap() = Some(current.clone());
            match failure {
                0 => Err(Error::msg("animation query failure")),
                1 => panic!("animation query panic"),
                _ => {
                    let error = context
                        .raw()?
                        .lv_color_to_int(UnsafePointer(u32::MAX))
                        .unwrap_err();
                    assert_eq!(
                        error.downcast_ref::<wasmtime::Trap>(),
                        Some(&wasmtime::Trap::MemoryOutOfBounds)
                    );
                    Ok(1)
                }
            }
        });
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            runtime.start_animation(descriptor, callbacks)?;
            step(&mut runtime, 1)
        }));
        if failure == 1 {
            assert!(outcome.is_err());
        } else {
            assert!(outcome.unwrap().is_err());
        }
        assert_eq!(Arc::strong_count(&captured), 1);
        assert!(
            animation
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .pointer()
                .is_err()
        );
        assert!(
            runtime
                .call_raw::<_, u32>("lvw_abi_version", ())
                .unwrap_err()
                .to_string()
                .contains("poisoned")
        );
    }

    let mut runtime = load()?;
    let mut other = load()?;
    let victim_descriptor = descriptor(&mut runtime, UnsafePointer(7), false)?;
    let victim_capture = Arc::new(());
    let held = Arc::clone(&victim_capture);
    let victim_notifications = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&victim_notifications);
    let victim = runtime.start_animation(
        victim_descriptor,
        AnimationCallbacks::new(|_, _, _| Ok(())).deleted(move |_, _| {
            let _capture = &held;
            observed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }),
    )?;
    runtime.free(victim_descriptor.0)?;
    assert_eq!(Arc::strong_count(&victim_capture), 2);
    let victim_alias = victim.clone();
    let released = Arc::downgrade(&victim_capture);
    let descriptor = descriptor(&mut runtime, UnsafePointer(5), false)?;
    let captured = Arc::new(());
    let held = Arc::clone(&captured);
    let notifications = Arc::new(AtomicU32::new(0));
    let observed = Arc::clone(&notifications);
    let animation = runtime.start_animation(
        descriptor,
        AnimationCallbacks::new(move |_, _, _| {
            let _capture = &held;
            Ok(())
        })
        .deleted(move |context, current| {
            assert!(current.pointer().is_err());
            assert!(context.raw().is_err());
            context.cancel_animation(current)?;
            context.cancel_animation(&victim_alias)?;
            context.cancel_animation(&victim_alias)?;
            assert!(victim_alias.pointer().is_err());
            assert_eq!(released.strong_count(), 1);
            observed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }),
    )?;
    runtime.free(descriptor.0)?;
    assert!(other.cancel_animation(&animation).is_err());
    runtime.shutdown()?;
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
    assert_eq!(victim_notifications.load(Ordering::SeqCst), 0);
    assert_eq!(Arc::strong_count(&victim_capture), 1);
    assert!(victim.pointer().is_err());
    runtime.cancel_animation(&victim)?;
    assert_eq!(Arc::strong_count(&captured), 1);
    assert!(animation.pointer().is_err());
    runtime.cancel_animation(&animation)?;
    let descriptor = self::descriptor(&mut other, UnsafePointer(6), false)?;
    let held = Arc::clone(&captured);
    let dropped = other.start_animation(
        descriptor,
        AnimationCallbacks::new(move |_, _, _| {
            let _capture = &held;
            Ok(())
        }),
    )?;
    other.free(descriptor.0)?;
    drop(other);
    assert!(dropped.pointer().is_err());
    assert_eq!(Arc::strong_count(&captured), 1);
    Ok(())
}
