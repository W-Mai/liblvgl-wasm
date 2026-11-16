#[path = "../../../tests/fixtures/host-sdk/event-lib-runtime.rs"]
#[allow(dead_code)]
mod runtime;

use liblvgl_wasm_host::{
    ManifestRequirement, ModuleExport, ModuleExternalType, ModuleImport, NumericEnvironment,
    NumericEnvironmentState, WasmExternal, inspect_wasm_facts,
};
use runtime::{Graph, Trace, load};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf, sync::Mutex};

static TEST_LOCK: Mutex<()> = Mutex::new(());

fn fixture(name: &str) -> (Graph, Value) {
    let bytes = std::fs::read(
        std::env::var_os("LVW_TEST_EVENT_LIB_GRAPH").expect("LVW_TEST_EVENT_LIB_GRAPH"),
    )
    .unwrap();
    let cases: Value = serde_json::from_slice(&bytes).unwrap();
    (
        runtime::fixture::lvgl_fixture::graph(&bytes, name),
        runtime::select_case(&cases, name).clone(),
    )
}

fn substitute(graph: &mut Graph, id: &str, name: &str) {
    let root = PathBuf::from(
        std::env::var_os("LVW_TEST_EVENT_LIB_FAULTS").expect("LVW_TEST_EVENT_LIB_FAULTS"),
    );
    let bytes = std::fs::read(root.join(format!("{name}.wasm"))).unwrap();
    let facts = inspect_wasm_facts(&bytes).unwrap();
    let descriptor = |external: &WasmExternal| match *external {
        WasmExternal::Function { type_index, .. } => ModuleExternalType::Function {
            params: facts.types[type_index as usize].params.clone(),
            results: facts.types[type_index as usize].results.clone(),
        },
        WasmExternal::Memory { ty, .. } => ModuleExternalType::Memory(ty),
        WasmExternal::Table { ty, .. } => ModuleExternalType::Table(ty),
        _ => panic!("unsupported test declaration"),
    };
    let mut requirements = BTreeMap::new();
    for item in &facts.imports {
        let provider = match item.module.as_str() {
            "trace" => "host.trace",
            "lvgl" => "host.label",
            "lvw" => "host.lvw",
            name => name,
        };
        let requirement =
            requirements
                .entry(provider.to_owned())
                .or_insert_with(|| ManifestRequirement {
                    provider: provider.into(),
                    interface: item.module.clone(),
                    version: 1,
                    imports: vec![],
                });
        requirement.imports.push(ModuleImport {
            module: item.module.clone(),
            name: item.name.clone(),
            provider_export: item.name.clone(),
            ty: descriptor(&item.external),
        });
    }
    let exports = facts
        .exports
        .iter()
        .map(|item| ModuleExport {
            name: item.name.clone(),
            ty: descriptor(&item.external),
        })
        .collect();
    if id == "lvcore" {
        let host = graph
            .hosts
            .iter_mut()
            .find(|host| host.id == "host.lvw")
            .unwrap();
        host.exports = requirements["host.lvw"]
            .imports
            .iter()
            .map(|item| ModuleExport {
                name: item.name.clone(),
                ty: item.ty.clone(),
            })
            .collect();
    }
    graph.replace(id, bytes);
    let manifest = &mut graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == id)
        .unwrap()
        .0;
    manifest.requires = requirements.into_values().collect();
    manifest.exports = exports;
    manifest.target.features.clear();
    graph.profile.limits.max_total_table_elements = graph
        .modules
        .iter()
        .map(|(_, bytes)| {
            inspect_wasm_facts(bytes)
                .unwrap()
                .tables
                .iter()
                .map(|table| u64::from(table.ty.maximum.unwrap()))
                .sum::<u64>()
        })
        .sum();
}

fn poison(
    environment: &mut NumericEnvironment,
    action: impl FnOnce(
        &mut NumericEnvironment,
    ) -> Result<(), liblvgl_wasm_host::NumericEnvironmentError>,
    expected: &str,
    trace: &Trace,
) {
    let error = action(environment).unwrap_err();
    assert!(error.message().contains(expected), "{error}");
    assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
    let previous = trace.0.lock().unwrap().clone();
    for next in [
        environment.run(0).unwrap_err(),
        environment.read_frame().unwrap_err(),
        environment.close().unwrap_err(),
    ] {
        assert_eq!(next.message(), error.message());
        assert_eq!(next.cleanup_errors(), error.cleanup_errors());
    }
    assert_eq!(*trace.0.lock().unwrap(), previous);
}

#[test]
fn library_callback_table_tokens_limits_and_host_errors_poison_without_guest_cleanup() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    for (name, action, expected) in [
        ("event-lib-index-2", 0, "guest call failed"),
        ("event-lib-index-3", 0, "guest call failed"),
        ("event-lib-index-4", 0, "guest call failed"),
        ("event-lib-fault", 3, "invalid LVGL event token"),
        ("event-lib-fault", 6, "unsupported LVGL event dispatch"),
        ("event-lib-fault", 9, "invalid LVGL event descriptor"),
        ("event-lib-fault", 1, "LVGL event nesting limit exceeded"),
        ("event-lib-fault", 0, "test callback host failure"),
    ] {
        let (mut graph, mut case) = fixture("real");
        substitute(&mut graph, "middle", name);
        case["event"]["maxDepth"] = Value::from(1);
        let trace = Trace::default();
        let fail_host = expected == "test callback host failure";
        let mut environment = load(&graph, &case, &trace, fail_host).unwrap();
        if action == 3 {
            assert_eq!(environment.run(0).unwrap(), 1);
        }
        poison(
            &mut environment,
            |env| env.run(action).map(|_| ()),
            expected,
            &trace,
        );
        let events = trace.0.lock().unwrap();
        assert!(!events.contains(&"guest:39".into()));
        assert!(events.ends_with(&["host:app".into(), "host:middle".into()]));
    }
}

#[test]
fn foreign_event_tokens_reject_inside_an_active_middle_callback() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let (mut graph, case) = fixture("real");
    substitute(&mut graph, "middle", "event-lib-foreign");
    let a_trace = Trace::default();
    let b_trace = Trace::default();
    let mut a = load(&graph, &case, &a_trace, false).unwrap();
    let mut b = load(&graph, &case, &b_trace, false).unwrap();
    assert_eq!(a.run(0).unwrap(), 1);
    let token = a.run(-1).unwrap();
    assert_ne!(token, 0);
    poison(
        &mut b,
        |env| env.run(token).map(|_| ()),
        "invalid LVGL event token",
        &b_trace,
    );
    assert_eq!(a.run(0).unwrap(), 2);
    a.close().unwrap();
}

#[test]
fn reactor_and_close_failures_stop_guest_and_keep_initialization_errors() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    for trap in [false, true] {
        let (mut graph, case) = fixture("real");
        substitute(
            &mut graph,
            "middle",
            if trap {
                "event-lib-reactor-trap"
            } else {
                "event-lib-reactor"
            },
        );
        let trace = Trace::default();
        let result = load(&graph, &case, &trace, false);
        if trap {
            assert!(result.unwrap_err().message().contains("guest call failed"));
            assert_eq!(
                *trace.0.lock().unwrap(),
                [
                    "guest:31",
                    "guest:70",
                    "guest:71",
                    "host:app",
                    "host:middle"
                ]
            );
        } else {
            let mut environment = result.unwrap();
            runtime::frame(&mut environment);
            environment.close().unwrap();
            assert_eq!(
                *trace.0.lock().unwrap(),
                [
                    "guest:31",
                    "guest:70",
                    "guest:71",
                    "guest:33",
                    "guest:20",
                    "guest:21",
                    "guest:39",
                    "host:app",
                    "host:middle"
                ]
            );
        }
    }
    for trap in [false, true] {
        for rollback in [false, true] {
            let (mut graph, case) = fixture(if rollback { "app-fail-init" } else { "real" });
            substitute(
                &mut graph,
                "middle",
                if trap {
                    "event-lib-close-trap"
                } else {
                    "event-lib-close-fail"
                },
            );
            let trace = Trace::default();
            let expected = if trap {
                "guest call failed"
            } else {
                "module_close returned 7"
            };
            if rollback {
                let error = load(&graph, &case, &trace, true).unwrap_err();
                assert!(
                    error.message().contains("module_init returned 7"),
                    "{error}"
                );
                assert!(
                    error
                        .cleanup_errors()
                        .iter()
                        .any(|error| error.contains(expected)),
                    "{error}"
                );
                assert!(
                    error
                        .cleanup_errors()
                        .iter()
                        .any(|error| error.contains("test host cleanup failed")),
                    "{error}"
                );
            } else {
                let mut environment = load(&graph, &case, &trace, true).unwrap();
                poison(
                    &mut environment,
                    NumericEnvironment::close,
                    expected,
                    &trace,
                );
            }
        }
    }
    let (mut graph, case) = fixture("real");
    substitute(&mut graph, "app", "event-lib-app-data");
    let trace = Trace::default();
    let error = load(&graph, &case, &trace, false).unwrap_err();
    assert!(
        error.message().contains("out of bounds memory access"),
        "{error}"
    );
    assert_eq!(
        *trace.0.lock().unwrap(),
        ["guest:10", "host:app", "host:middle"]
    );
}

#[test]
fn controlled_core_unsubscribe_failure_stops_shutdown_in_close_and_rollback() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    for rollback in [false, true] {
        let (mut graph, case) = fixture(if rollback { "app-fail-init" } else { "real" });
        substitute(&mut graph, "middle", "event-lib-fault");
        substitute(&mut graph, "lvcore", "event-lib-core-remove-fail");
        let trace = Trace::default();
        if rollback {
            let error = load(&graph, &case, &trace, true).unwrap_err();
            assert!(
                error.message().contains("module_init returned 7"),
                "{error}"
            );
            assert!(
                error
                    .cleanup_errors()
                    .iter()
                    .any(|error| error.contains("LVGL event removal failed (7)")),
                "{error}"
            );
        } else {
            let mut environment = load(&graph, &case, &trace, true).unwrap();
            poison(
                &mut environment,
                NumericEnvironment::close,
                "LVGL event removal failed (7)",
                &trace,
            );
        }
        let events = trace.0.lock().unwrap();
        assert!(events.contains(&"guest:51".into()));
        assert!(!events.contains(&"guest:19".into()));
        assert!(
            events.ends_with(&[
                "host:app".into(),
                "host:middle".into(),
                "host:lvcore".into()
            ]),
            "{events:?}"
        );
    }
}
