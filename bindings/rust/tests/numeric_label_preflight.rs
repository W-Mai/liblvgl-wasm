#[path = "../../../tests/fixtures/numeric-label/fixture.rs"]
#[allow(dead_code)]
mod fixture;

use liblvgl_wasm_host::{
    FeatureModuleGraphError, FeatureValidationError, ManifestCheck, NumericPreflightError,
    WasmCheck, preflight_lvgl_label_graph,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;

#[test]
fn shared_real_and_synthetic_label_graph_preflight() {
    let json =
        fs::read(std::env::var_os("LVW_TEST_LABEL_GRAPH").expect("LVW_TEST_LABEL_GRAPH")).unwrap();
    let cases: Value = serde_json::from_slice(&json).unwrap();
    assert!(cases.as_array().unwrap().len() > 15);
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let graph = fixture::lvgl_fixture::graph(&json, name);
        let input = graph.input();
        let allowed: Vec<_> = case["allowedFeatures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        let wasi = case["wasi"]
            .as_bool()
            .unwrap_or(false)
            .then(fixture::lvgl_fixture::wasi_fixture::options);
        let result = preflight_lvgl_label_graph(
            &input,
            &graph.profile,
            &allowed,
            &fixture::lvgl_fixture::options(),
            wasi.as_ref(),
            &fixture::options(case),
        );
        if case["pass"].as_bool().unwrap() {
            let report = result.unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(report.app_id(), "app", "{name}");
            assert_eq!(report.graph().order(), ["lvcore", "app"], "{name}");
            for module in report.graph().modules() {
                let binary = graph
                    .modules
                    .iter()
                    .find(|(manifest, _)| manifest.id == module.id())
                    .unwrap();
                assert_eq!(
                    module.sha256(),
                    format!("{:x}", Sha256::digest(&binary.1)),
                    "{name}"
                );
                assert_eq!(module.checks().engine(), ManifestCheck::Passed);
                assert_eq!(module.checks().host_implementation(), WasmCheck::NotRun);
                assert_eq!(module.checks().lifecycle(), WasmCheck::NotRun);
                assert_eq!(module.checks().runtime(), WasmCheck::NotRun);
            }
        } else if case["error"] == "feature" {
            assert!(
                matches!(result, Err(NumericPreflightError::Feature(FeatureModuleGraphError::Feature { module, source: FeatureValidationError::InvalidModule(_), })) if module == "app"),
                "{name}: feature validation must reject app"
            );
        } else {
            let expected = match name {
                "core-no-memory" | "app-no-memory" => {
                    "label profile requires owned exported memory"
                }
                "alias" => "LVGL label import is not authorized",
                "signature" => "LVGL label host contract differs",
                "core-steal" => "LVGL label host is reserved for its app",
                "missing-create" => "missing lv_label_create",
                "imported-alloc" => "lvw_alloc must be an owned function",
                "bad-display" => "invalid lvw_display_create signature",
                "missing-dependency" => "label app must depend on its LVGL core",
                "identity" => "module identity is not authorized",
                "id-conflict" | "zero-width" | "oversized-frame" | "zero-labels" | "zero-text"
                | "too-many-labels" | "text-too-long" => "invalid LVGL label options",
                "pointer-export" => "unsupported LVGL scalar export",
                _ => panic!("unknown fixture {name}"),
            };
            match result {
                Err(NumericPreflightError::Numeric(message)) => {
                    assert!(message.contains(expected), "{name}: {message}")
                }
                other => panic!("{name}: unexpected result {other:?}"),
            }
        }
    }
}
