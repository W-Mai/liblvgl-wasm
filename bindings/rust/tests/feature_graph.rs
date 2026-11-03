#[path = "../../../tests/fixtures/feature-graph/decode.rs"]
mod decode;

use liblvgl_wasm_host::{
    FEATURE_POLICY_VERSION, FeatureModuleGraphError, FeatureModuleGraphReport,
    FeatureValidationCheck, IsolatedTopologyCheck, ManifestCheck, ModuleArtifactInput,
    ModuleHostProvider, ModuleManifestInput, WasiEvidence, WasiImportCheck, WasmCheck,
    inspect_feature_module_graph,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn fixture_path() -> PathBuf {
    env::var_os("LVW_TEST_FEATURE_GRAPH_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/fixtures/feature-graph/cases.json")
        })
}

fn input<'a>(value: &Value, binaries: &'a [Vec<u8>]) -> ModuleManifestInput<'a> {
    ModuleManifestInput {
        modules: value["modules"]
            .as_array()
            .unwrap()
            .iter()
            .zip(binaries)
            .map(|(item, bytes)| ModuleArtifactInput {
                manifest: decode::manifest(&item["manifest"]),
                bytes,
            })
            .collect(),
        hosts: value["hosts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|host| ModuleHostProvider {
                id: decode::string(&host["id"]),
                interface: decode::interface(&host["interface"]),
                exports: decode::exports(&host["exports"]),
            })
            .collect(),
    }
}

fn assert_checks(report: &FeatureModuleGraphReport, value: &Value) {
    assert_eq!(report.policy_version(), FEATURE_POLICY_VERSION);
    for module in report.modules() {
        let source = value["modules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["manifest"]["id"] == module.id())
            .unwrap();
        assert_eq!(
            module.sha256(),
            source["manifest"]["artifact"]["sha256"].as_str().unwrap()
        );
        assert_eq!(
            module.sha256(),
            format!("{:x}", Sha256::digest(decode::hex(&source["hex"])))
        );
        assert_eq!(module.sha256(), module.wasi().sha256());
        assert_eq!(module.sha256(), module.isolated().sha256());
        let declared: Vec<_> = source["manifest"]["target"]["features"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        assert_eq!(module.declared_features(), declared);
        let checks = module.checks();
        assert_eq!(checks.declaration(), ManifestCheck::Passed);
        assert_eq!(checks.identity(), ManifestCheck::Passed);
        assert_eq!(checks.interface(), ManifestCheck::Passed);
        assert_eq!(checks.feature(), FeatureValidationCheck::Passed);
        assert_eq!(checks.resource_topology(), IsolatedTopologyCheck::Passed);
        assert_eq!(
            checks.wasi_abi(),
            if module.wasi().evidence() == WasiEvidence::Present {
                WasiImportCheck::Passed
            } else {
                WasiImportCheck::NotObserved
            }
        );
        assert_eq!(checks.engine(), WasmCheck::NotRun);
        assert_eq!(checks.target_provenance(), WasmCheck::NotRun);
        assert_eq!(checks.pointer_contracts(), WasmCheck::NotRun);
        assert_eq!(checks.handle_isolation(), WasmCheck::NotRun);
        assert_eq!(checks.environment_isolation(), WasmCheck::NotRun);
        assert_eq!(checks.host_implementation(), WasmCheck::NotRun);
        assert_eq!(checks.lifecycle(), WasmCheck::NotRun);
        assert_eq!(checks.runtime(), WasmCheck::NotRun);
    }
}

#[test]
fn shared_feature_graph_cases() {
    let cases: Value = serde_json::from_slice(&fs::read(fixture_path()).unwrap()).unwrap();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let value = &case["input"];
        let binaries: Vec<_> = value["modules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| decode::hex(&item["hex"]))
            .collect();
        let input = input(value, &binaries);
        let allowed: Vec<_> = case["allowedFeatures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        let result = inspect_feature_module_graph(&input, &allowed);
        if !case["accepted"].as_bool().unwrap() {
            let error = result.expect_err(name);
            match (case["stage"].as_str().unwrap(), &error) {
                ("manifest", FeatureModuleGraphError::Manifest(_)) => (),
                ("policy", FeatureModuleGraphError::Policy(_)) => (),
                ("feature", FeatureModuleGraphError::Feature { module, .. })
                | ("resource", FeatureModuleGraphError::Resource { module, .. })
                | ("wasi", FeatureModuleGraphError::Wasi { module, .. }) => {
                    assert_eq!(module, case["module"].as_str().unwrap(), "{name}")
                }
                _ => panic!("{name}: unexpected error {error:?}"),
            }
            continue;
        }
        let report = result.unwrap_or_else(|error| panic!("{name}: {error}"));
        let expected: &[&str] = match binaries.len() {
            1 => &["app"],
            2 => &["lib", "app"],
            _ => &["core", "lib", "app"],
        };
        assert_eq!(report.order(), expected, "{name}");
        assert_checks(&report, value);
    }
}

#[test]
fn graph_rejects_oversized_input_before_validation() {
    let cases: Value = serde_json::from_slice(&fs::read(fixture_path()).unwrap()).unwrap();
    let value = &cases[0]["input"];
    let mut binaries: Vec<_> = value["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| decode::hex(&item["hex"]))
        .collect();
    binaries[0] = vec![0; 64 * 1024 * 1024 + 1];
    let input = input(value, &binaries);
    let error = inspect_feature_module_graph(&input, &[]).unwrap_err();
    assert!(matches!(error, FeatureModuleGraphError::Manifest(_)));
    assert!(error.to_string().contains("input bytes"), "{error}");
}

#[test]
fn real_feature_graph() {
    let Some(path) = env::var_os("LVW_TEST_FEATURE_GRAPH_REAL") else {
        return;
    };
    let value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let source = &value["input"];
    let binaries: Vec<_> = source["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| decode::hex(&item["hex"]))
        .collect();
    let input = input(source, &binaries);
    let allowed: Vec<_> = value["allowedFeatures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap())
        .collect();
    let report = inspect_feature_module_graph(&input, &allowed).unwrap();
    assert_checks(&report, source);
    assert_eq!(report.order(), ["app"]);
    let item = &report.modules()[0];
    let reference = &value["report"];
    assert_eq!(item.sha256(), reference["sha256"].as_str().unwrap());
    assert_eq!(
        item.wasi().evidence(),
        if reference["wasi"]["evidence"] == "present" {
            WasiEvidence::Present
        } else {
            WasiEvidence::Absent
        }
    );
    let imports: Vec<_> = reference["wasi"]["imports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap())
        .collect();
    assert_eq!(item.wasi().imports(), imports);
    assert_eq!(
        item.wasi().entrypoints().initialize(),
        reference["wasi"]["entrypoints"]["initialize"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(
        item.wasi().entrypoints().start(),
        reference["wasi"]["entrypoints"]["start"].as_bool().unwrap()
    );
    assert_eq!(
        item.wasi().entrypoints().start_section(),
        reference["wasi"]["entrypoints"]["startSection"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(
        item.isolated().memories(),
        reference["isolated"]["memories"].as_u64().unwrap() as usize
    );
    assert_eq!(
        item.isolated().tables(),
        reference["isolated"]["tables"].as_u64().unwrap() as usize
    );
    assert_eq!(
        item.isolated().uses_wasi(),
        reference["isolated"]["usesWasi"].as_bool().unwrap()
    );
}

#[test]
fn graph_report_survives_input_mutation() {
    let cases: Value = serde_json::from_slice(&fs::read(fixture_path()).unwrap()).unwrap();
    let value = &cases[0]["input"];
    let mut binaries: Vec<_> = value["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| decode::hex(&item["hex"]))
        .collect();
    let report = {
        let mut input = input(value, &binaries);
        let report = inspect_feature_module_graph(&input, &[]).unwrap();
        input.modules[0]
            .manifest
            .target
            .features
            .push("unknown".into());
        report
    };
    for bytes in &mut binaries {
        bytes.fill(0);
    }
    assert_checks(&report, value);
    assert_eq!(report.order(), ["core", "lib", "app"]);
}
