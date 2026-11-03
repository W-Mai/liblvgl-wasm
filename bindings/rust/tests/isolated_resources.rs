use liblvgl_wasm_host::{
    IsolatedResourceReport, IsolatedTopologyCheck, WasmCheck, inspect_isolated_resources,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn fixture_path() -> PathBuf {
    env::var_os("LVW_TEST_ISOLATED_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/fixtures/isolated-resources/cases.json")
        })
}

fn leb(mut value: usize) -> Vec<u8> {
    let mut result = Vec::new();
    loop {
        let byte = (value & 127) as u8;
        value >>= 7;
        result.push(byte | if value == 0 { 0 } else { 128 });
        if value == 0 {
            return result;
        }
    }
}

fn bytes(case: &Value) -> Vec<u8> {
    if case["recipe"] != "repeated" {
        return case["hex"]
            .as_str()
            .unwrap()
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect();
    }
    let mut types = vec![1, 0x60];
    types.extend(leb(1000));
    types.resize(types.len() + 1000, 0x7f);
    types.push(0);
    let count = case["repeat"].as_u64().unwrap() as usize;
    let mut imports = leb(count);
    for _ in 0..count {
        imports.extend([3, b'e', b'n', b'v', 1, b'f', 0, 0]);
    }
    let mut output = b"\0asm\x01\0\0\0".to_vec();
    for (id, payload) in [(1, types), (2, imports)] {
        output.push(id);
        output.extend(leb(payload.len()));
        output.extend(payload);
    }
    output
}

fn checks(report: &IsolatedResourceReport) {
    let checks = report.checks();
    assert_eq!(checks.resource_topology(), IsolatedTopologyCheck::Passed);
    assert_eq!(checks.engine(), WasmCheck::NotRun);
    assert_eq!(checks.feature(), WasmCheck::NotRun);
    assert_eq!(checks.wasi_abi(), WasmCheck::NotRun);
    assert_eq!(checks.pointer_contracts(), WasmCheck::NotRun);
    assert_eq!(checks.handle_isolation(), WasmCheck::NotRun);
    assert_eq!(checks.environment_isolation(), WasmCheck::NotRun);
    assert_eq!(checks.host_implementation(), WasmCheck::NotRun);
    assert_eq!(checks.lifecycle(), WasmCheck::NotRun);
}

#[test]
fn shared_isolated_cases() {
    let cases: Value = serde_json::from_slice(&fs::read(fixture_path()).unwrap()).unwrap();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes = bytes(case);
        let result = inspect_isolated_resources(&bytes);
        if !case["accepted"].as_bool().unwrap() {
            let error = result.expect_err(name);
            assert!(
                error.to_string().contains(case["error"].as_str().unwrap()),
                "{name}: {error}"
            );
            continue;
        }
        let report = result.unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(
            report.sha256(),
            format!("{:x}", Sha256::digest(&bytes)),
            "{name}"
        );
        assert_eq!(
            report.memories(),
            case["memories"].as_u64().unwrap() as usize,
            "{name}"
        );
        assert_eq!(
            report.tables(),
            case["tables"].as_u64().unwrap() as usize,
            "{name}"
        );
        assert_eq!(
            report.uses_wasi(),
            case["usesWasi"].as_bool().unwrap(),
            "{name}"
        );
        checks(&report);
    }
}

#[test]
fn real_isolated_resources() {
    let input = env::var_os("LVW_TEST_ISOLATED_REAL_INPUT");
    let reference = env::var_os("LVW_TEST_ISOLATED_REAL_REFERENCE");
    match (input, reference) {
        (None, None) => (),
        (Some(input), Some(reference)) => {
            let bytes = fs::read(input).unwrap();
            let expected: Value = serde_json::from_slice(&fs::read(reference).unwrap()).unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(&bytes)),
                expected["sha256"].as_str().unwrap()
            );
            let result = inspect_isolated_resources(&bytes);
            if !expected["accepted"].as_bool().unwrap() {
                let error = result.expect_err("expected topology rejection");
                assert!(
                    error
                        .to_string()
                        .contains(expected["reason"].as_str().unwrap()),
                    "{error}"
                );
                return;
            }
            let report = result.unwrap();
            assert_eq!(report.sha256(), expected["sha256"].as_str().unwrap());
            assert_eq!(
                report.memories(),
                expected["memories"].as_u64().unwrap() as usize
            );
            assert_eq!(
                report.tables(),
                expected["tables"].as_u64().unwrap() as usize
            );
            assert_eq!(report.uses_wasi(), expected["usesWasi"].as_bool().unwrap());
            checks(&report);
        }
        _ => panic!("real isolated comparison requires both input and reference paths"),
    }
}

#[test]
fn report_retains_snapshot_after_input_changes() {
    let mut bytes = b"\0asm\x01\0\0\0".to_vec();
    let expected = format!("{:x}", Sha256::digest(&bytes));
    let report = inspect_isolated_resources(&bytes).unwrap();
    bytes.fill(0);
    assert_eq!(report.sha256(), expected);
    checks(&report);
}
