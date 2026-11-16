#[path = "../../../tests/fixtures/host-sdk/event-lib-runtime.rs"]
#[allow(dead_code)]
mod runtime;

#[test]
fn real_library_events_render_nest_cancel_and_close_in_two_environments() {
    let bytes = std::fs::read(
        std::env::var_os("LVW_TEST_EVENT_LIB_GRAPH").expect("LVW_TEST_EVENT_LIB_GRAPH"),
    )
    .unwrap();
    runtime::run_runtime(&bytes);
    runtime::failed_init(&bytes, "middle-fail-init", &["guest:10"]);
    runtime::failed_init(
        &bytes,
        "app-fail-init",
        &["guest:10", "guest:20", "guest:11"],
    );
}
