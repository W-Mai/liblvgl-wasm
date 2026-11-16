use super::numeric_label_lib_test::{Factory, NoOutput, Trace, graph};
use super::numeric_label_test::{lvgl_options, options, wasi_options};
use super::numeric_lvgl_test::{check_core_proof, read_bounded};
use super::{
    EVENT_BOUNDARY_OBSERVATIONS, EVENT_OBSERVATIONS, LVGL_SHUTDOWN_OBSERVATIONS,
    load_lvgl_event_environment_for_consumer,
};
use crate::{NumericEventOptions, NumericHostBinding};
use serde_json::Value;

#[test]
#[ignore = "requires the real event library graph and fixed-core proof"]
fn library_events_preserve_the_same_core_lifecycle() {
    let bytes = read_bounded("LVW_TEST_EVENT_LIB_GRAPH", 256 * 1024 * 1024);
    let core = read_bounded("LVW_TEST_LVGL_CORE", 64 * 1024 * 1024);
    let api = read_bounded("LVW_TEST_LVGL_API", 32 * 1024 * 1024);
    let proof = read_bounded("LVW_TEST_LVGL_PROOF", 1024 * 1024);
    check_core_proof(&core, &api, &proof);
    let cases: Value = serde_json::from_slice(&bytes).unwrap();
    for name in ["real", "middle-fail-init", "app-fail-init", "non-trap"] {
        let source = if name == "non-trap" { "real" } else { name };
        let case = cases
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == source)
            .unwrap();
        let graph = graph(case, &core, None);
        let trace = Trace::default();
        EVENT_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
        EVENT_BOUNDARY_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
        LVGL_SHUTDOWN_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
        if name == "non-trap" {
            super::numeric_instantiation_test::inject_error("app");
        }
        let mut factory = Factory(trace);
        let mut hosts = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
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
        let allowed: Vec<_> = case["allowedFeatures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|feature| feature.as_str().unwrap())
            .collect();
        let result = load_lvgl_event_environment_for_consumer(
            &graph.input(),
            &graph.profile,
            &allowed,
            &mut hosts,
            &lvgl_options(),
            &options(&bytes, source),
            &event,
            "middle",
            Some((&wasi_options(), Box::new(NoOutput))),
        );
        if name == "real" {
            let mut environment = result.unwrap();
            environment.run(10).unwrap();
            environment.run(11).unwrap();
            environment.close().unwrap();
        } else {
            let error = result.unwrap_err();
            assert!(
                error.message().contains(if name == "non-trap" {
                    "injected non-trap instantiation failure"
                } else {
                    "module_init returned 7"
                }),
                "{name}: {error}"
            );
            assert!(error.cleanup_errors().is_empty(), "{name}: {error}");
        }
        let shutdown =
            LVGL_SHUTDOWN_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
        assert_eq!(shutdown, [("lvcore".into(), Some(0))], "{name}");
        let events = EVENT_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
        let expected = match name {
            "real" => vec![
                "add",
                "app_close",
                "consumer_close",
                "remove",
                "core_shutdown",
            ],
            "middle-fail-init" => vec!["add", "remove", "core_shutdown"],
            _ => vec!["add", "remove", "consumer_close", "core_shutdown"],
        };
        assert_eq!(events, expected, "{name}");
        let boundary =
            EVENT_BOUNDARY_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
        assert_eq!(
            boundary,
            if name == "real" {
                vec![]
            } else {
                vec![(true, true)]
            },
            "{name}"
        );
    }
}
