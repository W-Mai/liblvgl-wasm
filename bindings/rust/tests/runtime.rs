use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use liblvgl_wasm_host::{Error, Result, Runtime, UnsafePointer};

fn load() -> Result<Runtime> {
    Runtime::from_file(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"))
}

#[test]
fn instances_own_their_memory_and_reject_access_after_shutdown() -> Result<()> {
    let mut first = load()?;
    let mut second = load()?;
    let a = first.alloc(4)?;
    let b = second.alloc(4)?;
    first.write_memory(a, &[1, 2, 3, 4])?;
    second.write_memory(b, &[5, 6, 7, 8])?;
    let mut bytes = [0; 4];
    first.read_memory(a, &mut bytes)?;
    assert_eq!(bytes, [1, 2, 3, 4]);
    second.read_memory(b, &mut bytes)?;
    assert_eq!(bytes, [5, 6, 7, 8]);

    // Lookup and checked memory errors do not enter the guest.
    assert!(first.call_raw::<_, ()>("missing_export", ()).is_err());
    assert!(first.call_raw::<_, ()>("lvw_abi_version", ()).is_err());
    assert!(first.write_memory(u32::MAX, &[1, 2]).is_err());
    assert_eq!(first.call_raw::<_, u32>("lvw_abi_version", ())?, 1);

    first.free(a)?;
    first.shutdown()?;
    assert_unavailable(&mut first, a, "closed");
    second.read_memory(b, &mut bytes)?;
    assert_eq!(bytes, [5, 6, 7, 8]);
    second.free(b)?;
    second.shutdown()?;
    Ok(())
}

fn assert_unavailable(runtime: &mut Runtime, pointer: u32, reason: &str) {
    let mut byte = [0];
    let errors = [
        runtime.call_raw::<_, ()>("lv_refr_now", 0u32).unwrap_err(),
        runtime.alloc(4).unwrap_err(),
        runtime.free(pointer).unwrap_err(),
        runtime.read_memory(pointer, &mut byte).unwrap_err(),
        runtime.write_memory(pointer, &[0]).unwrap_err(),
        runtime.set_event_handler(|_| Ok(())).unwrap_err(),
        runtime.shutdown().unwrap_err(),
    ];
    for error in errors {
        assert!(error.to_string().contains(reason), "{error}");
    }
}

#[test]
fn failed_or_panicking_synchronous_callbacks_poison_the_instance() -> Result<()> {
    for panics in [false, true] {
        let mut runtime = load()?;
        let display: u32 = runtime.call_raw("lvw_display_create", (80u32, 60u32, 1u32))?;
        assert_ne!(display, 0);
        let screen: u32 = runtime.call_raw("lv_display_get_screen_active", display)?;
        let object: u32 = runtime.call_raw("lv_button_create", screen)?;
        let code: u32 = runtime.call_raw("lvw_event_clicked", ())?;
        let count = Arc::new(AtomicU32::new(0));
        let observed = Arc::clone(&count);
        runtime.set_event_handler(move |event| {
            assert_eq!(event.callback_id, 7);
            assert_eq!(event.object, object);
            assert_eq!(event.code, code);
            observed.fetch_add(1, Ordering::SeqCst);
            if panics {
                panic!("callback panic");
            }
            Err(Error::msg("callback failure"))
        })?;
        assert_eq!(
            runtime.call_raw::<_, i32>("lvw_event_add", (object, code, 7u32))?,
            0
        );
        {
            let mut raw = runtime.raw()?;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                raw.lv_obj_send_event(UnsafePointer(object), code as i32, UnsafePointer(0))
            }));
            if panics {
                assert!(result.is_err());
            } else {
                let error = result.unwrap().unwrap_err();
                assert!(format!("{error:#}").contains("callback failure"));
            }
            assert!(raw.lv_pow(2, 3).is_err());
        }
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_unavailable(&mut runtime, object, "poisoned");
    }
    Ok(())
}
