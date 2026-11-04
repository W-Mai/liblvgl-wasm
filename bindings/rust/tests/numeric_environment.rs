#[path = "../../../tests/fixtures/numeric-environment/fixture.rs"]
mod fixture;

use fixture::{Fixture, Trace, TraceFactory};
use liblvgl_wasm_host::{
    NumericEnvironmentId, NumericEnvironmentState, NumericHostBinding, NumericHostFactory,
    NumericHostInstance, load_numeric_environment, preflight_numeric_graph,
};
use std::{fs, path::PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn json() -> Vec<u8> {
    fs::read(root().join("target/validator/numeric-preflight.json")).unwrap()
}
fn wasm(name: &str) -> Vec<u8> {
    fs::read(root().join(format!("target/validator/numeric-fixtures/{name}.wasm"))).unwrap()
}
fn extra(name: &str) -> Vec<u8> {
    fs::read(root().join(format!(
        "target/validator/numeric-environment-fixtures/{name}.wasm"
    )))
    .unwrap()
}
fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).into()).collect()
}

#[test]
fn dag_runs_and_closes_in_dependency_order() {
    fixture::run_positive(&json());
}

#[test]
fn independent_environments_keep_each_module_memory_private() {
    let graph = Fixture::from_json(&json());
    let input = graph.input();
    let trace = Trace::default();
    let mut factory = TraceFactory(trace.clone());
    let mut bindings = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let mut a = load_numeric_environment(&input, &graph.profile, &[], &mut bindings).unwrap();
    let mut b = load_numeric_environment(&input, &graph.profile, &[], &mut bindings).unwrap();
    {
        let ids = trace.environments.lock().unwrap();
        assert_eq!(ids.len(), 8);
        assert!(ids[..4].iter().all(|id| id == &ids[0]));
        assert!(ids[4..].iter().all(|id| id == &ids[4]));
        assert!(ids[0] != ids[4]);
    }
    assert_eq!(a.run(-2).unwrap(), 0);
    assert_eq!(b.run(-2).unwrap(), 0);
    assert_eq!(a.run(5).unwrap(), 30);
    assert_eq!(a.run(-2).unwrap(), 120);
    assert_eq!(b.run(-2).unwrap(), 0);
    assert_eq!(b.run(7).unwrap(), 40);
    assert_eq!(b.run(-2).unwrap(), 128);
    assert_eq!(a.run(-2).unwrap(), 120);
    a.close().unwrap();
    b.close().unwrap();
}

#[test]
fn nonzero_initialization_rolls_back_only_successful_modules() {
    for (id, expected) in [
        ("core", strings(&["12", "10"])),
        ("b", strings(&["12", "10", "22", "20", "11"])),
        (
            "a",
            strings(&["12", "10", "22", "20", "32", "30", "21", "11"]),
        ),
        (
            "app",
            strings(&[
                "12", "10", "22", "20", "32", "30", "42", "40", "31", "21", "11",
            ]),
        ),
    ] {
        let mut graph = Fixture::from_json(&json());
        graph.replace(id, wasm(&format!("{id}-fail")));
        let input = graph.input();
        let trace = Trace::default();
        let mut factory = TraceFactory(trace.clone());
        let mut bindings = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
        let error = load_numeric_environment(&input, &graph.profile, &[], &mut bindings)
            .err()
            .unwrap();
        assert!(error.message().contains("7"), "{id}: {}", error.message());
        let events = trace.events.lock().unwrap();
        assert_eq!(&events[..expected.len()], expected, "{id}");
        assert_eq!(
            &events[expected.len()..],
            strings(&["host:app", "host:a", "host:b", "host:core"]),
            "{id}"
        );
    }
}

#[test]
fn traps_and_failed_close_poison_without_further_guest_calls() {
    for (variant, expected) in [
        (
            "app-reactor-trap",
            strings(&["12", "10", "22", "20", "32", "30", "42"]),
        ),
        (
            "app-init-trap",
            strings(&["12", "10", "22", "20", "32", "30", "42", "40"]),
        ),
    ] {
        let mut graph = Fixture::from_json(&json());
        graph.replace("app", wasm(variant));
        let input = graph.input();
        let trace = Trace::default();
        let mut factory = TraceFactory(trace.clone());
        let mut bindings = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
        assert!(
            load_numeric_environment(&input, &graph.profile, &[], &mut bindings).is_err(),
            "{variant}"
        );
        let events = trace.events.lock().unwrap();
        assert_eq!(&events[..expected.len()], expected, "{variant}");
        assert_eq!(
            &events[expected.len()..],
            strings(&["host:app", "host:a", "host:b", "host:core"])
        );
    }
    for variant in ["app", "app-close-trap", "app-close-fail"] {
        let mut graph = Fixture::from_json(&json());
        graph.replace("app", wasm(variant));
        let input = graph.input();
        let trace = Trace::default();
        let mut factory = TraceFactory(trace.clone());
        let mut bindings = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
        let mut environment =
            load_numeric_environment(&input, &graph.profile, &[], &mut bindings).unwrap();
        if variant == "app" {
            assert!(environment.run(-1).is_err());
        } else {
            assert!(environment.close().is_err());
        }
        assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
        assert!(environment.run(5).is_err());
        assert!(environment.close().is_err());
        let mut expected = strings(&["12", "10", "22", "20", "32", "30", "42", "40"]);
        if variant != "app" {
            expected.push("41".into());
        }
        expected.extend(strings(&["host:app", "host:a", "host:b", "host:core"]));
        assert_eq!(*trace.events.lock().unwrap(), expected, "{variant}");
    }
}

#[test]
fn distinct_consumer_bindings_and_duplicate_imports_are_preserved() {
    let mut graph = Fixture::from_json(&json());
    graph.replace("b", extra("b-distinct"));
    graph.replace("a", extra("a-distinct"));
    graph.replace("app", extra("app-duplicate"));
    for id in ["a", "b"] {
        let manifest = &mut graph
            .modules
            .iter_mut()
            .find(|(manifest, _)| manifest.id == id)
            .unwrap()
            .0;
        let provider = if id == "a" { "b" } else { "core" };
        let requirement = manifest
            .requires
            .iter_mut()
            .find(|item| item.provider == provider)
            .unwrap();
        requirement
            .imports
            .iter_mut()
            .find(|item| item.name == "calc")
            .unwrap()
            .module = "shared".into();
    }
    let manifest = &mut graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "app")
        .unwrap()
        .0;
    let requirement = manifest
        .requires
        .iter_mut()
        .find(|item| item.provider == "a")
        .unwrap();
    let duplicate = requirement
        .imports
        .iter()
        .find(|item| item.name == "calc")
        .unwrap()
        .clone();
    requirement.imports.push(duplicate);
    let input = graph.input();
    let trace = Trace::default();
    let mut factory = TraceFactory(trace.clone());
    let mut bindings = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let mut environment =
        load_numeric_environment(&input, &graph.profile, &[], &mut bindings).unwrap();
    assert_eq!(environment.run(5).unwrap(), 30);
    environment.close().unwrap();
}

#[test]
fn trapping_instantiation_stops_guest_and_preserves_host_cleanup_errors() {
    for (variant, reason, table) in [
        ("app-instantiate-fail", "out of bounds memory access", false),
        (
            "app-instantiate-table-fail",
            "out of bounds table access",
            true,
        ),
    ] {
        for fail_close in [false, true] {
            let mut graph = Fixture::from_json(&json());
            graph.replace("app", extra(variant));
            if table {
                graph.profile.limits.max_table_elements = 1;
                graph.profile.limits.max_total_table_elements = 1;
            }
            let input = graph.input();
            let trace = Trace::default();
            let mut factory = FaultFactory {
                trace: trace.clone(),
                faults: Faults {
                    fail_close: fail_close.then(|| "b".into()),
                    ..Faults::default()
                },
            };
            let mut bindings = [NumericHostBinding {
                id: "host.trace".into(),
                factory: &mut factory,
            }];
            let report = preflight_numeric_graph(&input, &graph.profile, &[]).unwrap();
            assert_eq!(report.app_id(), "app");
            assert!(trace.events.lock().unwrap().is_empty());
            let error = load_numeric_environment(&input, &graph.profile, &[], &mut bindings)
                .expect_err("active segment must trap during instantiation");
            assert!(
                error.message().contains("\"app\": instantiation failed"),
                "{variant}: {}",
                error.message()
            );
            assert!(
                error.message().contains(reason),
                "{variant}: {}",
                error.message()
            );
            if fail_close {
                assert_eq!(error.cleanup_errors(), &["host cleanup failed"]);
            } else {
                assert!(error.cleanup_errors().is_empty());
            }
            assert_eq!(
                *trace.events.lock().unwrap(),
                strings(&[
                    "12",
                    "10",
                    "22",
                    "20",
                    "32",
                    "30",
                    "host:app",
                    "host:a",
                    "host:b",
                    "host:core"
                ]),
                "{variant}, host failure={fail_close}"
            );
        }
    }
}

#[derive(Clone, Default)]
struct Faults {
    fail_factory: Option<String>,
    panic_factory: Option<String>,
    fail_event: Option<i32>,
    panic_event: Option<i32>,
    fail_close: Option<String>,
    panic_close: Option<String>,
}
struct FaultFactory {
    trace: Trace,
    faults: Faults,
}
struct FaultHost {
    trace: Trace,
    faults: Faults,
    consumer: String,
}
impl NumericHostFactory for FaultFactory {
    fn create(
        &mut self,
        consumer_id: &str,
        _: NumericEnvironmentId,
    ) -> Result<Box<dyn NumericHostInstance>, String> {
        assert_ne!(
            self.faults.panic_factory.as_deref(),
            Some(consumer_id),
            "factory panic"
        );
        if self.faults.fail_factory.as_deref() == Some(consumer_id) {
            return Err("factory failed".into());
        }
        Ok(Box::new(FaultHost {
            trace: self.trace.clone(),
            faults: self.faults.clone(),
            consumer: consumer_id.into(),
        }))
    }
}
impl NumericHostInstance for FaultHost {
    fn call(&mut self, _: &str, args: &[i32]) -> Result<Option<i32>, String> {
        let value = args[0];
        self.trace.events.lock().unwrap().push(value.to_string());
        assert_ne!(self.faults.panic_event, Some(value), "host panic");
        if self.faults.fail_event == Some(value) {
            return Err("host call failed".into());
        }
        Ok(None)
    }
    fn close(&mut self) -> Result<(), String> {
        self.trace
            .events
            .lock()
            .unwrap()
            .push(format!("host:{}", self.consumer));
        assert_ne!(
            self.faults.panic_close.as_deref(),
            Some(self.consumer.as_str()),
            "host cleanup panic"
        );
        if self.faults.fail_close.as_deref() == Some(&self.consumer) {
            return Err("host cleanup failed".into());
        }
        Ok(())
    }
}

#[test]
fn host_factory_failure_cleans_created_hosts_before_guest() {
    for panic in [false, true] {
        let graph = Fixture::from_json(&json());
        let input = graph.input();
        let trace = Trace::default();
        let faults = Faults {
            fail_factory: (!panic).then(|| "b".into()),
            panic_factory: panic.then(|| "b".into()),
            ..Faults::default()
        };
        let mut factory = FaultFactory {
            trace: trace.clone(),
            faults,
        };
        let mut bindings = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
        let error = load_numeric_environment(&input, &graph.profile, &[], &mut bindings)
            .err()
            .unwrap();
        assert!(error.message().contains(if panic {
            "factory panic"
        } else {
            "factory failed"
        }));
        assert_eq!(*trace.events.lock().unwrap(), strings(&["host:core"]));
    }
}

#[test]
fn host_error_and_panic_poison_and_keep_cleanup_failure_observable() {
    for panic in [false, true] {
        let graph = Fixture::from_json(&json());
        let input = graph.input();
        let trace = Trace::default();
        let faults = Faults {
            fail_event: (!panic).then_some(40),
            panic_event: panic.then_some(40),
            fail_close: Some("b".into()),
            ..Faults::default()
        };
        let mut factory = FaultFactory {
            trace: trace.clone(),
            faults,
        };
        let mut bindings = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
        let error = load_numeric_environment(&input, &graph.profile, &[], &mut bindings)
            .err()
            .unwrap();
        assert!(
            error.message().contains(if panic {
                "host panic"
            } else {
                "host call failed"
            }),
            "{}",
            error.message()
        );
        assert!(
            error
                .cleanup_errors()
                .iter()
                .any(|value| value.contains("host cleanup failed"))
        );
        assert_eq!(
            *trace.events.lock().unwrap(),
            strings(&[
                "12",
                "10",
                "22",
                "20",
                "32",
                "30",
                "42",
                "40",
                "host:app",
                "host:a",
                "host:b",
                "host:core"
            ])
        );
    }
}

#[test]
fn invalid_factory_inventory_is_rejected_without_any_factory() {
    let graph = Fixture::from_json(&json());
    let input = graph.input();
    let trace = Trace::default();
    let mut first = TraceFactory(trace.clone());
    let mut second = TraceFactory(trace.clone());
    let mut duplicate = [
        NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut first,
        },
        NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut second,
        },
    ];
    assert!(load_numeric_environment(&input, &graph.profile, &[], &mut duplicate).is_err());
    let mut missing: [NumericHostBinding<'_>; 0] = [];
    assert!(load_numeric_environment(&input, &graph.profile, &[], &mut missing).is_err());
    assert!(trace.environments.lock().unwrap().is_empty());
    assert!(trace.events.lock().unwrap().is_empty());
}

#[test]
fn dropping_environment_never_runs_guest_close() {
    let graph = Fixture::from_json(&json());
    let input = graph.input();
    let trace = Trace::default();
    let mut factory = TraceFactory(trace.clone());
    let mut bindings = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let environment = load_numeric_environment(&input, &graph.profile, &[], &mut bindings).unwrap();
    drop(environment);
    assert_eq!(
        *trace.events.lock().unwrap(),
        strings(&[
            "12",
            "10",
            "22",
            "20",
            "32",
            "30",
            "42",
            "40",
            "host:app",
            "host:a",
            "host:b",
            "host:core"
        ])
    );
}

#[test]
fn host_cleanup_panic_is_recorded_and_remaining_hosts_are_closed() {
    let graph = Fixture::from_json(&json());
    let input = graph.input();
    let trace = Trace::default();
    let faults = Faults {
        fail_event: Some(40),
        panic_close: Some("b".into()),
        ..Faults::default()
    };
    let mut factory = FaultFactory {
        trace: trace.clone(),
        faults,
    };
    let mut bindings = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let error = load_numeric_environment(&input, &graph.profile, &[], &mut bindings)
        .err()
        .unwrap();
    assert!(error.message().contains("host call failed"));
    assert!(
        error
            .cleanup_errors()
            .iter()
            .any(|value| value.contains("host cleanup panic"))
    );
    assert_eq!(
        *trace.events.lock().unwrap(),
        strings(&[
            "12",
            "10",
            "22",
            "20",
            "32",
            "30",
            "42",
            "40",
            "host:app",
            "host:a",
            "host:b",
            "host:core"
        ])
    );
}

#[test]
fn failed_rollback_preserves_init_failure_and_stops_guest_cleanup() {
    for variant in ["a-close-fail", "a-close-trap"] {
        let mut graph = Fixture::from_json(&json());
        graph.replace("app", wasm("app-fail"));
        graph.replace("a", wasm(variant));
        let input = graph.input();
        let trace = Trace::default();
        let mut factory = TraceFactory(trace.clone());
        let mut bindings = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
        let error = load_numeric_environment(&input, &graph.profile, &[], &mut bindings)
            .err()
            .unwrap();
        assert!(error.message().contains("7"), "{}", error.message());
        assert!(!error.cleanup_errors().is_empty(), "{variant}");
        assert_eq!(
            *trace.events.lock().unwrap(),
            strings(&[
                "12",
                "10",
                "22",
                "20",
                "32",
                "30",
                "42",
                "40",
                "31",
                "host:app",
                "host:a",
                "host:b",
                "host:core"
            ])
        );
    }
}

struct SecondPayload;
impl Drop for SecondPayload {
    fn drop(&mut self) {
        panic!("second payload drop");
    }
}
struct PanickingPayload;
impl Drop for PanickingPayload {
    fn drop(&mut self) {
        std::panic::panic_any(SecondPayload);
    }
}

struct PayloadFactory {
    trace: Trace,
    factory: bool,
    call: bool,
    close: bool,
    drop_host: bool,
}
struct PayloadHost {
    trace: Trace,
    consumer: String,
    call: bool,
    close: bool,
    drop_host: bool,
}
impl NumericHostFactory for PayloadFactory {
    fn create(
        &mut self,
        consumer_id: &str,
        _: NumericEnvironmentId,
    ) -> Result<Box<dyn NumericHostInstance>, String> {
        if self.factory && consumer_id == "b" {
            std::panic::panic_any(PanickingPayload);
        }
        Ok(Box::new(PayloadHost {
            trace: self.trace.clone(),
            consumer: consumer_id.into(),
            call: self.call,
            close: self.close,
            drop_host: self.drop_host,
        }))
    }
}
impl Drop for PayloadHost {
    fn drop(&mut self) {
        if self.drop_host && self.consumer == "b" {
            std::panic::panic_any(PanickingPayload);
        }
    }
}
impl NumericHostInstance for PayloadHost {
    fn call(&mut self, _: &str, args: &[i32]) -> Result<Option<i32>, String> {
        self.trace.events.lock().unwrap().push(args[0].to_string());
        if self.call && args[0] == 40 {
            std::panic::panic_any(PanickingPayload);
        }
        Ok(None)
    }
    fn close(&mut self) -> Result<(), String> {
        self.trace
            .events
            .lock()
            .unwrap()
            .push(format!("host:{}", self.consumer));
        if self.close && self.consumer == "b" {
            std::panic::panic_any(PanickingPayload);
        }
        Ok(())
    }
}

#[test]
fn panicking_payload_destructors_do_not_escape_or_interrupt_cleanup() {
    for (factory_panic, call_panic, close_panic, drop_host, drop_environment, unwind) in [
        (true, false, false, false, false, false),
        (false, true, true, false, false, false),
        (false, false, true, false, false, false),
        (false, false, false, true, false, false),
        (false, false, true, false, true, false),
        (false, false, false, true, true, false),
        (false, false, true, false, true, true),
        (false, false, false, true, true, true),
    ] {
        let graph = Fixture::from_json(&json());
        let input = graph.input();
        let trace = Trace::default();
        let mut factory = PayloadFactory {
            trace: trace.clone(),
            factory: factory_panic,
            call: call_panic,
            close: close_panic,
            drop_host,
        };
        let mut bindings = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
        if factory_panic || call_panic {
            let error = load_numeric_environment(&input, &graph.profile, &[], &mut bindings)
                .err()
                .unwrap();
            assert!(
                error.message().contains("panic payload drop panicked"),
                "{}",
                error.message()
            );
            if close_panic {
                assert!(
                    error
                        .cleanup_errors()
                        .iter()
                        .any(|value| value.contains("panic payload drop panicked"))
                );
            }
        } else {
            let mut environment =
                load_numeric_environment(&input, &graph.profile, &[], &mut bindings).unwrap();
            if unwind {
                let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _environment = environment;
                    panic!("original outer panic");
                }))
                .unwrap_err();
                assert_eq!(panic.downcast_ref::<&str>(), Some(&"original outer panic"));
            } else if drop_environment {
                assert!(
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(environment)))
                        .is_ok()
                );
            } else {
                let error = environment.close().unwrap_err();
                assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
                assert!(
                    error
                        .cleanup_errors()
                        .iter()
                        .any(|value| value.contains("panic payload drop panicked"))
                );
            }
        }
        let events = trace.events.lock().unwrap();
        let last = if factory_panic {
            &events[..]
        } else {
            &events[events.len() - 4..]
        };
        assert_eq!(
            last,
            if factory_panic {
                strings(&["host:core"])
            } else {
                strings(&["host:app", "host:a", "host:b", "host:core"])
            }
        );
    }
}
