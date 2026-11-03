//! Inspect module resource topology without compiling or executing it.

use std::fmt;

use crate::wasm_facts::{WasmCheck, WasmExternal, WasmFacts, WasmValueType, inspect_wasm_facts};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IsolatedTopologyCheck {
    Passed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IsolatedResourceChecks;
impl IsolatedResourceChecks {
    pub fn resource_topology(&self) -> IsolatedTopologyCheck {
        IsolatedTopologyCheck::Passed
    }
    pub fn engine(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn feature(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn wasi_abi(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn pointer_contracts(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn handle_isolation(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn environment_isolation(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn host_implementation(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn lifecycle(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IsolatedResourceReport {
    sha256: String,
    memories: usize,
    tables: usize,
    uses_wasi: bool,
    checks: IsolatedResourceChecks,
}
impl IsolatedResourceReport {
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn memories(&self) -> usize {
        self.memories
    }
    pub fn tables(&self) -> usize {
        self.tables
    }
    pub fn uses_wasi(&self) -> bool {
        self.uses_wasi
    }
    pub fn checks(&self) -> &IsolatedResourceChecks {
        &self.checks
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IsolatedResourceError(String);
impl fmt::Display for IsolatedResourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for IsolatedResourceError {}
type Result<T> = std::result::Result<T, IsolatedResourceError>;
fn fail(message: impl Into<String>) -> IsolatedResourceError {
    IsolatedResourceError(message.into())
}

fn reference(value: &WasmValueType) -> bool {
    matches!(value, WasmValueType::FuncRef | WasmValueType::ExternRef)
}

fn check_interface(
    facts: &WasmFacts,
    item: WasmExternal,
    label: &str,
    references: &mut [Option<bool>],
) -> Result<()> {
    let type_index = match item {
        WasmExternal::Function { type_index, .. } | WasmExternal::Tag { type_index, .. } => {
            type_index
        }
        _ => return Ok(()),
    };
    let cached = references
        .get_mut(type_index as usize)
        .ok_or_else(|| fail("invalid Wasm type index"))?;
    let has_reference = *cached.get_or_insert_with(|| {
        let ty = &facts.types[type_index as usize];
        ty.params.iter().chain(&ty.results).any(reference)
    });
    if has_reference {
        return Err(fail(format!(
            "{label}: reference-typed function or tag crosses an instance boundary"
        )));
    }
    Ok(())
}

/// Inspect a private Wasm snapshot for resource topology. This does not authorize loading or establish pointer, handle, host, or runtime isolation.
pub fn inspect_isolated_resources(bytes: &[u8]) -> Result<IsolatedResourceReport> {
    let facts = inspect_wasm_facts(bytes).map_err(|error| fail(error.to_string()))?;
    inspect_isolated_facts(&facts)
}

pub(crate) fn inspect_isolated_facts(facts: &WasmFacts) -> Result<IsolatedResourceReport> {
    if facts.start.is_some() {
        return Err(fail("isolated module cannot have a start section"));
    }
    let mut references = Vec::new();
    references
        .try_reserve_exact(facts.types.len())
        .map_err(|_| fail("resource inspection allocation failed"))?;
    references.resize(facts.types.len(), None);
    for item in &facts.imports {
        let label = format!("import {:?}.{:?}", item.module, item.name);
        match item.external {
            WasmExternal::Memory { .. } => {
                return Err(fail(format!(
                    "{label}: isolated module cannot import memory"
                )));
            }
            WasmExternal::Table { .. } => {
                return Err(fail(format!(
                    "{label}: isolated module cannot import table"
                )));
            }
            WasmExternal::Global { ty, .. } if ty.mutable || reference(&ty.value) => {
                return Err(fail(format!(
                    "{label}: isolated module cannot import mutable or reference-typed globals"
                )));
            }
            _ => check_interface(facts, item.external, &label, &mut references)?,
        }
    }
    for item in &facts.exports {
        check_interface(
            facts,
            item.external,
            &format!("export {:?}", item.name),
            &mut references,
        )?;
    }
    if facts.memories.len() > 1 {
        return Err(fail("isolated module cannot have multiple memories"));
    }
    if facts.tables.len() > 1 {
        return Err(fail("isolated module cannot have multiple tables"));
    }
    if facts.memories.iter().any(|memory| memory.ty.shared) {
        return Err(fail("isolated module cannot have shared memory"));
    }
    let uses_wasi = facts
        .imports
        .iter()
        .any(|item| item.module == "wasi_snapshot_preview1");
    if uses_wasi
        && (facts.memories.len() != 1
            || !facts.exports.iter().any(|item| {
                item.name == "memory"
                    && matches!(item.external, WasmExternal::Memory { index: 0, .. })
            }))
    {
        return Err(fail(
            "isolated WASI module must export its own memory as memory",
        ));
    }
    Ok(IsolatedResourceReport {
        sha256: facts.sha256.clone(),
        memories: facts.memories.len(),
        tables: facts.tables.len(),
        uses_wasi,
        checks: IsolatedResourceChecks,
    })
}
