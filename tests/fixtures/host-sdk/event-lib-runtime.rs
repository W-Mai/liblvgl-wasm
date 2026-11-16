#[path = "event-lib-preflight.rs"]
#[allow(dead_code)]
pub mod preflight;

use liblvgl_wasm_host::{
    NumericEnvironment, NumericEnvironmentError, NumericEnvironmentId, NumericEnvironmentState,
    NumericFrame, NumericHostBinding, NumericHostFactory, NumericHostInstance, NumericWasiOutput,
    load_lvgl_event_environment_for_consumer,
};
pub use preflight::fixture;
use serde_json::Value;
use std::sync::{Arc, Mutex};
pub type Graph = fixture::lvgl_fixture::wasi_fixture::numeric::Fixture;

#[derive(Clone, Default)]
pub struct Trace(pub Arc<Mutex<Vec<String>>>);
struct Factory(Trace, bool);
struct Host(Trace, String, bool);
impl NumericHostFactory for Factory {
    fn create(
        &mut self,
        consumer: &str,
        _: NumericEnvironmentId,
    ) -> Result<Box<dyn NumericHostInstance>, String> {
        Ok(Box::new(Host(self.0.clone(), consumer.into(), self.1)))
    }
}
impl NumericHostInstance for Host {
    fn call(&mut self, name: &str, values: &[i32]) -> Result<Option<i32>, String> {
        assert_eq!(name, "lifecycle");
        assert_eq!(values.len(), 1);
        if values[0] == 70 && self.2 {
            return Err("test callback host failure".into());
        }
        self.0
            .0
            .lock()
            .unwrap()
            .push(format!("guest:{}", values[0]));
        Ok(None)
    }
    fn close(&mut self) -> Result<(), String> {
        self.0.0.lock().unwrap().push(format!("host:{}", self.1));
        if self.2 && self.1 == "middle" {
            return Err("test host cleanup failed".into());
        }
        Ok(())
    }
}
struct NoOutput;
impl NumericWasiOutput for NoOutput {
    fn write(&mut self, _: &str, _: u32, _: &[u8], _: NumericEnvironmentId) -> Result<(), String> {
        Err("unexpected WASI output".into())
    }
}

pub fn select_case<'a>(cases: &'a Value, name: &str) -> &'a Value {
    cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap()
}

pub fn load(
    graph: &Graph,
    case: &Value,
    trace: &Trace,
    fail_host: bool,
) -> Result<NumericEnvironment, NumericEnvironmentError> {
    let mut factory = Factory(trace.clone(), fail_host);
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
        .map(|feature| feature.as_str().unwrap())
        .collect();
    load_lvgl_event_environment_for_consumer(
        &graph.input(),
        &graph.profile,
        &allowed,
        &mut hosts,
        &fixture::lvgl_fixture::options(),
        &fixture::options(case),
        &preflight::options(case),
        "middle",
        Some((&wasi, Box::new(NoOutput))),
    )
}

pub fn frame(environment: &mut NumericEnvironment) -> NumericFrame {
    let frame = environment.read_frame().unwrap();
    assert_eq!((frame.width, frame.height), (120, 48));
    assert_eq!(frame.rgba.len(), 120 * 48 * 4);
    assert!(frame.rgba.chunks_exact(4).all(|pixel| pixel[3] == 255));
    frame
}

pub fn run_runtime(bytes: &[u8]) {
    let cases: Value = serde_json::from_slice(bytes).unwrap();
    let case = select_case(&cases, "real");
    let graph = fixture::lvgl_fixture::graph(bytes, "real");
    let ta = Trace::default();
    let tb = Trace::default();
    let mut a = load(&graph, case, &ta, false).unwrap();
    let mut b = load(&graph, case, &tb, false).unwrap();
    let initial = frame(&mut a);
    let other = frame(&mut b);
    assert_eq!(initial.rgba, other.rgba);
    assert_eq!(a.run(1).unwrap(), 2);
    assert_eq!(a.run(4).unwrap(), 1);
    assert_eq!([5, 6, 7, 8].map(|op| a.run(op).unwrap()), [11, 12, 22, 21]);
    let changed = frame(&mut a);
    assert_ne!(initial.rgba, changed.rgba);
    assert_eq!(frame(&mut b).rgba, other.rgba);
    assert_eq!(a.run(2).unwrap(), 1);
    assert_eq!(a.run(1).unwrap(), 2);
    assert_eq!(a.run(3).unwrap(), 1);
    assert_eq!(a.run(1).unwrap(), 3);
    assert_eq!(b.run(9).unwrap(), 2);
    assert_eq!(b.run(1).unwrap(), 2);
    assert_eq!(b.run(3).unwrap(), 1);
    assert_eq!(b.run(1).unwrap(), 3);
    a.run(10).unwrap();
    a.run(11).unwrap();
    let retained = changed.rgba.clone();
    a.close().unwrap();
    assert_eq!(a.state(), NumericEnvironmentState::Closed);
    assert_eq!(changed.rgba, retained);
    assert_eq!(b.run(1).unwrap(), 4);
    assert_eq!(frame(&mut b).rgba, changed.rgba);
    b.close().unwrap();
    assert_eq!(b.state(), NumericEnvironmentState::Closed);
    let expected = [
        "guest:10",
        "guest:20",
        "guest:21",
        "guest:11",
        "host:app",
        "host:middle",
    ];
    assert_eq!(*ta.0.lock().unwrap(), expected);
    assert_eq!(*tb.0.lock().unwrap(), expected);
}

#[allow(dead_code)]
pub fn failed_init(bytes: &[u8], name: &str, expected: &[&str]) {
    let cases: Value = serde_json::from_slice(bytes).unwrap();
    let graph = fixture::lvgl_fixture::graph(bytes, name);
    let trace = Trace::default();
    let error = load(&graph, select_case(&cases, name), &trace, false).unwrap_err();
    assert!(
        error.message().contains("module_init returned 7"),
        "{name}: {error}"
    );
    assert!(error.cleanup_errors().is_empty(), "{name}: {error}");
    let mut expected: Vec<String> = expected.iter().map(|value| (*value).into()).collect();
    expected.extend(["host:app".into(), "host:middle".into()]);
    assert_eq!(*trace.0.lock().unwrap(), expected);
}

pub fn main() {
    let file =
        std::fs::File::open(std::env::args_os().nth(1).expect("event library graph")).unwrap();
    let limit = 256 * 1024 * 1024;
    assert!(file.metadata().unwrap().len() <= limit);
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(file, limit + 1), &mut bytes).unwrap();
    assert!(bytes.len() as u64 <= limit);
    preflight::preflight(&bytes);
    run_runtime(&bytes);
    println!("event library runtime passed");
}
