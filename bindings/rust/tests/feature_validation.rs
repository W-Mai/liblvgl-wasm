use liblvgl_wasm_host::{
    FEATURE_POLICY, FEATURE_POLICY_VERSION, FeaturePolicyError, FeatureValidationCheck,
    FeatureValidationError, WasmCheck, validate_wasm_features,
};
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

const CASES: &[(&str, &[&str])] = &[
    ("bulk-memory", &[]),
    ("reference-types", &[]),
    ("sign-extension", &[]),
    ("saturating-float-to-int", &[]),
    ("exceptions", &[]),
    ("simd", &[]),
    ("multi-value", &[]),
    ("threads", &[]),
    ("memory64", &[]),
    ("multi-memory", &[]),
    ("tail-call", &[]),
    ("extended-const", &[]),
    ("relaxed-simd", &["simd"]),
    ("legacy-exceptions", &[]),
    ("function-references", &["reference-types"]),
    ("gc", &["reference-types", "function-references"]),
];

fn fixture(name: &str) -> Vec<u8> {
    let root = env::var_os("LVW_TEST_FEATURE_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/validator/fixtures")
        });
    fs::read(root.join(format!("{name}.wasm"))).unwrap()
}

#[test]
fn shared_helper_feature_policy_and_real_binaries() {
    assert_eq!(FEATURE_POLICY_VERSION, 1);
    assert_eq!(FEATURE_POLICY.len(), CASES.len());
    let allowed: Vec<_> = FEATURE_POLICY.iter().map(|entry| entry.name).collect();
    for (bit, ((name, dependencies), policy)) in CASES.iter().zip(FEATURE_POLICY).enumerate() {
        assert_eq!((policy.name, policy.mask), (*name, 1u32 << bit));
        let bytes = fixture(name);
        assert!(
            matches!(
                validate_wasm_features(&bytes, dependencies, &allowed),
                Err(FeatureValidationError::InvalidModule(_))
            ),
            "{name}: feature not declared"
        );
        let mut declared = dependencies.to_vec();
        declared.push(name);
        let report = validate_wasm_features(&bytes, &declared, &allowed).unwrap();
        assert_eq!(report.sha256(), format!("{:x}", Sha256::digest(&bytes)));
        assert_eq!(report.policy_version(), FEATURE_POLICY_VERSION);
        assert_eq!(report.declared_features(), declared);
        assert_eq!(report.checks().feature(), FeatureValidationCheck::Passed);
        assert_eq!(report.checks().engine(), WasmCheck::NotRun);
        assert_eq!(report.checks().wasi_abi(), WasmCheck::NotRun);
        assert_eq!(report.checks().resource_topology(), WasmCheck::NotRun);
        assert_eq!(report.checks().host_implementation(), WasmCheck::NotRun);
        assert_eq!(report.checks().runtime(), WasmCheck::NotRun);
        assert!(matches!(
            validate_wasm_features(&bytes, &declared, dependencies),
            Err(FeatureValidationError::Policy(
                FeaturePolicyError::Disallowed(_)
            ))
        ));
    }
}

#[test]
fn feature_policy_rejects_untrusted_declarations_and_invalid_code() {
    let empty = b"\0asm\x01\0\0\0";
    assert!(matches!(
        validate_wasm_features(empty, &[&"x".repeat(129)], &[]),
        Err(FeatureValidationError::InvalidFeatureList)
    ));
    assert!(validate_wasm_features(empty, &[], &[]).is_ok());
    assert!(matches!(
        validate_wasm_features(empty, &["not-a-feature"], &[]),
        Err(FeatureValidationError::Policy(FeaturePolicyError::Unknown(
            _
        )))
    ));
    assert!(matches!(
        validate_wasm_features(empty, &["simd", "simd"], &["simd"]),
        Err(FeatureValidationError::Policy(
            FeaturePolicyError::Duplicate(_)
        ))
    ));
    assert!(matches!(
        validate_wasm_features(empty, &[], &["not-a-feature"]),
        Err(FeatureValidationError::Policy(FeaturePolicyError::Unknown(
            _
        )))
    ));
    assert!(matches!(
        validate_wasm_features(empty, &[], &["simd", "simd"]),
        Err(FeatureValidationError::Policy(
            FeaturePolicyError::Duplicate(_)
        ))
    ));
    assert!(matches!(
        validate_wasm_features(&empty[..4], &[], &[]),
        Err(FeatureValidationError::InvalidModule(_))
    ));
    let mut spoofed = fixture("simd");
    spoofed.extend_from_slice(b"\0\x11\x0ftarget_features\0");
    assert!(matches!(
        validate_wasm_features(&spoofed, &[], &["simd"]),
        Err(FeatureValidationError::InvalidModule(_))
    ));
    assert!(matches!(
        validate_wasm_features(&vec![0; 64 * 1024 * 1024 + 1], &[], &[]),
        Err(FeatureValidationError::InputLimit)
    ));
}

#[test]
fn feature_report_retains_snapshot_identity() {
    let mut bytes = b"\0asm\x01\0\0\0".to_vec();
    let expected = format!("{:x}", Sha256::digest(&bytes));
    let report = validate_wasm_features(&bytes, &[], &[]).unwrap();
    bytes.fill(0);
    assert_eq!(report.sha256(), expected);
    assert!(report.declared_features().is_empty());
}
