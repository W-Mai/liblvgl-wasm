#[path = "../../../tests/fixtures/numeric-label/fixture.rs"]
#[allow(dead_code)]
mod fixture;

use liblvgl_wasm_host::{
    FeatureModuleGraphError, FeatureValidationError, ManifestCheck, NumericEventOptions,
    NumericPreflightError, WasmCheck, WasmExternal, inspect_wasm_facts, preflight_lvgl_event_graph,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;

#[test]
fn shared_real_and_synthetic_event_graph_preflight() {
    let json =
        fs::read(std::env::var_os("LVW_TEST_EVENT_GRAPH").expect("LVW_TEST_EVENT_GRAPH")).unwrap();
    let cases: Value = serde_json::from_slice(&json).unwrap();
    assert!(cases.as_array().unwrap().len() > 30);
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let graph = fixture::lvgl_fixture::graph(&json, name);
        if name == "dispatch-alias" {
            let bytes = &graph
                .modules
                .iter()
                .find(|(item, _)| item.id == "app")
                .unwrap()
                .1;
            let facts = inspect_wasm_facts(bytes).unwrap();
            let index = |name: &str| match facts
                .exports
                .iter()
                .find(|item| item.name == name)
                .unwrap()
                .external
            {
                WasmExternal::Function { index, .. } => index,
                _ => panic!("dispatcher alias is not a function"),
            };
            assert_eq!(index("app_event_dispatch"), index("dispatch_alias"));
        }
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
        let event = NumericEventOptions {
            max_registrations: case["event"]["maxRegistrations"]
                .as_u64()
                .unwrap()
                .try_into()
                .unwrap(),
            max_depth: case["event"]["maxDepth"]
                .as_u64()
                .unwrap()
                .try_into()
                .unwrap(),
        };
        let result = preflight_lvgl_event_graph(
            &input,
            &graph.profile,
            &allowed,
            &fixture::lvgl_fixture::options(),
            wasi.as_ref(),
            &fixture::options(case),
            &event,
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
                matches!(result, Err(NumericPreflightError::Feature(FeatureModuleGraphError::Feature {
                module, source: FeatureValidationError::InvalidModule(_),
            })) if module == "app"),
                "{name}: app feature validation must reject"
            );
        } else {
            let expected = if let Some(function) = name.strip_prefix("missing-lv") {
                format!("missing lv{function}")
            } else if let Some(function) = name.strip_prefix("badsig-lv") {
                format!("invalid lv{function} signature")
            } else {
                match name {
                    "missing-dispatch" => "missing app_event_dispatch",
                    "bad-dispatch" => "invalid app_event_dispatch signature",
                    "imported-dispatch" => "app_event_dispatch must be an owned function",
                    "dispatch-alias" => "LVGL event dispatcher cannot be a business export",
                    "missing-table" | "imported-table" | "multiple-tables" => {
                        "LVGL event app requires its own table"
                    }
                    "unbounded-table" => "table maximum is required",
                    "no-event-import" => "LVGL event profile requires the core event import",
                    "bad-event-import" => "LVGL host contract differs",
                    "bad-add-import" => "LVGL label host contract differs",
                    "imported-clicked" => "lvw_event_clicked must be an owned function",
                    "alias" => "LVGL label import is not authorized",
                    "core-steal" => "LVGL label host is reserved for its app",
                    "identity" => "module identity is not authorized",
                    "missing-dependency" => "label app must depend on its LVGL core",
                    "dispatch-export" => "invalid numeric function contract",
                    "zero-registrations" | "too-many-registrations" | "zero-depth" | "too-deep" => {
                        "invalid LVGL event options"
                    }
                    "table-limit" => "numeric table limit exceeded",
                    _ => panic!("unknown fixture {name}"),
                }
                .to_owned()
            };
            match result {
                Err(NumericPreflightError::Numeric(message)) => {
                    assert!(message.contains(&expected), "{name}: {message}")
                }
                other => panic!("{name}: unexpected result {other:?}"),
            }
        }
    }
}
