use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use wasmtime::{AsContextMut, Caller, Linker};

use crate::{CallbackContext, Error, Host, Result, Runtime, State, UnsafePointer};

type Handler = Arc<dyn Fn(&mut CallbackContext<'_>, &Timer) -> Result<()> + Send + Sync>;

struct Lifetime {
    pointer: AtomicU32,
    alive: AtomicBool,
}

/// A managed native LVGL timer. Clones share its lifetime.
///
/// Explicit deletion, native automatic deletion, shutdown, failure, and dropping the runtime invalidate the handle. Use `Runtime::cancel_timer` or `CallbackContext::cancel_timer` for idempotent cancellation. Dropping a handle alone does not cancel the timer.
#[derive(Clone)]
pub struct Timer {
    owner: Arc<AtomicBool>,
    id: u32,
    lifetime: Arc<Lifetime>,
}

impl Timer {
    /// Return the timer's native pointer while it and its runtime are active.
    ///
    /// Use generated timer methods to set period, pause, resume, repeat count, auto-delete, or user data. The caller must not replace the bridge's external-data destructor or callback, or use a saved pointer after deletion.
    pub fn pointer(&self) -> Result<UnsafePointer> {
        if !self.owner.load(Ordering::SeqCst) || !self.lifetime.alive.load(Ordering::SeqCst) {
            return Err(Error::msg("invalid LVGL timer reference"));
        }
        let pointer = self.lifetime.pointer.load(Ordering::SeqCst);
        if pointer == 0 {
            return Err(Error::msg("LVGL timer creation is not complete"));
        }
        Ok(UnsafePointer(pointer))
    }
}

#[derive(Clone)]
pub(super) struct Registration {
    timer: Timer,
    handler: Handler,
}

impl Host {
    pub(super) fn invalidate_timers(&self) {
        for registration in self.timers.values() {
            registration
                .timer
                .lifetime
                .alive
                .store(false, Ordering::SeqCst);
        }
    }

    fn release_timer(&mut self, id: u32) {
        if let Some(registration) = self.timers.remove(&id) {
            registration
                .timer
                .lifetime
                .alive
                .store(false, Ordering::SeqCst);
        }
    }
}

pub(super) fn add_to_linker(linker: &mut Linker<Host>) -> Result<()> {
    linker.func_wrap(
        "lvw",
        "timer",
        |mut caller: Caller<'_, Host>, id: u32, pointer: u32| -> Result<()> {
            caller.data().ensure_ready()?;
            let registration = caller
                .data()
                .timers
                .get(&id)
                .cloned()
                .ok_or_else(|| Error::msg("unknown LVGL timer callback"))?;
            if pointer == 0 || registration.timer.pointer()?.0 != pointer {
                return Err(Error::msg("LVGL timer callback pointer mismatch"));
            }
            let core = caller
                .data()
                .core
                .ok_or_else(|| Error::msg("LVGL core is not instantiated"))?;
            (registration.handler)(
                &mut CallbackContext {
                    store: caller.as_context_mut(),
                    core,
                },
                &registration.timer,
            )?;
            caller.data().ensure_not_poisoned()
        },
    )?;
    linker.func_wrap(
        "lvw",
        "timer_release",
        |mut caller: Caller<'_, Host>, id: u32| {
            caller.data_mut().release_timer(id);
        },
    )?;
    Ok(())
}

impl Runtime {
    /// Create a native timer driven by LVGL's tick and timer handler.
    ///
    /// `user_data` is a guest pointer preserved for the native getter/setter. The synchronous `Fn` handler can update LVGL through its context and can cancel itself. Release application locks before guest calls; nested notifications may invoke captured application code.
    pub fn create_timer(
        &mut self,
        period_ms: u32,
        user_data: UnsafePointer,
        handler: impl Fn(&mut CallbackContext<'_>, &Timer) -> Result<()> + Send + Sync + 'static,
    ) -> Result<Timer> {
        self.context().create_timer(period_ms, user_data, handler)
    }

    /// Cancel a timer from this runtime. Already invalidated timers require no guest call.
    pub fn cancel_timer(&mut self, timer: &Timer) -> Result<()> {
        self.context().cancel_timer(timer)
    }
}

impl CallbackContext<'_> {
    /// Create a timer with a synchronous callback and independent native user data.
    ///
    /// Requires `lvw_timer_create` and `lvw_timer_delete` exports. Native pause, period, repeat, and auto-delete settings can be changed through generated methods using `Timer::pointer`.
    pub fn create_timer(
        &mut self,
        period_ms: u32,
        user_data: UnsafePointer,
        handler: impl Fn(&mut CallbackContext<'_>, &Timer) -> Result<()> + Send + Sync + 'static,
    ) -> Result<Timer> {
        self.store.data().ensure_ready()?;
        // Validate the complete capability before allocating a registration.
        self.core
            .instance
            .get_typed_func::<(u32, u32, u32), u32>(&mut self.store, "lvw_timer_create")?;
        self.core
            .instance
            .get_typed_func::<(u32, u32), i32>(&mut self.store, "lvw_timer_delete")?;
        let id = u32::try_from(self.store.data().next_timer_id)
            .map_err(|_| Error::msg("LVGL timer callback IDs exhausted"))?;
        self.store.data_mut().next_timer_id += 1;
        let timer = Timer {
            owner: Arc::clone(&self.store.data().lifetime),
            id,
            lifetime: Arc::new(Lifetime {
                pointer: AtomicU32::new(0),
                alive: AtomicBool::new(true),
            }),
        };
        self.store.data_mut().timers.insert(
            id,
            Registration {
                timer: timer.clone(),
                handler: Arc::new(handler),
            },
        );
        match self.call_raw::<_, u32>("lvw_timer_create", (period_ms, user_data.0, id)) {
            Ok(pointer) if pointer != 0 => {
                timer.lifetime.pointer.store(pointer, Ordering::SeqCst);
                timer.pointer()?;
                Ok(timer)
            }
            result => {
                self.store.data_mut().release_timer(id);
                match result {
                    Ok(_) => Err(Error::msg("lvw_timer_create failed")),
                    Err(error) => Err(error),
                }
            }
        }
    }

    /// Cancel a timer owned by this context's runtime, including from its callback.
    ///
    /// A timer from another runtime is rejected. Repeated cancellation and cancellation after automatic deletion, shutdown, or failure do not enter the guest.
    pub fn cancel_timer(&mut self, timer: &Timer) -> Result<()> {
        if !Arc::ptr_eq(&self.store.data().lifetime, &timer.owner) {
            return Err(Error::msg("LVGL timer belongs to another runtime"));
        }
        if !timer.lifetime.alive.load(Ordering::SeqCst) {
            return Ok(());
        }
        if matches!(self.store.data().state, State::Closing) {
            self.store.data_mut().release_timer(timer.id);
            return Ok(());
        }
        self.store.data().ensure_ready()?;
        let status: i32 = self.call_raw("lvw_timer_delete", (timer.pointer()?.0, timer.id))?;
        if status != 0 {
            return Err(Error::msg(format!("lvw_timer_delete failed ({status})")));
        }
        self.store.data_mut().release_timer(timer.id);
        Ok(())
    }
}
