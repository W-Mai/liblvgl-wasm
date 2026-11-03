use super::numeric_label_test::{
    Fixture, Trace, TraceFactory, core_text, features, graph, lvgl_options, options,
    verify_real_core, wasi_options,
};
use super::numeric_lvgl_test::read_bounded;
use super::{
    NumericEnvironment, NumericEnvironmentError, NumericEnvironmentState, NumericHostBinding,
    load_lvgl_event_environment,
};
use crate::{NumericEnvironmentId, NumericEventOptions, NumericWasiOutput};
use serde_json::Value;
use std::path::PathBuf;

fn graph_bytes() -> Vec<u8> {
    read_bounded("LVW_TEST_EVENT_GRAPH", 256 * 1024 * 1024)
}
fn event_options(bytes: &[u8], name: &str) -> NumericEventOptions {
    let cases: Value = serde_json::from_slice(bytes).unwrap();
    let case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == name)
        .unwrap();
    NumericEventOptions {
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
    }
}
struct NoOutput;
impl NumericWasiOutput for NoOutput {
    fn write(&mut self, _: &str, _: u32, _: &[u8], _: NumericEnvironmentId) -> Result<(), String> {
        Err("unexpected WASI output".into())
    }
}
fn real_environment(
    bytes: &[u8],
    name: &str,
) -> Result<NumericEnvironment, NumericEnvironmentError> {
    let graph = graph(bytes, name);
    verify_real_core(&graph);
    let mut wasi = wasi_options();
    wasi.output_fds.clear();
    load_lvgl_event_environment(
        &graph.input(),
        &graph.profile,
        &features(),
        &mut [],
        &lvgl_options(),
        &options(bytes, name),
        &event_options(bytes, name),
        Some((&wasi, Box::new(NoOutput))),
    )
}
fn event_trace(trace: &Trace) -> Vec<String> {
    trace.events.lock().unwrap().clone()
}
fn synthetic(
    core: &str,
    app: &str,
    event: &NumericEventOptions,
) -> (Result<NumericEnvironment, NumericEnvironmentError>, Trace) {
    let bytes = graph_bytes();
    let mut graph: Fixture = graph(&bytes, "synthetic");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/validator/lvgl-event-negative");
    graph.replace(
        "lvcore",
        std::fs::read(root.join(format!("{core}.wasm"))).unwrap(),
    );
    graph.replace(
        "app",
        std::fs::read(root.join(format!("{app}.wasm"))).unwrap(),
    );
    let trace = Trace::default();
    let mut factory = TraceFactory(trace.clone());
    let mut hosts = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let mut label = options(&bytes, "synthetic");
    label.max_labels = 4;
    label.max_text_bytes = 16;
    let result = load_lvgl_event_environment(
        &graph.input(),
        &graph.profile,
        &[],
        &mut hosts,
        &lvgl_options(),
        &label,
        event,
        None,
    );
    (result, trace)
}
fn default_event() -> NumericEventOptions {
    NumericEventOptions {
        max_registrations: 1,
        max_depth: 4,
    }
}

#[test]
#[ignore = "requires generated event graph and fixed-table LVGL core"]
fn real_event_nested_dispatch_reregistration_and_isolation() {
    let bytes = graph_bytes();
    let mut a = real_environment(&bytes, "real").unwrap();
    let mut b = real_environment(&bytes, "real").unwrap();
    assert_eq!(core_text(&mut a), b"READY");
    assert_eq!(core_text(&mut b), b"READY");
    let before = a.read_frame().unwrap();
    let other = b.read_frame().unwrap();
    let first_label = a.run(0).unwrap();
    assert_ne!(first_label, b.run(0).unwrap());
    assert_eq!(a.run(1).unwrap(), 2);
    assert_eq!(a.run(4).unwrap(), 1);
    assert_eq!(
        [
            a.run(5).unwrap(),
            a.run(6).unwrap(),
            a.run(7).unwrap(),
            a.run(8).unwrap()
        ],
        [11, 12, 22, 21]
    );
    assert_eq!(core_text(&mut a), b"CLICKED");
    assert_eq!(core_text(&mut b), b"READY");
    assert_ne!(a.read_frame().unwrap().rgba, before.rgba);
    assert_eq!(b.read_frame().unwrap().rgba, other.rgba);
    assert_eq!(a.run(2).unwrap(), 1);
    let old = a.run(14).unwrap();
    assert_ne!(old, 0);
    assert_eq!(a.run(3).unwrap(), 2);
    assert_eq!(a.run(13).unwrap(), 1);
    let new = a.run(15).unwrap();
    assert_ne!(new, 0);
    assert_ne!(new, old);
    assert_eq!(a.run(3).unwrap(), 3);
    a.close().unwrap();
    assert_eq!(b.read_frame().unwrap().rgba, other.rgba);
    assert_eq!(b.run(16).unwrap(), 0);
    let error = b.run(first_label).unwrap_err();
    assert!(
        error.message().contains("invalid LVGL event target"),
        "{error}"
    );
    assert_eq!(b.state(), NumericEnvironmentState::Poisoned);
    assert_eq!(b.close().unwrap_err().message(), error.message());
}

#[test]
#[ignore = "requires generated event graph and fixed-table LVGL core"]
fn real_event_nested_removal_keeps_active_frame() {
    let bytes = graph_bytes();
    let mut environment = real_environment(&bytes, "real").unwrap();
    assert_eq!(environment.run(9).unwrap(), 2);
    assert_eq!(environment.run(4).unwrap(), 1);
    assert_eq!(
        [
            environment.run(5).unwrap(),
            environment.run(6).unwrap(),
            environment.run(7).unwrap(),
            environment.run(8).unwrap()
        ],
        [11, 12, 22, 21]
    );
    assert_eq!(environment.run(3).unwrap(), 2);
    environment.close().unwrap();
}

#[test]
#[ignore = "requires generated event graph and fixed-table LVGL core"]
fn real_event_stale_descriptor_cannot_remove_reregistered_callback() {
    let bytes = graph_bytes();
    let mut environment = real_environment(&bytes, "real").unwrap();
    assert_eq!(environment.run(2).unwrap(), 1);
    let old = environment.run(14).unwrap();
    assert_eq!(environment.run(13).unwrap(), 1);
    assert_ne!(environment.run(15).unwrap(), old);
    let error = environment.run(-2).unwrap_err();
    assert!(error.message().contains("descriptor"), "{error}");
    assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
    assert_eq!(environment.run(3).unwrap_err().message(), error.message());
    assert_eq!(
        environment.read_frame().unwrap_err().message(),
        error.message()
    );
    assert_eq!(environment.close().unwrap_err().message(), error.message());
}

#[test]
#[ignore = "requires generated event graph and synthetic fixtures"]
fn synthetic_event_nested_and_close_order() {
    let (result, trace) = synthetic("core", "app-close-observed", &default_event());
    let mut environment = result.unwrap();
    assert_eq!(environment.run(1).unwrap(), 2);
    let before = event_trace(&trace);
    let callback: Vec<_> = before
        .iter()
        .filter(|item| item.as_str() == "70" || item.as_str() == "71")
        .map(String::as_str)
        .collect();
    assert_eq!(callback, ["70", "70", "71", "71"]);
    environment.close().unwrap();
    let trace = event_trace(&trace);
    let pos = |value: &str| trace.iter().position(|item| item == value).unwrap();
    assert!(pos("39") < pos("38"), "{trace:?}");
    assert!(pos("38") < pos("51"), "{trace:?}");
    assert!(pos("51") < pos("19"), "{trace:?}");
}

#[test]
#[ignore = "requires generated event graph and synthetic fixtures"]
fn synthetic_event_failed_initialization_removes_before_shutdown() {
    let (result, trace) = synthetic("core", "app-init-fail", &default_event());
    let error = result.unwrap_err();
    assert!(
        error.message().contains("module_init returned 7"),
        "{error}"
    );
    assert!(error.cleanup_errors().is_empty());
    let trace = event_trace(&trace);
    let pos = |value: &str| trace.iter().position(|item| item == value).unwrap();
    assert!(pos("50") < pos("51") && pos("51") < pos("19"), "{trace:?}");
    assert!(!trace.iter().any(|item| item == "39"));
    let (result, trace) = synthetic("core-add-fail", "app", &default_event());
    let error = result.unwrap_err();
    assert!(
        error.message().contains("module_init returned 9"),
        "{error}"
    );
    let trace = event_trace(&trace);
    assert!(trace.iter().any(|item| item == "50"));
    assert!(!trace.iter().any(|item| item == "51"));
    assert!(trace.iter().any(|item| item == "19"));
}

#[test]
#[ignore = "requires generated event graph and synthetic fixtures"]
fn synthetic_event_errors_poison_and_never_reenter_guest() {
    for (core, app, action) in [
        ("core", "app", 5),
        ("core", "app", 6),
        ("core", "app", 7),
        ("core", "app", 8),
        ("core", "app", 9),
        ("core-bad-id", "app", 2),
        ("core-bad-current", "app", 2),
        ("core-bad-code", "app", 2),
        ("core-event-null", "app", 2),
        ("core-original-mismatch", "app", 2),
        ("core", "app-wrong-index", 2),
        ("core", "app-empty-index", 2),
        ("core", "app-callback-trap", 2),
    ] {
        let (result, trace) = synthetic(core, app, &default_event());
        let mut environment = result.unwrap();
        let error = environment.run(action).unwrap_err();
        assert_eq!(
            environment.state(),
            NumericEnvironmentState::Poisoned,
            "{core}/{app}: {error}"
        );
        let before = event_trace(&trace);
        assert!(
            !before.iter().any(|item| item == "51" || item == "19"),
            "{core}/{app}: {before:?}"
        );
        assert_eq!(
            environment.run(action).unwrap_err().message(),
            error.message()
        );
        assert_eq!(
            environment.read_frame().unwrap_err().message(),
            error.message()
        );
        assert_eq!(environment.close().unwrap_err().message(), error.message());
        assert_eq!(event_trace(&trace), before, "guest entered after failure");
    }
}

#[test]
#[ignore = "requires generated event graph and synthetic fixtures"]
fn synthetic_event_stale_token_and_depth_limit() {
    let (result, trace) = synthetic("core", "app", &default_event());
    let mut environment = result.unwrap();
    assert_eq!(environment.run(2).unwrap(), 1);
    let error = environment.run(3).unwrap_err();
    assert!(error.message().contains("event token"), "{error}");
    let before = event_trace(&trace);
    assert!(!before.iter().any(|item| item == "51" || item == "19"));
    assert_eq!(environment.close().unwrap_err().message(), error.message());
    assert_eq!(event_trace(&trace), before);
    let event = NumericEventOptions {
        max_registrations: 1,
        max_depth: 1,
    };
    let (result, trace) = synthetic("core", "app", &event);
    let mut environment = result.unwrap();
    let error = environment.run(1).unwrap_err();
    assert!(error.message().contains("nesting"), "{error}");
    let before = event_trace(&trace);
    assert!(before.iter().any(|item| item == "70"));
    assert!(!before.iter().any(|item| item == "51" || item == "19"));
}

#[test]
#[ignore = "requires generated event graph and synthetic fixtures"]
fn synthetic_event_remove_failure_preserves_init_error_and_stops_shutdown() {
    for core in ["core-remove-fail", "core-remove-trap"] {
        let (result, trace) = synthetic(core, "app-init-fail", &default_event());
        let error = result.unwrap_err();
        assert!(
            error.message().contains("module_init returned 7"),
            "{core}: {error}"
        );
        assert!(!error.cleanup_errors().is_empty(), "{core}: {error}");
        let trace = event_trace(&trace);
        assert!(trace.iter().any(|item| item == "51"));
        assert!(!trace.iter().any(|item| item == "19"), "{trace:?}");
        let (result, trace) = synthetic(core, "app", &default_event());
        let mut environment = result.unwrap();
        let error = environment.close().unwrap_err();
        assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
        let before = event_trace(&trace);
        assert!(before.iter().any(|item| item == "51"));
        assert!(!before.iter().any(|item| item == "19"));
        assert_eq!(environment.close().unwrap_err().message(), error.message());
        assert_eq!(event_trace(&trace), before);
    }
}

#[test]
#[ignore = "requires generated event graph and synthetic fixtures"]
fn synthetic_event_close_and_registration_failures_do_not_cleanup_guest() {
    for core in ["core-add-error", "core-add-trap"] {
        let (result, trace) = synthetic(core, "app", &default_event());
        assert!(result.is_err(), "{core}");
        let trace = event_trace(&trace);
        assert!(trace.iter().any(|item| item == "50"));
        assert!(
            !trace.iter().any(|item| item == "51" || item == "19"),
            "{core}: {trace:?}"
        );
    }
    for app in ["app-close-fail", "app-close-trap"] {
        let (result, trace) = synthetic("core", app, &default_event());
        let mut environment = result.unwrap();
        let error = environment.close().unwrap_err();
        assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
        let before = event_trace(&trace);
        assert!(before.iter().any(|item| item == "39"));
        assert!(
            !before.iter().any(|item| item == "51" || item == "19"),
            "{app}: {before:?}"
        );
        assert_eq!(environment.run(1).unwrap_err().message(), error.message());
        assert_eq!(environment.close().unwrap_err().message(), error.message());
        assert_eq!(event_trace(&trace), before);
    }
}

#[test]
#[ignore = "requires generated event graph and synthetic fixtures"]
fn synthetic_event_nested_targets_restore_outer_frame() {
    let event = NumericEventOptions {
        max_registrations: 2,
        max_depth: 4,
    };
    let (result, trace) = synthetic("core", "app-multilabel", &event);
    let mut environment = result.unwrap();
    assert_eq!(environment.run(11).unwrap(), 2);
    let trace = event_trace(&trace);
    let callback: Vec<_> = trace
        .iter()
        .filter(|item| item.as_str() == "70" || item.as_str() == "71")
        .map(String::as_str)
        .collect();
    assert_eq!(callback, ["70", "70", "71", "71"]);
    environment.close().unwrap();
    let (result, trace) = synthetic("core-cross-send", "app-multilabel", &event);
    let mut environment = result.unwrap();
    assert!(environment.run(10).is_err());
    assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
    let trace = event_trace(&trace);
    assert!(
        !trace
            .iter()
            .any(|item| item == "70" || item == "51" || item == "19"),
        "{trace:?}"
    );
}

#[test]
#[ignore = "requires generated event graph and fixed-table LVGL core"]
fn real_event_close_removes_after_app_returns_and_before_core_shutdown() {
    let bytes = graph_bytes();
    super::EVENT_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
    super::LVGL_SHUTDOWN_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
    let mut environment = real_environment(&bytes, "real").unwrap();
    assert_eq!(environment.run(11).unwrap(), 0);
    environment.close().unwrap();
    let trace = super::EVENT_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
    let shutdown =
        super::LVGL_SHUTDOWN_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
    assert_eq!(trace, ["add", "app_close", "remove", "core_shutdown"]);
    assert_eq!(shutdown, vec![("lvcore".into(), Some(0))]);
}

#[test]
#[ignore = "requires generated event graph and fixed-table LVGL core"]
fn real_event_failed_init_removes_before_same_core_shutdown() {
    let bytes = graph_bytes();
    super::EVENT_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
    super::LVGL_SHUTDOWN_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
    let error = real_environment(&bytes, "real-fail-init-not-run").unwrap_err();
    let trace = super::EVENT_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
    let shutdown =
        super::LVGL_SHUTDOWN_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
    assert!(
        error.message().contains("module_init returned 7"),
        "{error}"
    );
    assert!(error.cleanup_errors().is_empty());
    assert_eq!(trace, ["add", "remove", "core_shutdown"]);
    assert_eq!(shutdown, vec![("lvcore".into(), Some(0))]);
}

#[test]
#[ignore = "requires generated event graph and fixed-table LVGL core"]
fn real_event_close_can_dispatch_before_removal() {
    let bytes = graph_bytes();
    super::EVENT_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
    let mut environment = real_environment(&bytes, "real").unwrap();
    assert_eq!(environment.run(12).unwrap(), 0);
    environment.close().unwrap();
    let trace = super::EVENT_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
    assert_eq!(trace, ["add", "remove", "app_close", "core_shutdown"]);
}

#[test]
#[ignore = "requires generated event graph and fixed-table LVGL core"]
fn real_event_outer_token_is_invalid_inside_nested_callback() {
    let bytes = graph_bytes();
    super::EVENT_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
    let mut environment = real_environment(&bytes, "real").unwrap();
    let error = environment.run(10).unwrap_err();
    assert!(error.message().contains("event token"), "{error}");
    assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
    assert_eq!(
        environment.read_frame().unwrap_err().message(),
        error.message()
    );
    assert_eq!(environment.close().unwrap_err().message(), error.message());
    let trace = super::EVENT_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
    assert_eq!(trace, ["add"]);
}

#[test]
#[ignore = "requires generated event graph and synthetic fixtures"]
fn synthetic_event_pending_registration_cannot_exceed_quota_through_nested_callback() {
    let event = NumericEventOptions {
        max_registrations: 2,
        max_depth: 4,
    };
    let (result, trace) = synthetic("core-nested-add", "app-nested-add", &event);
    let mut environment = result.unwrap();
    let error = environment.run(12).unwrap_err();
    assert!(error.message().contains("quota"), "{error}");
    assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
    let before = event_trace(&trace);
    assert_eq!(
        before.iter().filter(|item| item.as_str() == "50").count(),
        2,
        "{before:?}"
    );
    assert_eq!(
        before.iter().filter(|item| item.as_str() == "70").count(),
        2,
        "{before:?}"
    );
    assert!(
        !before.iter().any(|item| item == "51" || item == "19"),
        "{before:?}"
    );
    assert_eq!(environment.run(12).unwrap_err().message(), error.message());
    assert_eq!(environment.close().unwrap_err().message(), error.message());
    assert_eq!(event_trace(&trace), before);
}

#[test]
#[ignore = "requires generated event graph and synthetic fixtures"]
fn synthetic_event_bind_failure_invalidates_label_before_core_rollback() {
    super::EVENT_BOUNDARY_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
    let (result, trace) = synthetic("core-clicked-zero", "app", &default_event());
    let error = result.unwrap_err();
    let boundary =
        super::EVENT_BOUNDARY_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
    assert!(
        error
            .message()
            .contains("clicked event code is unavailable"),
        "{error}"
    );
    assert_eq!(boundary, [(true, true)]);
    let trace = event_trace(&trace);
    assert!(trace.iter().any(|item| item == "45"));
    assert!(trace.iter().any(|item| item == "19"));
    assert!(
        !trace
            .iter()
            .any(|item| item == "31" || item == "50" || item == "51"),
        "{trace:?}"
    );

    let (result, trace) = synthetic("core-clicked-trap", "app", &default_event());
    assert!(result.is_err());
    let trace = event_trace(&trace);
    assert!(trace.iter().any(|item| item == "45"));
    assert!(
        !trace
            .iter()
            .any(|item| item == "31" || item == "50" || item == "51" || item == "19"),
        "{trace:?}"
    );
}

#[test]
#[ignore = "requires generated event graph and synthetic fixtures"]
fn synthetic_event_nested_remove_does_not_enter_native_twice() {
    let event = NumericEventOptions {
        max_registrations: 2,
        max_depth: 4,
    };
    let (result, trace) = synthetic("core-nested-remove", "app", &event);
    let mut environment = result.unwrap();
    assert_ne!(environment.run(7).unwrap(), 0);
    let error = environment.run(4).unwrap_err();
    assert!(error.message().contains("event"), "{error}");
    assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
    let before = event_trace(&trace);
    assert_eq!(
        before.iter().filter(|item| item.as_str() == "70").count(),
        2,
        "{before:?}"
    );
    assert_eq!(
        before.iter().filter(|item| item.as_str() == "51").count(),
        1,
        "{before:?}"
    );
    assert!(!before.iter().any(|item| item == "19"), "{before:?}");
    assert_eq!(environment.run(4).unwrap_err().message(), error.message());
    assert_eq!(environment.close().unwrap_err().message(), error.message());
    assert_eq!(event_trace(&trace), before);
}

#[test]
#[ignore = "requires generated event graph and synthetic fixtures"]
fn synthetic_event_getter_reentry_is_rejected_before_callback_and_cleanup() {
    for (core, targets) in [("core-current-reenter", 0), ("core-target-reenter", 1)] {
        let (result, trace) = synthetic(core, "app-remove-first", &default_event());
        let mut environment = result.unwrap();
        let error = environment.run(4).unwrap_err();
        assert!(
            error.message().contains("event validation is reentrant"),
            "{core}: {error}"
        );
        assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
        let before = event_trace(&trace);
        assert_eq!(
            before.iter().filter(|item| item.as_str() == "53").count(),
            1,
            "{core}: {before:?}"
        );
        assert_eq!(
            before.iter().filter(|item| item.as_str() == "54").count(),
            targets,
            "{core}: {before:?}"
        );
        assert!(
            !before
                .iter()
                .any(|item| ["70", "71", "51", "19"].contains(&item.as_str())),
            "{core}: {before:?}"
        );
        assert_eq!(environment.run(4).unwrap_err().message(), error.message());
        assert_eq!(environment.close().unwrap_err().message(), error.message());
        assert_eq!(event_trace(&trace), before);
    }
}
