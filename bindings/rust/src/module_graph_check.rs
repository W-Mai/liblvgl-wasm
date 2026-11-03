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
    ManifestCheck, ModuleManifestError, ModuleManifestInput, prepare_module_manifests,
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
pub fn inspect_feature_module_graph(
    input: &ModuleManifestInput<'_>,
    allowed: &[&str],
) -> Result<FeatureModuleGraphReport, FeatureModuleGraphError> {
    let prepared = prepare_module_manifests(input).map_err(FeatureModuleGraphError::Manifest)?;
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
    Ok(FeatureModuleGraphReport {
        order: prepared.order,
        modules: reports,
    })
}
