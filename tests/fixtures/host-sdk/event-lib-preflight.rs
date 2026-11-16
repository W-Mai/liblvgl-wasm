#[path = "../numeric-label/fixture.rs"]
#[allow(dead_code)]
pub mod fixture;

use liblvgl_wasm_host::{
    FeatureValidationCheck, IsolatedTopologyCheck, ManifestCheck, NumericEventOptions,
    WasiImportCheck, WasmCheck, WasmExternal, WasmReferenceType, WasmValueType, inspect_wasm_facts,
    preflight_lvgl_event_graph_for_consumer,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn options(case: &Value) -> NumericEventOptions {
    NumericEventOptions {
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
    }
}

pub fn preflight(bytes: &[u8]) {
    let cases: Value = serde_json::from_slice(bytes).unwrap();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        assert_eq!(case["label"]["consumer"], "middle");
        let graph = fixture::lvgl_fixture::graph(bytes, name);
        let middle = graph
            .modules
            .iter()
            .find(|(manifest, _)| manifest.id == "middle")
            .unwrap();
        let facts = inspect_wasm_facts(&middle.1).unwrap();
        let dispatcher = facts
            .exports
            .iter()
            .find(|item| item.name == "app_event_dispatch")
            .unwrap();
        let WasmExternal::Function { index, type_index } = dispatcher.external else {
            panic!("dispatcher is not a function");
        };
        assert!(!facts.functions[index as usize].imported);
        assert_eq!(
            facts.types[type_index as usize].params,
            [WasmValueType::I32; 2]
        );
        assert!(facts.types[type_index as usize].results.is_empty());
        assert_eq!(facts.tables.len(), 1);
        assert!(!facts.tables[0].imported);
        assert_eq!(facts.tables[0].ty.element, WasmReferenceType::FuncRef);
        assert!(facts.tables[0].ty.maximum.is_some());
        let app = &graph
            .modules
            .iter()
            .find(|(manifest, _)| manifest.id == "app")
            .unwrap()
            .1;
        let app = inspect_wasm_facts(app).unwrap();
        assert!(app.imports.iter().all(|item| item.module != "lvgl"));
        assert!(
            app.exports
                .iter()
                .all(|item| item.name != "app_event_dispatch")
        );
        let allowed: Vec<_> = case["allowedFeatures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|feature| feature.as_str().unwrap())
            .collect();
        let wasi = fixture::lvgl_fixture::wasi_fixture::options();
        let report = preflight_lvgl_event_graph_for_consumer(
            &graph.input(),
            &graph.profile,
            &allowed,
            &fixture::lvgl_fixture::options(),
            Some(&wasi),
            &fixture::options(case),
            &options(case),
            "middle",
        )
        .unwrap();
        assert_eq!(report.app_id(), "app");
        assert_eq!(report.graph().order(), ["lvcore", "middle", "app"]);
        assert_eq!(report.graph().modules().len(), 3);
        for module in report.graph().modules() {
            let (manifest, binary) = graph
                .modules
                .iter()
                .find(|(manifest, _)| manifest.id == module.id())
                .unwrap();
            let sha = format!("{:x}", Sha256::digest(binary));
            assert_eq!(manifest.artifact.sha256, sha);
            assert_eq!(module.sha256(), sha);
            let checks = module.checks();
            assert_eq!(checks.declaration(), ManifestCheck::Passed);
            assert_eq!(checks.identity(), ManifestCheck::Passed);
            assert_eq!(checks.interface(), ManifestCheck::Passed);
            assert_eq!(checks.feature(), FeatureValidationCheck::Passed);
            assert_eq!(checks.engine(), ManifestCheck::Passed);
            assert_eq!(checks.resource_topology(), IsolatedTopologyCheck::Passed);
            assert_eq!(
                checks.wasi_abi(),
                if module.id() == "lvcore" {
                    WasiImportCheck::Passed
                } else {
                    WasiImportCheck::NotObserved
                }
            );
            assert_eq!(checks.target_provenance(), WasmCheck::NotRun);
            assert_eq!(checks.pointer_contracts(), WasmCheck::NotRun);
            assert_eq!(checks.handle_isolation(), WasmCheck::NotRun);
            assert_eq!(checks.environment_isolation(), WasmCheck::NotRun);
            assert_eq!(checks.host_implementation(), WasmCheck::NotRun);
            assert_eq!(checks.lifecycle(), WasmCheck::NotRun);
            assert_eq!(checks.runtime(), WasmCheck::NotRun);
        }
    }
}

pub fn main() {
    let path = std::env::args_os().nth(1).expect("event library graph");
    preflight(&std::fs::read(path).unwrap());
    println!("event library preflight passed");
}
