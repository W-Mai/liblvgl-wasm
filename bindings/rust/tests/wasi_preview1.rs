use liblvgl_wasm_host::{
    WASI_PREVIEW1_SIGNATURES, WasiEvidence, WasiImportCheck, WasmCheck, inspect_wasi_preview1,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, env, fs, path::PathBuf};

fn fixture_path() -> PathBuf {
    env::var_os("LVW_TEST_WASI_PREVIEW1_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/fixtures/wasi-preview1/cases.json")
        })
}

fn bytes(hex: &str) -> Vec<u8> {
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn leb(mut value: usize) -> Vec<u8> {
    let mut output = Vec::new();
    loop {
        let byte = (value & 127) as u8;
        value >>= 7;
        output.push(byte | if value == 0 { 0 } else { 128 });
        if value == 0 {
            return output;
        }
    }
}

fn repeated_imports(count: usize) -> Vec<u8> {
    let mut imports = leb(count);
    for _ in 0..count {
        imports.push(22);
        imports.extend(b"wasi_snapshot_preview1");
        imports.push(8);
        imports.extend(b"fd_close");
        imports.extend([0, 0]);
    }
    let mut output = b"\0asm\x01\0\0\0\x01\x06\x01\x60\x01\x7f\x01\x7f\x02".to_vec();
    output.extend(leb(imports.len()));
    output.extend(imports);
    output
}

fn check_not_run(report: &liblvgl_wasm_host::WasiPreview1Report) {
    let checks = report.checks();
    assert_eq!(checks.engine(), WasmCheck::NotRun);
    assert_eq!(checks.target_provenance(), WasmCheck::NotRun);
    assert_eq!(checks.feature(), WasmCheck::NotRun);
    assert_eq!(checks.host_implementation(), WasmCheck::NotRun);
    assert_eq!(checks.runtime(), WasmCheck::NotRun);
}

#[test]
fn shared_wasi_preview1_cases() {
    assert_eq!(WASI_PREVIEW1_SIGNATURES.len(), 46);
    assert_eq!(
        WASI_PREVIEW1_SIGNATURES
            .iter()
            .map(|(name, _)| name)
            .collect::<HashSet<_>>()
            .len(),
        46
    );
    let cases: Value = serde_json::from_slice(&fs::read(fixture_path()).unwrap()).unwrap();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let data = if case["recipe"] == "fd_close" {
            repeated_imports(case["repeat"].as_u64().unwrap() as usize)
        } else {
            bytes(case["hex"].as_str().unwrap())
        };
        let result = inspect_wasi_preview1(&data);
        if !case["accepted"].as_bool().unwrap() {
            let error = result.expect_err(name);
            assert!(
                error.to_string().contains(case["error"].as_str().unwrap()),
                "{name}: {error}"
            );
            continue;
        }
        let report = result.unwrap_or_else(|error| panic!("{name}: {error}"));
        let imports: Vec<_> = if case["recipe"] == "fd_close" {
            vec!["fd_close"; case["repeat"].as_u64().unwrap() as usize]
        } else {
            case["imports"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect()
        };
        assert_eq!(
            report.sha256(),
            format!("{:x}", Sha256::digest(&data)),
            "{name}"
        );
        assert_eq!(report.imports(), imports, "{name}");
        assert_eq!(
            report.evidence(),
            if imports.is_empty() {
                WasiEvidence::Absent
            } else {
                WasiEvidence::Present
            },
            "{name}"
        );
        assert_eq!(
            report.checks().import_signatures(),
            if imports.is_empty() {
                WasiImportCheck::NotObserved
            } else {
                WasiImportCheck::Passed
            },
            "{name}"
        );
        assert_eq!(
            report.entrypoints().initialize(),
            case["entrypoint"] == "_initialize",
            "{name}"
        );
        assert_eq!(
            report.entrypoints().start(),
            case["entrypoint"] == "_start",
            "{name}"
        );
        assert_eq!(
            report.entrypoints().start_section(),
            case["startSection"].as_bool().unwrap_or(false),
            "{name}"
        );
        check_not_run(&report);
    }
}

#[test]
fn real_wasi_preview1() {
    let input = env::var_os("LVW_TEST_WASI_REAL_INPUT");
    let reference = env::var_os("LVW_TEST_WASI_REAL_REFERENCE");
    match (input, reference) {
        (None, None) => (),
        (Some(input), Some(reference)) => {
            let report = inspect_wasi_preview1(&fs::read(input).unwrap()).unwrap();
            let expected: Value = serde_json::from_slice(&fs::read(reference).unwrap()).unwrap();
            let imports: Vec<_> = expected["imports"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item.as_str().unwrap())
                .collect();
            assert_eq!(report.sha256(), expected["sha256"].as_str().unwrap());
            assert_eq!(report.imports(), imports);
            assert_eq!(
                report.evidence(),
                if expected["evidence"] == "present" {
                    WasiEvidence::Present
                } else {
                    WasiEvidence::Absent
                }
            );
            assert_eq!(
                report.entrypoints().initialize(),
                expected["entrypoints"]["initialize"].as_bool().unwrap()
            );
            assert_eq!(
                report.entrypoints().start(),
                expected["entrypoints"]["start"].as_bool().unwrap()
            );
            assert_eq!(
                report.entrypoints().start_section(),
                expected["entrypoints"]["startSection"].as_bool().unwrap()
            );
            check_not_run(&report);
        }
        _ => panic!("real WASI comparison requires both input and reference paths"),
    }
}

#[test]
fn report_keeps_snapshot_identity_after_input_changes() {
    let mut input = b"\0asm\x01\0\0\0".to_vec();
    let expected = format!("{:x}", Sha256::digest(&input));
    let report = inspect_wasi_preview1(&input).unwrap();
    input.fill(0);
    assert_eq!(report.sha256(), expected);
    assert_eq!(report.evidence(), WasiEvidence::Absent);
    check_not_run(&report);
}
