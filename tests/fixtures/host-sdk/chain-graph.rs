#[path = "../numeric-lvgl/fixture.rs"]
#[allow(dead_code)]
mod fixture;

use liblvgl_wasm_host::{
    FeatureModuleGraphError, FeatureValidationError, ManifestCheck, NumericEnvironment,
    NumericEnvironmentError, NumericEnvironmentId, NumericEnvironmentState, NumericHostBinding,
    NumericHostFactory, NumericHostInstance, NumericPreflightError, WasmCheck,
    load_lvgl_core_environment, preflight_lvgl_core_graph,
};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

type Graph = fixture::wasi_fixture::numeric::Fixture;
#[derive(Clone, Default)]
struct Trace {
    events: Arc<Mutex<Vec<i32>>>,
    created: Arc<Mutex<Vec<String>>>,
    closed: Arc<Mutex<Vec<String>>>,
}
struct Factory(Trace);
struct Host(Trace, String);
impl NumericHostFactory for Factory {
    fn create(
        &mut self,
        consumer: &str,
        _: NumericEnvironmentId,
    ) -> Result<Box<dyn NumericHostInstance>, String> {
        self.0.created.lock().unwrap().push(consumer.into());
        Ok(Box::new(Host(self.0.clone(), consumer.into())))
    }
}
impl NumericHostInstance for Host {
    fn call(&mut self, name: &str, values: &[i32]) -> Result<Option<i32>, String> {
        assert_eq!(name, "lifecycle");
        assert_eq!(values.len(), 1);
        self.0.events.lock().unwrap().push(values[0]);
        Ok(None)
    }
    fn close(&mut self) -> Result<(), String> {
        self.0.closed.lock().unwrap().push(self.1.clone());
        Ok(())
    }
}
fn events(trace: &Trace) -> Vec<i32> {
    trace.events.lock().unwrap().clone()
}
fn load(graph: &Graph, trace: &Trace) -> Result<NumericEnvironment, NumericEnvironmentError> {
    let mut factory = Factory(trace.clone());
    let mut hosts = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let mut wasi = fixture::wasi_fixture::options();
    wasi.output_fds.clear();
    let output = fixture::wasi_fixture::Writes::default();
    load_lvgl_core_environment(
        &graph.input(),
        &graph.profile,
        &fixture::features(),
        &mut hosts,
        &fixture::options(),
        Some((&wasi, Box::new(output))),
    )
}

pub fn positive(bytes: &[u8]) {
    let graph = fixture::graph(bytes, "real");
    let mut wasi = fixture::wasi_fixture::options();
    wasi.output_fds.clear();
    let report = preflight_lvgl_core_graph(
        &graph.input(),
        &graph.profile,
        &fixture::features(),
        &fixture::options(),
        Some(&wasi),
    )
    .unwrap();
    assert_eq!(report.app_id(), "app");
    assert_eq!(report.graph().order(), ["lvcore", "middle", "app"]);
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
    let first_trace = Trace::default();
    let second_trace = Trace::default();
    let mut first = load(&graph, &first_trace).unwrap();
    let mut second = load(&graph, &second_trace).unwrap();
    assert_eq!(events(&first_trace), [10, 20]);
    assert_eq!(events(&second_trace), [10, 20]);
    assert_eq!(first.run(5).unwrap(), 115);
    assert_eq!(second.run(7).unwrap(), 117);
    assert_eq!(first.run(5).unwrap(), 225);
    assert_eq!((first.run(-10).unwrap(), first.run(-11).unwrap()), (2, 2));
    assert_eq!((second.run(-10).unwrap(), second.run(-11).unwrap()), (1, 1));
    first.close().unwrap();
    assert_eq!(first.state(), NumericEnvironmentState::Closed);
    assert_eq!(events(&first_trace), [10, 20, 21, 11]);
    assert_eq!(*first_trace.closed.lock().unwrap(), ["app", "middle"]);
    assert_eq!(second.run(5).unwrap(), 225);
    second.close().unwrap();
    assert_eq!(second.state(), NumericEnvironmentState::Closed);
    assert_eq!(events(&second_trace), [10, 20, 21, 11]);
    assert_eq!(*second_trace.closed.lock().unwrap(), ["app", "middle"]);
}

pub fn failed_init(bytes: &[u8], name: &str, expected: &[i32]) {
    let graph = fixture::graph(bytes, name);
    let trace = Trace::default();
    let error = load(&graph, &trace).unwrap_err();
    assert!(
        error.message().contains("module_init returned 7"),
        "{name}: {error}"
    );
    assert!(error.cleanup_errors().is_empty(), "{name}: {error}");
    assert_eq!(events(&trace), expected, "{name}");
    assert_eq!(*trace.created.lock().unwrap(), ["middle", "app"], "{name}");
    assert_eq!(*trace.closed.lock().unwrap(), ["app", "middle"], "{name}");
}

pub fn trap(bytes: &[u8]) {
    let graph = fixture::graph(bytes, "real");
    let trace = Trace::default();
    let mut environment = load(&graph, &trace).unwrap();
    let failure = environment.run(-1).unwrap_err();
    assert!(failure.message().contains("guest call failed"), "{failure}");
    assert!(failure.message().contains("unreachable"), "{failure}");
    assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
    assert_eq!(events(&trace), [10, 20]);
    assert_eq!(environment.run(5).unwrap_err().message(), failure.message());
    assert_eq!(
        environment.close().unwrap_err().message(),
        failure.message()
    );
    assert_eq!(events(&trace), [10, 20]);
    assert_eq!(*trace.closed.lock().unwrap(), ["app", "middle"]);
}

pub fn rejects_untrusted_middle_before_host_creation(bytes: &[u8]) {
    for mismatch in ["sha", "interface", "signature"] {
        let mut graph = fixture::graph(bytes, "real");
        let middle = graph
            .profile
            .modules
            .iter_mut()
            .find(|item| item.id == "middle")
            .unwrap();
        match mismatch {
            "sha" => middle.sha256 = "0".repeat(64),
            "interface" => middle.interface.version += 1,
            "signature" => {
                middle
                    .exports
                    .iter_mut()
                    .find(|item| item.name == "middle_step")
                    .unwrap()
                    .params += 1
            }
            _ => unreachable!(),
        }
        let trace = Trace::default();
        let error = load(&graph, &trace).unwrap_err();
        assert!(
            error.message().contains("authorized") || error.message().contains("contract differs"),
            "{mismatch}: {error}"
        );
        assert!(trace.created.lock().unwrap().is_empty(), "{mismatch}");
        assert!(events(&trace).is_empty(), "{mismatch}");
    }

    let mut graph = fixture::graph(bytes, "real");
    graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "middle")
        .unwrap()
        .0
        .target
        .features
        .push("simd".into());
    let mut wasi = fixture::wasi_fixture::options();
    wasi.output_fds.clear();
    assert!(matches!(
        preflight_lvgl_core_graph(&graph.input(), &graph.profile, &fixture::features(),
            &fixture::options(), Some(&wasi)),
        Err(NumericPreflightError::Feature(FeatureModuleGraphError::Feature {
            module, source: FeatureValidationError::Policy(_),
        })) if module == "middle"
    ));
    let trace = Trace::default();
    assert!(load(&graph, &trace).is_err());
    assert!(trace.created.lock().unwrap().is_empty());
}

pub fn main() {
    let path = std::env::args_os().nth(1).expect("chain graph path");
    positive(&std::fs::read(path).unwrap());
}
