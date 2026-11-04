#[path = "../numeric-label/fixture.rs"]
#[allow(dead_code)]
mod fixture;

use liblvgl_wasm_host::{ManifestCheck, WasmCheck, preflight_lvgl_label_graph_for_consumer};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;

pub fn main() {
    let path = std::env::args_os()
        .nth(1)
        .expect("label library graph path");
    let file = std::fs::File::open(path).unwrap();
    let limit = 256 * 1024 * 1024;
    assert!(file.metadata().unwrap().len() <= limit);
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).unwrap();
    assert!(bytes.len() as u64 <= limit);
    let cases: Value = serde_json::from_slice(&bytes).unwrap();
    let case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "real")
        .unwrap();
    assert_eq!(case["label"]["consumer"], "middle");
    let graph = fixture::lvgl_fixture::graph(&bytes, "real");
    let allowed: Vec<_> = case["allowedFeatures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    let wasi = fixture::lvgl_fixture::wasi_fixture::options();
    let report = preflight_lvgl_label_graph_for_consumer(
        &graph.input(),
        &graph.profile,
        &allowed,
        &fixture::lvgl_fixture::options(),
        Some(&wasi),
        &fixture::options(case),
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
        assert_eq!(checks.engine(), ManifestCheck::Passed);
        assert_eq!(checks.pointer_contracts(), WasmCheck::NotRun);
        assert_eq!(checks.environment_isolation(), WasmCheck::NotRun);
        assert_eq!(checks.host_implementation(), WasmCheck::NotRun);
        assert_eq!(checks.lifecycle(), WasmCheck::NotRun);
        assert_eq!(checks.runtime(), WasmCheck::NotRun);
    }
}
