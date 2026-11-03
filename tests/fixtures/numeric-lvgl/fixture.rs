#[path = "../numeric-wasi/fixture.rs"]
#[allow(dead_code)]
pub mod wasi_fixture;

use liblvgl_wasm_host::{
    ModuleInterface, NumericEnvironmentState, NumericHostBinding, NumericLvglCoreOptions,
    load_lvgl_core_environment,
};
use serde_json::{Value, json};

pub fn graph(bytes: &[u8], name: &str) -> wasi_fixture::numeric::Fixture {
    let cases: Value = serde_json::from_slice(bytes).unwrap();
    let mut case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap()
        .clone();
    case["name"] = json!("dag");
    wasi_fixture::numeric::Fixture::from_json(&serde_json::to_vec(&[case]).unwrap())
}

pub fn options() -> NumericLvglCoreOptions {
    NumericLvglCoreOptions {
        module: "lvcore".into(),
        id: "host.lvw".into(),
        interface: ModuleInterface {
            name: "lvw".into(),
            version: 1,
        },
        abi_version: 1,
    }
}

pub fn features() -> Vec<&'static str> {
    vec![
        "bulk-memory",
        "reference-types",
        "sign-extension",
        "saturating-float-to-int",
        "exceptions",
    ]
}

pub fn run_positive(json: &[u8]) {
    let graph = graph(json, "real");
    let input = graph.input();
    let mut hosts: [NumericHostBinding<'_>; 0] = [];
    let output = wasi_fixture::Writes::default();
    let mut wasi = wasi_fixture::options();
    wasi.output_fds.clear();
    wasi.clock.as_mut().unwrap().realtime_ns = 0;
    wasi.clock.as_mut().unwrap().monotonic_ns = 0;
    let mut a = load_lvgl_core_environment(
        &input,
        &graph.profile,
        &features(),
        &mut hosts,
        &options(),
        Some((&wasi, Box::new(output.clone()))),
    )
    .unwrap();
    let mut b = load_lvgl_core_environment(
        &input,
        &graph.profile,
        &features(),
        &mut hosts,
        &options(),
        Some((&wasi, Box::new(output.clone()))),
    )
    .unwrap();
    assert_eq!(a.state(), NumericEnvironmentState::Ready);
    assert_eq!(b.state(), NumericEnvironmentState::Ready);
    assert_eq!(a.run(5).unwrap(), 5);
    assert_eq!(b.run(9).unwrap(), 9);
    a.close().unwrap();
    assert_eq!(a.state(), NumericEnvironmentState::Closed);
    assert_eq!(b.run(7).unwrap(), 7);
    b.close().unwrap();
    assert_eq!(b.state(), NumericEnvironmentState::Closed);
    assert!(output.messages().is_empty());
}
