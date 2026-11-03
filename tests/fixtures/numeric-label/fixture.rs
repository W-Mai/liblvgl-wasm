#[path = "../numeric-lvgl/fixture.rs"]
#[allow(dead_code)]
pub mod lvgl_fixture;

use liblvgl_wasm_host::{
    ManifestCheck, ModuleInterface, NumericLabelOptions, WasmCheck, preflight_lvgl_label_graph,
};
use serde_json::Value;

pub fn options(case: &Value) -> NumericLabelOptions {
    let label = &case["label"];
    let number = |name: &str| label[name].as_u64().unwrap().try_into().unwrap();
    NumericLabelOptions {
        id: label["id"].as_str().unwrap().into(),
        interface: ModuleInterface {
            name: label["interface"]["name"].as_str().unwrap().into(),
            version: label["interface"]["version"]
                .as_u64()
                .unwrap()
                .try_into()
                .unwrap(),
        },
        width: number("width"),
        height: number("height"),
        max_labels: number("maxLabels"),
        max_text_bytes: number("maxTextBytes"),
    }
}

pub fn run_preflight(json: &[u8]) {
    let cases: Value = serde_json::from_slice(json).unwrap();
    let case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "real")
        .unwrap();
    let graph = lvgl_fixture::graph(json, "real");
    let input = graph.input();
    let mut wasi = lvgl_fixture::wasi_fixture::options();
    wasi.output_fds.clear();
    let report = preflight_lvgl_label_graph(
        &input,
        &graph.profile,
        &lvgl_fixture::features(),
        &lvgl_fixture::options(),
        Some(&wasi),
        &options(case),
    )
    .unwrap();
    assert_eq!(report.app_id(), "app");
    assert_eq!(report.graph().order(), ["lvcore", "app"]);
    for module in report.graph().modules() {
        assert_eq!(module.checks().engine(), ManifestCheck::Passed);
        assert_eq!(module.checks().host_implementation(), WasmCheck::NotRun);
        assert_eq!(module.checks().lifecycle(), WasmCheck::NotRun);
        assert_eq!(module.checks().runtime(), WasmCheck::NotRun);
    }
}
