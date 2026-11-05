#[path = "../../../tests/fixtures/host-sdk/label-consumer.rs"]
#[allow(dead_code)]
mod label_consumer;

#[test]
fn real_library_consumer_renders_and_rolls_back() {
    let path = std::env::var_os("LVW_TEST_LABEL_LIB_GRAPH").expect("LVW_TEST_LABEL_LIB_GRAPH");
    let graph = std::fs::read(path).unwrap();
    label_consumer::preflight(&graph);
    label_consumer::run_runtime(&graph);
    label_consumer::failed_init(&graph, "middle-fail-init", &["guest:10"]);
    label_consumer::failed_init(
        &graph,
        "app-fail-init",
        &["guest:10", "guest:20", "guest:11"],
    );
}
