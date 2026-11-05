//! Private label adapter for an isolated LVGL core and consumer.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU64, Ordering};

use wasmtime::{
    AsContext, AsContextMut, Caller, Func, FuncType, Instance, Memory, Store, TypedFunc, Val,
    WasmParams, WasmResults,
};

use crate::numeric_environment::{HostState, panic_message};
use crate::numeric_label::{NumericFrame, NumericLabelOptions};

static NEXT_LABEL_TOKEN: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Eq, PartialEq)]
enum Kind {
    Screen,
    Label,
}
#[derive(Clone, Copy)]
struct Handle {
    kind: Kind,
    pointer: i32,
}

pub(crate) struct LabelState {
    consumer_memory: Memory,
    core_memory: Memory,
    display: i32,
    screen: Option<u32>,
    labels: u32,
    handles: HashMap<u32, Handle>,
    active: bool,
    options: NumericLabelOptions,
    screen_get: TypedFunc<i32, i32>,
    label_create: TypedFunc<i32, i32>,
    label_set_text: TypedFunc<(i32, i32), ()>,
    alloc: TypedFunc<i32, i32>,
    free: TypedFunc<i32, ()>,
    refresh: TypedFunc<i32, ()>,
    frame_get: TypedFunc<(i32, i32), i32>,
}

pub(crate) fn reserve_token() -> Result<u32, String> {
    NEXT_LABEL_TOKEN
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            (value <= u64::from(u32::MAX)).then_some(value + 1)
        })
        .map(|value| value as u32)
        .map_err(|_| "LVGL label tokens exhausted".into())
}

pub(crate) fn guest_call<P: WasmParams, R: WasmResults>(
    context: &mut impl AsContextMut<Data = HostState>,
    function: &TypedFunc<P, R>,
    params: P,
) -> Result<R, String> {
    if let Some(message) = &context.as_context().data().failure {
        return Err(message.clone());
    }
    let outcome = catch_unwind(AssertUnwindSafe(|| function.call(&mut *context, params)));
    if let Some(message) = context.as_context().data().failure.clone() {
        if let Err(panic) = outcome {
            return Err(format!("{message}; subsequent {}", panic_message(panic)));
        }
        return Err(message);
    }
    match outcome {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(context
            .as_context_mut()
            .data_mut()
            .poison(format!("guest call failed: {error:#}"))),
        Err(panic) => Err(context
            .as_context_mut()
            .data_mut()
            .poison(panic_message(panic))),
    }
}

pub(crate) fn label_active(caller: &Caller<'_, HostState>) -> bool {
    caller
        .data()
        .label
        .as_ref()
        .is_none_or(|label| label.active)
}

pub(crate) fn event_target(caller: &Caller<'_, HostState>, token: i32) -> Result<i32, String> {
    caller
        .data()
        .label
        .as_ref()
        .and_then(|label| label.handles.get(&(token as u32)))
        .filter(|handle| handle.kind == Kind::Label)
        .map(|handle| handle.pointer)
        .ok_or_else(|| "invalid LVGL event target".to_owned())
}

/// Bind the consumer's memory and create a display in its already initialized core. A null display is a recoverable status failure.
pub(crate) fn bind_label(
    store: &mut Store<HostState>,
    core: Instance,
    consumer_memory: Memory,
    options: &NumericLabelOptions,
) -> Result<Option<LabelState>, String> {
    let core_memory = core
        .get_memory(&mut *store, "memory")
        .ok_or_else(|| "LVGL core memory is unavailable".to_owned())?;
    let screen_get = core
        .get_typed_func::<i32, i32>(&mut *store, "lv_display_get_screen_active")
        .map_err(|error| error.to_string())?;
    let label_create = core
        .get_typed_func::<i32, i32>(&mut *store, "lv_label_create")
        .map_err(|error| error.to_string())?;
    let label_set_text = core
        .get_typed_func::<(i32, i32), ()>(&mut *store, "lv_label_set_text")
        .map_err(|error| error.to_string())?;
    let alloc = core
        .get_typed_func::<i32, i32>(&mut *store, "lvw_alloc")
        .map_err(|error| error.to_string())?;
    let free = core
        .get_typed_func::<i32, ()>(&mut *store, "lvw_free")
        .map_err(|error| error.to_string())?;
    let refresh = core
        .get_typed_func::<i32, ()>(&mut *store, "lv_refr_now")
        .map_err(|error| error.to_string())?;
    let frame_get = core
        .get_typed_func::<(i32, i32), i32>(&mut *store, "lvw_frame_get")
        .map_err(|error| error.to_string())?;
    let create_display = core
        .get_typed_func::<(i32, i32, i32), i32>(&mut *store, "lvw_display_create")
        .map_err(|error| error.to_string())?;
    let display = guest_call(
        store,
        &create_display,
        (options.width as i32, options.height as i32, 1),
    )?;
    if display == 0 {
        return Ok(None);
    }
    Ok(Some(LabelState {
        consumer_memory,
        core_memory,
        display,
        screen: None,
        labels: 0,
        handles: HashMap::new(),
        active: false,
        options: options.clone(),
        screen_get,
        label_create,
        label_set_text,
        alloc,
        free,
        refresh,
        frame_get,
    }))
}

/// Refresh and copy the selected display without exposing guest memory.
pub(crate) fn read_frame(store: &mut Store<HostState>) -> Result<NumericFrame, String> {
    let (memory, display, width, height, refresh, frame_get, alloc, free) = {
        let label = store
            .data_mut()
            .label
            .as_mut()
            .ok_or_else(|| "LVGL label adapter is unavailable".to_owned())?;
        if label.active {
            return Err("LVGL label adapter is reentrant".into());
        }
        label.active = true;
        (
            label.core_memory,
            label.display,
            label.options.width,
            label.options.height,
            label.refresh.clone(),
            label.frame_get.clone(),
            label.alloc.clone(),
            label.free.clone(),
        )
    };
    let result = (|| {
        guest_call(store, &refresh, display)?;
        let scratch = guest_call(store, &alloc, 48)? as u32;
        if scratch == 0 || !scratch.is_multiple_of(4) {
            return Err("invalid LVGL frame allocation".into());
        }
        let offset = scratch as usize;
        let mut metadata = [0u8; 48];
        metadata[..4].copy_from_slice(&48u32.to_le_bytes());
        metadata[4..8].copy_from_slice(&1u32.to_le_bytes());
        memory
            .write(&mut *store, offset, &metadata)
            .map_err(|_| "LVGL frame allocation is out of bounds".to_owned())?;
        if guest_call(store, &frame_get, (display, scratch as i32))? != 0 {
            return Err("LVGL frame is unavailable".into());
        }
        memory
            .read(&*store, offset, &mut metadata)
            .map_err(|_| "LVGL frame metadata is out of bounds".to_owned())?;
        let field = |index: usize| {
            u32::from_le_bytes(metadata[index..index + 4].try_into().expect("frame field"))
        };
        let pointer = field(8);
        let length = field(12);
        let stride = width
            .checked_mul(4)
            .ok_or_else(|| "invalid LVGL frame metadata".to_owned())?;
        let expected = stride
            .checked_mul(height)
            .filter(|length| *length <= 16 * 1024 * 1024)
            .ok_or_else(|| "invalid LVGL frame metadata".to_owned())?;
        if field(0) != 48
            || field(4) != 1
            || pointer == 0
            || length != expected
            || field(16) != width
            || field(20) != height
            || field(24) != stride
            || field(28) != 1
            || field(32) != 0
        {
            return Err("invalid LVGL frame metadata".into());
        }
        let start = pointer as usize;
        let end = start
            .checked_add(length as usize)
            .ok_or_else(|| "invalid LVGL frame metadata".to_owned())?;
        let source = memory
            .data(&*store)
            .get(start..end)
            .ok_or_else(|| "invalid LVGL frame metadata".to_owned())?;
        let mut rgba = Vec::new();
        rgba.try_reserve_exact(length as usize)
            .map_err(|_| "LVGL frame allocation failed".to_owned())?;
        for pixel in source.chunks_exact(4) {
            rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
        }
        let frame = NumericFrame {
            width,
            height,
            frame_id: field(44),
            rgba,
        };
        guest_call(store, &free, scratch as i32)?;
        Ok(frame)
    })();
    if let Some(label) = store.data_mut().label.as_mut() {
        label.active = false;
    }
    result
}

fn screen(caller: &mut Caller<'_, HostState>) -> Result<i32, String> {
    let (function, display) = {
        let label = caller
            .data()
            .label
            .as_ref()
            .ok_or_else(|| "LVGL label adapter is unavailable".to_owned())?;
        (label.screen_get.clone(), label.display)
    };
    let pointer = guest_call(caller, &function, display)?;
    if pointer == 0 {
        return Err("LVGL screen is unavailable".into());
    }
    let label = caller
        .data_mut()
        .label
        .as_mut()
        .ok_or_else(|| "LVGL label adapter is unavailable".to_owned())?;
    if let Some(token) = label.screen {
        let record = label
            .handles
            .get(&token)
            .ok_or_else(|| "invalid LVGL screen handle".to_owned())?;
        if record.kind != Kind::Screen || record.pointer != pointer {
            return Err("LVGL screen changed".into());
        }
        return Ok(token as i32);
    }
    label
        .handles
        .try_reserve(1)
        .map_err(|_| "LVGL handle allocation failed".to_owned())?;
    let token = reserve_token()?;
    label.handles.insert(
        token,
        Handle {
            kind: Kind::Screen,
            pointer,
        },
    );
    label.screen = Some(token);
    Ok(token as i32)
}

fn create(caller: &mut Caller<'_, HostState>, parent: i32) -> Result<i32, String> {
    let (function, pointer, token) = {
        let label = caller
            .data_mut()
            .label
            .as_mut()
            .ok_or_else(|| "LVGL label adapter is unavailable".to_owned())?;
        let record = label
            .handles
            .get(&(parent as u32))
            .filter(|record| record.kind == Kind::Screen)
            .ok_or_else(|| "invalid LVGL label parent".to_owned())?;
        let pointer = record.pointer;
        if label.labels >= label.options.max_labels {
            return Err("LVGL label quota exceeded".into());
        }
        label
            .handles
            .try_reserve(1)
            .map_err(|_| "LVGL handle allocation failed".to_owned())?;
        (label.label_create.clone(), pointer, reserve_token()?)
    };
    let created = guest_call(caller, &function, pointer)?;
    if created == 0 {
        return Ok(0);
    }
    let label = caller
        .data_mut()
        .label
        .as_mut()
        .ok_or_else(|| "LVGL label adapter is unavailable".to_owned())?;
    label.handles.insert(
        token,
        Handle {
            kind: Kind::Label,
            pointer: created,
        },
    );
    label.labels += 1;
    Ok(token as i32)
}

fn set_text(caller: &mut Caller<'_, HostState>, token: i32, address: i32) -> Result<(), String> {
    let (consumer_memory, core_memory, pointer, max_text_bytes, alloc, set_text, free) = {
        let label = caller
            .data()
            .label
            .as_ref()
            .ok_or_else(|| "LVGL label adapter is unavailable".to_owned())?;
        let pointer = label
            .handles
            .get(&(token as u32))
            .filter(|record| record.kind == Kind::Label)
            .ok_or_else(|| "invalid LVGL label handle".to_owned())?
            .pointer;
        (
            label.consumer_memory,
            label.core_memory,
            pointer,
            label.options.max_text_bytes as usize,
            label.alloc.clone(),
            label.label_set_text.clone(),
            label.free.clone(),
        )
    };
    let offset = address as u32 as usize;
    if offset == 0 {
        return guest_call(caller, &set_text, (pointer, 0));
    }
    let snapshot = {
        let data = consumer_memory.data(&*caller);
        let remainder = data
            .get(offset..)
            .filter(|slice| !slice.is_empty())
            .ok_or_else(|| "LVGL text pointer is out of bounds".to_owned())?;
        let scan = &remainder[..remainder.len().min(max_text_bytes + 1)];
        let size = scan
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| "LVGL text is unterminated or too long".to_owned())?
            + 1;
        let mut copy = Vec::new();
        copy.try_reserve_exact(size)
            .map_err(|_| "LVGL text snapshot allocation failed".to_owned())?;
        copy.extend_from_slice(&scan[..size]);
        copy
    };
    let scratch = guest_call(caller, &alloc, snapshot.len() as i32)?;
    if scratch == 0 {
        return Err("LVGL text allocation failed".into());
    }
    core_memory
        .write(&mut *caller, scratch as u32 as usize, &snapshot)
        .map_err(|_| "LVGL text allocation is out of bounds".to_owned())?;
    guest_call(caller, &set_text, (pointer, scratch))?;
    guest_call(caller, &free, scratch)
}

/// Create an app-only shim. Any error permanently poisons the enclosing environment.
pub(crate) fn label_function(
    store: &mut Store<HostState>,
    ty: FuncType,
    name: &str,
) -> Result<Func, String> {
    let name = name.to_owned();
    Func::try_new(
        store,
        ty,
        move |mut caller: Caller<'_, HostState>, values: &[Val], results: &mut [Val]| {
            if let Some(message) = &caller.data().failure {
                return Err(wasmtime::Error::msg(message.clone()));
            }
            let ready = caller
                .data()
                .label
                .as_ref()
                .is_some_and(|label| !label.active);
            if !ready {
                return Err(wasmtime::Error::msg(
                    caller
                        .data_mut()
                        .poison("LVGL label adapter unavailable or reentrant".into()),
                ));
            }
            caller
                .data_mut()
                .label
                .as_mut()
                .expect("active adapter")
                .active = true;
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                let arg = |index| match values.get(index) {
                    Some(Val::I32(value)) => Ok(*value),
                    _ => Err("invalid LVGL label argument".to_owned()),
                };
                match name.as_str() {
                    "lv_screen_active" => screen(&mut caller).map(Some),
                    "lv_label_create" => create(&mut caller, arg(0)?).map(Some),
                    "lv_label_set_text" => set_text(&mut caller, arg(0)?, arg(1)?).map(|()| None),
                    _ => Err("unsupported LVGL label import".into()),
                }
            }));
            if let Some(label) = caller.data_mut().label.as_mut() {
                label.active = false;
            }
            if let Some(message) = caller.data().failure.clone() {
                if let Err(panic) = outcome {
                    let _ = panic_message(panic);
                }
                return Err(wasmtime::Error::msg(message));
            }
            let output = match outcome {
                Ok(Ok(output)) => output,
                Ok(Err(message)) => {
                    return Err(wasmtime::Error::msg(caller.data_mut().poison(message)));
                }
                Err(panic) => {
                    return Err(wasmtime::Error::msg(
                        caller.data_mut().poison(panic_message(panic)),
                    ));
                }
            };
            match (results.len(), output) {
                (0, None) => (),
                (1, Some(value)) => results[0] = Val::I32(value),
                _ => {
                    return Err(wasmtime::Error::msg(
                        caller.data_mut().poison("invalid LVGL label result".into()),
                    ));
                }
            }
            Ok(())
        },
    )
    .map_err(|error| format!("LVGL label host creation failed: {error:#}"))
}
