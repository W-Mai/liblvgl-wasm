//! Run trusted numeric module graphs with isolated Wasm instances.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use crate::module_manifest::ModuleManifestInput;
use crate::numeric_profile::{NumericProfile, prepare_numeric_graph_with_wasi};
use crate::numeric_wasi::{NumericWasiOptions, NumericWasiOutput, NumericWasiService, WasiState};
use wasmtime::{Caller, Extern, ExternType, Func, Instance, Store, TypedFunc, Val};

#[derive(Clone, Debug)]
pub struct NumericEnvironmentId(Arc<()>);
impl PartialEq for NumericEnvironmentId {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for NumericEnvironmentId {}

/// A synchronous numeric host instance for one consumer and environment.
pub trait NumericHostInstance {
    fn call(&mut self, name: &str, args: &[i32]) -> Result<Option<i32>, String>;
    fn close(&mut self) -> Result<(), String>;
}

/// Create host instances after the entire graph has passed preflight and compilation.
pub trait NumericHostFactory {
    fn create(
        &mut self,
        consumer_id: &str,
        environment: NumericEnvironmentId,
    ) -> Result<Box<dyn NumericHostInstance>, String>;
}

pub struct NumericHostBinding<'a> {
    pub id: String,
    pub factory: &'a mut dyn NumericHostFactory,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NumericEnvironmentState {
    Ready,
    Closing,
    Poisoned,
    Closed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NumericEnvironmentError {
    message: String,
    cleanup_errors: Vec<String>,
    exit_code: Option<u32>,
}
impl NumericEnvironmentError {
    pub fn message(&self) -> &str {
        &self.message
    }
    pub fn cleanup_errors(&self) -> &[String] {
        &self.cleanup_errors
    }
    pub fn exit_code(&self) -> Option<u32> {
        self.exit_code
    }
}
impl fmt::Display for NumericEnvironmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)?;
        for error in &self.cleanup_errors {
            write!(f, "; cleanup: {error}")?;
        }
        Ok(())
    }
}
impl std::error::Error for NumericEnvironmentError {}
fn numeric_error(message: impl Into<String>) -> NumericEnvironmentError {
    NumericEnvironmentError {
        message: message.into(),
        cleanup_errors: Vec::new(),
        exit_code: None,
    }
}
pub(crate) fn panic_message(panic: Box<dyn std::any::Any + Send>) -> String {
    let mut message = if let Some(message) = panic.downcast_ref::<&str>() {
        format!("panic: {message}")
    } else if let Some(message) = panic.downcast_ref::<String>() {
        format!("panic: {message}")
    } else {
        "panic with non-string payload".into()
    };
    if let Err(payload) = catch_unwind(AssertUnwindSafe(|| drop(panic))) {
        // The second payload may also panic on drop; it cannot be safely inspected or dropped.
        std::mem::forget(payload);
        message.push_str("; panic payload drop panicked");
    }
    message
}

struct HostSlot {
    instance: Option<Box<dyn NumericHostInstance>>,
}
#[derive(Default)]
pub(crate) struct HostState {
    hosts: Vec<HostSlot>,
    pub(crate) failure: Option<String>,
    pub(crate) exit_code: Option<u32>,
    pub(crate) wasi: Option<WasiState>,
}
impl HostState {
    pub(crate) fn poison(&mut self, message: String) -> String {
        if self.failure.is_none() {
            self.failure = Some(message);
        }
        self.failure.as_ref().expect("latched failure").clone()
    }
}

fn release_hosts(store: &mut Store<HostState>) -> Vec<String> {
    let mut failures = Vec::new();
    if let Some(wasi) = &mut store.data_mut().wasi {
        for slot in &mut wasi.slots {
            slot.memory = None;
            slot.fds.fill(false);
        }
    }
    for slot in store.data_mut().hosts.iter_mut().rev() {
        if let Some(mut host) = slot.instance.take() {
            match catch_unwind(AssertUnwindSafe(|| host.close())) {
                Ok(Ok(())) => (),
                Ok(Err(message)) => failures.push(message),
                Err(panic) => failures.push(panic_message(panic)),
            }
            if let Err(panic) = catch_unwind(AssertUnwindSafe(|| drop(host))) {
                failures.push(panic_message(panic));
            }
        }
    }
    store.data_mut().hosts.clear();
    if let Some(mut wasi) = store.data_mut().wasi.take()
        && let Some(output) = wasi.output.take()
        && let Err(panic) = catch_unwind(AssertUnwindSafe(|| drop(output)))
    {
        failures.push(panic_message(panic));
    }
    failures
}

fn call0(store: &mut Store<HostState>, function: &TypedFunc<(), i32>) -> Result<i32, String> {
    let outcome = catch_unwind(AssertUnwindSafe(|| function.call(&mut *store, ())));
    if let Some(message) = &store.data().failure {
        if let Err(panic) = outcome {
            return Err(format!("{message}; subsequent {}", panic_message(panic)));
        }
        return Err(message.clone());
    }
    match outcome {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(store
            .data_mut()
            .poison(format!("guest call failed: {error:#}"))),
        Err(panic) => Err(store.data_mut().poison(panic_message(panic))),
    }
}
fn call_void(store: &mut Store<HostState>, function: &TypedFunc<(), ()>) -> Result<(), String> {
    let outcome = catch_unwind(AssertUnwindSafe(|| function.call(&mut *store, ())));
    if let Some(message) = &store.data().failure {
        if let Err(panic) = outcome {
            return Err(format!("{message}; subsequent {}", panic_message(panic)));
        }
        return Err(message.clone());
    }
    match outcome {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(store
            .data_mut()
            .poison(format!("guest call failed: {error:#}"))),
        Err(panic) => Err(store.data_mut().poison(panic_message(panic))),
    }
}

struct LiveModule {
    id: String,
    close: TypedFunc<(), i32>,
    wasi_slot: Option<usize>,
}

fn close_wasi_slot(store: &mut Store<HostState>, slot: Option<usize>) {
    if let Some(slot) = slot {
        let slot = &mut store.data_mut().wasi.as_mut().expect("WASI state").slots[slot];
        slot.memory = None;
        slot.fds.fill(false);
    }
}

fn rollback(
    store: &mut Store<HostState>,
    initialized: &mut Vec<LiveModule>,
    failure: &mut NumericEnvironmentError,
) {
    while let Some(previous) = initialized.last() {
        match call0(store, &previous.close) {
            Ok(0) => {
                close_wasi_slot(store, previous.wasi_slot);
                initialized.pop();
            }
            Ok(code) => {
                failure
                    .cleanup_errors
                    .push(format!("{:?}: module_close returned {code}", previous.id));
                break;
            }
            Err(message) => {
                failure.cleanup_errors.push(message);
                break;
            }
        }
    }
}

/// An environment that owns a private Store and its numeric module instances.
pub struct NumericEnvironment {
    store: Option<Store<HostState>>,
    initialized: Vec<LiveModule>,
    app: TypedFunc<i32, i32>,
    state: NumericEnvironmentState,
    failure: Option<NumericEnvironmentError>,
}
impl fmt::Debug for NumericEnvironment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NumericEnvironment")
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}
impl NumericEnvironment {
    pub fn state(&self) -> NumericEnvironmentState {
        self.state
    }
    fn failure(&self) -> NumericEnvironmentError {
        self.failure
            .clone()
            .unwrap_or_else(|| numeric_error("numeric environment is unavailable"))
    }
    fn poison(&mut self, message: String) -> NumericEnvironmentError {
        if self.failure.is_none() {
            self.failure = Some(numeric_error(message));
        }
        self.state = NumericEnvironmentState::Poisoned;
        if let Some(mut store) = self.store.take() {
            self.failure.as_mut().expect("latched failure").exit_code = store.data().exit_code;
            self.failure
                .as_mut()
                .expect("latched failure")
                .cleanup_errors
                .extend(release_hosts(&mut store));
        }
        self.initialized.clear();
        self.failure()
    }
    /// Run the app with one signed i32 value.
    pub fn run(&mut self, value: i32) -> Result<i32, NumericEnvironmentError> {
        if self.state == NumericEnvironmentState::Poisoned {
            return Err(self.failure());
        }
        if self.state != NumericEnvironmentState::Ready {
            return Err(numeric_error("numeric environment is not ready"));
        }
        let store = self.store.as_mut().expect("ready store");
        let outcome = catch_unwind(AssertUnwindSafe(|| self.app.call(&mut *store, value)));
        if let Some(message) = store.data().failure.clone() {
            if let Err(panic) = outcome {
                return Err(self.poison(format!("{message}; subsequent {}", panic_message(panic))));
            }
            return Err(self.poison(message));
        }
        match outcome {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(self.poison(format!("guest call failed: {error:#}"))),
            Err(panic) => Err(self.poison(panic_message(panic))),
        }
    }
    /// Close initialized modules and hosts in reverse order. Repeated close after success is a no-op.
    pub fn close(&mut self) -> Result<(), NumericEnvironmentError> {
        if self.state == NumericEnvironmentState::Closed {
            return Ok(());
        }
        if self.state == NumericEnvironmentState::Poisoned {
            return Err(self.failure());
        }
        if self.state != NumericEnvironmentState::Ready {
            return Err(numeric_error("numeric environment is not ready"));
        }
        self.state = NumericEnvironmentState::Closing;
        while let Some(module) = self.initialized.last() {
            let id = module.id.clone();
            let result = call0(self.store.as_mut().expect("closing store"), &module.close);
            match result {
                Ok(0) => {
                    close_wasi_slot(
                        self.store.as_mut().expect("closing store"),
                        module.wasi_slot,
                    );
                    self.initialized.pop();
                }
                Ok(status) => {
                    return Err(self.poison(format!("{id:?}: module_close returned {status}")));
                }
                Err(message) => return Err(self.poison(message)),
            }
        }
        let mut store = self.store.take().expect("closing store");
        let cleanup = release_hosts(&mut store);
        if !cleanup.is_empty() {
            self.state = NumericEnvironmentState::Poisoned;
            self.failure = Some(NumericEnvironmentError {
                message: "numeric host cleanup failed".into(),
                cleanup_errors: cleanup,
                exit_code: None,
            });
            return Err(self.failure());
        }
        self.state = NumericEnvironmentState::Closed;
        Ok(())
    }
}
impl Drop for NumericEnvironment {
    fn drop(&mut self) {
        if let Some(mut store) = self.store.take() {
            let _ = release_hosts(&mut store);
        }
    }
}

fn host_function(
    store: &mut Store<HostState>,
    ty: wasmtime::FuncType,
    host_index: usize,
    name: String,
) -> Result<Func, String> {
    Func::try_new(
        store,
        ty,
        move |mut caller: Caller<'_, HostState>, values: &[Val], results: &mut [Val]| {
            if let Some(message) = &caller.data().failure {
                return Err(wasmtime::Error::msg(message.clone()));
            }
            let mut args = Vec::with_capacity(values.len());
            for value in values {
                match value {
                    Val::I32(value) => args.push(*value),
                    _ => return Err(wasmtime::Error::msg("invalid numeric host argument")),
                }
            }
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                caller
                    .data_mut()
                    .hosts
                    .get_mut(host_index)
                    .and_then(|slot| slot.instance.as_mut())
                    .ok_or_else(|| "numeric host is unavailable".to_owned())?
                    .call(&name, &args)
            }));
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
                        caller
                            .data_mut()
                            .poison("invalid numeric host result".into()),
                    ));
                }
            }
            if let Some(message) = &caller.data().failure {
                return Err(wasmtime::Error::msg(message.clone()));
            }
            Ok(())
        },
    )
    .map_err(|error| format!("numeric host creation failed: {error:#}"))
}

/// Load a trusted graph after complete preflight. Host functions receive only numeric values; this does not provide CPU, memory, or time execution limits.
pub fn load_numeric_environment(
    input: &ModuleManifestInput<'_>,
    profile: &NumericProfile,
    allowed: &[&str],
    factories: &mut [NumericHostBinding<'_>],
) -> Result<NumericEnvironment, NumericEnvironmentError> {
    load_numeric_environment_internal(input, profile, allowed, factories, None, &mut None)
}

/// Load a numeric graph with a bounded WASI Preview 1 provider and a synchronous output sink.
pub fn load_numeric_environment_with_wasi(
    input: &ModuleManifestInput<'_>,
    profile: &NumericProfile,
    allowed: &[&str],
    factories: &mut [NumericHostBinding<'_>],
    wasi: &NumericWasiOptions,
    output: Box<dyn NumericWasiOutput>,
) -> Result<NumericEnvironment, NumericEnvironmentError> {
    let mut output = Some(output);
    let mut result = match catch_unwind(AssertUnwindSafe(|| {
        load_numeric_environment_internal(
            input,
            profile,
            allowed,
            factories,
            Some(wasi),
            &mut output,
        )
    })) {
        Ok(result) => result,
        Err(panic) => Err(numeric_error(panic_message(panic))),
    };
    if let Some(output) = output
        && let Err(panic) = catch_unwind(AssertUnwindSafe(|| drop(output)))
    {
        match &mut result {
            Err(error) => error.cleanup_errors.push(panic_message(panic)),
            Ok(_) => unreachable!("output is consumed by a loaded environment"),
        }
    }
    result
}

fn load_numeric_environment_internal(
    input: &ModuleManifestInput<'_>,
    profile: &NumericProfile,
    allowed: &[&str],
    factories: &mut [NumericHostBinding<'_>],
    wasi: Option<&NumericWasiOptions>,
    output: &mut Option<Box<dyn NumericWasiOutput>>,
) -> Result<NumericEnvironment, NumericEnvironmentError> {
    let prepared = prepare_numeric_graph_with_wasi(input, profile, allowed, wasi)
        .map_err(|error| numeric_error(error.to_string()))?;
    let (prepared, engine, compiled, profile) = prepared.into_parts();
    let mut factory_indices = HashMap::new();
    for (index, binding) in factories.iter().enumerate() {
        if factory_indices.insert(binding.id.as_str(), index).is_some() {
            return Err(numeric_error("duplicate numeric host factory"));
        }
    }
    if factory_indices.len() != profile.hosts.len()
        || profile
            .hosts
            .iter()
            .any(|host| !factory_indices.contains_key(host.id.as_str()))
    {
        return Err(numeric_error("numeric host factory inventory differs"));
    }
    let factory_indices: HashMap<String, usize> = factory_indices
        .into_iter()
        .map(|(name, index)| (name.to_owned(), index))
        .collect();
    let module_by_id: HashMap<
        &str,
        (
            &crate::module_manifest::SnapshotModule<'_>,
            &wasmtime::Module,
        ),
    > = prepared
        .modules
        .iter()
        .zip(&compiled)
        .map(|(item, compiled)| (item.manifest.id.as_str(), (item, compiled)))
        .collect();
    let host_ids: HashSet<&str> = profile.hosts.iter().map(|host| host.id.as_str()).collect();
    let mut store = Store::new(&engine, HostState::default());
    let environment_id = NumericEnvironmentId(Arc::new(()));
    if let Some(wasi) = wasi {
        store.data_mut().wasi = Some(WasiState {
            options: wasi.clone(),
            output: output.take(),
            slots: Vec::new(),
            used: 0,
            environment: environment_id.clone(),
        });
    }
    let mut host_slots: HashMap<(&str, &str), usize> = HashMap::new();
    let mut wasi_slots: HashMap<&str, usize> = HashMap::new();
    let mut initialized: Vec<LiveModule> = Vec::new();
    let mut instances: HashMap<&str, Instance> = HashMap::new();
    let mut rollback_permitted = false;
    let mut pending_wasi_slot = None;
    let result = catch_unwind(AssertUnwindSafe(
        || -> Result<TypedFunc<i32, i32>, NumericEnvironmentError> {
            for id in &prepared.order {
                let module = module_by_id[id.as_str()].0;
                for requirement in &module.manifest.requires {
                    if wasi.is_some_and(|wasi| requirement.provider == wasi.id)
                        && !requirement.imports.is_empty()
                    {
                        if !wasi_slots.contains_key(id.as_str()) {
                            let slot = store
                                .data_mut()
                                .wasi
                                .as_mut()
                                .expect("WASI state")
                                .add_slot(id.clone());
                            wasi_slots.insert(id.as_str(), slot);
                        }
                        continue;
                    }
                    if !host_ids.contains(requirement.provider.as_str()) {
                        continue;
                    }
                    let key = (id.as_str(), requirement.provider.as_str());
                    if host_slots.contains_key(&key) {
                        continue;
                    }
                    let index = factory_indices[requirement.provider.as_str()];
                    let outcome = catch_unwind(AssertUnwindSafe(|| {
                        factories[index].factory.create(id, environment_id.clone())
                    }));
                    let host = match outcome {
                        Ok(Ok(host)) => host,
                        Ok(Err(message)) => return Err(numeric_error(message)),
                        Err(panic) => return Err(numeric_error(panic_message(panic))),
                    };
                    let slot = store.data().hosts.len();
                    store.data_mut().hosts.push(HostSlot {
                        instance: Some(host),
                    });
                    host_slots.insert(key, slot);
                }
            }
            let mut app = None;
            for id in &prepared.order {
                rollback_permitted = true;
                pending_wasi_slot = wasi_slots.get(id.as_str()).copied();
                let (record, module) = module_by_id[id.as_str()];
                let mut bindings = HashMap::new();
                for requirement in &record.manifest.requires {
                    for item in &requirement.imports {
                        bindings.insert(
                            (item.module.as_str(), item.name.as_str()),
                            (requirement.provider.as_str(), item.provider_export.as_str()),
                        );
                    }
                }
                let mut imports = Vec::new();
                imports
                    .try_reserve_exact(record.facts.imports.len())
                    .map_err(|_| numeric_error("numeric import allocation failed"))?;
                let mut actual = module.imports();
                for fact in &record.facts.imports {
                    let item = actual
                        .next()
                        .ok_or_else(|| numeric_error("compiled import inventory differs"))?;
                    if item.module() != fact.module || item.name() != fact.name {
                        return Err(numeric_error("compiled import inventory differs"));
                    }
                    let (provider, export) = *bindings
                        .get(&(fact.module.as_str(), fact.name.as_str()))
                        .ok_or_else(|| numeric_error("numeric import binding is missing"))?;
                    let function = if wasi.is_some_and(|wasi| provider == wasi.id) {
                        let ExternType::Func(ty) = item.ty() else {
                            return Err(numeric_error("numeric WASI import is not a function"));
                        };
                        let slot = *wasi_slots
                            .get(id.as_str())
                            .ok_or_else(|| numeric_error("numeric WASI slot is missing"))?;
                        let service = NumericWasiService::from_name(export)
                            .ok_or_else(|| numeric_error("numeric WASI service is missing"))?;
                        crate::numeric_wasi::function(&mut store, ty, slot, service)
                            .map_err(numeric_error)?
                    } else if let Some(slot) = host_slots.get(&(id.as_str(), provider)) {
                        let ExternType::Func(ty) = item.ty() else {
                            return Err(numeric_error("numeric import is not a function"));
                        };
                        host_function(&mut store, ty, *slot, export.to_owned())
                            .map_err(numeric_error)?
                    } else {
                        let instance = instances
                            .get(provider)
                            .ok_or_else(|| numeric_error("numeric provider is not initialized"))?;
                        instance
                            .get_func(&mut store, export)
                            .ok_or_else(|| numeric_error("numeric provider export is missing"))?
                    };
                    imports.push(Extern::Func(function));
                }
                if actual.next().is_some() {
                    return Err(numeric_error("compiled import inventory differs"));
                }
                let instance = match catch_unwind(AssertUnwindSafe(|| {
                    Instance::new(&mut store, module, &imports)
                })) {
                    Ok(Ok(instance)) => instance,
                    Ok(Err(failure)) => {
                        return Err(numeric_error(format!(
                            "{id:?}: instantiation failed: {failure:#}"
                        )));
                    }
                    Err(panic) => {
                        rollback_permitted = false;
                        return Err(numeric_error(panic_message(panic)));
                    }
                };
                let wasi_slot = wasi_slots.get(id.as_str()).copied();
                if let Some(slot) = wasi_slot {
                    let memory = instance
                        .get_memory(&mut store, "memory")
                        .ok_or_else(|| numeric_error("numeric WASI memory is unavailable"))?;
                    store.data_mut().wasi.as_mut().expect("WASI state").slots[slot].memory =
                        Some(memory);
                }
                let close = instance
                    .get_typed_func::<(), i32>(&mut store, "module_close")
                    .map_err(|error| numeric_error(error.to_string()))?;
                let init = instance
                    .get_typed_func::<(), i32>(&mut store, "module_init")
                    .map_err(|error| numeric_error(error.to_string()))?;
                let initialize = instance
                    .get_func(&mut store, "_initialize")
                    .map(|function| function.typed::<(), ()>(&store))
                    .transpose()
                    .map_err(|error| numeric_error(error.to_string()))?;
                let app_function = if record.manifest.role == crate::module_graph::ModuleRole::App {
                    Some(
                        instance
                            .get_typed_func::<i32, i32>(&mut store, "app_run")
                            .map_err(|error| numeric_error(error.to_string()))?,
                    )
                } else {
                    None
                };
                rollback_permitted = false;
                if let Some(initialize) = initialize {
                    call_void(&mut store, &initialize).map_err(numeric_error)?;
                }
                let status = call0(&mut store, &init).map_err(numeric_error)?;
                if status != 0 {
                    let mut failure =
                        numeric_error(format!("{id:?}: module_init returned {status}"));
                    close_wasi_slot(&mut store, wasi_slot);
                    rollback(&mut store, &mut initialized, &mut failure);
                    return Err(failure);
                }
                initialized.push(LiveModule {
                    id: id.clone(),
                    close,
                    wasi_slot,
                });
                pending_wasi_slot = None;
                instances.insert(id.as_str(), instance);
                if let Some(function) = app_function {
                    app = Some(function);
                }
            }
            app.ok_or_else(|| numeric_error("numeric app is missing"))
        },
    ));
    let result = match result {
        Ok(result) => result,
        Err(panic) => {
            rollback_permitted = false;
            Err(numeric_error(panic_message(panic)))
        }
    };
    match result {
        Ok(app) => Ok(NumericEnvironment {
            store: Some(store),
            initialized,
            app,
            state: NumericEnvironmentState::Ready,
            failure: None,
        }),
        Err(mut failure) => {
            if rollback_permitted && store.data().failure.is_none() {
                close_wasi_slot(&mut store, pending_wasi_slot);
                rollback(&mut store, &mut initialized, &mut failure);
            }
            if store.data().failure.as_deref() == Some(failure.message.as_str()) {
                failure.exit_code = store.data().exit_code;
            }
            failure.cleanup_errors.extend(release_hosts(&mut store));
            Err(failure)
        }
    }
}
