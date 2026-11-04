#[path = "../../../tests/fixtures/host-sdk/chain-graph.rs"]
#[allow(dead_code)]
mod chain;

fn graph() -> Vec<u8> {
    std::fs::read(std::env::var_os("LVW_TEST_CHAIN_GRAPH").expect("LVW_TEST_CHAIN_GRAPH")).unwrap()
}

#[test]
fn independent_real_core_middle_and_app_run_in_order() {
    chain::positive(&graph());
}

#[test]
fn failed_middle_initialization_rolls_back_the_core() {
    chain::failed_init(&graph(), "middle-fail-init", &[10]);
}

#[test]
fn failed_application_initialization_rolls_back_the_middle() {
    chain::failed_init(&graph(), "app-fail-init", &[10, 20, 11]);
}

#[test]
fn middle_trap_poison_prevents_guest_cleanup() {
    chain::trap(&graph());
}

#[test]
fn untrusted_middle_is_rejected_before_any_host_factory() {
    chain::rejects_untrusted_middle_before_host_creation(&graph());
}
