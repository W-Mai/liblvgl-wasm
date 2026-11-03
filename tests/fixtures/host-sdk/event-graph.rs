#[path = "fixtures/numeric-label/fixture.rs"]
#[allow(dead_code)]
mod fixture;

use liblvgl_wasm_host::{
    ManifestCheck, NumericEnvironmentState, NumericEventOptions, NumericPreflightError, WasmCheck,
    load_lvgl_event_environment, preflight_lvgl_event_graph,
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

    let output = fixture::lvgl_fixture::wasi_fixture::Writes::default();
    let mut first = load_lvgl_event_environment(
        &input,
        &graph.profile,
        &features,
        &mut [],
        &lvgl,
        &label,
        &event,
        Some((&wasi, Box::new(output.clone()))),
    )
    .unwrap();
    let mut second = load_lvgl_event_environment(
        &input,
        &graph.profile,
        &features,
        &mut [],
        &lvgl,
        &label,
        &event,
        Some((&wasi, Box::new(output.clone()))),
    )
    .unwrap();
    assert_ne!(first.run(0).unwrap(), second.run(0).unwrap());
    let initial = first.read_frame().unwrap();
    let other = second.read_frame().unwrap();
    assert_eq!(initial.rgba, other.rgba);
    assert_eq!(first.run(1).unwrap(), 2);
    assert_eq!(first.run(4).unwrap(), 1);
    assert_eq!(
        (
            first.run(5).unwrap(),
            first.run(6).unwrap(),
            first.run(7).unwrap(),
            first.run(8).unwrap()
        ),
        (11, 12, 22, 21)
    );
    let updated = first.read_frame().unwrap();
    assert_ne!(initial.rgba, updated.rgba);
    assert_eq!(second.read_frame().unwrap().rgba, other.rgba);
    assert_eq!(first.run(2).unwrap(), 1);
    assert_eq!(first.run(3).unwrap(), 2);
    assert_eq!(second.run(9).unwrap(), 2);
    assert_eq!(second.run(3).unwrap(), 2);
    assert_ne!(second.read_frame().unwrap().rgba, other.rgba);
    assert_eq!(first.read_frame().unwrap().rgba, updated.rgba);
    let copy = updated.rgba.clone();
    first.close().unwrap();
    assert_eq!(first.state(), NumericEnvironmentState::Closed);
    second.close().unwrap();
    assert_eq!(second.state(), NumericEnvironmentState::Closed);
    assert_eq!(updated.rgba, copy);
    assert!(output.messages().is_empty());
}
