//! Load a WASIp1 LVGL core, call its exports, and access its linear memory.
//!
//! Guest calls are synchronous. A failed guest call poisons the runtime; dropping it releases the Wasmtime store without invoking guest cleanup. Call [`Runtime::shutdown`] for explicit cleanup.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha256};
use wasmtime::{
    AsContextMut, Caller, Engine, ExternType, Instance, Linker, Memory, Module, Store,
    StoreContextMut,
};
use wasmtime::{WasmParams, WasmResults};
use wasmtime_wasi::WasiCtxBuilder;
use wasmtime_wasi::p1::{self, WasiP1Ctx};

pub use wasmtime::{Error, Result};

mod timer;
pub use timer::Timer;
mod animation;
pub use animation::{Animation, AnimationCallbacks};
mod observer;
pub use observer::Observer;

mod generated {
    include!(concat!(env!("OUT_DIR"), "/raw.rs"));
}

pub use generated::{
    API_EXPORTS, BINDING_IDENTITY, BindingIdentity, RawApi, UnsafeFunctionPointer, UnsafePointer,
    values,
};

/// A synchronous notification from the core's event bridge.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Event {
    pub callback_id: u32,
    /// An object pointer in the emitting runtime's linear memory.
    pub object: u32,
    pub code: u32,
}

type NotificationHandler = Box<dyn FnMut(Event) -> Result<()> + Send>;
type ContextHandler = Arc<dyn Fn(&mut CallbackContext<'_>, Event) -> Result<()> + Send + Sync>;

enum EventHandler {
    Notification(NotificationHandler),
    Context(ContextHandler),
}

#[derive(Clone, Copy)]
struct Core {
    instance: Instance,
    memory: Memory,
}

struct Host {
    wasi: WasiP1Ctx,
    handler: Option<EventHandler>,
    core: Option<Core>,
    core_hash: String,
    state: State,
    guest_depth: usize,
    failure: Option<String>,
    lifetime: Arc<AtomicBool>,
    timers: HashMap<u32, timer::Registration>,
    next_timer_id: u64,
    animations: animation::Registry,
    observers: HashMap<u32, observer::Registration>,
    next_observer_id: u64,
}

#[derive(Clone, Copy)]
enum State {
    Ready,
    Closing,
    Poisoned,
    Closed,
}

impl Host {
    fn ensure_ready(&self) -> Result<()> {
        match self.state {
            State::Ready => Ok(()),
            State::Closing => Err(Error::msg("LVGL runtime is closing")),
            State::Poisoned => Err(self.poison_error()),
            State::Closed => Err(Error::msg("LVGL runtime is closed")),
        }
    }

    fn poison_error(&self) -> Error {
        Error::msg(format!(
            "LVGL runtime is poisoned after a failed guest call: {}",
            self.failure.as_deref().unwrap_or("unknown failure")
        ))
    }

    fn poison(&mut self, reason: impl FnOnce() -> String) {
        self.state = State::Poisoned;
        self.lifetime.store(false, Ordering::SeqCst);
        self.clear_callbacks();
        if self.failure.is_none() {
            self.failure = Some(reason());
        }
    }

    fn clear_callbacks(&mut self) {
        self.invalidate_timers();
        self.timers.clear();
        self.animations.clear();
        self.invalidate_observers();
        self.observers.clear();
        self.handler = None;
    }

    fn ensure_not_poisoned(&self) -> Result<()> {
        if matches!(self.state, State::Poisoned) {
            return Err(self.poison_error());
        }
        Ok(())
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.lifetime.store(false, Ordering::SeqCst);
        self.invalidate_timers();
        self.animations.invalidate();
        self.invalidate_observers();
    }
}

/// An isolated LVGL runtime with private Wasmtime execution state.
pub struct Runtime {
    store: Store<Host>,
}

/// Synchronous access to the emitting core, borrowed for the duration of a callback.
///
/// Generated methods and checked memory access share the runtime's state and identity guards. Guest pointer preconditions still apply. Calling `lvw_step` or `lvw_shutdown` during a callback is rejected; during shutdown, callbacks may only update host data.
pub struct CallbackContext<'a> {
    store: StoreContextMut<'a, Host>,
    core: Core,
}

impl Runtime {
    /// Instantiate core bytes, initialize the reactor, and validate bridge ABI 1.
    pub fn load(bytes: &[u8]) -> Result<Self> {
        let core_hash = format!("{:x}", Sha256::digest(bytes));
        let engine = Engine::default();
        let module = Module::from_binary(&engine, bytes)?;
        for import in module.imports() {
            if !matches!(
                (import.module(), import.name()),
                (
                    "lvw",
                    "event"
                        | "timer"
                        | "timer_release"
                        | "anim_exec"
                        | "anim_query"
                        | "anim_notify"
                        | "anim_release"
                        | "observer"
                        | "observer_release"
                ) | (
                    "wasi_snapshot_preview1",
                    "fd_close" | "fd_write" | "fd_seek"
                )
            ) || !matches!(import.ty(), ExternType::Func(_))
            {
                return Err(Error::msg(format!(
                    "unsupported Wasm import: {}.{}",
                    import.module(),
                    import.name()
                )));
            }
        }

        let mut linker = Linker::<Host>::new(&engine);
        p1::add_to_linker_sync(&mut linker, |host| &mut host.wasi)?;
        linker.func_wrap(
            "lvw",
            "event",
            |mut caller: Caller<'_, Host>,
             callback_id: u32,
             object: u32,
             code: u32|
             -> Result<()> {
                caller.data().ensure_not_poisoned()?;
                let event = Event {
                    callback_id,
                    object,
                    code,
                };
                let context_handler = match caller.data().handler.as_ref() {
                    Some(EventHandler::Context(handler)) => Some(Arc::clone(handler)),
                    _ => None,
                };
                if let Some(handler) = context_handler {
                    let core = caller
                        .data()
                        .core
                        .ok_or_else(|| Error::msg("LVGL core is not instantiated"))?;
                    handler(
                        &mut CallbackContext {
                            store: caller.as_context_mut(),
                            core,
                        },
                        event,
                    )?;
                } else if let Some(EventHandler::Notification(handler)) =
                    caller.data_mut().handler.as_mut()
                {
                    handler(event)?;
                }
                caller.data().ensure_not_poisoned()
            },
        )?;
        timer::add_to_linker(&mut linker)?;
        animation::add_to_linker(&mut linker)?;
        observer::add_to_linker(&mut linker)?;
        let mut store = Store::new(
            &engine,
            Host {
                wasi: WasiCtxBuilder::new().inherit_stdio().build_p1(),
                handler: None,
                core: None,
                core_hash,
                state: State::Ready,
                guest_depth: 0,
                failure: None,
                lifetime: Arc::new(AtomicBool::new(true)),
                timers: HashMap::new(),
                next_timer_id: 1,
                animations: animation::Registry::default(),
                observers: HashMap::new(),
                next_observer_id: 1,
            },
        );
        let instance = linker.instantiate(&mut store, &module)?;
        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| Error::msg("missing Wasm memory export"))?;
        store.data_mut().core = Some(Core { instance, memory });
        let mut runtime = Self { store };
        runtime.call_raw::<(), ()>("_initialize", ())?;
        if runtime.call_raw::<(), u32>("lvw_abi_version", ())? != 1 {
            return Err(Error::msg("unsupported bridge ABI"));
        }
        let status = runtime.call_raw::<(), i32>("lvw_init", ())?;
        if status != 0 {
            return Err(Error::msg(format!("lvw_init failed ({status})")));
        }
        Ok(runtime)
    }

    /// Load a core from a file.
    pub fn from_file(path: impl AsRef<Path>) -> Result<Self> {
        Self::load(&std::fs::read(path)?)
    }

    fn context(&mut self) -> CallbackContext<'_> {
        CallbackContext {
            core: self.store.data().core.expect("instantiated core"),
            store: self.store.as_context_mut(),
        }
    }

    /// Borrow generated LVGL methods for the exact core recorded in [`BINDING_IDENTITY`].
    ///
    /// The caller manages guest pointer ownership, bounds, alignment, and lifetime. A different core can still use the bridge through [`Self::call_raw`], but cannot use these generated methods.
    pub fn raw(&mut self) -> Result<RawApi<'_>> {
        self.context().into_raw()
    }

    /// Call an export using its Wasm parameter and result types.
    ///
    /// The caller manages guest object state and the ownership, bounds, alignment, and lifetime of pointers in this instance. Use [`Self::shutdown`] for runtime cleanup. Signature lookup failures leave the runtime usable; guest traps, handler errors, and handler panics poison it.
    ///
    /// This is a safe Rust method: invalid guest pointers can corrupt the guest runtime or trap, but remain confined to Wasmtime's sandbox.
    pub fn call_raw<P: WasmParams, R: WasmResults>(&mut self, name: &str, params: P) -> Result<R> {
        self.context().call_raw(name, params)
    }

    /// Read bytes from linear memory, checking the requested range.
    pub fn read_memory(&self, pointer: u32, buffer: &mut [u8]) -> Result<()> {
        self.store.data().ensure_ready()?;
        self.store
            .data()
            .core
            .expect("instantiated core")
            .memory
            .read(&self.store, pointer as usize, buffer)?;
        Ok(())
    }

    /// Write bytes to linear memory, checking the requested range.
    pub fn write_memory(&mut self, pointer: u32, bytes: &[u8]) -> Result<()> {
        self.context().write_memory(pointer, bytes)
    }

    /// Allocate scratch memory in this instance. Release it with [`Self::free`].
    pub fn alloc(&mut self, bytes: u32) -> Result<u32> {
        self.context().alloc(bytes)
    }

    /// Release a scratch allocation from this instance.
    ///
    /// The pointer must come from [`Self::alloc`] on this runtime and must not have been freed.
    pub fn free(&mut self, pointer: u32) -> Result<()> {
        self.context().free(pointer)
    }

    /// Replace the synchronous event handler.
    ///
    /// The handler receives callback identifiers and guest object pointers. Use [`Self::set_event_handler_with_context`] for nested guest calls. Returning an error or panicking poisons the runtime.
    pub fn set_event_handler(
        &mut self,
        handler: impl FnMut(Event) -> Result<()> + Send + 'static,
    ) -> Result<()> {
        self.store.data().ensure_ready()?;
        self.store.data_mut().handler = Some(EventHandler::Notification(Box::new(handler)));
        Ok(())
    }

    /// Replace the event handler with a function that can call LVGL synchronously.
    ///
    /// Nested notifications invoke the same `Fn` handler. Use atomics or a mutex for mutable captured state, and release application locks before calling the guest to avoid recursive locking. The context and its generated API cannot outlive the callback's borrow.
    pub fn set_event_handler_with_context(
        &mut self,
        handler: impl Fn(&mut CallbackContext<'_>, Event) -> Result<()> + Send + Sync + 'static,
    ) -> Result<()> {
        self.store.data().ensure_ready()?;
        self.store.data_mut().handler = Some(EventHandler::Context(Arc::new(handler)));
        Ok(())
    }

    /// Run guest cleanup and close the runtime.
    ///
    /// A cleanup status error still closes the runtime. Traps poison it. Dropping a runtime does not execute this method.
    pub fn shutdown(&mut self) -> Result<()> {
        let status = self.call_raw::<(), i32>("lvw_shutdown", ())?;
        if status != 0 {
            return Err(Error::msg(format!("lvw_shutdown failed ({status})")));
        }
        Ok(())
    }
}

impl<'a> CallbackContext<'a> {
    fn poison(&mut self, reason: impl FnOnce() -> String) {
        let result = catch_unwind(AssertUnwindSafe(|| self.store.data_mut().poison(reason)));
        animation::flush_slots(&mut self.store);
        if let Err(payload) = result {
            resume_unwind(payload);
        }
    }

    fn reborrow(&mut self) -> CallbackContext<'_> {
        CallbackContext {
            store: self.store.as_context_mut(),
            core: self.core,
        }
    }

    fn into_raw(self) -> Result<RawApi<'a>> {
        self.store.data().ensure_ready()?;
        if self.store.data().core_hash != BINDING_IDENTITY.wasm_sha256 {
            return Err(Error::msg(
                "LVGL bindings do not match this core; generate bindings for the selected core",
            ));
        }
        Ok(RawApi { runtime: self })
    }

    /// Borrow generated methods for the exact core recorded in [`BINDING_IDENTITY`].
    ///
    /// The caller manages guest pointer ownership, bounds, alignment, and lifetime.
    pub fn raw(&mut self) -> Result<RawApi<'_>> {
        self.reborrow().into_raw()
    }

    /// Borrow the native event pointer for the innermost active bridge event.
    ///
    /// The event and its layer, task, and parameter pointers are valid only during the synchronous event call. Nested callbacks may access a still-active outer event. Do not retain these pointers after that event returns. A missing export or no active event is a recoverable error; closing and poisoned runtimes reject access.
    pub fn event_pointer(&mut self) -> Result<UnsafePointer> {
        let pointer = self.call_raw::<(), u32>("lvw_event_current", ())?;
        if pointer == 0 {
            return Err(Error::msg("no active native LVGL event"));
        }
        Ok(UnsafePointer(pointer))
    }

    /// Call a core export synchronously with its Wasm parameter and result types.
    ///
    /// Lookup and signature errors leave the instance usable. A guest trap, handler error, or panic permanently poisons it, even when caught inside a callback. Raw lifecycle functions remain subject to LVGL's preconditions; use [`Runtime::shutdown`] for cleanup.
    pub fn call_raw<P: WasmParams, R: WasmResults>(&mut self, name: &str, params: P) -> Result<R> {
        self.store.data().ensure_ready()?;
        if self.store.data().guest_depth != 0 && matches!(name, "lvw_step" | "lvw_shutdown") {
            return Err(Error::msg(format!(
                "{name} cannot be called during an active guest call"
            )));
        }
        if self.store.data().animations.callback_depth != 0
            && matches!(name, "lv_anim_refr_now" | "lv_anim_delete_all")
        {
            return Err(Error::msg(format!(
                "{name} cannot be called during an animation callback"
            )));
        }
        let function = self
            .core
            .instance
            .get_typed_func::<P, R>(&mut self.store, name)?;
        let closing = name == "lvw_shutdown";
        if closing {
            self.store.data_mut().state = State::Closing;
            self.store.data().lifetime.store(false, Ordering::SeqCst);
        }
        self.store.data_mut().guest_depth += 1;
        let outcome = catch_unwind(AssertUnwindSafe(|| function.call(&mut self.store, params)));
        self.store.data_mut().guest_depth -= 1;
        animation::flush_slots(&mut self.store);
        match outcome {
            Ok(Ok(value)) => {
                self.store.data().ensure_not_poisoned()?;
                if closing {
                    self.store.data_mut().state = State::Closed;
                    self.store.data_mut().clear_callbacks();
                    animation::flush_slots(&mut self.store);
                }
                Ok(value)
            }
            Ok(Err(error)) => {
                self.poison(|| format!("{error:#}"));
                Err(error)
            }
            Err(payload) => {
                self.poison(|| "host callback panicked".to_owned());
                resume_unwind(payload)
            }
        }
    }

    /// Read bytes from linear memory, checking the requested range.
    pub fn read_memory(&self, pointer: u32, buffer: &mut [u8]) -> Result<()> {
        self.store.data().ensure_ready()?;
        self.core
            .memory
            .read(&self.store, pointer as usize, buffer)?;
        Ok(())
    }

    /// Write bytes to linear memory, checking the requested range.
    pub fn write_memory(&mut self, pointer: u32, bytes: &[u8]) -> Result<()> {
        self.store.data().ensure_ready()?;
        self.core
            .memory
            .write(&mut self.store, pointer as usize, bytes)?;
        Ok(())
    }

    /// Allocate scratch memory in this instance. Release it with [`Self::free`].
    pub fn alloc(&mut self, bytes: u32) -> Result<u32> {
        let pointer = self.call_raw::<u32, u32>("lvw_alloc", bytes)?;
        if pointer == 0 {
            return Err(Error::msg(format!(
                "guest allocation failed ({bytes} bytes)"
            )));
        }
        Ok(pointer)
    }

    /// Release scratch memory allocated by [`Self::alloc`] on this instance.
    ///
    /// The pointer must not have been freed.
    pub fn free(&mut self, pointer: u32) -> Result<()> {
        self.call_raw("lvw_free", pointer)
    }
}
