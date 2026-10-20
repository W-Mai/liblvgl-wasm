//! Load a WASIp1 LVGL core, call its exports, and access its linear memory.
//!
//! Guest calls are synchronous. A failed guest call poisons the runtime; dropping it releases the Wasmtime store without invoking guest cleanup. Call [`Runtime::shutdown`] for explicit cleanup.

use std::path::Path;

use wasmtime::{Caller, Engine, ExternType, Instance, Linker, Memory, Module, Store};
use wasmtime::{WasmParams, WasmResults};
use wasmtime_wasi::WasiCtxBuilder;
use wasmtime_wasi::p1::{self, WasiP1Ctx};

pub use wasmtime::{Error, Result};

/// A synchronous notification from the core's event bridge.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Event {
    pub callback_id: u32,
    /// An object pointer in the emitting runtime's linear memory.
    pub object: u32,
    pub code: u32,
}

type EventHandler = Box<dyn FnMut(Event) -> Result<()> + Send>;

struct Host {
    wasi: WasiP1Ctx,
    handler: Option<EventHandler>,
}

enum State {
    Ready,
    Poisoned,
    Closed,
}

/// An isolated LVGL runtime with private Wasmtime execution state.
pub struct Runtime {
    store: Store<Host>,
    instance: Instance,
    memory: Memory,
    state: State,
}

impl Runtime {
    /// Instantiate core bytes, initialize the reactor, and validate bridge ABI 1.
    pub fn load(bytes: &[u8]) -> Result<Self> {
        let engine = Engine::default();
        let module = Module::from_binary(&engine, bytes)?;
        for import in module.imports() {
            if !matches!(
                (import.module(), import.name()),
                ("lvw", "event") | ("wasi_snapshot_preview1", "fd_close" | "fd_write")
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
                if let Some(handler) = caller.data_mut().handler.as_mut() {
                    handler(Event {
                        callback_id,
                        object,
                        code,
                    })?;
                }
                Ok(())
            },
        )?;
        let mut store = Store::new(
            &engine,
            Host {
                wasi: WasiCtxBuilder::new().inherit_stdio().build_p1(),
                handler: None,
            },
        );
        let instance = linker.instantiate(&mut store, &module)?;
        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| Error::msg("missing Wasm memory export"))?;
        let mut runtime = Self {
            store,
            instance,
            memory,
            state: State::Ready,
        };
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

    fn ensure_ready(&self) -> Result<()> {
        match self.state {
            State::Ready => Ok(()),
            State::Poisoned => Err(Error::msg(
                "LVGL runtime is poisoned after a failed guest call",
            )),
            State::Closed => Err(Error::msg("LVGL runtime is closed")),
        }
    }

    /// Call an export using its Wasm parameter and result types.
    ///
    /// The caller manages guest object state and the ownership, bounds, alignment, and lifetime of pointers in this instance. Use [`Self::shutdown`] for runtime cleanup. Signature lookup failures leave the runtime usable; guest traps, handler errors, and handler panics poison it.
    ///
    /// This is a safe Rust method: invalid guest pointers can corrupt the guest runtime or trap, but remain confined to Wasmtime's sandbox.
    pub fn call_raw<P: WasmParams, R: WasmResults>(&mut self, name: &str, params: P) -> Result<R> {
        self.ensure_ready()?;
        let function = self
            .instance
            .get_typed_func::<P, R>(&mut self.store, name)?;
        self.state = State::Poisoned;
        let result = function.call(&mut self.store, params)?;
        self.state = State::Ready;
        Ok(result)
    }

    /// Read bytes from linear memory, checking the requested range.
    pub fn read_memory(&self, pointer: u32, buffer: &mut [u8]) -> Result<()> {
        self.ensure_ready()?;
        self.memory.read(&self.store, pointer as usize, buffer)?;
        Ok(())
    }

    /// Write bytes to linear memory, checking the requested range.
    pub fn write_memory(&mut self, pointer: u32, bytes: &[u8]) -> Result<()> {
        self.ensure_ready()?;
        self.memory
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

    /// Release a scratch allocation from this instance.
    ///
    /// The pointer must come from [`Self::alloc`] on this runtime and must not have been freed.
    pub fn free(&mut self, pointer: u32) -> Result<()> {
        self.call_raw("lvw_free", pointer)
    }

    /// Replace the synchronous event handler.
    ///
    /// The handler receives callback identifiers and guest object pointers. It does not receive execution state for reentering the guest; returning an error or panicking poisons the runtime.
    pub fn set_event_handler(
        &mut self,
        handler: impl FnMut(Event) -> Result<()> + Send + 'static,
    ) -> Result<()> {
        self.ensure_ready()?;
        self.store.data_mut().handler = Some(Box::new(handler));
        Ok(())
    }

    /// Run guest cleanup and close the runtime.
    ///
    /// A cleanup status error still closes the runtime. Traps poison it. Dropping a runtime does not execute this method.
    pub fn shutdown(&mut self) -> Result<()> {
        let status = self.call_raw::<(), i32>("lvw_shutdown", ())?;
        self.state = State::Closed;
        self.store.data_mut().handler = None;
        if status != 0 {
            return Err(Error::msg(format!("lvw_shutdown failed ({status})")));
        }
        Ok(())
    }
}
