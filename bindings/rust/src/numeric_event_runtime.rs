//! Private clicked-event adapter for an isolated LVGL core and consumer.

use std::panic::{AssertUnwindSafe, catch_unwind};

use wasmtime::{Caller, Func, FuncType, Instance, Store, TypedFunc, Val};

use crate::numeric_environment::{HostState, panic_message};
use crate::numeric_event::NumericEventOptions;
use crate::numeric_label_runtime::{event_target, guest_call, label_active, reserve_token};

#[derive(Clone, Copy, Eq, PartialEq)]
struct Registration {
    descriptor: u32,
    id: u32,
    target: u32,
    pointer: i32,
    callback: u32,
    user: u32,
    removing: bool,
}

#[derive(Clone, Copy)]
struct Frame {
    token: u32,
    registration: Registration,
    code: u32,
}

pub(crate) struct EventState {
    options: NumericEventOptions,
    clicked: u32,
    next_id: u64,
    registrations: Vec<Registration>,
    pending_registrations: usize,
    checking_dispatch: bool,
    sends: Vec<i32>,
    frames: Vec<Frame>,
    dispatch: TypedFunc<(i32, i32), ()>,
    current: TypedFunc<(), i32>,
    target: TypedFunc<i32, i32>,
    add: TypedFunc<(i32, i32, i32), i32>,
    remove: TypedFunc<(i32, i32), i32>,
    send: TypedFunc<(i32, i32, i32), i32>,
}

/// Bind the selected core and consumer. A zero clicked code is a recoverable status failure.
pub(crate) fn bind_event(
    store: &mut Store<HostState>,
    core: Instance,
    consumer: Instance,
    options: &NumericEventOptions,
) -> Result<Option<EventState>, String> {
    let clicked = core
        .get_typed_func::<(), i32>(&mut *store, "lvw_event_clicked")
        .map_err(|error| error.to_string())?;
    let current = core
        .get_typed_func::<(), i32>(&mut *store, "lvw_event_current")
        .map_err(|error| error.to_string())?;
    let target = core
        .get_typed_func::<i32, i32>(&mut *store, "lv_event_get_target_obj")
        .map_err(|error| error.to_string())?;
    let add = core
        .get_typed_func::<(i32, i32, i32), i32>(&mut *store, "lvw_event_add")
        .map_err(|error| error.to_string())?;
    let remove = core
        .get_typed_func::<(i32, i32), i32>(&mut *store, "lvw_event_remove")
        .map_err(|error| error.to_string())?;
    let send = core
        .get_typed_func::<(i32, i32, i32), i32>(&mut *store, "lv_obj_send_event")
        .map_err(|error| error.to_string())?;
    let dispatch = consumer
        .get_typed_func::<(i32, i32), ()>(&mut *store, "app_event_dispatch")
        .map_err(|error| error.to_string())?;
    let clicked = guest_call(store, &clicked, ())? as u32;
    if clicked == 0 {
        return Ok(None);
    }
    Ok(Some(EventState {
        options: options.clone(),
        clicked,
        next_id: 1,
        registrations: Vec::new(),
        pending_registrations: 0,
        checking_dispatch: false,
        sends: Vec::new(),
        frames: Vec::new(),
        dispatch,
        current,
        target,
        add,
        remove,
        send,
    }))
}

fn state<'a>(caller: &'a Caller<'_, HostState>) -> Result<&'a EventState, String> {
    caller
        .data()
        .event
        .as_ref()
        .ok_or_else(|| "LVGL event adapter is unavailable".into())
}

fn add(
    caller: &mut Caller<'_, HostState>,
    target: i32,
    callback: i32,
    code: i32,
    user: i32,
) -> Result<i32, String> {
    let pointer = event_target(caller, target)?;
    let (function, registration) = {
        let event = caller
            .data_mut()
            .event
            .as_mut()
            .ok_or_else(|| "LVGL event adapter is unavailable".to_owned())?;
        if code as u32 != event.clicked {
            return Err("unsupported LVGL event code".into());
        }
        if callback == 0 {
            return Ok(0);
        }
        if event.registrations.len() + event.pending_registrations
            >= event.options.max_registrations as usize
        {
            return Err("LVGL event quota exceeded".into());
        }
        if event.next_id > u64::from(u32::MAX) {
            return Err("LVGL callback IDs exhausted".into());
        }
        event
            .registrations
            .try_reserve(event.pending_registrations + 1)
            .map_err(|_| "LVGL event registration allocation failed".to_owned())?;
        let descriptor = reserve_token()?;
        let id = event.next_id as u32;
        event.next_id += 1;
        event.pending_registrations += 1;
        (
            event.add.clone(),
            Registration {
                descriptor,
                id,
                target: target as u32,
                pointer,
                callback: callback as u32,
                user: user as u32,
                removing: false,
            },
        )
    };
    let outcome = guest_call(caller, &function, (pointer, code, registration.id as i32));
    let event = caller
        .data_mut()
        .event
        .as_mut()
        .ok_or_else(|| "LVGL event adapter is unavailable".to_owned())?;
    event.pending_registrations = event
        .pending_registrations
        .checked_sub(1)
        .ok_or_else(|| "LVGL event registration reservation is invalid".to_owned())?;
    let status = outcome?;
    if status == -3 {
        return Ok(0);
    }
    if status != 0 {
        return Err(format!("LVGL event registration failed ({status})"));
    }
    #[cfg(test)]
    crate::numeric_environment::observe_event("add");
    caller
        .data_mut()
        .event
        .as_mut()
        .ok_or_else(|| "LVGL event adapter is unavailable".to_owned())?
        .registrations
        .push(registration);
    Ok(registration.descriptor as i32)
}

fn remove(caller: &mut Caller<'_, HostState>, target: i32, descriptor: i32) -> Result<i32, String> {
    let pointer = event_target(caller, target)?;
    let (function, registration) = {
        let event = caller
            .data_mut()
            .event
            .as_mut()
            .ok_or_else(|| "LVGL event adapter is unavailable".to_owned())?;
        let registration = event
            .registrations
            .iter_mut()
            .find(|item| {
                item.descriptor == descriptor as u32
                    && item.target == target as u32
                    && item.pointer == pointer
            })
            .ok_or_else(|| "invalid LVGL event descriptor".to_owned())?;
        if registration.removing {
            return Err("LVGL event removal is already in progress".into());
        }
        registration.removing = true;
        (event.remove.clone(), *registration)
    };
    let status = guest_call(caller, &function, (pointer, registration.id as i32))?;
    if status != 0 {
        return Err(format!("LVGL event removal failed ({status})"));
    }
    #[cfg(test)]
    crate::numeric_environment::observe_event("remove");
    let event = caller
        .data_mut()
        .event
        .as_mut()
        .ok_or_else(|| "LVGL event adapter is unavailable".to_owned())?;
    let index = event
        .registrations
        .iter()
        .position(|item| item.id == registration.id)
        .ok_or_else(|| "LVGL event registration changed".to_owned())?;
    event.registrations.remove(index);
    Ok(1)
}

fn send(
    caller: &mut Caller<'_, HostState>,
    target: i32,
    code: i32,
    parameter: i32,
) -> Result<i32, String> {
    let pointer = event_target(caller, target)?;
    let function = {
        let event = caller
            .data_mut()
            .event
            .as_mut()
            .ok_or_else(|| "LVGL event adapter is unavailable".to_owned())?;
        if code as u32 != event.clicked || parameter != 0 {
            return Err("unsupported LVGL event dispatch".into());
        }
        if event.sends.len() > event.options.max_depth as usize {
            return Err("LVGL event nesting limit exceeded".into());
        }
        event
            .sends
            .try_reserve(1)
            .map_err(|_| "LVGL event send allocation failed".to_owned())?;
        event.sends.push(pointer);
        event.send.clone()
    };
    let result = guest_call(caller, &function, (pointer, code, 0));
    let event = caller
        .data_mut()
        .event
        .as_mut()
        .ok_or_else(|| "LVGL event adapter is unavailable".to_owned())?;
    if event.sends.pop() != Some(pointer) {
        return Err("LVGL event send stack corrupted".into());
    }
    result
}

fn frame(caller: &Caller<'_, HostState>, token: i32) -> Result<Frame, String> {
    state(caller)?
        .frames
        .last()
        .copied()
        .filter(|frame| frame.token == token as u32)
        .ok_or_else(|| "invalid LVGL event token".into())
}

fn dispatch(
    caller: &mut Caller<'_, HostState>,
    id: i32,
    current: i32,
    code: i32,
) -> Result<(), String> {
    let (registration, current_function, target_function, callback) = {
        let event = state(caller)?;
        if event.checking_dispatch {
            return Err("LVGL event validation is reentrant".into());
        }
        let registration = event
            .registrations
            .iter()
            .find(|item| item.id == id as u32 && !item.removing)
            .copied()
            .ok_or_else(|| "invalid LVGL event dispatch".to_owned())?;
        if event.sends.last().copied() != Some(registration.pointer)
            || registration.pointer != current
            || event.clicked != code as u32
        {
            return Err("invalid LVGL event dispatch".into());
        }
        if event.frames.len() >= event.options.max_depth as usize {
            return Err("LVGL event nesting limit exceeded".into());
        }
        (
            registration,
            event.current.clone(),
            event.target.clone(),
            event.dispatch.clone(),
        )
    };
    caller
        .data_mut()
        .event
        .as_mut()
        .ok_or_else(|| "LVGL event adapter is unavailable".to_owned())?
        .checking_dispatch = true;
    let validation = (|| {
        let native = guest_call(caller, &current_function, ())?;
        if native == 0 || guest_call(caller, &target_function, native)? != registration.pointer {
            return Err("invalid LVGL event target".to_owned());
        }
        Ok(())
    })();
    let event = caller
        .data_mut()
        .event
        .as_mut()
        .ok_or_else(|| "LVGL event adapter is unavailable".to_owned())?;
    if !event.checking_dispatch {
        return Err("LVGL event validation state changed".into());
    }
    event.checking_dispatch = false;
    validation?;
    if !event.registrations.contains(&registration)
        || registration.removing
        || event.sends.last().copied() != Some(registration.pointer)
        || event.clicked != code as u32
    {
        return Err("invalid LVGL event dispatch".into());
    }
    if event.frames.len() >= event.options.max_depth as usize {
        return Err("LVGL event nesting limit exceeded".into());
    }
    let token = reserve_token()?;
    {
        let event = caller
            .data_mut()
            .event
            .as_mut()
            .ok_or_else(|| "LVGL event adapter is unavailable".to_owned())?;
        event
            .frames
            .try_reserve(1)
            .map_err(|_| "LVGL event frame allocation failed".to_owned())?;
        event.frames.push(Frame {
            token,
            registration,
            code: code as u32,
        });
    }
    let result = guest_call(
        caller,
        &callback,
        (registration.callback as i32, token as i32),
    );
    let event = caller
        .data_mut()
        .event
        .as_mut()
        .ok_or_else(|| "LVGL event adapter is unavailable".to_owned())?;
    if event.frames.pop().map(|frame| frame.token) != Some(token) {
        return Err("LVGL event stack corrupted".into());
    }
    result
}

/// Create one app-only event import. Any error permanently poisons the environment.
pub(crate) fn event_function(
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
            if label_active(&caller) {
                return Err(wasmtime::Error::msg(
                    caller
                        .data_mut()
                        .poison("LVGL label adapter unavailable or reentrant".into()),
                ));
            }
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                let arg = |index| match values.get(index) {
                    Some(Val::I32(value)) => Ok(*value),
                    _ => Err("invalid LVGL event argument".to_owned()),
                };
                match name.as_str() {
                    "lv_obj_add_event_cb" => add(&mut caller, arg(0)?, arg(1)?, arg(2)?, arg(3)?),
                    "lv_obj_remove_event_dsc" => remove(&mut caller, arg(0)?, arg(1)?),
                    "lv_obj_send_event" => send(&mut caller, arg(0)?, arg(1)?, arg(2)?),
                    "lv_event_get_code" => Ok(frame(&caller, arg(0)?)?.code as i32),
                    "lv_event_get_user_data" => {
                        Ok(frame(&caller, arg(0)?)?.registration.user as i32)
                    }
                    "lv_event_get_target_obj" => {
                        Ok(frame(&caller, arg(0)?)?.registration.target as i32)
                    }
                    _ => Err("unsupported LVGL event import".into()),
                }
            }));
            if let Some(message) = caller.data().failure.clone() {
                if let Err(panic) = outcome {
                    let _ = panic_message(panic);
                }
                return Err(wasmtime::Error::msg(message));
            }
            let result = match outcome {
                Ok(Ok(result)) => result,
                Ok(Err(message)) => {
                    return Err(wasmtime::Error::msg(caller.data_mut().poison(message)));
                }
                Err(panic) => {
                    return Err(wasmtime::Error::msg(
                        caller.data_mut().poison(panic_message(panic)),
                    ));
                }
            };
            if results.len() != 1 {
                return Err(wasmtime::Error::msg(
                    caller.data_mut().poison("invalid LVGL event result".into()),
                ));
            }
            results[0] = Val::I32(result);
            Ok(())
        },
    )
    .map_err(|error| format!("LVGL event host creation failed: {error:#}"))
}

/// Create the selected core's lvw.event callback trampoline.
pub(crate) fn event_bridge(store: &mut Store<HostState>, ty: FuncType) -> Result<Func, String> {
    Func::try_new(
        store,
        ty,
        move |mut caller: Caller<'_, HostState>, values: &[Val], results: &mut [Val]| {
            if let Some(message) = &caller.data().failure {
                return Err(wasmtime::Error::msg(message.clone()));
            }
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                if label_active(&caller) {
                    return Err("LVGL label adapter unavailable or reentrant".to_owned());
                }
                let arg = |index| match values.get(index) {
                    Some(Val::I32(value)) => Ok(*value),
                    _ => Err("invalid LVGL event callback argument".to_owned()),
                };
                if !results.is_empty() {
                    return Err("invalid LVGL event callback result".into());
                }
                dispatch(&mut caller, arg(0)?, arg(1)?, arg(2)?)
            }));
            if let Some(message) = caller.data().failure.clone() {
                if let Err(panic) = outcome {
                    let _ = panic_message(panic);
                }
                return Err(wasmtime::Error::msg(message));
            }
            match outcome {
                Ok(Ok(())) => Ok(()),
                Ok(Err(message)) => Err(wasmtime::Error::msg(caller.data_mut().poison(message))),
                Err(panic) => Err(wasmtime::Error::msg(
                    caller.data_mut().poison(panic_message(panic)),
                )),
            }
        },
    )
    .map_err(|error| format!("LVGL event callback creation failed: {error:#}"))
}

/// Remove live native registrations while the core is healthy and initialized.
pub(crate) fn close_event(store: &mut Store<HostState>) -> Result<(), String> {
    loop {
        if let Some(message) = &store.data().failure {
            return Err(message.clone());
        }
        let next = {
            let Some(event) = store.data_mut().event.as_mut() else {
                return Ok(());
            };
            if !event.frames.is_empty()
                || !event.sends.is_empty()
                || event.pending_registrations != 0
                || event.checking_dispatch
            {
                return Err(store
                    .data_mut()
                    .poison("LVGL event adapter is active".into()));
            }
            let function = event.remove.clone();
            match event.registrations.last_mut() {
                Some(registration) if registration.removing => {
                    return Err(store
                        .data_mut()
                        .poison("LVGL event removal is already in progress".into()));
                }
                Some(registration) => {
                    registration.removing = true;
                    Some((function, *registration))
                }
                None => None,
            }
        };
        let Some((function, registration)) = next else {
            return Ok(());
        };
        let status = guest_call(
            store,
            &function,
            (registration.pointer, registration.id as i32),
        )?;
        if status != 0 {
            return Err(store
                .data_mut()
                .poison(format!("LVGL event removal failed ({status})")));
        }
        #[cfg(test)]
        crate::numeric_environment::observe_event("remove");
        let event = store
            .data_mut()
            .event
            .as_mut()
            .ok_or_else(|| "LVGL event adapter is unavailable".to_owned())?;
        if event.registrations.pop().map(|item| item.id) != Some(registration.id) {
            return Err(store
                .data_mut()
                .poison("LVGL event registration changed".into()));
        }
    }
}
