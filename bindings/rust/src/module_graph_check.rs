//! Inspect a module graph against feature, WASI, and resource topology policies.

use std::fmt;

use crate::feature_validation::{
    FEATURE_POLICY, FEATURE_POLICY_VERSION, FeatureValidationCheck, FeatureValidationError,
    feature_mask, validate_features_snapshot,
};
use crate::isolated_resources::{
    IsolatedResourceError, IsolatedResourceReport, IsolatedTopologyCheck, inspect_isolated_facts,
};
use crate::module_manifest::{
    ManifestCheck, ModuleManifestError, ModuleManifestInput, PreparedModuleGraph,
    prepare_module_manifests,
};
use crate::wasi_preview1::{
    WasiImportCheck, WasiPreview1Error, WasiPreview1Report, inspect_wasi_facts,
};
use crate::wasm_facts::WasmCheck;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeatureModuleGraphChecks {
    wasi_abi: WasiImportCheck,
}
impl FeatureModuleGraphChecks {
    pub fn declaration(&self) -> ManifestCheck {
        ManifestCheck::Passed
    }
    pub fn identity(&self) -> ManifestCheck {
        ManifestCheck::Passed
    }
    pub fn interface(&self) -> ManifestCheck {
        ManifestCheck::Passed
    }
    pub fn feature(&self) -> FeatureValidationCheck {
        FeatureValidationCheck::Passed
    }
    pub fn resource_topology(&self) -> IsolatedTopologyCheck {
        IsolatedTopologyCheck::Passed
    }
    pub fn wasi_abi(&self) -> WasiImportCheck {
        self.wasi_abi
    }
    pub fn engine(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn target_provenance(&self) -> WasmCheck {
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
    pub fn runtime(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeatureModuleGraphModuleReport {
    id: String,
    sha256: String,
    declared_features: Vec<&'static str>,
    wasi: WasiPreview1Report,
    isolated: IsolatedResourceReport,
    checks: FeatureModuleGraphChecks,
}
impl FeatureModuleGraphModuleReport {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn declared_features(&self) -> &[&'static str] {
        &self.declared_features
    }
    pub fn wasi(&self) -> &WasiPreview1Report {
        &self.wasi
    }
    pub fn isolated(&self) -> &IsolatedResourceReport {
        &self.isolated
    }
    pub fn checks(&self) -> &FeatureModuleGraphChecks {
        &self.checks
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeatureModuleGraphReport {
    order: Vec<String>,
    modules: Vec<FeatureModuleGraphModuleReport>,
}
impl FeatureModuleGraphReport {
    pub fn order(&self) -> &[String] {
        &self.order
    }
    pub fn modules(&self) -> &[FeatureModuleGraphModuleReport] {
        &self.modules
    }
    pub fn policy_version(&self) -> u32 {
        FEATURE_POLICY_VERSION
    }
}

#[derive(Debug)]
pub enum FeatureModuleGraphError {
    Manifest(ModuleManifestError),
    Policy(FeatureValidationError),
    Resource {
        module: String,
        source: IsolatedResourceError,
    },
    Wasi {
        module: String,
        source: WasiPreview1Error,
    },
    Feature {
        module: String,
        source: FeatureValidationError,
    },
    Identity {
        module: String,
    },
    Allocation,
}
impl fmt::Display for FeatureModuleGraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Manifest(error) => write!(f, "module manifest inspection failed: {error}"),
            Self::Policy(error) => write!(f, "feature policy rejected: {error}"),
            Self::Resource { module, source } => {
                write!(f, "{module:?}: resource inspection failed: {source}")
            }
            Self::Wasi { module, source } => {
                write!(f, "{module:?}: WASI inspection failed: {source}")
            }
            Self::Feature { module, source } => {
                write!(f, "{module:?}: feature validation failed: {source}")
            }
            Self::Identity { module } => {
                write!(f, "{module:?}: inspection snapshot identity mismatch")
            }
            Self::Allocation => write!(f, "module graph inspection allocation failed"),
        }
    }
}
impl std::error::Error for FeatureModuleGraphError {}

/// Inspect a graph on private snapshots with a trusted host feature allowlist. Native feature validation is synchronous without CPU, memory, or time limits; the report does not authorize execution.
pub(crate) struct FeaturePreparedGraph<'a> {
    prepared: PreparedModuleGraph<'a>,
    report: FeatureModuleGraphReport,
    mask: u32,
}

fn prepare_feature_module_graph<'a>(
    input: &'a ModuleManifestInput<'a>,
    allowed: &[&str],
) -> Result<FeaturePreparedGraph<'a>, FeatureModuleGraphError> {
    let prepared = prepare_module_manifests(input).map_err(FeatureModuleGraphError::Manifest)?;
    check_prepared_feature_graph(prepared, allowed)
}

pub(crate) fn check_prepared_feature_graph<'a>(
    prepared: PreparedModuleGraph<'a>,
    allowed: &[&str],
) -> Result<FeaturePreparedGraph<'a>, FeatureModuleGraphError> {
    feature_mask(&[], allowed).map_err(FeatureModuleGraphError::Policy)?;
    let mut allowed_snapshot = Vec::new();
    allowed_snapshot
        .try_reserve_exact(allowed.len())
        .map_err(|_| FeatureModuleGraphError::Allocation)?;
    for name in allowed {
        allowed_snapshot.push(
            FEATURE_POLICY
                .iter()
                .find(|feature| feature.name == *name)
                .expect("validated host feature")
                .name,
        );
    }
    let mut observations = Vec::new();
    observations
        .try_reserve_exact(prepared.modules.len())
        .map_err(|_| FeatureModuleGraphError::Allocation)?;
    for module in &prepared.modules {
        let id = &module.manifest.id;
        let isolated = inspect_isolated_facts(&module.facts).map_err(|source| {
            FeatureModuleGraphError::Resource {
                module: id.clone(),
                source,
            }
        })?;
        let wasi =
            inspect_wasi_facts(&module.facts).map_err(|source| FeatureModuleGraphError::Wasi {
                module: id.clone(),
                source,
            })?;
        if module.manifest.target.features.len() > FEATURE_POLICY.len() {
            return Err(FeatureModuleGraphError::Feature {
                module: id.clone(),
                source: FeatureValidationError::InvalidFeatureList,
            });
        }
        let declared: Vec<&str> = module
            .manifest
            .target
            .features
            .iter()
            .map(String::as_str)
            .collect();
        feature_mask(&declared, &allowed_snapshot).map_err(|source| {
            FeatureModuleGraphError::Feature {
                module: id.clone(),
                source,
            }
        })?;
        observations.push((isolated, wasi));
    }
    let mut reports = Vec::new();
    reports
        .try_reserve_exact(prepared.modules.len())
        .map_err(|_| FeatureModuleGraphError::Allocation)?;
    let mut union_mask = 0;
    for (module, (isolated, wasi)) in prepared.modules.iter().zip(observations) {
        let id = &module.manifest.id;
        let declared: Vec<&str> = module
            .manifest
            .target
            .features
            .iter()
            .map(String::as_str)
            .collect();
        let feature = validate_features_snapshot(&module.bytes, &declared, &allowed_snapshot)
            .map_err(|source| FeatureModuleGraphError::Feature {
                module: id.clone(),
                source,
            })?;
        union_mask |= feature_mask(&declared, &allowed_snapshot).map_err(|source| {
            FeatureModuleGraphError::Feature {
                module: id.clone(),
                source,
            }
        })?;
        if feature.sha256() != module.facts.sha256
            || wasi.sha256() != module.facts.sha256
            || isolated.sha256() != module.facts.sha256
        {
            return Err(FeatureModuleGraphError::Identity { module: id.clone() });
        }
        let checks = FeatureModuleGraphChecks {
            wasi_abi: wasi.checks().import_signatures(),
        };
        reports.push(FeatureModuleGraphModuleReport {
            id: id.clone(),
            sha256: module.facts.sha256.clone(),
            declared_features: feature.declared_features().to_vec(),
            wasi,
            isolated,
            checks,
        });
    }
    let report = FeatureModuleGraphReport {
        order: prepared.order.clone(),
        modules: reports,
    };
    Ok(FeaturePreparedGraph {
        prepared,
        report,
        mask: union_mask,
    })
}

/// Inspect a graph on private snapshots with a trusted host feature allowlist. Native feature validation is synchronous without CPU, memory, or time limits; the report does not authorize execution.
pub fn inspect_feature_module_graph(
    input: &ModuleManifestInput<'_>,
    allowed: &[&str],
) -> Result<FeatureModuleGraphReport, FeatureModuleGraphError> {
    Ok(prepare_feature_module_graph(input, allowed)?.report)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompiledModuleGraphChecks {
    precheck: FeatureModuleGraphChecks,
}
impl CompiledModuleGraphChecks {
    pub fn declaration(&self) -> ManifestCheck {
        self.precheck.declaration()
    }
    pub fn identity(&self) -> ManifestCheck {
        self.precheck.identity()
    }
    pub fn interface(&self) -> ManifestCheck {
        self.precheck.interface()
    }
    pub fn feature(&self) -> FeatureValidationCheck {
        self.precheck.feature()
    }
    pub fn resource_topology(&self) -> IsolatedTopologyCheck {
        self.precheck.resource_topology()
    }
    pub fn wasi_abi(&self) -> WasiImportCheck {
        self.precheck.wasi_abi()
    }
    pub fn engine(&self) -> ManifestCheck {
        ManifestCheck::Passed
    }
    pub fn target_provenance(&self) -> WasmCheck {
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
    pub fn runtime(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompiledModuleGraphModuleReport {
    precheck: FeatureModuleGraphModuleReport,
    checks: CompiledModuleGraphChecks,
}
impl CompiledModuleGraphModuleReport {
    pub fn id(&self) -> &str {
        self.precheck.id()
    }
    pub fn sha256(&self) -> &str {
        self.precheck.sha256()
    }
    pub fn declared_features(&self) -> &[&'static str] {
        self.precheck.declared_features()
    }
    pub fn wasi(&self) -> &WasiPreview1Report {
        self.precheck.wasi()
    }
    pub fn isolated(&self) -> &IsolatedResourceReport {
        self.precheck.isolated()
    }
    pub fn checks(&self) -> &CompiledModuleGraphChecks {
        &self.checks
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompiledModuleGraphReport {
    order: Vec<String>,
    modules: Vec<CompiledModuleGraphModuleReport>,
}
impl CompiledModuleGraphReport {
    pub fn order(&self) -> &[String] {
        &self.order
    }
    pub fn modules(&self) -> &[CompiledModuleGraphModuleReport] {
        &self.modules
    }
    pub fn policy_version(&self) -> u32 {
        FEATURE_POLICY_VERSION
    }
}

#[derive(Debug)]
pub enum CompiledModuleGraphError {
    Precheck(FeatureModuleGraphError),
    EngineConfig(String),
    EngineModule { module: String, source: String },
    InvalidPolicy,
    Allocation,
}
impl fmt::Display for CompiledModuleGraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Precheck(error) => write!(f, "module graph precheck failed: {error}"),
            Self::EngineConfig(error) => write!(f, "engine configuration failed: {error}"),
            Self::EngineModule { module, source } => {
                write!(f, "{module:?}: engine compilation failed: {source}")
            }
            Self::InvalidPolicy => write!(f, "invalid validated feature policy"),
            Self::Allocation => write!(f, "module graph compilation allocation failed"),
        }
    }
}
impl std::error::Error for CompiledModuleGraphError {}

/// Compile a fully inspected graph from its private snapshots with one feature-restricted Wasmtime engine. This synchronous operation has no CPU, memory, or time limit and does not instantiate modules or authorize execution.
pub fn compile_feature_module_graph(
    input: &ModuleManifestInput<'_>,
    allowed: &[&str],
) -> Result<CompiledModuleGraphReport, CompiledModuleGraphError> {
    let prepared =
        prepare_feature_module_graph(input, allowed).map_err(CompiledModuleGraphError::Precheck)?;
    let (_, _, _, report) = compile_prepared_feature_graph(prepared)?;
    Ok(report)
}

pub(crate) fn compile_prepared_feature_graph<'a>(
    checked: FeaturePreparedGraph<'a>,
) -> Result<
    (
        PreparedModuleGraph<'a>,
        wasmtime::Engine,
        Vec<wasmtime::Module>,
        CompiledModuleGraphReport,
    ),
    CompiledModuleGraphError,
> {
    let FeaturePreparedGraph {
        prepared,
        report,
        mask,
    } = checked;
    let features = lvw_feature_validator::policy_features(mask)
        .map_err(|_| CompiledModuleGraphError::InvalidPolicy)?;
    let mut config = wasmtime::Config::new();
    config.wasm_features(wasmparser::WasmFeatures::all(), false);
    config.wasm_features(features, true);
    let engine = wasmtime::Engine::new(&config)
        .map_err(|error| CompiledModuleGraphError::EngineConfig(format!("{error:#}")))?;
    let mut compiled = Vec::new();
    compiled
        .try_reserve_exact(prepared.modules.len())
        .map_err(|_| CompiledModuleGraphError::Allocation)?;
    for module in &prepared.modules {
        compiled.push(
            wasmtime::Module::from_binary(&engine, &module.bytes).map_err(|error| {
                CompiledModuleGraphError::EngineModule {
                    module: module.manifest.id.clone(),
                    source: format!("{error:#}"),
                }
            })?,
        );
    }
    let mut modules = Vec::new();
    modules
        .try_reserve_exact(report.modules.len())
        .map_err(|_| CompiledModuleGraphError::Allocation)?;
    for precheck in report.modules {
        let checks = CompiledModuleGraphChecks {
            precheck: precheck.checks.clone(),
        };
        modules.push(CompiledModuleGraphModuleReport { precheck, checks });
    }
    let compiled_report = CompiledModuleGraphReport {
        order: report.order,
        modules,
    };
    Ok((prepared, engine, compiled, compiled_report))
}
