#[path = "../../../tests/fixtures/numeric-lvgl/fixture.rs"]
mod fixture;

use fixture::{graph, options};
use liblvgl_wasm_host::{
    NumericEnvironment, NumericEnvironmentError, NumericEnvironmentState, NumericFunctionContract,
    NumericHostBinding, NumericHostContract, NumericResult, load_lvgl_core_environment,
    preflight_lvgl_core_graph,
};
use std::{fs, path::PathBuf};

fn json() -> Vec<u8> {
    fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/validator/numeric-lvgl.json"),
    )
    .unwrap()
}
fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).into()).collect()
}
fn load_synthetic(
    graph: &fixture::wasi_fixture::numeric::Fixture,
    trace: &fixture::wasi_fixture::numeric::Trace,
) -> Result<NumericEnvironment, NumericEnvironmentError> {
    let input = graph.input();
    let mut factory = fixture::wasi_fixture::numeric::TraceFactory(trace.clone());
    let mut hosts = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    load_lvgl_core_environment(&input, &graph.profile, &[], &mut hosts, &options(), None)
}

#[test]
fn actual_bounded_core_runs_two_independent_environments() {
    fixture::run_positive(&json());
}

#[test]
fn actual_app_init_failure_rolls_back_real_core() {
    let graph = graph(&json(), "real-fail");
    let input = graph.input();
    let mut hosts: [NumericHostBinding<'_>; 0] = [];
    let mut wasi = fixture::wasi_fixture::options();
    wasi.output_fds.clear();
    let output = fixture::wasi_fixture::Writes::default();
    let error = load_lvgl_core_environment(
        &input,
        &graph.profile,
        &fixture::features(),
        &mut hosts,
        &options(),
        Some((&wasi, Box::new(output.clone()))),
    )
    .err()
    .unwrap();
    assert!(
        error.message().contains("module_init returned 7"),
        "{}",
        error.message()
    );
    assert!(error.cleanup_errors().is_empty());
    assert!(output.messages().is_empty());
}

#[test]
fn synthetic_core_initializes_and_closes_in_graph_order() {
    let graph = graph(&json(), "core");
    let trace = fixture::wasi_fixture::numeric::Trace::default();
    let mut environment = load_synthetic(&graph, &trace).unwrap();
    assert_eq!(environment.run(5).unwrap(), 7);
    environment.close().unwrap();
    assert_eq!(
        *trace.events.lock().unwrap(),
        strings(&[
            "10",
            "11",
            "20",
            "21",
            "22",
            "30",
            "31",
            "32",
            "39",
            "29",
            "19",
            "host:app",
            "host:lvcore",
            "host:base"
        ])
    );
}

#[test]
fn abi_and_lifecycle_failures_follow_rollback_boundaries() {
    for (name, expected, message) in [
        (
            "core-bad-abi",
            strings(&["10", "11", "20", "21", "19"]),
            "ABI",
        ),
        (
            "core-init-fail",
            strings(&["10", "11", "20", "21", "22", "19"]),
            "returned 7",
        ),
        (
            "core-init-trap",
            strings(&["10", "11", "20", "21", "22"]),
            "guest call",
        ),
        (
            "core-reactor-trap",
            strings(&["10", "11", "20"]),
            "guest call",
        ),
        (
            "core-event-init",
            strings(&["10", "11", "20", "21", "22"]),
            "unsupported LVGL callback",
        ),
        (
            "app-fail",
            strings(&["10", "11", "20", "21", "22", "30", "31", "29", "19"]),
            "returned 8",
        ),
    ] {
        let graph = graph(&json(), name);
        let trace = fixture::wasi_fixture::numeric::Trace::default();
        let error = load_synthetic(&graph, &trace).err().unwrap();
        assert!(
            error.message().contains(message),
            "{name}: {}",
            error.message()
        );
        let events = trace.events.lock().unwrap();
        assert_eq!(&events[..expected.len()], expected, "{name}");
        assert_eq!(
            &events[expected.len()..],
            strings(&["host:app", "host:lvcore", "host:base"]),
            "{name}"
        );
    }
    let graph = graph(&json(), "rollback-trap");
    let trace = fixture::wasi_fixture::numeric::Trace::default();
    let error = load_synthetic(&graph, &trace).err().unwrap();
    assert!(error.message().contains("ABI"));
    assert!(!error.cleanup_errors().is_empty());
    assert_eq!(
        *trace.events.lock().unwrap(),
        strings(&[
            "10",
            "11",
            "20",
            "21",
            "19",
            "host:app",
            "host:lvcore",
            "host:base"
        ])
    );
}

#[test]
fn runtime_and_close_failures_poison_without_other_guest_calls() {
    for (name, closing, expected) in [
        (
            "core-run-trap",
            false,
            strings(&["10", "11", "20", "21", "22", "30", "31", "32"]),
        ),
        (
            "core-event-run",
            false,
            strings(&["10", "11", "20", "21", "22", "30", "31", "32"]),
        ),
        (
            "core-close-trap",
            true,
            strings(&["10", "11", "20", "21", "22", "30", "31", "39", "29"]),
        ),
        (
            "core-close-fail",
            true,
            strings(&["10", "11", "20", "21", "22", "30", "31", "39", "29"]),
        ),
    ] {
        let graph = graph(&json(), name);
        let trace = fixture::wasi_fixture::numeric::Trace::default();
        let mut environment = load_synthetic(&graph, &trace).unwrap();
        if closing {
            assert!(environment.close().is_err(), "{name}");
        } else {
            assert!(environment.run(5).is_err(), "{name}");
        }
        assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
        assert!(environment.run(5).is_err());
        assert!(environment.close().is_err());
        let events = trace.events.lock().unwrap();
        assert_eq!(&events[..expected.len()], expected, "{name}");
        assert_eq!(
            &events[expected.len()..],
            strings(&["host:app", "host:lvcore", "host:base"]),
            "{name}"
        );
    }
}

#[test]
fn all_bridge_callbacks_are_rejected_when_called_by_wasm() {
    for callback in [
        "event",
        "timer",
        "timer_release",
        "anim_exec",
        "anim_query",
        "anim_notify",
        "anim_release",
        "observer",
        "observer_release",
        "decoder_info",
        "decoder_open",
        "decoder_area",
        "decoder_close",
        "decoder_release",
    ] {
        let graph = graph(&json(), &format!("callback-{callback}"));
        let trace = fixture::wasi_fixture::numeric::Trace::default();
        let mut environment = load_synthetic(&graph, &trace).unwrap();
        let error = environment.run(5).unwrap_err();
        assert!(
            error.message().contains(callback),
            "{callback}: {}",
            error.message()
        );
        assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
        assert!(environment.close().is_err());
        assert_eq!(
            *trace.events.lock().unwrap(),
            strings(&[
                "10",
                "11",
                "20",
                "21",
                "22",
                "30",
                "31",
                "32",
                "host:app",
                "host:lvcore",
                "host:base"
            ])
        );
    }
}

#[test]
fn unsupported_core_contracts_fail_before_host_creation() {
    for name in [
        "core-bad-event",
        "core-alias-event",
        "core-missing-init",
        "core-imported-init",
        "core-bad-abi-signature",
        "app-reserved",
        "app-steal",
    ] {
        let graph = graph(&json(), name);
        let input = graph.input();
        assert!(
            preflight_lvgl_core_graph(&input, &graph.profile, &[], &options(), None).is_err(),
            "{name}"
        );
        let trace = fixture::wasi_fixture::numeric::Trace::default();
        assert!(load_synthetic(&graph, &trace).is_err(), "{name}");
        assert!(trace.environments.lock().unwrap().is_empty());
        assert!(trace.events.lock().unwrap().is_empty());
    }
    for mutation in [
        "identity",
        "interface",
        "pointer",
        "reserved",
        "forged-host",
    ] {
        let mut graph = graph(&json(), "core");
        let core = graph
            .profile
            .modules
            .iter_mut()
            .find(|item| item.id == "lvcore")
            .unwrap();
        match mutation {
            "identity" => core.sha256 = "0".repeat(64),
            "interface" => core.interface.version = 2,
            "pointer" => core.exports.push(NumericFunctionContract {
                name: "lv_obj_create".into(),
                params: 1,
                result: NumericResult::I32,
            }),
            "reserved" => core.exports.push(NumericFunctionContract {
                name: "lvw_init".into(),
                params: 0,
                result: NumericResult::I32,
            }),
            "forged-host" => graph.profile.hosts.push(NumericHostContract {
                id: "host.lvw".into(),
                interface: options().interface,
                exports: vec![],
            }),
            _ => unreachable!(),
        }
        let input = graph.input();
        assert!(
            preflight_lvgl_core_graph(&input, &graph.profile, &[], &options(), None).is_err(),
            "{mutation}"
        );
        let trace = fixture::wasi_fixture::numeric::Trace::default();
        assert!(load_synthetic(&graph, &trace).is_err(), "{mutation}");
        assert!(trace.environments.lock().unwrap().is_empty());
        assert!(trace.events.lock().unwrap().is_empty());
    }
}
