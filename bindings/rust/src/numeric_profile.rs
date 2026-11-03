//! Validate trusted i32 interface contracts before compiling a module graph.

use std::collections::{HashMap, HashSet};
use std::fmt;

use crate::module_graph::ModuleRole;
use crate::module_graph_check::{
    CompiledModuleGraphError, CompiledModuleGraphReport, FeatureModuleGraphError,
    check_prepared_feature_graph, compile_prepared_feature_graph,
};
use crate::module_manifest::{
    ModuleExternalType, ModuleInterface, ModuleManifestError, ModuleManifestInput,
    PreparedModuleGraph, SnapshotModule, prepare_module_manifests,
};
use crate::numeric_wasi::{NumericWasiOptions, NumericWasiService};
use crate::wasm_facts::{WasmExternal, WasmValueType};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NumericResult {
    I32,
    Void,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NumericFunctionContract {
    pub name: String,
    pub params: usize,
    pub result: NumericResult,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NumericModuleContract {
    pub id: String,
    pub sha256: String,
    pub interface: ModuleInterface,
    pub exports: Vec<NumericFunctionContract>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NumericHostContract {
    pub id: String,
    pub interface: ModuleInterface,
    pub exports: Vec<NumericFunctionContract>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NumericLimits {
    pub max_memory_pages: u64,
    pub max_total_memory_pages: u64,
    pub max_table_elements: u64,
    pub max_total_table_elements: u64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NumericProfile {
    pub modules: Vec<NumericModuleContract>,
    pub hosts: Vec<NumericHostContract>,
    pub limits: NumericLimits,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NumericPreflightReport {
    app_id: String,
    graph: CompiledModuleGraphReport,
}
impl NumericPreflightReport {
    pub fn app_id(&self) -> &str {
        &self.app_id
    }
    pub fn graph(&self) -> &CompiledModuleGraphReport {
        &self.graph
    }
}
#[derive(Debug)]
pub enum NumericPreflightError {
    Manifest(ModuleManifestError),
    Numeric(String),
    Feature(FeatureModuleGraphError),
    Engine(CompiledModuleGraphError),
}
impl fmt::Display for NumericPreflightError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Manifest(error) => write!(f, "module manifest inspection failed: {error}"),
            Self::Numeric(error) => write!(f, "numeric profile rejected: {error}"),
            Self::Feature(error) => write!(f, "feature graph inspection failed: {error}"),
            Self::Engine(error) => write!(f, "module graph compilation failed: {error}"),
        }
    }
}
impl std::error::Error for NumericPreflightError {}
type Result<T> = std::result::Result<T, NumericPreflightError>;
fn fail(message: impl Into<String>) -> NumericPreflightError {
    NumericPreflightError::Numeric(message.into())
}

fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with(whitespace)
        && !name.ends_with(whitespace)
        && name.encode_utf16().take(4097).count() <= 4096
}
fn reserved(name: &str) -> bool {
    matches!(
        name,
        "_initialize" | "_start" | "module_init" | "module_close" | "app_run"
    )
}
fn valid_interface(interface: &ModuleInterface) -> bool {
    valid_name(&interface.name) && interface.version != 0
}
fn same_function(contract: &NumericFunctionContract, ty: &ModuleExternalType) -> bool {
    let ModuleExternalType::Function { params, results } = ty else {
        return false;
    };
    params.len() == contract.params
        && params.iter().all(|ty| *ty == WasmValueType::I32)
        && match contract.result {
            NumericResult::I32 => results.as_slice() == [WasmValueType::I32],
            NumericResult::Void => results.is_empty(),
        }
}
fn contracts(
    items: &[NumericFunctionContract],
    allow_void: bool,
    entries: &mut usize,
) -> Result<()> {
    if items.len() > 4096 {
        return Err(fail("numeric function count exceeded"));
    }
    *entries = entries
        .checked_add(items.len())
        .filter(|n| *n <= 100_000)
        .ok_or_else(|| fail("numeric profile entry limit exceeded"))?;
    let mut names = HashSet::new();
    for item in items {
        if !valid_name(&item.name)
            || reserved(&item.name)
            || !names.insert(item.name.as_str())
            || item.params > 64
            || (!allow_void && item.result == NumericResult::Void)
        {
            return Err(fail(format!(
                "invalid numeric function contract {:?}",
                item.name
            )));
        }
        *entries = entries
            .checked_add(item.params + usize::from(item.result == NumericResult::I32))
            .filter(|n| *n <= 100_000)
            .ok_or_else(|| fail("numeric profile entry limit exceeded"))?;
    }
    Ok(())
}
fn entrypoint(
    module: &SnapshotModule<'_>,
    name: &str,
    params: &[WasmValueType],
    results: &[WasmValueType],
    required: bool,
) -> Result<()> {
    let Some(item) = module.facts.exports.iter().find(|item| item.name == name) else {
        return if required {
            Err(fail(format!("{:?}: missing {name}", module.manifest.id)))
        } else {
            Ok(())
        };
    };
    let WasmExternal::Function { index, type_index } = item.external else {
        return Err(fail(format!(
            "{:?}: {name} must be an owned function",
            module.manifest.id
        )));
    };
    if module
        .facts
        .functions
        .get(index as usize)
        .is_none_or(|function| function.imported)
    {
        return Err(fail(format!(
            "{:?}: {name} must be an owned function",
            module.manifest.id
        )));
    }
    let ty = &module.facts.types[type_index as usize];
    if ty.params != params || ty.results != results {
        return Err(fail(format!(
            "{:?}: invalid {name} signature",
            module.manifest.id
        )));
    }
    Ok(())
}

fn check_profile<'a>(
    prepared: &PreparedModuleGraph<'_>,
    profile: &'a NumericProfile,
    wasi: Option<&NumericWasiOptions>,
) -> Result<&'a str> {
    if profile.modules.len() > 256 || profile.hosts.len() > 256 {
        return Err(fail("numeric provider limit exceeded"));
    }
    let limits = profile.limits;
    if limits.max_memory_pages > 65536
        || limits.max_total_memory_pages > 65536 * 256
        || limits.max_table_elements > u64::from(u32::MAX)
        || limits.max_total_table_elements > u64::from(u32::MAX) * 256
    {
        return Err(fail("invalid numeric resource limit"));
    }
    let mut entries = 0usize;
    let mut modules = HashMap::new();
    for item in &profile.modules {
        if !valid_name(&item.id)
            || !valid_interface(&item.interface)
            || item.sha256.len() != 64
            || !item
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || modules.insert(item.id.as_str(), item).is_some()
        {
            return Err(fail(format!(
                "invalid numeric module identity {:?}",
                item.id
            )));
        }
        contracts(&item.exports, false, &mut entries)?;
    }
    let mut hosts = HashMap::new();
    for item in &profile.hosts {
        if !valid_name(&item.id)
            || !valid_interface(&item.interface)
            || hosts.insert(item.id.as_str(), item).is_some()
            || modules.contains_key(item.id.as_str())
        {
            return Err(fail(format!("invalid numeric host {:?}", item.id)));
        }
        contracts(&item.exports, true, &mut entries)?;
    }
    if let Some(wasi) = wasi
        && (!wasi.valid()
            || !valid_name(&wasi.id)
            || !valid_interface(&wasi.interface)
            || hosts.contains_key(wasi.id.as_str())
            || modules.contains_key(wasi.id.as_str()))
    {
        return Err(fail("invalid numeric WASI options"));
    }
    if modules.len() != prepared.modules.len()
        || hosts.len() + usize::from(wasi.is_some()) != prepared.hosts.len()
    {
        return Err(fail("numeric provider inventory differs"));
    }
    let mut authorized = HashMap::new();
    for contract in &profile.modules {
        for function in &contract.exports {
            authorized.insert((contract.id.as_str(), function.name.as_str()), function);
        }
    }
    for contract in &profile.hosts {
        for function in &contract.exports {
            authorized.insert((contract.id.as_str(), function.name.as_str()), function);
        }
    }
    let mut app = None;
    let mut memory_total = 0u64;
    let mut table_total = 0u64;
    for module in &prepared.modules {
        let id = &module.manifest.id;
        let contract = modules
            .get(id.as_str())
            .ok_or_else(|| fail(format!("{id:?}: module is not authorized")))?;
        if contract.sha256 != module.facts.sha256 || contract.interface != module.manifest.interface
        {
            return Err(fail(format!("{id:?}: module identity is not authorized")));
        }
        if module.manifest.role == ModuleRole::App {
            if app.replace(contract.id.as_str()).is_some() {
                return Err(fail("numeric profile requires exactly one app"));
            }
            entrypoint(
                module,
                "app_run",
                &[WasmValueType::I32],
                &[WasmValueType::I32],
                true,
            )?;
        }
        if module.facts.start.is_some() {
            return Err(fail(format!("{id:?}: start section is unsupported")));
        }
        if module
            .facts
            .exports
            .iter()
            .any(|item| item.name == "_start")
        {
            return Err(fail(format!("{id:?}: _start is unsupported")));
        }
        entrypoint(module, "_initialize", &[], &[], false)?;
        entrypoint(module, "module_init", &[], &[WasmValueType::I32], true)?;
        entrypoint(module, "module_close", &[], &[WasmValueType::I32], true)?;
        if module.facts.imports.iter().any(|item| {
            (wasi.is_none() && item.module == "wasi_snapshot_preview1")
                || item.module == "wasi_unstable"
                || item.module.starts_with("wasi:")
        }) {
            return Err(fail(format!("{id:?}: WASI is unsupported")));
        }
        for item in &module.facts.memories {
            let max = item
                .ty
                .maximum_pages
                .ok_or_else(|| fail(format!("{id:?}: memory maximum is required")))?
                as u64;
            if item.imported || item.ty.shared || max > limits.max_memory_pages {
                return Err(fail(format!("{id:?}: numeric memory limit exceeded")));
            }
            memory_total = memory_total
                .checked_add(max)
                .ok_or_else(|| fail("numeric memory total overflow"))?;
        }
        for item in &module.facts.tables {
            let max = item
                .ty
                .maximum
                .ok_or_else(|| fail(format!("{id:?}: table maximum is required")))?
                as u64;
            if item.imported || max > limits.max_table_elements {
                return Err(fail(format!("{id:?}: numeric table limit exceeded")));
            }
            table_total = table_total
                .checked_add(max)
                .ok_or_else(|| fail("numeric table total overflow"))?;
        }
        let exports: HashMap<_, _> = module
            .manifest
            .exports
            .iter()
            .map(|item| (item.name.as_str(), &item.ty))
            .collect();
        let wasi_imports: HashSet<u32> = if wasi.is_some() {
            module
                .facts
                .imports
                .iter()
                .filter_map(|import| match import.external {
                    WasmExternal::Function { index, .. }
                        if import.module == "wasi_snapshot_preview1" =>
                    {
                        Some(index)
                    }
                    _ => None,
                })
                .collect()
        } else {
            HashSet::new()
        };
        let wasi_exports: HashSet<&str> = module
            .facts
            .exports
            .iter()
            .filter_map(|export| match export.external {
                WasmExternal::Function { index, .. } if wasi_imports.contains(&index) => {
                    Some(export.name.as_str())
                }
                _ => None,
            })
            .collect();
        for function in &contract.exports {
            if !exports
                .get(function.name.as_str())
                .is_some_and(|ty| same_function(function, ty))
            {
                return Err(fail(format!(
                    "{id:?}: numeric export contract differs for {:?}",
                    function.name
                )));
            }
            if wasi_exports.contains(function.name.as_str()) {
                return Err(fail(format!(
                    "{id:?}: WASI imports cannot be numeric exports"
                )));
            }
        }
    }
    let app = app.ok_or_else(|| fail("numeric profile requires exactly one app"))?;
    if memory_total > limits.max_total_memory_pages || table_total > limits.max_total_table_elements
    {
        return Err(fail("numeric environment resource limit exceeded"));
    }
    for host in prepared.hosts {
        if let Some(wasi) = wasi.filter(|wasi| wasi.id == host.id) {
            if wasi.interface != host.interface
                || wasi.allowed.len() != host.exports.len()
                || host.exports.iter().any(|item| {
                    NumericWasiService::from_name(&item.name).is_none_or(|service| {
                        !wasi.allowed.contains(&service) || !service.matches(&item.ty)
                    })
                })
            {
                return Err(fail("numeric WASI host contract differs"));
            }
            continue;
        }
        let contract = hosts
            .get(host.id.as_str())
            .ok_or_else(|| fail(format!("{:?}: host is not authorized", host.id)))?;
        if contract.interface != host.interface || contract.exports.len() != host.exports.len() {
            return Err(fail(format!(
                "{:?}: numeric host contract differs",
                host.id
            )));
        }
        let exports: HashMap<_, _> = host
            .exports
            .iter()
            .map(|item| (item.name.as_str(), &item.ty))
            .collect();
        for function in &contract.exports {
            if !exports
                .get(function.name.as_str())
                .is_some_and(|ty| same_function(function, ty))
            {
                return Err(fail(format!(
                    "{:?}: numeric host export differs for {:?}",
                    host.id, function.name
                )));
            }
        }
    }
    for module in &prepared.modules {
        for requirement in &module.manifest.requires {
            for item in &requirement.imports {
                if item.module == "wasi_snapshot_preview1"
                    || wasi.is_some_and(|wasi| requirement.provider == wasi.id)
                {
                    if !wasi.is_some_and(|wasi| {
                        requirement.provider == wasi.id
                            && item.module == "wasi_snapshot_preview1"
                            && item.provider_export == item.name
                            && NumericWasiService::from_name(&item.name).is_some_and(|service| {
                                wasi.allowed.contains(&service) && service.matches(&item.ty)
                            })
                    }) {
                        return Err(fail(format!(
                            "{:?}: numeric WASI import is not authorized",
                            module.manifest.id
                        )));
                    }
                    continue;
                }
                if reserved(&item.provider_export) {
                    return Err(fail(format!(
                        "{:?}: lifecycle import is unsupported",
                        module.manifest.id
                    )));
                }
                let function =
                    authorized.get(&(requirement.provider.as_str(), item.provider_export.as_str()));
                if !function.is_some_and(|function| same_function(function, &item.ty)) {
                    return Err(fail(format!(
                        "{:?}: numeric import is not authorized",
                        module.manifest.id
                    )));
                }
            }
        }
    }
    Ok(app)
}

pub(crate) struct PreparedNumericGraph<'a> {
    _prepared: PreparedModuleGraph<'a>,
    _engine: wasmtime::Engine,
    _modules: Vec<wasmtime::Module>,
    _profile: &'a NumericProfile,
    report: NumericPreflightReport,
}
impl<'a> PreparedNumericGraph<'a> {
    pub(crate) fn into_parts(
        self,
    ) -> (
        PreparedModuleGraph<'a>,
        wasmtime::Engine,
        Vec<wasmtime::Module>,
        &'a NumericProfile,
    ) {
        (self._prepared, self._engine, self._modules, self._profile)
    }
}

/// Validate trusted numeric contracts and compile the same private snapshots without creating an instance. The report does not authorize execution, and i32 contracts must exclude pointer and handle semantics.
pub fn preflight_numeric_graph(
    input: &ModuleManifestInput<'_>,
    profile: &NumericProfile,
    allowed: &[&str],
) -> Result<NumericPreflightReport> {
    let prepared = prepare_numeric_graph(input, profile, allowed)?;
    Ok(prepared.report)
}

pub(crate) fn prepare_numeric_graph<'a>(
    input: &'a ModuleManifestInput<'a>,
    profile: &'a NumericProfile,
    allowed: &[&str],
) -> Result<PreparedNumericGraph<'a>> {
    prepare_numeric_graph_with_wasi(input, profile, allowed, None)
}

/// Validate and compile a numeric graph with a bounded WASI provider without instantiating it.
pub fn preflight_numeric_graph_with_wasi(
    input: &ModuleManifestInput<'_>,
    profile: &NumericProfile,
    allowed: &[&str],
    wasi: &NumericWasiOptions,
) -> Result<NumericPreflightReport> {
    Ok(prepare_numeric_graph_with_wasi(input, profile, allowed, Some(wasi))?.report)
}

pub(crate) fn prepare_numeric_graph_with_wasi<'a>(
    input: &'a ModuleManifestInput<'a>,
    profile: &'a NumericProfile,
    allowed: &[&str],
    wasi: Option<&NumericWasiOptions>,
) -> Result<PreparedNumericGraph<'a>> {
    let prepared = prepare_module_manifests(input).map_err(NumericPreflightError::Manifest)?;
    let app_id = check_profile(&prepared, profile, wasi)?.to_owned();
    let checked =
        check_prepared_feature_graph(prepared, allowed).map_err(NumericPreflightError::Feature)?;
    let (prepared, engine, modules, graph) =
        compile_prepared_feature_graph(checked).map_err(NumericPreflightError::Engine)?;
    Ok(PreparedNumericGraph {
        _prepared: prepared,
        _engine: engine,
        _modules: modules,
        _profile: profile,
        report: NumericPreflightReport { app_id, graph },
    })
}
