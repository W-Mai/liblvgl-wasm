use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use wasmtime::{AsContextMut, Caller, Linker};

use crate::{CallbackContext, Error, Host, Result, Runtime, State, UnsafePointer};

type Handler =
    Arc<dyn Fn(&mut CallbackContext<'_>, &Observer, UnsafePointer) -> Result<()> + Send + Sync>;

struct Lifetime {
    pointer: AtomicU32,
    alive: AtomicBool,
}

/// A managed native LVGL observer. Clones share its lifetime.
///
/// Native deletion, subject or bound-object cleanup, shutdown, failure, and dropping the runtime invalidate the handle. Dropping a handle alone does not unsubscribe. An initial callback may cancel an unbound observer before its creation returns; the returned handle is then already invalid.
#[derive(Clone)]
pub struct Observer {
    owner: Arc<AtomicBool>,
    id: u32,
    lifetime: Arc<Lifetime>,
}

impl Observer {
    /// Return the native observer pointer while it and its runtime are active.
    ///
    /// The pointer is available in the initial synchronous callback. Generated user-data and target getters retain native semantics. Do not use a saved pointer after release or overwrite the native callback. Raw deletion of an object-bound observer can remove shared widget bindings; use the managed cancellation rules.
    pub fn pointer(&self) -> Result<UnsafePointer> {
        if !self.owner.load(Ordering::SeqCst) || !self.lifetime.alive.load(Ordering::SeqCst) {
            return Err(Error::msg("invalid LVGL observer reference"));
        }
        let pointer = self.lifetime.pointer.load(Ordering::SeqCst);
        if pointer == 0 {
            return Err(Error::msg("LVGL observer creation is not complete"));
        }
        Ok(UnsafePointer(pointer))
    }

    fn bind(&self, pointer: u32) -> Result<()> {
        if pointer == 0 || !self.lifetime.alive.load(Ordering::SeqCst) {
            return Err(Error::msg("invalid LVGL observer callback pointer"));
        }
        match self
            .lifetime
            .pointer
            .compare_exchange(0, pointer, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => Ok(()),
            Err(existing) if existing == pointer => Ok(()),
            Err(_) => Err(Error::msg("LVGL observer callback pointer mismatch")),
        }
    }
}

#[derive(Clone)]
pub(super) struct Registration {
    observer: Observer,
    subject: UnsafePointer,
    handler: Handler,
}

impl Host {
    pub(super) fn invalidate_observers(&self) {
        for registration in self.observers.values() {
            registration
                .observer
                .lifetime
                .alive
                .store(false, Ordering::SeqCst);
        }
    }

    fn release_observer(&mut self, id: u32) {
        if let Some(registration) = self.observers.remove(&id) {
            registration
                .observer
                .lifetime
                .alive
                .store(false, Ordering::SeqCst);
        }
    }
}

pub(super) fn add_to_linker(linker: &mut Linker<Host>) -> Result<()> {
    linker.func_wrap(
        "lvw",
        "observer",
        |mut caller: Caller<'_, Host>, id: u32, pointer: u32, subject: u32| -> Result<()> {
            if matches!(caller.data().state, State::Closing) {
                return Ok(());
            }
            caller.data().ensure_ready()?;
            let registration = caller
                .data()
                .observers
                .get(&id)
                .cloned()
                .ok_or_else(|| Error::msg("unknown LVGL observer callback"))?;
            if registration.subject.0 != subject {
                return Err(Error::msg("LVGL observer callback subject mismatch"));
            }
            registration.observer.bind(pointer)?;
            let core = caller
                .data()
                .core
                .ok_or_else(|| Error::msg("LVGL core is not instantiated"))?;
            (registration.handler)(
                &mut CallbackContext {
                    store: caller.as_context_mut(),
                    core,
                },
                &registration.observer,
                registration.subject,
            )?;
            caller.data().ensure_not_poisoned()
        },
    )?;
    linker.func_wrap(
        "lvw",
        "observer_release",
        |mut caller: Caller<'_, Host>, id: u32| {
            caller.data_mut().release_observer(id);
        },
    )?;
    Ok(())
}

impl Runtime {
    /// Observe a subject, invoking the handler synchronously before returning.
    ///
    /// `user_data` remains available through native observer getters and setters. The handler receives its subject pointer and may update other subjects or create more observers, including on this subject. Raw calls must not recursively notify an active subject or delete/deinitialize it during notification. Release application locks before guest calls because handlers may nest.
    pub fn observe(
        &mut self,
        subject: UnsafePointer,
        user_data: UnsafePointer,
        handler: impl Fn(&mut CallbackContext<'_>, &Observer, UnsafePointer) -> Result<()>
        + Send
        + Sync
        + 'static,
    ) -> Result<Observer> {
        self.context().observe(subject, user_data, handler)
    }

    /// Observe a subject with an arbitrary target pointer, without object ownership.
    pub fn observe_target(
        &mut self,
        subject: UnsafePointer,
        target: UnsafePointer,
        user_data: UnsafePointer,
        handler: impl Fn(&mut CallbackContext<'_>, &Observer, UnsafePointer) -> Result<()>
        + Send
        + Sync
        + 'static,
    ) -> Result<Observer> {
        self.context()
            .observe_target(subject, target, user_data, handler)
    }

    /// Observe a subject until the native object or subject is cleaned up.
    ///
    /// Pointers must belong to this guest and remain valid. Individual cancellation with a non-null object is rejected to preserve other widget bindings. Delete the object or subject, or use `lv_obj_remove_from_subject` to remove all bindings between them. A null object permits ordinary cancellation.
    pub fn observe_object(
        &mut self,
        subject: UnsafePointer,
        object: UnsafePointer,
        user_data: UnsafePointer,
        handler: impl Fn(&mut CallbackContext<'_>, &Observer, UnsafePointer) -> Result<()>
        + Send
        + Sync
        + 'static,
    ) -> Result<Observer> {
        self.context()
            .observe_object(subject, object, user_data, handler)
    }

    /// Cancel an unbound observer from this runtime. Already released observers are unchanged.
    pub fn cancel_observer(&mut self, observer: &Observer) -> Result<()> {
        self.context().cancel_observer(observer)
    }
}

impl CallbackContext<'_> {
    /// Observe a subject with the synchronous semantics of [`Runtime::observe`].
    pub fn observe(
        &mut self,
        subject: UnsafePointer,
        user_data: UnsafePointer,
        handler: impl Fn(&mut CallbackContext<'_>, &Observer, UnsafePointer) -> Result<()>
        + Send
        + Sync
        + 'static,
    ) -> Result<Observer> {
        self.create_observer(subject, UnsafePointer(0), user_data, 0, Arc::new(handler))
    }

    /// Observe a subject with an arbitrary target that does not own the registration.
    pub fn observe_target(
        &mut self,
        subject: UnsafePointer,
        target: UnsafePointer,
        user_data: UnsafePointer,
        handler: impl Fn(&mut CallbackContext<'_>, &Observer, UnsafePointer) -> Result<()>
        + Send
        + Sync
        + 'static,
    ) -> Result<Observer> {
        self.create_observer(subject, target, user_data, 0, Arc::new(handler))
    }

    /// Observe a subject with the object-cleanup semantics of [`Runtime::observe_object`].
    pub fn observe_object(
        &mut self,
        subject: UnsafePointer,
        object: UnsafePointer,
        user_data: UnsafePointer,
        handler: impl Fn(&mut CallbackContext<'_>, &Observer, UnsafePointer) -> Result<()>
        + Send
        + Sync
        + 'static,
    ) -> Result<Observer> {
        self.create_observer(subject, object, user_data, 1, Arc::new(handler))
    }

    fn create_observer(
        &mut self,
        subject: UnsafePointer,
        target: UnsafePointer,
        user_data: UnsafePointer,
        mode: u32,
        handler: Handler,
    ) -> Result<Observer> {
        self.store.data().ensure_ready()?;
        self.core
            .instance
            .get_typed_func::<(u32, u32, u32, u32, u32), u32>(
                &mut self.store,
                "lvw_observer_create",
            )?;
        self.core
            .instance
            .get_typed_func::<(u32, u32), i32>(&mut self.store, "lvw_observer_delete")?;
        let id = u32::try_from(self.store.data().next_observer_id)
            .map_err(|_| Error::msg("LVGL observer callback IDs exhausted"))?;
        self.store.data_mut().next_observer_id += 1;
        let observer = Observer {
            owner: Arc::clone(&self.store.data().lifetime),
            id,
            lifetime: Arc::new(Lifetime {
                pointer: AtomicU32::new(0),
                alive: AtomicBool::new(true),
            }),
        };
        self.store.data_mut().observers.insert(
            id,
            Registration {
                observer: observer.clone(),
                subject,
                handler,
            },
        );
        match self.call_raw::<_, u32>(
            "lvw_observer_create",
            (subject.0, target.0, user_data.0, id, mode),
        ) {
            Ok(pointer) if pointer != 0 && !observer.lifetime.alive.load(Ordering::SeqCst) => {
                Ok(observer)
            }
            Ok(pointer) if pointer != 0 => {
                if observer.lifetime.pointer.load(Ordering::SeqCst) != pointer {
                    let error = Error::msg("LVGL observer creation pointer mismatch");
                    self.poison(|| error.to_string());
                    return Err(error);
                }
                Ok(observer)
            }
            result => {
                self.store.data_mut().release_observer(id);
                match result {
                    Ok(_) => Err(Error::msg("lvw_observer_create failed")),
                    Err(error) => Err(error),
                }
            }
        }
    }

    /// Cancel an observer owned by this runtime.
    ///
    /// Repeated cancellation is idempotent. Non-null object-bound observers reject individual cancellation with a recoverable error. Closing permits host registration cleanup without entering the guest.
    pub fn cancel_observer(&mut self, observer: &Observer) -> Result<()> {
        if !Arc::ptr_eq(&self.store.data().lifetime, &observer.owner) {
            return Err(Error::msg("LVGL observer belongs to another runtime"));
        }
        if !observer.lifetime.alive.load(Ordering::SeqCst) {
            return Ok(());
        }
        if matches!(self.store.data().state, State::Closing) {
            self.store.data_mut().release_observer(observer.id);
            return Ok(());
        }
        self.store.data().ensure_ready()?;
        let status: i32 =
            self.call_raw("lvw_observer_delete", (observer.pointer()?.0, observer.id))?;
        if status != 0 {
            return Err(Error::msg(format!("lvw_observer_delete failed ({status})")));
        }
        self.store.data_mut().release_observer(observer.id);
        Ok(())
    }
}
