//! Validate a private Wasm snapshot against an explicit host feature policy.

use std::fmt;

use crate::wasm_facts::WasmCheck;
use sha2::{Digest, Sha256};

pub use lvw_feature_validator::{
    FEATURES as FEATURE_POLICY, Feature as FeaturePolicyEntry,
    POLICY_VERSION as FEATURE_POLICY_VERSION, PolicyError as FeaturePolicyError,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FeatureValidationCheck {
    Passed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeatureValidationChecks;
impl FeatureValidationChecks {
    pub fn feature(&self) -> FeatureValidationCheck {
        FeatureValidationCheck::Passed
    }
    pub fn engine(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn wasi_abi(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn resource_topology(&self) -> WasmCheck {
        WasmCheck::NotRun
    }
    pub fn target_provenance(&self) -> WasmCheck {
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
pub struct FeatureValidationReport {
    sha256: String,
    declared_features: Vec<&'static str>,
    checks: FeatureValidationChecks,
}
impl FeatureValidationReport {
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn declared_features(&self) -> &[&'static str] {
        &self.declared_features
    }
    pub fn policy_version(&self) -> u32 {
        FEATURE_POLICY_VERSION
    }
    pub fn checks(&self) -> &FeatureValidationChecks {
        &self.checks
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum FeatureValidationError {
    InputLimit,
    InvalidFeatureList,
    Policy(FeaturePolicyError),
    InvalidModule(String),
    InvalidPolicy,
    Allocation,
}
impl fmt::Display for FeatureValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputLimit => write!(f, "feature validation input limit exceeded"),
            Self::InvalidFeatureList => write!(f, "invalid feature list"),
            Self::Policy(error) => write!(f, "feature policy rejected: {error:?}"),
            Self::InvalidModule(error) => write!(f, "feature validation rejected module: {error}"),
            Self::InvalidPolicy => write!(f, "invalid feature policy mask"),
            Self::Allocation => write!(f, "feature validation allocation failed"),
        }
    }
}
impl std::error::Error for FeatureValidationError {}

/// Validate a private snapshot against declared features authorized by the host. Validation is synchronous and does not enforce a CPU, memory, or time limit; the report does not authorize execution.
pub fn validate_wasm_features(
    bytes: &[u8],
    declared: &[&str],
    allowed: &[&str],
) -> Result<FeatureValidationReport, FeatureValidationError> {
    let mask = feature_mask(declared, allowed)?;
    if bytes.len() > lvw_feature_validator::MAX_INPUT_BYTES {
        return Err(FeatureValidationError::InputLimit);
    }
    let mut snapshot = Vec::new();
    snapshot
        .try_reserve_exact(bytes.len())
        .map_err(|_| FeatureValidationError::Allocation)?;
    snapshot.extend_from_slice(bytes);
    validate_snapshot(&snapshot, declared, mask)
}

pub(crate) fn feature_mask(
    declared: &[&str],
    allowed: &[&str],
) -> Result<u32, FeatureValidationError> {
    if declared.len() > FEATURE_POLICY.len()
        || allowed.len() > FEATURE_POLICY.len()
        || declared.iter().chain(allowed).any(|name| name.len() > 128)
    {
        return Err(FeatureValidationError::InvalidFeatureList);
    }
    lvw_feature_validator::policy_mask(declared, allowed).map_err(FeatureValidationError::Policy)
}

pub(crate) fn validate_features_snapshot(
    bytes: &[u8],
    declared: &[&str],
    allowed: &[&str],
) -> Result<FeatureValidationReport, FeatureValidationError> {
    let mask = feature_mask(declared, allowed)?;
    validate_snapshot(bytes, declared, mask)
}

fn validate_snapshot(
    bytes: &[u8],
    declared: &[&str],
    mask: u32,
) -> Result<FeatureValidationReport, FeatureValidationError> {
    lvw_feature_validator::validate(bytes, mask).map_err(|error| match error {
        lvw_feature_validator::ValidationError::InputTooLarge => FeatureValidationError::InputLimit,
        lvw_feature_validator::ValidationError::InvalidPolicy => {
            FeatureValidationError::InvalidPolicy
        }
        lvw_feature_validator::ValidationError::InvalidModule(message) => {
            FeatureValidationError::InvalidModule(message)
        }
    })?;
    let mut features = Vec::new();
    features
        .try_reserve_exact(declared.len())
        .map_err(|_| FeatureValidationError::Allocation)?;
    for name in declared {
        features.push(
            FEATURE_POLICY
                .iter()
                .find(|feature| feature.name == *name)
                .expect("validated feature")
                .name,
        );
    }
    Ok(FeatureValidationReport {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        declared_features: features,
        checks: FeatureValidationChecks,
    })
}
