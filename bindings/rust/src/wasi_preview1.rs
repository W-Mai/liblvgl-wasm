//! Static WASI Preview 1 import and entrypoint signature inspection.

use std::fmt;

use crate::wasm_facts::{
    WasmCheck, WasmExternal, WasmFacts, WasmFunctionType, WasmValueType, inspect_wasm_facts,
};

/// Raw wasm32 Preview 1 signatures. `i` denotes i32, `I` denotes i64, and `/` separates parameters from results.
pub const WASI_PREVIEW1_SIGNATURES: &[(&str, &str)] = &[
    ("args_get", "ii/i"),
    ("args_sizes_get", "ii/i"),
    ("clock_res_get", "ii/i"),
    ("clock_time_get", "iIi/i"),
    ("environ_get", "ii/i"),
    ("environ_sizes_get", "ii/i"),
    ("fd_advise", "iIIi/i"),
    ("fd_allocate", "iII/i"),
    ("fd_close", "i/i"),
    ("fd_datasync", "i/i"),
    ("fd_fdstat_get", "ii/i"),
    ("fd_fdstat_set_flags", "ii/i"),
    ("fd_fdstat_set_rights", "iII/i"),
    ("fd_filestat_get", "ii/i"),
    ("fd_filestat_set_size", "iI/i"),
    ("fd_filestat_set_times", "iIIi/i"),
    ("fd_pread", "iiiIi/i"),
    ("fd_prestat_dir_name", "iii/i"),
    ("fd_prestat_get", "ii/i"),
    ("fd_pwrite", "iiiIi/i"),
    ("fd_read", "iiii/i"),
    ("fd_readdir", "iiiIi/i"),
    ("fd_renumber", "ii/i"),
    ("fd_seek", "iIii/i"),
    ("fd_sync", "i/i"),
    ("fd_tell", "ii/i"),
    ("fd_write", "iiii/i"),
    ("path_create_directory", "iii/i"),
    ("path_filestat_get", "iiiii/i"),
    ("path_filestat_set_times", "iiiiIIi/i"),
    ("path_link", "iiiiiii/i"),
    ("path_open", "iiiiiIIii/i"),
    ("path_readlink", "iiiiii/i"),
    ("path_remove_directory", "iii/i"),
    ("path_rename", "iiiiii/i"),
    ("path_symlink", "iiiii/i"),
    ("path_unlink_file", "iii/i"),
    ("poll_oneoff", "iiii/i"),
    ("proc_exit", "i/"),
    ("proc_raise", "i/i"),
    ("random_get", "ii/i"),
    ("sched_yield", "/i"),
    ("sock_accept", "iii/i"),
    ("sock_recv", "iiiiii/i"),
    ("sock_send", "iiiii/i"),
    ("sock_shutdown", "ii/i"),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WasiEvidence {
    Present,
    Absent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WasiImportCheck {
    Passed,
    NotObserved,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WasiEntrypoints {
    initialize: bool,
    start: bool,
    start_section: bool,
}
impl WasiEntrypoints {
    pub fn initialize(&self) -> bool {
        self.initialize
    }
    pub fn start(&self) -> bool {
        self.start
    }
    pub fn start_section(&self) -> bool {
        self.start_section
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WasiPreview1Checks {
    import_signatures: WasiImportCheck,
}
impl WasiPreview1Checks {
    pub fn import_signatures(&self) -> WasiImportCheck {
        self.import_signatures
    }
    pub fn engine(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn target_provenance(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn feature(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn host_implementation(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn runtime(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WasiPreview1Report {
    sha256: String,
    evidence: WasiEvidence,
    imports: Vec<String>,
    entrypoints: WasiEntrypoints,
    checks: WasiPreview1Checks,
}
impl WasiPreview1Report {
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn evidence(&self) -> WasiEvidence {
        self.evidence
    }
    pub fn imports(&self) -> &[String] {
        &self.imports
    }
    pub fn entrypoints(&self) -> &WasiEntrypoints {
        &self.entrypoints
    }
    pub fn checks(&self) -> &WasiPreview1Checks {
        &self.checks
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WasiPreview1Error(String);
impl fmt::Display for WasiPreview1Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for WasiPreview1Error {}
type Result<T> = std::result::Result<T, WasiPreview1Error>;
fn fail(message: impl Into<String>) -> WasiPreview1Error {
    WasiPreview1Error(message.into())
}

fn part_matches(actual: &[WasmValueType], expected: &str) -> bool {
    actual.len() == expected.len()
        && actual
            .iter()
            .zip(expected.bytes())
            .all(|(actual, expected)| {
                matches!(
                    (actual, expected),
                    (WasmValueType::I32, b'i') | (WasmValueType::I64, b'I')
                )
            })
}
fn matches(ty: &WasmFunctionType, expected: &str) -> bool {
    let (params, results) = expected.split_once('/').expect("fixed WASI signature");
    part_matches(&ty.params, params) && part_matches(&ty.results, results)
}

/// Inspect a private Wasm snapshot without compiling, instantiating, or executing it. The report does not authorize loading or identify the producing toolchain.
pub fn inspect_wasi_preview1(bytes: &[u8]) -> Result<WasiPreview1Report> {
    let facts = inspect_wasm_facts(bytes).map_err(|error| fail(error.to_string()))?;
    inspect_wasi_facts(&facts)
}

pub(crate) fn inspect_wasi_facts(facts: &WasmFacts) -> Result<WasiPreview1Report> {
    let mut signatures = Vec::new();
    signatures
        .try_reserve_exact(facts.types.len())
        .map_err(|_| fail("WASI inspection allocation failed"))?;
    signatures.resize(facts.types.len(), None);
    let mut imports = Vec::new();
    imports
        .try_reserve(facts.imports.len())
        .map_err(|_| fail("WASI inspection allocation failed"))?;
    for item in &facts.imports {
        if item.module == "wasi_unstable" || item.module.starts_with("wasi:") {
            return Err(fail(format!(
                "unsupported WASI import namespace {:?}",
                item.module
            )));
        }
        if item.module != "wasi_snapshot_preview1" {
            continue;
        }
        let index = WASI_PREVIEW1_SIGNATURES
            .iter()
            .position(|(name, _)| *name == item.name)
            .ok_or_else(|| fail(format!("unsupported WASI Preview 1 import {:?}", item.name)))?;
        let WasmExternal::Function { type_index, .. } = item.external else {
            return Err(fail(format!(
                "WASI Preview 1 import {:?} must be a function",
                item.name
            )));
        };
        let slot = signatures
            .get_mut(type_index as usize)
            .ok_or_else(|| fail("invalid WASI function type index"))?;
        let mask = *slot.get_or_insert_with(|| {
            let ty = &facts.types[type_index as usize];
            WASI_PREVIEW1_SIGNATURES.iter().enumerate().fold(
                0u64,
                |bits, (index, (_, expected))| {
                    if matches(ty, expected) {
                        bits | (1u64 << index)
                    } else {
                        bits
                    }
                },
            )
        });
        if mask & (1u64 << index) == 0 {
            return Err(fail(format!(
                "WASI Preview 1 import {:?} signature mismatch",
                item.name
            )));
        }
        let mut name = String::new();
        name.try_reserve_exact(item.name.len())
            .map_err(|_| fail("WASI inspection allocation failed"))?;
        name.push_str(&item.name);
        imports.push(name);
    }
    let mut entrypoints = WasiEntrypoints {
        initialize: false,
        start: false,
        start_section: facts.start.is_some(),
    };
    for item in &facts.exports {
        if item.name != "_initialize" && item.name != "_start" {
            continue;
        }
        let valid = if let WasmExternal::Function { type_index, .. } = item.external {
            facts
                .types
                .get(type_index as usize)
                .is_some_and(|ty| ty.params.is_empty() && ty.results.is_empty())
        } else {
            false
        };
        if !valid {
            return Err(fail(format!(
                "WASI entrypoint {:?} must be a () -> () function",
                item.name
            )));
        }
        if item.name == "_initialize" {
            entrypoints.initialize = true;
        } else {
            entrypoints.start = true;
        }
    }
    let evidence = if imports.is_empty() {
        WasiEvidence::Absent
    } else {
        WasiEvidence::Present
    };
    let checks = WasiPreview1Checks {
        import_signatures: if imports.is_empty() {
            WasiImportCheck::NotObserved
        } else {
            WasiImportCheck::Passed
        },
    };
    Ok(WasiPreview1Report {
        sha256: facts.sha256.clone(),
        evidence,
        imports,
        entrypoints,
        checks,
    })
}
