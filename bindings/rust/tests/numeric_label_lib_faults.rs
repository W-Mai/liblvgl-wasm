#[path = "../../../tests/fixtures/numeric-label/fixture.rs"]
#[allow(dead_code)]
mod fixture;

use liblvgl_wasm_host::{
    ModuleExport, ModuleExternalType, NumericEnvironment, NumericEnvironmentError,
    NumericEnvironmentId, NumericEnvironmentState, NumericHostBinding, NumericHostFactory,
    NumericHostInstance, NumericLabelOptions, NumericWasiOutput, WasmExternal, inspect_wasm_facts,
    load_lvgl_label_environment_for_consumer,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

type Graph = fixture::lvgl_fixture::wasi_fixture::numeric::Fixture;
static TEST_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Default)]
struct Trace(Arc<Mutex<Vec<String>>>);
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

fn load(
    graph: &Graph,
    label: &NumericLabelOptions,
    trace: &Trace,
) -> Result<NumericEnvironment, NumericEnvironmentError> {
    load_with_host_failure(graph, label, trace, false)
}

fn load_with_host_failure(
    graph: &Graph,
    label: &NumericLabelOptions,
    trace: &Trace,
    fail_cleanup: bool,
) -> Result<NumericEnvironment, NumericEnvironmentError> {
    let mut factory = Factory(trace.clone(), fail_cleanup);
    let mut hosts = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let mut wasi = fixture::lvgl_fixture::wasi_fixture::options();
    wasi.output_fds.clear();
    load_lvgl_label_environment_for_consumer(
        &graph.input(),
        &graph.profile,
        &fixture::lvgl_fixture::features(),
        &mut hosts,
        &fixture::lvgl_fixture::options(),
        label,
        "middle",
        Some((&wasi, Box::new(NoOutput))),
    )
}

fn fault_graph(name: &str, wasm_env: &str) -> (Graph, NumericLabelOptions) {
    let graph_path =
        std::env::var_os("LVW_TEST_LABEL_LIB_GRAPH").expect("LVW_TEST_LABEL_LIB_GRAPH");
    let wasm_path = std::env::var_os(wasm_env).expect(wasm_env);
    let bytes = std::fs::read(graph_path).unwrap();
    let cases: Value = serde_json::from_slice(&bytes).unwrap();
    let case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap();
    assert_eq!(case["label"]["consumer"], "middle");
    let label = fixture::options(case);
    let mut graph = fixture::lvgl_fixture::graph(&bytes, name);
    let wasm = std::fs::read(wasm_path).unwrap();
    let facts = inspect_wasm_facts(&wasm).unwrap();
    graph.replace("middle", wasm);
    let manifest = &mut graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "middle")
        .unwrap()
        .0;
    manifest.exports = facts
        .exports
        .iter()
        .map(|item| {
            let ty = match item.external {
                WasmExternal::Function { type_index, .. } => {
                    let signature = &facts.types[type_index as usize];
                    ModuleExternalType::Function {
                        params: signature.params.clone(),
                        results: signature.results.clone(),
                    }
                }
                WasmExternal::Memory { ty, .. } => ModuleExternalType::Memory(ty),
                _ => panic!("unexpected label library fixture export"),
            };
            ModuleExport {
                name: item.name.clone(),
                ty,
            }
        })
        .collect();
    (graph, label)
}

#[test]
fn real_core_label_library_poison_and_memory_isolation() {
    let _guard = TEST_LOCK.lock().unwrap();
    let (graph, mut label) = fault_graph("real", "LVW_TEST_LABEL_LIB_FAULT");
    label.max_labels = 1;
    for (action, reason) in [
        (-1, "unreachable"),
        (-2, "invalid LVGL label handle"),
        (-3, "LVGL text pointer is out of bounds"),
        (-4, "LVGL text is unterminated or too long"),
        (-5, "LVGL label quota exceeded"),
    ] {
        let trace = Trace::default();
        let mut environment = load(&graph, &label, &trace).unwrap();
        let error = environment
            .run(action)
            .expect_err("fault must poison the environment");
        assert!(error.message().contains(reason), "action {action}: {error}");
        assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
        assert_eq!(environment.run(0).unwrap_err(), error);
        assert_eq!(environment.close().unwrap_err(), error);
        assert_eq!(
            *trace.0.lock().unwrap(),
            ["guest:10", "guest:20", "host:app", "host:middle"]
        );
    }

    let trace = Trace::default();
    let mut grown = load(&graph, &label, &trace).unwrap();
    let before = grown.read_frame().unwrap();
    assert_eq!((before.width, before.height), (120, 48));
    assert_eq!(before.rgba.len(), 120 * 48 * 4);
    assert!(before.rgba.chunks_exact(4).all(|pixel| pixel[3] == 255));
    assert_eq!(grown.run(-6).unwrap(), 0);
    let after = grown.read_frame().unwrap();
    assert_eq!(after.rgba.len(), before.rgba.len());
    assert_ne!(after.rgba, before.rgba);
    grown.close().unwrap();
    assert_eq!(
        *trace.0.lock().unwrap(),
        [
            "guest:10",
            "guest:20",
            "guest:21",
            "guest:11",
            "host:app",
            "host:middle"
        ]
    );

    let first_trace = Trace::default();
    let second_trace = Trace::default();
    let mut first = load(&graph, &label, &first_trace).unwrap();
    let mut second = load(&graph, &label, &second_trace).unwrap();
    // This fixture-only probe exposes a token; numeric business contracts must not do so.
    let token = first.run(-7).unwrap();
    assert!(token > 0);
    let error = second.run(token).unwrap_err();
    assert!(
        error.message().contains("invalid LVGL label handle"),
        "{error}"
    );
    assert_eq!(second.state(), NumericEnvironmentState::Poisoned);
    assert_eq!(second.close().unwrap_err(), error);
    first.close().unwrap();
    let third_trace = Trace::default();
    let mut third = load(&graph, &label, &third_trace).unwrap();
    let error = third.run(token).unwrap_err();
    assert!(
        error.message().contains("invalid LVGL label handle"),
        "{error}"
    );
    assert_eq!(third.state(), NumericEnvironmentState::Poisoned);
    assert_eq!(third.close().unwrap_err(), error);
    for trace in [second_trace, third_trace] {
        assert_eq!(
            *trace.0.lock().unwrap(),
            ["guest:10", "guest:20", "host:app", "host:middle"]
        );
    }
}

#[test]
fn middle_close_failure_stops_guest_shutdown_and_preserves_cleanup_errors() {
    let _guard = TEST_LOCK.lock().unwrap();
    for (wasm_env, close_reason) in [
        ("LVW_TEST_LABEL_LIB_CLOSE_FAIL", "module_close returned 7"),
        ("LVW_TEST_LABEL_LIB_CLOSE_TRAP", "unreachable"),
    ] {
        for rollback in [false, true] {
            let case = if rollback { "app-fail-init" } else { "real" };
            let (graph, label) = fault_graph(case, wasm_env);
            let trace = Trace::default();
            if rollback {
                let error = load(&graph, &label, &trace).unwrap_err();
                assert!(
                    error.message().contains("\"app\": module_init returned 7"),
                    "{error}"
                );
                assert_eq!(error.cleanup_errors().len(), 1, "{error}");
                assert!(error.cleanup_errors()[0].contains(close_reason), "{error}");
                assert_eq!(
                    *trace.0.lock().unwrap(),
                    [
                        "guest:10",
                        "guest:20",
                        "guest:11",
                        "host:app",
                        "host:middle"
                    ]
                );
            } else {
                let mut environment = load(&graph, &label, &trace).unwrap();
                let error = environment.close().unwrap_err();
                assert!(error.message().contains(close_reason), "{error}");
                assert!(error.cleanup_errors().is_empty(), "{error}");
                assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
                assert_eq!(environment.run(0).unwrap_err(), error);
                assert_eq!(environment.close().unwrap_err(), error);
                assert_eq!(
                    *trace.0.lock().unwrap(),
                    [
                        "guest:10",
                        "guest:20",
                        "guest:21",
                        "guest:11",
                        "host:app",
                        "host:middle"
                    ]
                );
            }
        }
    }
    let (graph, label) = fault_graph("app-fail-init", "LVW_TEST_LABEL_LIB_CLOSE_TRAP");
    let trace = Trace::default();
    let error = load_with_host_failure(&graph, &label, &trace, true).unwrap_err();
    assert!(
        error.message().contains("\"app\": module_init returned 7"),
        "{error}"
    );
    assert_eq!(error.cleanup_errors().len(), 2, "{error}");
    assert!(error.cleanup_errors()[0].contains("unreachable"), "{error}");
    assert_eq!(error.cleanup_errors()[1], "test host cleanup failed");
    assert_eq!(
        *trace.0.lock().unwrap(),
        [
            "guest:10",
            "guest:20",
            "guest:11",
            "host:app",
            "host:middle"
        ]
    );
}

#[test]
fn middle_reactor_uses_label_before_init_and_trap_stops_guest_cleanup() {
    let _guard = TEST_LOCK.lock().unwrap();
    let (graph, label) = fault_graph("real", "LVW_TEST_LABEL_LIB_REACTOR");
    let trace = Trace::default();
    let mut environment = load(&graph, &label, &trace).unwrap();
    assert_eq!(
        *trace.0.lock().unwrap(),
        ["guest:5", "guest:10", "guest:20"]
    );
    let frame = environment.read_frame().unwrap();
    assert_eq!((frame.width, frame.height), (120, 48));
    assert_eq!(frame.rgba.len(), 120 * 48 * 4);
    assert!(frame.rgba.chunks_exact(4).all(|pixel| pixel[3] == 255));
    environment.close().unwrap();
    assert_eq!(
        *trace.0.lock().unwrap(),
        [
            "guest:5",
            "guest:10",
            "guest:20",
            "guest:21",
            "guest:11",
            "host:app",
            "host:middle"
        ]
    );

    let (graph, label) = fault_graph("real", "LVW_TEST_LABEL_LIB_REACTOR_TRAP");
    let trace = Trace::default();
    let error = load(&graph, &label, &trace).unwrap_err();
    assert!(error.message().contains("unreachable"), "{error}");
    assert!(error.cleanup_errors().is_empty(), "{error}");
    assert_eq!(
        *trace.0.lock().unwrap(),
        ["guest:5", "host:app", "host:middle"]
    );
}
