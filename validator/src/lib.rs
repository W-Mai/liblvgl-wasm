//! WebAssembly feature policy validation.

use wasmparser::{Validator, WasmFeatures};

pub const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
pub const POLICY_VERSION: u32 = 1;

/// A named optional feature and its stable helper policy bit.
#[derive(Clone, Copy, Debug)]
pub struct Feature {
    pub name: &'static str,
    pub mask: u32,
    features: WasmFeatures,
}

macro_rules! features {
    ($(($name:literal, $bit:expr, $flag:ident)),+ $(,)?) => {
        pub const FEATURES: &[Feature] = &[$(Feature {
            name: $name,
            mask: 1 << $bit,
            features: WasmFeatures::$flag,
        }),+];
    };
}

features!(
    ("bulk-memory", 0, BULK_MEMORY),
    ("reference-types", 1, REFERENCE_TYPES),
    ("sign-extension", 2, SIGN_EXTENSION),
    ("saturating-float-to-int", 3, SATURATING_FLOAT_TO_INT),
    ("exceptions", 4, EXCEPTIONS),
    ("simd", 5, SIMD),
    ("multi-value", 6, MULTI_VALUE),
    ("threads", 7, THREADS),
    ("memory64", 8, MEMORY64),
    ("multi-memory", 9, MULTI_MEMORY),
    ("tail-call", 10, TAIL_CALL),
    ("extended-const", 11, EXTENDED_CONST),
    ("relaxed-simd", 12, RELAXED_SIMD),
    ("legacy-exceptions", 13, LEGACY_EXCEPTIONS),
    ("function-references", 14, FUNCTION_REFERENCES),
    ("gc", 15, GC),
);

/// Invalid feature declarations and host-policy mismatches.
#[derive(Debug, PartialEq, Eq)]
pub enum PolicyError {
    Unknown(String),
    Duplicate(String),
    Disallowed(String),
}

fn names_mask(names: &[&str]) -> Result<u32, PolicyError> {
    let mut mask = 0;
    for name in names {
        let feature = FEATURES
            .iter()
            .find(|feature| feature.name == *name)
            .ok_or_else(|| PolicyError::Unknown((*name).to_owned()))?;
        if mask & feature.mask != 0 {
            return Err(PolicyError::Duplicate((*name).to_owned()));
        }
        mask |= feature.mask;
    }
    Ok(mask)
}

/// Resolve declared features against the trusted host allowlist. The allowlist must come from the host, not from an untrusted module.
pub fn policy_mask(declared: &[&str], host_allowed: &[&str]) -> Result<u32, PolicyError> {
    let host_mask = names_mask(host_allowed)?;
    let requested = names_mask(declared)?;
    for name in declared {
        let bit = FEATURES
            .iter()
            .find(|feature| feature.name == *name)
            .unwrap()
            .mask;
        if host_mask & bit == 0 {
            return Err(PolicyError::Disallowed((*name).to_owned()));
        }
    }
    Ok(requested)
}

/// Complete binary validation failures, distinct from resource exhaustion.
#[derive(Debug, PartialEq, Eq)]
pub enum ValidationError {
    InputTooLarge,
    InvalidPolicy,
    InvalidModule(String),
}

/// Validate every section and function body against WASM1 and the policy mask. A successful validation does not identify which allowed features were used.
///
/// Call `policy_mask` with a trusted allowlist before using a module's declared features. This native function does not enforce a CPU or memory execution budget.
pub fn validate(bytes: &[u8], mask: u32) -> Result<(), ValidationError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(ValidationError::InputTooLarge);
    }
    let mut supported = 0;
    let mut features = WasmFeatures::WASM1;
    for feature in FEATURES {
        supported |= feature.mask;
        if mask & feature.mask != 0 {
            features |= feature.features;
        }
    }
    if mask & !supported != 0 {
        return Err(ValidationError::InvalidPolicy);
    }
    Validator::new_with_features(features)
        .validate_all(bytes)
        .map(|_| ())
        .map_err(|error| ValidationError::InvalidModule(error.to_string()))
}

// These exports are an internal protocol between the trusted host and an isolated helper instance.
// The host must discard the instance after a trap and must not expose its memory or functions.
#[cfg(target_arch = "wasm32")]
mod helper {
    use std::cell::RefCell;

    use super::{FEATURES, MAX_INPUT_BYTES, POLICY_VERSION, ValidationError, validate};

    thread_local! {
        static INPUT: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn lvw_policy_version() -> u32 {
        POLICY_VERSION
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn lvw_feature_count() -> u32 {
        FEATURES.len() as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn lvw_feature_name_length(index: u32) -> u32 {
        FEATURES
            .get(index as usize)
            .map_or(0, |feature| feature.name.len() as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn lvw_feature_name_byte(index: u32, offset: u32) -> i32 {
        FEATURES
            .get(index as usize)
            .and_then(|feature| feature.name.as_bytes().get(offset as usize))
            .map_or(-1, |byte| i32::from(*byte))
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn lvw_feature_mask(index: u32) -> u32 {
        FEATURES
            .get(index as usize)
            .map_or(0, |feature| feature.mask)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn lvw_reserve(length: u32) -> u32 {
        let length = length as usize;
        INPUT.with(|input| {
            let mut input = input.borrow_mut();
            if input.is_some() || length == 0 || length > MAX_INPUT_BYTES {
                *input = None;
                return 0;
            }
            let mut bytes = Vec::new();
            if bytes.try_reserve_exact(length).is_err() {
                return 0;
            }
            bytes.resize(length, 0);
            let pointer = bytes.as_mut_ptr() as u32;
            *input = Some(bytes);
            pointer
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn lvw_validate(mask: u32) -> i32 {
        INPUT.with(|input| {
            let input = input.borrow();
            let Some(bytes) = input.as_ref() else {
                return -2;
            };
            match validate(bytes, mask) {
                Ok(()) => 0,
                Err(ValidationError::InvalidModule(_)) => 1,
                Err(ValidationError::InvalidPolicy) => -1,
                Err(ValidationError::InputTooLarge) => -3,
            }
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn lvw_release() -> i32 {
        INPUT.with(|input| i32::from(input.borrow_mut().take().is_some()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_names_and_masks_are_unique_and_host_policy_is_explicit() {
        let mut mask = 0;
        for (index, feature) in FEATURES.iter().enumerate() {
            assert!(!feature.name.is_empty());
            assert!(feature.mask.is_power_of_two());
            assert_eq!(mask & feature.mask, 0);
            assert!(
                FEATURES[..index]
                    .iter()
                    .all(|other| other.name != feature.name)
            );
            mask |= feature.mask;
            assert_eq!(
                policy_mask(&[feature.name], &[feature.name]),
                Ok(feature.mask)
            );
            assert_eq!(
                policy_mask(&[feature.name], &[]),
                Err(PolicyError::Disallowed(feature.name.into()))
            );
            assert_eq!(
                policy_mask(&[feature.name, feature.name], &[feature.name]),
                Err(PolicyError::Duplicate(feature.name.into()))
            );
        }
        assert_eq!(
            policy_mask(&["unknown"], &[]),
            Err(PolicyError::Unknown("unknown".into()))
        );
        assert_eq!(
            policy_mask(&[], &["unknown"]),
            Err(PolicyError::Unknown("unknown".into()))
        );
        assert_eq!(
            policy_mask(&[], &["simd", "simd"]),
            Err(PolicyError::Duplicate("simd".into()))
        );
        assert_eq!(
            validate(b"\0asm\x01\0\0\0", !mask),
            Err(ValidationError::InvalidPolicy)
        );
    }

    #[test]
    fn wasm1_and_invalid_binary_are_distinguished() {
        assert_eq!(validate(b"\0asm\x01\0\0\0", 0), Ok(()));
        assert!(matches!(
            validate(b"\0asm\x01\0\0", 0),
            Err(ValidationError::InvalidModule(_))
        ));
    }
}
