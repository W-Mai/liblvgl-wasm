#[path = "../numeric-label/fixture.rs"]
#[allow(dead_code)]
mod fixture;

use liblvgl_wasm_host::{
    ManifestCheck, NumericEnvironment, NumericEnvironmentError, NumericEnvironmentId,
    NumericEnvironmentState, NumericFrame, NumericHostBinding, NumericHostFactory,
    NumericHostInstance, NumericWasiOutput, WasmCheck, load_lvgl_label_environment_for_consumer,
    preflight_lvgl_label_graph_for_consumer,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::{Arc, Mutex};

type Graph = fixture::lvgl_fixture::wasi_fixture::numeric::Fixture;

#[derive(Clone, Default)]
struct Trace(Arc<Mutex<Vec<String>>>);
struct Factory(Trace);
struct Host(Trace, String);
impl NumericHostFactory for Factory {
    fn create(
        &mut self,
        consumer: &str,
        _: NumericEnvironmentId,
    ) -> Result<Box<dyn NumericHostInstance>, String> {
        Ok(Box::new(Host(self.0.clone(), consumer.into())))
    }
}
impl NumericHostInstance for Host {
    fn call(&mut self, name: &str, values: &[i32]) -> Result<Option<i32>, String> {
        assert_eq!(name, "lifecycle");
        assert_eq!(values.len(), 1);
        self.0
            .0
            .lock()
            .unwrap()
            .push(format!("guest:{}", values[0]));
        Ok(None)
    }
    fn close(&mut self) -> Result<(), String> {
        self.0.0.lock().unwrap().push(format!("host:{}", self.1));
        Ok(())
    }
}
struct NoOutput;
impl NumericWasiOutput for NoOutput {
    fn write(&mut self, _: &str, _: u32, _: &[u8], _: NumericEnvironmentId) -> Result<(), String> {
        Err("unexpected WASI output".into())
    }
}

fn load(
    graph: &Graph,
    case: &Value,
    trace: &Trace,
) -> Result<NumericEnvironment, NumericEnvironmentError> {
    let mut factory = Factory(trace.clone());
    let mut hosts = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let mut wasi = fixture::lvgl_fixture::wasi_fixture::options();
    wasi.output_fds.clear();
    let allowed: Vec<_> = case["allowedFeatures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    load_lvgl_label_environment_for_consumer(
        &graph.input(),
        &graph.profile,
        &allowed,
        &mut hosts,
        &fixture::lvgl_fixture::options(),
        &fixture::options(case),
        "middle",
        Some((&wasi, Box::new(NoOutput))),
    )
}

fn frame(environment: &mut NumericEnvironment) -> NumericFrame {
    let frame = environment.read_frame().unwrap();
    assert_eq!((frame.width, frame.height), (120, 48));
    assert_eq!(frame.rgba.len(), 120 * 48 * 4);
    assert!(frame.rgba.chunks_exact(4).all(|pixel| pixel[3] == 255));
    frame
}

fn select_case<'a>(cases: &'a Value, name: &str) -> &'a Value {
    cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap()
}

pub fn run_runtime(bytes: &[u8]) {
    let cases: Value = serde_json::from_slice(bytes).unwrap();
    let case = select_case(&cases, "real");
    assert_eq!(case["label"]["consumer"], "middle");
    let graph = fixture::lvgl_fixture::graph(bytes, "real");
    let first_trace = Trace::default();
    let second_trace = Trace::default();
    let mut first = load(&graph, case, &first_trace).unwrap();
    let mut second = load(&graph, case, &second_trace).unwrap();
    let first_initial = frame(&mut first);
    let second_initial = frame(&mut second);
    assert_eq!(first_initial.rgba, second_initial.rgba);
    assert_eq!(first.run(1).unwrap(), 1);
    let first_changed = frame(&mut first);
    assert_ne!(first_changed.rgba, first_initial.rgba);
    assert_eq!(frame(&mut second).rgba, second_initial.rgba);
    assert_eq!(second.run(1).unwrap(), 1);
    assert_eq!(frame(&mut second).rgba, first_changed.rgba);
    assert_eq!(first.run(2).unwrap(), 2);
    assert_eq!(frame(&mut first).rgba, first_initial.rgba);
    assert_eq!(frame(&mut second).rgba, first_changed.rgba);
    let saved = first_changed.rgba.clone();
    first.close().unwrap();
    assert_eq!(first.state(), NumericEnvironmentState::Closed);
    assert_eq!(first_changed.rgba, saved);
    assert_eq!(second.run(2).unwrap(), 2);
    assert_eq!(frame(&mut second).rgba, second_initial.rgba);
    second.close().unwrap();
    assert_eq!(second.state(), NumericEnvironmentState::Closed);
    let expected = [
        "guest:10",
        "guest:20",
        "guest:21",
        "guest:11",
        "host:app",
        "host:middle",
    ];
    assert_eq!(*first_trace.0.lock().unwrap(), expected);
    assert_eq!(*second_trace.0.lock().unwrap(), expected);
}

#[allow(dead_code)]
pub fn failed_init(bytes: &[u8], name: &str, expected_guest: &[&str]) {
    let cases: Value = serde_json::from_slice(bytes).unwrap();
    let case = select_case(&cases, name);
    let graph = fixture::lvgl_fixture::graph(bytes, name);
    let trace = Trace::default();
    let error = load(&graph, case, &trace).unwrap_err();
    let module = if name == "middle-fail-init" {
        "middle"
    } else {
        "app"
    };
    assert!(
        error
            .message()
            .contains(&format!("{module:?}: module_init returned 7")),
        "{name}: {error}"
    );
    assert!(error.cleanup_errors().is_empty(), "{name}: {error}");
    let mut expected: Vec<_> = expected_guest
        .iter()
        .map(|value| (*value).to_owned())
        .collect();
    expected.extend(["host:app".into(), "host:middle".into()]);
    assert_eq!(*trace.0.lock().unwrap(), expected, "{name}");
}

pub fn preflight(bytes: &[u8]) {
    let cases: Value = serde_json::from_slice(bytes).unwrap();
    let case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "real")
        .unwrap();
    assert_eq!(case["label"]["consumer"], "middle");
    let graph = fixture::lvgl_fixture::graph(bytes, "real");
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
    preflight(&bytes);
    run_runtime(&bytes);
}
