#[path = "fixtures/numeric-label/fixture.rs"]
#[allow(dead_code)]
mod fixture;

use liblvgl_wasm_host::{
    ManifestCheck, NumericEventOptions, NumericPreflightError, WasmCheck,
    preflight_lvgl_event_graph,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn main() {
    let path = std::env::args_os().nth(1).expect("event graph path");
    let bytes = std::fs::read(path).unwrap();
    let cases: Value = serde_json::from_slice(&bytes).unwrap();
    let case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "real")
        .unwrap();
    let graph = fixture::lvgl_fixture::graph(&bytes, "real");
    let input = graph.input();
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
    let label = fixture::options(case);
    let lvgl = fixture::lvgl_fixture::options();
    let features = fixture::lvgl_fixture::features();
    let mut wasi = fixture::lvgl_fixture::wasi_fixture::options();
    wasi.output_fds.clear();
    let report = preflight_lvgl_event_graph(
        &input,
        &graph.profile,
        &features,
        &lvgl,
        Some(&wasi),
        &label,
        &event,
    )
    .unwrap();
    assert_eq!(report.app_id(), "app");
    assert_eq!(report.graph().order(), ["lvcore", "app"]);
    for module in report.graph().modules() {
        let binary = graph
            .modules
            .iter()
            .find(|(manifest, _)| manifest.id == module.id())
            .unwrap();
        assert_eq!(module.sha256(), format!("{:x}", Sha256::digest(&binary.1)));
        assert_eq!(module.checks().engine(), ManifestCheck::Passed);
        assert_eq!(module.checks().host_implementation(), WasmCheck::NotRun);
        assert_eq!(module.checks().lifecycle(), WasmCheck::NotRun);
        assert_eq!(module.checks().runtime(), WasmCheck::NotRun);
    }
    let invalid = NumericEventOptions {
        max_registrations: event.max_registrations,
        max_depth: 0,
    };
    assert!(matches!(
        preflight_lvgl_event_graph(
            &input,
            &graph.profile,
            &features,
            &lvgl,
            Some(&wasi),
            &label,
            &invalid,
        ),
        Err(NumericPreflightError::Numeric(message)) if message.contains("invalid LVGL event options")
    ));
}
