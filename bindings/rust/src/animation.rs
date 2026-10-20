use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use wasmtime::{
    AsContextMut, Caller, Func, Global, GlobalType, Instance, Linker, Module, Mutability, Ref,
    RefType, StoreContextMut, Table, Val, ValType,
};

use crate::{CallbackContext, Error, Host, Result, Runtime, State, UnsafePointer};

type Exec = Arc<dyn Fn(&mut CallbackContext<'_>, &Animation, i32) -> Result<()> + Send + Sync>;
type Query = Arc<dyn Fn(&mut CallbackContext<'_>, &Animation) -> Result<i32> + Send + Sync>;
type Notify = Arc<dyn Fn(&mut CallbackContext<'_>, &Animation) -> Result<()> + Send + Sync>;

/// Synchronous handlers for a native LVGL animation.
///
/// An exec handler is required. Optional path and get-value handlers return native `i32` values; omitted path handling preserves the descriptor's native path. Release application locks before guest calls because callbacks may nest.
#[derive(Clone)]
pub struct AnimationCallbacks {
    exec: Exec,
    path: Option<Query>,
    get_value: Option<Query>,
    start: Option<Notify>,
    completed: Option<Notify>,
    deleted: Option<Notify>,
}

impl AnimationCallbacks {
    /// Apply each animation value synchronously.
    pub fn new(
        exec: impl Fn(&mut CallbackContext<'_>, &Animation, i32) -> Result<()> + Send + Sync + 'static,
    ) -> Self {
        Self {
            exec: Arc::new(exec),
            path: None,
            get_value: None,
            start: None,
            completed: None,
            deleted: None,
        }
    }

    /// Compute the absolute value for the current animation position.
    pub fn path(
        mut self,
        handler: impl Fn(&mut CallbackContext<'_>, &Animation) -> Result<i32> + Send + Sync + 'static,
    ) -> Self {
        self.path = Some(Arc::new(handler));
        self
    }

    /// Supply the native relative-value offset.
    pub fn get_value(
        mut self,
        handler: impl Fn(&mut CallbackContext<'_>, &Animation) -> Result<i32> + Send + Sync + 'static,
    ) -> Self {
        self.get_value = Some(Arc::new(handler));
        self
    }

    /// Observe the start of each native animation segment.
    pub fn start(
        mut self,
        handler: impl Fn(&mut CallbackContext<'_>, &Animation) -> Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.start = Some(Arc::new(handler));
        self
    }

    /// Observe natural completion before the deleted notification.
    pub fn completed(
        mut self,
        handler: impl Fn(&mut CallbackContext<'_>, &Animation) -> Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.completed = Some(Arc::new(handler));
        self
    }

    /// Observe deletion, including cancellation and native object cleanup.
    pub fn deleted(
        mut self,
        handler: impl Fn(&mut CallbackContext<'_>, &Animation) -> Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.deleted = Some(Arc::new(handler));
        self
    }

    fn flags(&self) -> u32 {
        u32::from(self.path.is_some())
            | (u32::from(self.get_value.is_some()) << 1)
            | (u32::from(self.start.is_some()) << 2)
            | (u32::from(self.completed.is_some()) << 3)
            | (u32::from(self.deleted.is_some()) << 4)
    }
}

struct Lifetime {
    pointer: AtomicU32,
    alive: AtomicBool,
    finishing: AtomicBool,
}

/// A managed native animation whose clones share its lifetime.
///
/// The running animation is a copy of the input descriptor. Native completion, cancellation, object deletion, runtime failure, shutdown, and dropping the runtime invalidate the handle. Dropping this handle alone does not cancel the animation.
#[derive(Clone)]
pub struct Animation {
    owner: Arc<AtomicBool>,
    id: u32,
    lifetime: Arc<Lifetime>,
}

impl Animation {
    /// Return the native running animation pointer while it and its runtime are active.
    ///
    /// The pointer is available inside early callbacks. Generated setters and getters retain their native semantics. Do not overwrite managed callbacks or external data, or retain this pointer after the animation is released.
    pub fn pointer(&self) -> Result<UnsafePointer> {
        if !self.owner.load(Ordering::SeqCst) || !self.lifetime.alive.load(Ordering::SeqCst) {
            return Err(Error::msg("invalid LVGL animation reference"));
        }
        let pointer = self.lifetime.pointer.load(Ordering::SeqCst);
        if pointer == 0 {
            return Err(Error::msg("LVGL animation creation is not complete"));
        }
        Ok(UnsafePointer(pointer))
    }

    fn bind(&self, pointer: u32) -> Result<()> {
        if pointer == 0 || !self.lifetime.alive.load(Ordering::SeqCst) {
            return Err(Error::msg("invalid LVGL animation callback pointer"));
        }
        match self
            .lifetime
            .pointer
            .compare_exchange(0, pointer, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => Ok(()),
            Err(existing) if existing == pointer => Ok(()),
            Err(_) => Err(Error::msg("LVGL animation callback pointer mismatch")),
        }
    }
}

#[derive(Clone)]
struct Registration {
    animation: Animation,
    callbacks: AnimationCallbacks,
    slot: u32,
}

pub(super) struct Registry {
    registrations: HashMap<u32, Registration>,
    next_id: u64,
    table: Option<Table>,
    module: Option<Module>,
    wrappers: HashMap<u32, Func>,
    free_slots: Vec<u32>,
    pending_slots: Vec<u32>,
    retired_slots: Vec<u32>,
    pub(super) callback_depth: usize,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            registrations: HashMap::new(),
            next_id: 1,
            table: None,
            module: None,
            wrappers: HashMap::new(),
            free_slots: Vec::new(),
            pending_slots: Vec::new(),
            retired_slots: Vec::new(),
            callback_depth: 0,
        }
    }
}

impl Registry {
    pub(super) fn invalidate(&self) {
        for registration in self.registrations.values() {
            registration
                .animation
                .lifetime
                .alive
                .store(false, Ordering::SeqCst);
        }
    }

    pub(super) fn clear(&mut self) {
        self.invalidate();
        self.retired_slots
            .extend(self.registrations.values().map(|entry| entry.slot));
        self.registrations.clear();
    }
}

pub(super) fn flush_slots(store: &mut StoreContextMut<'_, Host>) {
    let slots = std::mem::take(&mut store.data_mut().animations.retired_slots);
    if let Some(table) = store.data().animations.table {
        for slot in &slots {
            // Only indices grown by this registry enter this list; tables cannot shrink.
            let _ = table.set(&mut *store, u64::from(*slot), Ref::Func(None));
        }
    }
    let idle = store.data().guest_depth == 0;
    let registry = &mut store.data_mut().animations;
    registry.pending_slots.extend(slots);
    if idle {
        registry.free_slots.append(&mut registry.pending_slots);
    }
}

fn release(store: &mut StoreContextMut<'_, Host>, id: u32) {
    if let Some(registration) = store.data_mut().animations.registrations.remove(&id) {
        registration
            .animation
            .lifetime
            .alive
            .store(false, Ordering::SeqCst);
        store
            .data_mut()
            .animations
            .retired_slots
            .push(registration.slot);
        flush_slots(store);
    }
}

fn callback<R>(
    caller: &mut Caller<'_, Host>,
    id: u32,
    pointer: u32,
    finishing: bool,
    invoke: impl FnOnce(&mut CallbackContext<'_>, &Registration) -> Result<R>,
) -> Result<R> {
    caller.data().ensure_not_poisoned()?;
    let registration = caller
        .data()
        .animations
        .registrations
        .get(&id)
        .cloned()
        .ok_or_else(|| Error::msg("unknown LVGL animation callback"))?;
    registration.animation.bind(pointer)?;
    if finishing {
        registration
            .animation
            .lifetime
            .finishing
            .store(true, Ordering::SeqCst);
    }
    let core = caller
        .data()
        .core
        .ok_or_else(|| Error::msg("LVGL core is not instantiated"))?;
    caller.data_mut().animations.callback_depth += 1;
    let result = catch_unwind(AssertUnwindSafe(|| {
        invoke(
            &mut CallbackContext {
                store: caller.as_context_mut(),
                core,
            },
            &registration,
        )
    }));
    caller.data_mut().animations.callback_depth -= 1;
    match result {
        Ok(result) => {
            let value = result?;
            caller.data().ensure_not_poisoned()?;
            Ok(value)
        }
        Err(payload) => resume_unwind(payload),
    }
}

pub(super) fn add_to_linker(linker: &mut Linker<Host>) -> Result<()> {
    linker.func_wrap(
        "lvw",
        "anim_exec",
        |mut caller: Caller<'_, Host>, id: u32, pointer: u32, value: i32| -> Result<()> {
            caller.data().ensure_ready()?;
            callback(&mut caller, id, pointer, false, |context, registration| {
                (registration.callbacks.exec)(context, &registration.animation, value)
            })
        },
    )?;
    linker.func_wrap(
        "lvw",
        "anim_query",
        |mut caller: Caller<'_, Host>, id: u32, pointer: u32, kind: u32| -> Result<i32> {
            caller.data().ensure_ready()?;
            callback(&mut caller, id, pointer, false, |context, registration| {
                let handler = match kind {
                    1 => &registration.callbacks.path,
                    2 => &registration.callbacks.get_value,
                    _ => return Err(Error::msg("unknown LVGL animation query kind")),
                }
                .as_ref()
                .ok_or_else(|| Error::msg("missing LVGL animation query handler"))?;
                handler(context, &registration.animation)
            })
        },
    )?;
    linker.func_wrap(
        "lvw",
        "anim_notify",
        |mut caller: Caller<'_, Host>, id: u32, pointer: u32, kind: u32| -> Result<()> {
            if matches!(caller.data().state, State::Closing)
                && !caller.data().animations.registrations.contains_key(&id)
            {
                return Ok(());
            }
            callback(
                &mut caller,
                id,
                pointer,
                matches!(kind, 2 | 3),
                |context, registration| {
                    let handler = match kind {
                        1 => &registration.callbacks.start,
                        2 => &registration.callbacks.completed,
                        3 => &registration.callbacks.deleted,
                        _ => return Err(Error::msg("unknown LVGL animation notification kind")),
                    };
                    if let Some(handler) = handler {
                        handler(context, &registration.animation)?;
                    }
                    Ok(())
                },
            )
        },
    )?;
    linker.func_wrap(
        "lvw",
        "anim_release",
        |mut caller: Caller<'_, Host>, id: u32| {
            release(&mut caller.as_context_mut(), id);
        },
    )?;
    Ok(())
}

impl Runtime {
    /// Start a native animation from an initialized guest descriptor.
    ///
    /// The descriptor may be freed after this returns. Early application can invoke handlers before it returns. Existing exec/custom/get-value/start/completed/deleted callbacks or external data are rejected; the descriptor's native path, variable, and user data are preserved.
    pub fn start_animation(
        &mut self,
        descriptor: UnsafePointer,
        callbacks: AnimationCallbacks,
    ) -> Result<Animation> {
        self.context().start_animation(descriptor, callbacks)
    }

    /// Cancel one animation from this runtime without affecting others sharing its variable.
    pub fn cancel_animation(&mut self, animation: &Animation) -> Result<()> {
        self.context().cancel_animation(animation)
    }
}

impl CallbackContext<'_> {
    fn animation_slot(&mut self, table: Table, dispatch: Func) -> Result<u32> {
        let slot = match self.store.data_mut().animations.free_slots.pop() {
            Some(slot) => slot,
            None => {
                let size = table.size(&self.store);
                let slot = u32::try_from(size)
                    .map_err(|_| Error::msg("LVGL animation table indices exhausted"))?;
                if slot == 0 {
                    return Err(Error::msg("LVGL animation table has no native entries"));
                }
                table.grow(&mut self.store, 1, Ref::Func(None))?;
                slot
            }
        };
        let result = (|| {
            let function = match self.store.data().animations.wrappers.get(&slot).copied() {
                Some(function) => function,
                None => {
                    let module = self
                        .store
                        .data()
                        .animations
                        .module
                        .as_ref()
                        .expect("validated animation wrapper")
                        .clone();
                    let global = Global::new(
                        &mut self.store,
                        GlobalType::new(ValType::I32, Mutability::Const),
                        Val::I32(slot as i32),
                    )?;
                    let wrapper =
                        Instance::new(&mut self.store, &module, &[dispatch.into(), global.into()])?;
                    let function = *wrapper
                        .get_typed_func::<(u32, i32), ()>(&mut self.store, "exec")?
                        .func();
                    self.store
                        .data_mut()
                        .animations
                        .wrappers
                        .insert(slot, function);
                    function
                }
            };
            table.set(&mut self.store, u64::from(slot), Ref::Func(Some(function)))?;
            Ok(slot)
        })();
        if result.is_err() {
            self.store.data_mut().animations.retired_slots.push(slot);
            flush_slots(&mut self.store);
        }
        result
    }

    /// Copy an initialized descriptor into a managed native animation.
    ///
    /// Query, start, early-exec, and terminal callbacks cannot cancel still-active animations. Tick exec callbacks can cancel themselves or other animations. Raw deletion of the current animation, its variable object, or an ancestor during a protected phase violates native LVGL preconditions.
    pub fn start_animation(
        &mut self,
        descriptor: UnsafePointer,
        callbacks: AnimationCallbacks,
    ) -> Result<Animation> {
        self.store.data().ensure_ready()?;
        self.core
            .instance
            .get_typed_func::<(u32, u32, u32, u32), u32>(&mut self.store, "lvw_anim_start")?;
        self.core
            .instance
            .get_typed_func::<(u32, u32), i32>(&mut self.store, "lvw_anim_delete")?;
        let dispatch = *self
            .core
            .instance
            .get_typed_func::<(u32, u32, i32), ()>(&mut self.store, "lvw_anim_exec")?
            .func();
        let table = self
            .core
            .instance
            .get_table(&mut self.store, "__indirect_function_table")
            .ok_or_else(|| Error::msg("missing Wasm animation table: __indirect_function_table"))?;
        let ty = table.ty(&self.store);
        if ty.is_64() || !RefType::eq(ty.element(), &RefType::FUNCREF) {
            return Err(Error::msg("LVGL animation requires a wasm32 funcref table"));
        }
        self.store.data_mut().animations.table = Some(table);
        if self.store.data().animations.module.is_none() {
            let module =
                Module::from_binary(self.store.engine(), crate::generated::ANIMATION_EXEC_MODULE)?;
            self.store.data_mut().animations.module = Some(module);
        }
        let id = u32::try_from(self.store.data().animations.next_id)
            .map_err(|_| Error::msg("LVGL animation callback IDs exhausted"))?;
        let slot = self.animation_slot(table, dispatch)?;
        self.store.data_mut().animations.next_id += 1;
        let animation = Animation {
            owner: Arc::clone(&self.store.data().lifetime),
            id,
            lifetime: Arc::new(Lifetime {
                pointer: AtomicU32::new(0),
                alive: AtomicBool::new(true),
                finishing: AtomicBool::new(false),
            }),
        };
        let flags = callbacks.flags();
        self.store.data_mut().animations.registrations.insert(
            id,
            Registration {
                animation: animation.clone(),
                callbacks,
                slot,
            },
        );
        match self.call_raw::<_, u32>("lvw_anim_start", (descriptor.0, id, slot, flags)) {
            Ok(pointer) if pointer != 0 => {
                if let Err(error) = animation.bind(pointer) {
                    self.poison(|| error.to_string());
                    return Err(error);
                }
                Ok(animation)
            }
            result => {
                release(&mut self.store, id);
                match result {
                    Ok(_) => Err(Error::msg("lvw_anim_start failed")),
                    Err(error) => Err(error),
                }
            }
        }
    }

    /// Cancel an animation owned by this runtime.
    ///
    /// Released and finishing animations are already cancelled. Protected callback phases reject cancellation with a recoverable error. Closing permits host registration cleanup without reentering the guest.
    pub fn cancel_animation(&mut self, animation: &Animation) -> Result<()> {
        if !Arc::ptr_eq(&self.store.data().lifetime, &animation.owner) {
            return Err(Error::msg("LVGL animation belongs to another runtime"));
        }
        if !animation.lifetime.alive.load(Ordering::SeqCst)
            || animation.lifetime.finishing.load(Ordering::SeqCst)
        {
            return Ok(());
        }
        if matches!(self.store.data().state, State::Closing) {
            release(&mut self.store, animation.id);
            return Ok(());
        }
        self.store.data().ensure_ready()?;
        let status: i32 =
            self.call_raw("lvw_anim_delete", (animation.pointer()?.0, animation.id))?;
        if status != 0 {
            return Err(Error::msg(format!("lvw_anim_delete failed ({status})")));
        }
        release(&mut self.store, animation.id);
        Ok(())
    }
}
