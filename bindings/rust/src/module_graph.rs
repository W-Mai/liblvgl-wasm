//! Validation and deterministic ordering of declared module dependencies.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;

const MAX_PROVIDERS: usize = 256;
const MAX_ENTRIES: usize = 100_000;
const MAX_STRING_UNITS: usize = 4 * 1024 * 1024;

/// The role of a Wasm module in a declaration graph.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModuleRole {
    Lib,
    App,
}

/// A module and the providers it declares as dependencies.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleDeclaration {
    pub id: String,
    pub role: ModuleRole,
    pub requires: Vec<String>,
}

/// Module declarations and the explicitly available host providers.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ModuleGraph {
    pub modules: Vec<ModuleDeclaration>,
    pub host_providers: Vec<String>,
}

/// A declaration graph validation failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModuleGraphError {
    InvalidHostId,
    InvalidModuleId,
    InvalidProviderId { module: String },
    DuplicateProvider { id: String },
    SelfDependency { module: String, provider: String },
    MissingProvider { module: String, provider: String },
    AppProvider { module: String, provider: String },
    Cycle { path: Vec<String> },
    Limit { resource: &'static str },
}

impl fmt::Display for ModuleGraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidHostId => write!(f, "invalid host provider ID"),
            Self::InvalidModuleId => write!(f, "invalid module ID"),
            Self::InvalidProviderId { module } => write!(f, "invalid provider ID: {module:?}"),
            Self::DuplicateProvider { id } => write!(f, "duplicate provider ID: {id:?}"),
            Self::SelfDependency { module, provider } => {
                write!(f, "self dependency: {module:?} -> {provider:?}")
            }
            Self::MissingProvider { module, provider } => {
                write!(f, "missing provider: {module:?} -> {provider:?}")
            }
            Self::AppProvider { module, provider } => {
                write!(f, "app cannot be a provider: {module:?} -> {provider:?}")
            }
            Self::Cycle { path } => {
                write!(f, "library dependency cycle: ")?;
                for (index, id) in path.iter().enumerate() {
                    if index != 0 {
                        write!(f, " -> ")?;
                    }
                    write!(f, "{id:?}")?;
                }
                Ok(())
            }
            Self::Limit { resource } => write!(f, "module graph limit exceeded: {resource}"),
        }
    }
}

impl std::error::Error for ModuleGraphError {}

fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && !id.starts_with(whitespace) && !id.ends_with(whitespace)
}

fn budget(graph: &ModuleGraph) -> Result<(), ModuleGraphError> {
    let providers = graph
        .modules
        .len()
        .checked_add(graph.host_providers.len())
        .filter(|value| *value <= MAX_PROVIDERS)
        .ok_or(ModuleGraphError::Limit {
            resource: "providers",
        })?;
    let mut entries = providers;
    let mut units = 0usize;
    for id in graph
        .host_providers
        .iter()
        .chain(graph.modules.iter().map(|module| &module.id))
    {
        units = units
            .checked_add(id.encode_utf16().take(MAX_STRING_UNITS - units + 1).count())
            .filter(|value| *value <= MAX_STRING_UNITS)
            .ok_or(ModuleGraphError::Limit {
                resource: "string units",
            })?;
    }
    for module in &graph.modules {
        entries = entries
            .checked_add(module.requires.len())
            .filter(|value| *value <= MAX_ENTRIES)
            .ok_or(ModuleGraphError::Limit {
                resource: "entries",
            })?;
        for id in &module.requires {
            units = units
                .checked_add(id.encode_utf16().take(MAX_STRING_UNITS - units + 1).count())
                .filter(|value| *value <= MAX_STRING_UNITS)
                .ok_or(ModuleGraphError::Limit {
                    resource: "string units",
                })?;
        }
    }
    Ok(())
}

/// Validate provider identities and dependency edges, then return module IDs in provider-first order.
///
/// Libraries precede all apps. Ready libraries, apps, and cycle traversal use UTF-16 code-unit order. At most 256 providers, 100,000 graph entries, and 4 Mi UTF-16 string units are accepted. This does not inspect Wasm, validate interfaces, or authorize module execution.
pub fn order_module_graph(graph: &ModuleGraph) -> Result<Vec<String>, ModuleGraphError> {
    budget(graph)?;
    let mut hosts = HashSet::new();
    for id in &graph.host_providers {
        if !valid_id(id) {
            return Err(ModuleGraphError::InvalidHostId);
        }
        if !hosts.insert(id.as_str()) {
            return Err(ModuleGraphError::DuplicateProvider { id: id.clone() });
        }
    }
    let mut nodes = HashMap::new();
    for (index, module) in graph.modules.iter().enumerate() {
        if !valid_id(&module.id) {
            return Err(ModuleGraphError::InvalidModuleId);
        }
        if hosts.contains(module.id.as_str()) || nodes.insert(module.id.as_str(), index).is_some() {
            return Err(ModuleGraphError::DuplicateProvider {
                id: module.id.clone(),
            });
        }
    }

    let mut dependencies = vec![Vec::new(); graph.modules.len()];
    let mut dependents = vec![Vec::new(); graph.modules.len()];
    for (index, module) in graph.modules.iter().enumerate() {
        let mut seen = HashSet::new();
        for provider in &module.requires {
            if !valid_id(provider) {
                return Err(ModuleGraphError::InvalidProviderId {
                    module: module.id.clone(),
                });
            }
            if provider == &module.id {
                return Err(ModuleGraphError::SelfDependency {
                    module: module.id.clone(),
                    provider: provider.clone(),
                });
            }
            if hosts.contains(provider.as_str()) {
                continue;
            }
            let target =
                *nodes
                    .get(provider.as_str())
                    .ok_or_else(|| ModuleGraphError::MissingProvider {
                        module: module.id.clone(),
                        provider: provider.clone(),
                    })?;
            if graph.modules[target].role != ModuleRole::Lib {
                return Err(ModuleGraphError::AppProvider {
                    module: module.id.clone(),
                    provider: provider.clone(),
                });
            }
            if seen.insert(target) {
                dependencies[index].push(target);
                dependents[target].push(index);
            }
        }
    }

    let keys: Vec<Vec<u16>> = graph
        .modules
        .iter()
        .map(|module| module.id.encode_utf16().collect())
        .collect();
    for providers in &mut dependencies {
        providers.sort_by(|a, b| keys[*a].cmp(&keys[*b]));
    }
    let mut remaining: Vec<usize> = dependencies.iter().map(Vec::len).collect();
    let mut ready = BTreeSet::new();
    for (index, count) in remaining.iter().enumerate() {
        if *count == 0 {
            ready.insert((&keys[index], index));
        }
    }
    let mut order = Vec::with_capacity(graph.modules.len());
    while let Some((_, index)) = ready.pop_first() {
        order.push(index);
        for &consumer in &dependents[index] {
            remaining[consumer] -= 1;
            if remaining[consumer] == 0 {
                ready.insert((&keys[consumer], consumer));
            }
        }
    }
    if order.len() != graph.modules.len() {
        let mut state = vec![0u8; graph.modules.len()];
        let mut starts: Vec<usize> = (0..graph.modules.len()).collect();
        starts.sort_by(|a, b| keys[*a].cmp(&keys[*b]));
        for start in starts {
            if state[start] != 0 {
                continue;
            }
            state[start] = 1;
            let mut stack = vec![(start, 0usize)];
            while let Some((index, next)) = stack.last_mut() {
                if *next == dependencies[*index].len() {
                    state[*index] = 2;
                    stack.pop();
                    continue;
                }
                let target = dependencies[*index][*next];
                *next += 1;
                if state[target] == 1 {
                    let first = stack
                        .iter()
                        .position(|(item, _)| *item == target)
                        .expect("visiting node in stack");
                    let path = stack[first..]
                        .iter()
                        .map(|(item, _)| graph.modules[*item].id.clone())
                        .chain(std::iter::once(graph.modules[target].id.clone()))
                        .collect();
                    return Err(ModuleGraphError::Cycle { path });
                }
                if state[target] == 0 {
                    state[target] = 1;
                    stack.push((target, 0));
                }
            }
        }
        unreachable!("unfinished graph must contain a cycle");
    }
    let mut apps = Vec::new();
    let mut result = Vec::with_capacity(order.len());
    for index in order {
        if graph.modules[index].role == ModuleRole::Lib {
            result.push(graph.modules[index].id.clone());
        } else {
            apps.push(index);
        }
    }
    apps.sort_by(|a, b| keys[*a].cmp(&keys[*b]));
    result.extend(
        apps.into_iter()
            .map(|index| graph.modules[index].id.clone()),
    );
    Ok(result)
}
