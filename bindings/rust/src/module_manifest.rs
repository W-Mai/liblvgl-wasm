//! Static manifest, artifact identity, and interface inspection.

use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt;

use crate::module_graph::{ModuleDeclaration, ModuleGraph, ModuleRole, order_module_graph};
use crate::wasm_facts::{
    WASM_FACTS_MAX_INPUT_BYTES, WasmExternal, WasmFacts, WasmGlobalType, WasmMemoryType,
    WasmTableType, WasmValueType, inspect_wasm_snapshot,
};

const MAX_PROVIDERS: usize = 256;
const MAX_BYTES: usize = 128 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_STRING_UNITS: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleInterface {
    pub name: String,
    pub version: u32,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModuleExternalType {
    Function {
        params: Vec<WasmValueType>,
        results: Vec<WasmValueType>,
    },
    Tag {
        params: Vec<WasmValueType>,
        results: Vec<WasmValueType>,
    },
    Table(WasmTableType),
    Memory(WasmMemoryType),
    Global(WasmGlobalType),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleExport {
    pub name: String,
    pub ty: ModuleExternalType,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleImport {
    pub module: String,
    pub name: String,
    pub provider_export: String,
    pub ty: ModuleExternalType,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestRequirement {
    pub provider: String,
    pub interface: String,
    pub version: u32,
    pub imports: Vec<ModuleImport>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleArtifact {
    pub path: String,
    pub sha256: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleTarget {
    pub abi: String,
    pub features: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleManifest {
    pub schema_version: u32,
    pub kind: String,
    pub id: String,
    pub role: ModuleRole,
    pub artifact: ModuleArtifact,
    pub target: ModuleTarget,
    pub interface: ModuleInterface,
    pub memory_model: String,
    pub requires: Vec<ManifestRequirement>,
    pub exports: Vec<ModuleExport>,
    pub runtime_verification: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleHostProvider {
    pub id: String,
    pub interface: ModuleInterface,
    pub exports: Vec<ModuleExport>,
}
#[derive(Debug)]
pub struct ModuleArtifactInput<'a> {
    pub manifest: ModuleManifest,
    pub bytes: &'a [u8],
}
#[derive(Debug, Default)]
pub struct ModuleManifestInput<'a> {
    pub modules: Vec<ModuleArtifactInput<'a>>,
    pub hosts: Vec<ModuleHostProvider>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManifestCheck {
    Passed,
    NotRun,
}
#[derive(Clone, Debug)]
pub struct ModuleManifestChecks;
impl ModuleManifestChecks {
    pub fn declaration(&self) -> ManifestCheck {
        ManifestCheck::Passed
    }
    pub fn identity(&self) -> ManifestCheck {
        ManifestCheck::Passed
    }
    pub fn interface(&self) -> ManifestCheck {
        ManifestCheck::Passed
    }
    pub fn engine(&self) -> ManifestCheck {
        ManifestCheck::NotRun
    }
    pub fn feature(&self) -> ManifestCheck {
        ManifestCheck::NotRun
    }
    pub fn abi(&self) -> ManifestCheck {
        ManifestCheck::NotRun
    }
    pub fn memory_isolation(&self) -> ManifestCheck {
        ManifestCheck::NotRun
    }
    pub fn host_implementation(&self) -> ManifestCheck {
        ManifestCheck::NotRun
    }
    pub fn runtime(&self) -> ManifestCheck {
        ManifestCheck::NotRun
    }
}
#[derive(Clone, Debug)]
pub struct ModuleManifestModuleReport {
    id: String,
    facts: WasmFacts,
    checks: ModuleManifestChecks,
}
impl ModuleManifestModuleReport {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn facts(&self) -> &WasmFacts {
        &self.facts
    }
    pub fn checks(&self) -> &ModuleManifestChecks {
        &self.checks
    }
}
#[derive(Clone, Debug)]
pub struct ModuleManifestReport {
    order: Vec<String>,
    modules: Vec<ModuleManifestModuleReport>,
}
impl ModuleManifestReport {
    pub fn order(&self) -> &[String] {
        &self.order
    }
    pub fn modules(&self) -> &[ModuleManifestModuleReport] {
        &self.modules
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleManifestError(String);
impl fmt::Display for ModuleManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ModuleManifestError {}
type Result<T> = std::result::Result<T, ModuleManifestError>;
fn fail(message: impl Into<String>) -> ModuleManifestError {
    ModuleManifestError(message.into())
}

#[derive(Default)]
struct Budget {
    entries: usize,
    units: usize,
}
impl Budget {
    fn entries(&mut self, count: usize) -> Result<()> {
        self.entries = self
            .entries
            .checked_add(count)
            .filter(|n| *n <= MAX_ENTRIES)
            .ok_or_else(|| fail("manifest inspection limit: entries"))?;
        Ok(())
    }
    fn string(&mut self, value: &str, nonempty: bool) -> Result<()> {
        if nonempty
            && (value.is_empty() || value.starts_with(whitespace) || value.ends_with(whitespace))
        {
            return Err(fail("invalid manifest string"));
        }
        self.units = self
            .units
            .checked_add(
                value
                    .encode_utf16()
                    .take(MAX_STRING_UNITS - self.units + 1)
                    .count(),
            )
            .filter(|n| *n <= MAX_STRING_UNITS)
            .ok_or_else(|| fail("manifest inspection limit: string units"))?;
        Ok(())
    }
    fn interface(&mut self, interface: &ModuleInterface) -> Result<()> {
        self.string(&interface.name, true)?;
        if interface.version == 0 {
            return Err(fail("invalid interface version"));
        }
        Ok(())
    }
    fn ty(&mut self, ty: &ModuleExternalType) -> Result<()> {
        match ty {
            ModuleExternalType::Function { params, results }
            | ModuleExternalType::Tag { params, results } => {
                self.entries(params.len())?;
                self.entries(results.len())?;
                if matches!(ty, ModuleExternalType::Tag { .. }) && !results.is_empty() {
                    return Err(fail("tag results must be empty"));
                }
            }
            ModuleExternalType::Table(ty) => {
                if ty.maximum.is_some_and(|max| max < ty.minimum) {
                    return Err(fail("invalid table limits"));
                }
            }
            ModuleExternalType::Memory(ty) => {
                if ty.minimum_pages > 65536
                    || ty
                        .maximum_pages
                        .is_some_and(|max| max < ty.minimum_pages || max > 65536)
                    || ty.shared && ty.maximum_pages.is_none()
                {
                    return Err(fail("invalid memory limits"));
                }
            }
            ModuleExternalType::Global(_) => (),
        }
        Ok(())
    }
    fn exports(&mut self, exports: &[ModuleExport]) -> Result<()> {
        self.entries(exports.len())?;
        let mut names = HashSet::new();
        names
            .try_reserve(exports.len())
            .map_err(|_| fail("manifest allocation failed"))?;
        for item in exports {
            self.ty(&item.ty)?;
            self.string(&item.name, false)?;
            if !names.insert(item.name.as_str()) {
                return Err(fail("duplicate manifest export"));
            }
        }
        Ok(())
    }
}
fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn check_manifest(budget: &mut Budget, manifest: &ModuleManifest) -> Result<()> {
    if manifest.schema_version != 1
        || manifest.kind != "wasm-module"
        || manifest.target.abi != "wasip1"
        || manifest.memory_model != "isolated"
        || manifest.runtime_verification != "not-run"
    {
        return Err(fail("unsupported manifest schema"));
    }
    budget.string(&manifest.id, true)?;
    let path = &manifest.artifact.path;
    budget.string(path, true)?;
    if path.starts_with('/')
        || path.chars().any(|c| {
            matches!(c, '\\' | ':' | '%' | '?' | '#') || c <= '\u{001f}' || c == '\u{007f}'
        })
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(fail("invalid artifact path"));
    }
    budget.string(&manifest.artifact.sha256, true)?;
    if manifest.artifact.sha256.len() != 64
        || !manifest
            .artifact
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(fail("invalid artifact SHA-256"));
    }
    budget.entries(manifest.target.features.len())?;
    let mut features = HashSet::new();
    features
        .try_reserve(manifest.target.features.len())
        .map_err(|_| fail("manifest allocation failed"))?;
    for feature in &manifest.target.features {
        budget.string(feature, true)?;
        if !features.insert(feature) {
            return Err(fail("duplicate manifest feature"));
        }
    }
    budget.entries(manifest.requires.len())?;
    for requirement in &manifest.requires {
        budget.string(&requirement.provider, true)?;
        budget.string(&requirement.interface, true)?;
        if requirement.version == 0 {
            return Err(fail("invalid interface version"));
        }
        budget.entries(requirement.imports.len())?;
        for import in &requirement.imports {
            budget.ty(&import.ty)?;
            budget.string(&import.module, false)?;
            budget.string(&import.name, false)?;
            budget.string(&import.provider_export, false)?;
        }
    }
    budget.interface(&manifest.interface)?;
    budget.exports(&manifest.exports)
}

fn compatible(required: &ModuleExternalType, provided: &ModuleExternalType) -> bool {
    match (required, provided) {
        (ModuleExternalType::Table(a), ModuleExternalType::Table(b)) => {
            a.element == b.element
                && b.minimum >= a.minimum
                && a.maximum
                    .is_none_or(|max| b.maximum.is_some_and(|p| p <= max))
        }
        (ModuleExternalType::Memory(a), ModuleExternalType::Memory(b)) => {
            a.shared == b.shared
                && b.minimum_pages >= a.minimum_pages
                && a.maximum_pages
                    .is_none_or(|max| b.maximum_pages.is_some_and(|p| p <= max))
        }
        _ => required == provided,
    }
}

fn signature(kind: u8, params: &[WasmValueType], results: &[WasmValueType]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update([kind]);
    for values in [params, results] {
        hash.update((values.len() as u64).to_le_bytes());
        for value in values {
            hash.update([*value as u8]);
        }
    }
    hash.finalize().into()
}
fn type_key(ty: &ModuleExternalType) -> [u8; 32] {
    match ty {
        ModuleExternalType::Function { params, results } => signature(0, params, results),
        ModuleExternalType::Tag { params, results } => signature(4, params, results),
        _ => {
            let mut hash = Sha256::new();
            match ty {
                ModuleExternalType::Table(t) => {
                    hash.update([1, t.element as u8]);
                    hash.update(t.minimum.to_le_bytes());
                    hash.update([u8::from(t.maximum.is_some())]);
                    hash.update(t.maximum.unwrap_or(0).to_le_bytes());
                }
                ModuleExternalType::Memory(t) => {
                    hash.update([2, u8::from(t.shared)]);
                    hash.update(t.minimum_pages.to_le_bytes());
                    hash.update([u8::from(t.maximum_pages.is_some())]);
                    hash.update(t.maximum_pages.unwrap_or(0).to_le_bytes());
                }
                ModuleExternalType::Global(t) => {
                    hash.update([3, t.value as u8, u8::from(t.mutable)])
                }
                _ => unreachable!(),
            }
            hash.finalize().into()
        }
    }
}
fn fact_key(
    facts: &WasmFacts,
    item: WasmExternal,
    cache: &mut HashMap<(u8, u32), [u8; 32]>,
) -> [u8; 32] {
    match item {
        WasmExternal::Function { type_index, .. } | WasmExternal::Tag { type_index, .. } => {
            let kind = if matches!(item, WasmExternal::Function { .. }) {
                0
            } else {
                4
            };
            *cache.entry((kind, type_index)).or_insert_with(|| {
                let ty = &facts.types[type_index as usize];
                signature(kind, &ty.params, &ty.results)
            })
        }
        WasmExternal::Table { ty, .. } => type_key(&ModuleExternalType::Table(ty)),
        WasmExternal::Memory { ty, .. } => type_key(&ModuleExternalType::Memory(ty)),
        WasmExternal::Global { ty, .. } => type_key(&ModuleExternalType::Global(ty)),
    }
}
fn fact_matches(
    facts: &WasmFacts,
    item: WasmExternal,
    required: &ModuleExternalType,
    subtype: bool,
) -> bool {
    match (item, required) {
        (
            WasmExternal::Function { type_index, .. },
            ModuleExternalType::Function { params, results },
        )
        | (WasmExternal::Tag { type_index, .. }, ModuleExternalType::Tag { params, results }) => {
            let ty = &facts.types[type_index as usize];
            ty.params == *params && ty.results == *results
        }
        (WasmExternal::Table { ty, .. }, ModuleExternalType::Table(_)) => {
            if subtype {
                compatible(required, &ModuleExternalType::Table(ty))
            } else {
                *required == ModuleExternalType::Table(ty)
            }
        }
        (WasmExternal::Memory { ty, .. }, ModuleExternalType::Memory(_)) => {
            if subtype {
                compatible(required, &ModuleExternalType::Memory(ty))
            } else {
                *required == ModuleExternalType::Memory(ty)
            }
        }
        (WasmExternal::Global { ty, .. }, ModuleExternalType::Global(_)) => {
            *required == ModuleExternalType::Global(ty)
        }
        _ => false,
    }
}

struct SnapshotModule<'a> {
    manifest: &'a ModuleManifest,
    _bytes: Vec<u8>,
    facts: WasmFacts,
}
struct SnapshotInputs<'a> {
    order: Vec<String>,
    modules: Vec<SnapshotModule<'a>>,
    hosts: &'a [ModuleHostProvider],
}

fn snapshot_inputs<'a>(input: &'a ModuleManifestInput<'a>) -> Result<SnapshotInputs<'a>> {
    let count = input
        .modules
        .len()
        .checked_add(input.hosts.len())
        .filter(|n| *n <= MAX_PROVIDERS)
        .ok_or_else(|| fail("manifest inspection limit: providers"))?;
    let mut budget = Budget::default();
    budget.entries(count)?;
    let mut total_bytes = 0usize;
    for module in &input.modules {
        if module.bytes.len() > WASM_FACTS_MAX_INPUT_BYTES {
            return Err(fail("Wasm facts inspection limit: input bytes"));
        }
        total_bytes = total_bytes
            .checked_add(module.bytes.len())
            .filter(|n| *n <= MAX_BYTES)
            .ok_or_else(|| fail("manifest inspection limit: total bytes"))?;
        check_manifest(&mut budget, &module.manifest)?;
    }
    for host in &input.hosts {
        budget.string(&host.id, true)?;
        budget.interface(&host.interface)?;
        budget.exports(&host.exports)?;
    }
    let graph = ModuleGraph {
        modules: input
            .modules
            .iter()
            .map(|m| ModuleDeclaration {
                id: m.manifest.id.clone(),
                role: m.manifest.role,
                requires: m
                    .manifest
                    .requires
                    .iter()
                    .map(|r| r.provider.clone())
                    .collect(),
            })
            .collect(),
        host_providers: input.hosts.iter().map(|host| host.id.clone()).collect(),
    };
    let order = order_module_graph(&graph).map_err(|error| fail(error.to_string()))?;
    let mut modules = Vec::new();
    modules
        .try_reserve(input.modules.len())
        .map_err(|_| fail("manifest allocation failed"))?;
    let mut total_facts = 0usize;
    for module in &input.modules {
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(module.bytes.len())
            .map_err(|_| fail("manifest allocation failed"))?;
        bytes.extend_from_slice(module.bytes);
        let facts = inspect_wasm_snapshot(&bytes)
            .map_err(|error| fail(format!("{:?}: {error}", module.manifest.id)))?;
        for n in [
            facts.types.len(),
            facts.imports.len(),
            facts.exports.len(),
            facts.functions.len(),
            facts.tables.len(),
            facts.memories.len(),
            facts.globals.len(),
            facts.tags.len(),
        ] {
            total_facts = total_facts
                .checked_add(n)
                .filter(|n| *n <= MAX_ENTRIES)
                .ok_or_else(|| fail("manifest inspection limit: total Wasm facts"))?;
        }
        for ty in &facts.types {
            for n in [ty.params.len(), ty.results.len()] {
                total_facts = total_facts
                    .checked_add(n)
                    .filter(|n| *n <= MAX_ENTRIES)
                    .ok_or_else(|| fail("manifest inspection limit: total Wasm facts"))?;
            }
        }
        if facts.sha256 != module.manifest.artifact.sha256 {
            return Err(fail(format!(
                "{:?}: artifact SHA-256 mismatch",
                module.manifest.id
            )));
        }
        modules.push(SnapshotModule {
            manifest: &module.manifest,
            _bytes: bytes,
            facts,
        });
    }
    Ok(SnapshotInputs {
        order,
        modules,
        hosts: &input.hosts,
    })
}

/// Inspect declared identities and interfaces against private Wasm snapshots without compiling or executing modules. The report is not execution authorization.
pub fn inspect_module_manifests(input: &ModuleManifestInput<'_>) -> Result<ModuleManifestReport> {
    let snapshots = snapshot_inputs(input)?;
    let modules: HashMap<&str, &SnapshotModule<'_>> = snapshots
        .modules
        .iter()
        .map(|m| (m.manifest.id.as_str(), m))
        .collect();
    let hosts: HashMap<&str, &ModuleHostProvider> =
        snapshots.hosts.iter().map(|h| (h.id.as_str(), h)).collect();
    let module_exports: HashMap<&str, HashMap<&str, WasmExternal>> = snapshots
        .modules
        .iter()
        .map(|m| {
            (
                m.manifest.id.as_str(),
                m.facts
                    .exports
                    .iter()
                    .map(|e| (e.name.as_str(), e.external))
                    .collect(),
            )
        })
        .collect();
    let host_exports: HashMap<&str, HashMap<&str, &ModuleExternalType>> = snapshots
        .hosts
        .iter()
        .map(|h| {
            (
                h.id.as_str(),
                h.exports.iter().map(|e| (e.name.as_str(), &e.ty)).collect(),
            )
        })
        .collect();
    for current in &snapshots.modules {
        let id = &current.manifest.id;
        for requirement in &current.manifest.requires {
            let provider_interface = modules
                .get(requirement.provider.as_str())
                .map(|m| &m.manifest.interface)
                .or_else(|| {
                    hosts
                        .get(requirement.provider.as_str())
                        .map(|h| &h.interface)
                })
                .ok_or_else(|| {
                    fail(format!(
                        "{id:?}: missing provider {:?}",
                        requirement.provider
                    ))
                })?;
            if provider_interface.name != requirement.interface
                || provider_interface.version != requirement.version
            {
                return Err(fail(format!(
                    "{id:?}: interface mismatch for {:?}",
                    requirement.provider
                )));
            }
        }
        let actual_exports = &module_exports[id.as_str()];
        let declared_exports: HashSet<&str> = current
            .manifest
            .exports
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        for item in &current.manifest.exports {
            let actual = actual_exports.get(item.name.as_str()).copied();
            if !actual
                .is_some_and(|external| fact_matches(&current.facts, external, &item.ty, false))
            {
                return Err(fail(format!(
                    "{id:?}: export {:?} does not match artifact",
                    item.name
                )));
            }
        }
        for name in actual_exports.keys() {
            if !declared_exports.contains(name) {
                return Err(fail(format!(
                    "{id:?}: artifact export {name:?} has no declaration"
                )));
            }
        }

        type Pair<'a> = (&'a str, &'a str);
        type Binding<'a> = (&'a ManifestRequirement, &'a ModuleImport);
        struct Group<'a> {
            ty: &'a ModuleExternalType,
            bindings: Vec<Binding<'a>>,
        }
        let mut bindings: HashMap<Pair<'_>, Pair<'_>> = HashMap::new();
        let mut declared: HashMap<(Pair<'_>, [u8; 32]), Vec<Group<'_>>> = HashMap::new();
        for requirement in &current.manifest.requires {
            for item in &requirement.imports {
                let pair = (item.module.as_str(), item.name.as_str());
                let provider = (requirement.provider.as_str(), item.provider_export.as_str());
                if let Some(old) = bindings.insert(pair, provider)
                    && old != provider
                {
                    return Err(fail(format!(
                        "{id:?}: conflicting provider bindings for {:?}.{:?}",
                        item.module, item.name
                    )));
                }
                let groups = declared.entry((pair, type_key(&item.ty))).or_default();
                if let Some(group) = groups.iter_mut().find(|group| group.ty == &item.ty) {
                    group.bindings.push((requirement, item));
                } else {
                    groups.push(Group {
                        ty: &item.ty,
                        bindings: vec![(requirement, item)],
                    });
                }
            }
        }
        let mut cache = HashMap::new();
        let mut matched_groups = HashMap::new();
        let mut matched = Vec::new();
        matched
            .try_reserve(current.facts.imports.len())
            .map_err(|_| fail("manifest allocation failed"))?;
        for item in &current.facts.imports {
            let pair = (item.module.as_str(), item.name.as_str());
            let key = fact_key(&current.facts, item.external, &mut cache);
            let candidates = declared.get_mut(&(pair, key)).ok_or_else(|| {
                fail(format!(
                    "{id:?}: artifact import {:?}.{:?} has no matching declaration",
                    item.module, item.name
                ))
            })?;
            let group_key = match item.external {
                WasmExternal::Function { type_index, .. } => Some((pair, 0u8, type_index)),
                WasmExternal::Tag { type_index, .. } => Some((pair, 4u8, type_index)),
                _ => None,
            };
            let position = if let Some(index) =
                group_key.and_then(|key| matched_groups.get(&key).copied())
            {
                index
            } else {
                let index = candidates
                    .iter()
                    .position(|group| fact_matches(&current.facts, item.external, group.ty, false))
                    .ok_or_else(|| {
                        fail(format!(
                            "{id:?}: artifact import {:?}.{:?} has no matching declaration",
                            item.module, item.name
                        ))
                    })?;
                if let Some(key) = group_key {
                    matched_groups.insert(key, index);
                }
                index
            };
            let group = &mut candidates[position];
            let binding = group.bindings.pop().ok_or_else(|| {
                fail(format!(
                    "{id:?}: artifact import {:?}.{:?} has no matching declaration",
                    item.module, item.name
                ))
            })?;
            matched.push((binding.0, binding.1, group.ty));
        }
        if declared
            .values()
            .any(|groups| groups.iter().any(|group| !group.bindings.is_empty()))
        {
            return Err(fail(format!(
                "{id:?}: import declaration has no matching artifact import"
            )));
        }
        let mut checked_providers = HashSet::new();
        for (requirement, item, group_type) in matched {
            let key = (
                requirement.provider.as_str(),
                item.provider_export.as_str(),
                group_type as *const ModuleExternalType,
            );
            if checked_providers.contains(&key) {
                continue;
            }
            let valid = if let Some(provider) = modules.get(requirement.provider.as_str()) {
                module_exports[requirement.provider.as_str()]
                    .get(item.provider_export.as_str())
                    .is_some_and(|export| fact_matches(&provider.facts, *export, group_type, true))
            } else if let Some(exports) = host_exports.get(requirement.provider.as_str()) {
                exports
                    .get(item.provider_export.as_str())
                    .is_some_and(|export| compatible(group_type, export))
            } else {
                false
            };
            if !valid {
                return Err(fail(format!(
                    "{id:?}: provider {:?} export {:?} type mismatch",
                    requirement.provider, item.provider_export
                )));
            }
            checked_providers.insert(key);
        }
    }
    Ok(ModuleManifestReport {
        order: snapshots.order,
        modules: snapshots
            .modules
            .into_iter()
            .map(|module| ModuleManifestModuleReport {
                id: module.manifest.id.clone(),
                facts: module.facts,
                checks: ModuleManifestChecks,
            })
            .collect(),
    })
}
