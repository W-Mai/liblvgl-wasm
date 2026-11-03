#[path = "../../../tests/fixtures/numeric-wasi/fixture.rs"]
mod fixture;

use fixture::{Writes, graph, options};
use liblvgl_wasm_host::{
    NumericEnvironmentId, NumericEnvironmentState, NumericHostBinding, NumericWasiOutput,
    NumericWasiService, load_numeric_environment_with_wasi, preflight_numeric_graph_with_wasi,
};
use std::{fs, path::PathBuf};

fn json() -> Vec<u8> {
    fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/validator/numeric-wasi.json"),
    )
    .unwrap()
}
fn expected(value: &[(&str, u32, &str)]) -> Vec<(String, u32, String)> {
    value
        .iter()
        .map(|(consumer, fd, text)| ((*consumer).into(), *fd, (*text).into()))
        .collect()
}

#[test]
fn dual_consumer_and_dual_environment_use_independent_memories() {
    fixture::run_positive(&json());
}

#[test]
fn invalid_iovecs_have_no_output_and_precise_errno() {
    let graph = graph(&json(), "dag");
    let input = graph.input();
    let writes = Writes::default();
    let mut hosts: [NumericHostBinding<'_>; 0] = [];
    let mut environment = load_numeric_environment_with_wasi(
        &input,
        &graph.profile,
        &[],
        &mut hosts,
        &options(),
        Box::new(writes.clone()),
    )
    .unwrap();
    for (op, errno) in [
        (1, 21),
        (2, 28),
        (3, 21),
        (4, 21),
        (5, 21),
        (6, 8),
        (7, 0),
        (17, 58),
    ] {
        assert_eq!(environment.run(op).unwrap(), errno, "app opcode {op}");
        assert_eq!(environment.run(op + 100).unwrap(), errno, "lib opcode {op}");
    }
    assert_eq!(
        writes.messages(),
        expected(&[("lib", 2, "init"), ("app", 2, "init")])
    );
    assert_eq!(environment.run(16).unwrap(), 0);
    assert_eq!(
        writes.messages().last().unwrap(),
        &expected(&[("app", 1, "APP!")])[0]
    );
    environment.close().unwrap();
}

#[test]
fn output_quota_is_shared_only_within_each_environment() {
    let graph = graph(&json(), "dag");
    let input = graph.input();
    let writes = Writes::default();
    let mut hosts: [NumericHostBinding<'_>; 0] = [];
    let mut policy = options();
    policy.max_output_bytes = 12;
    let mut a = load_numeric_environment_with_wasi(
        &input,
        &graph.profile,
        &[],
        &mut hosts,
        &policy,
        Box::new(writes.clone()),
    )
    .unwrap();
    let mut b = load_numeric_environment_with_wasi(
        &input,
        &graph.profile,
        &[],
        &mut hosts,
        &policy,
        Box::new(writes.clone()),
    )
    .unwrap();
    assert_eq!(a.run(0).unwrap(), 0);
    assert_eq!(a.run(100).unwrap(), 51);
    assert_eq!(b.run(100).unwrap(), 0);
    assert_eq!(
        writes.messages(),
        expected(&[
            ("lib", 2, "init"),
            ("app", 2, "init"),
            ("lib", 2, "init"),
            ("app", 2, "init"),
            ("app", 1, "APP!"),
            ("lib", 1, "LIB!")
        ])
    );
    a.close().unwrap();
    b.close().unwrap();
}

#[test]
fn permissions_and_static_abi_fail_before_factory_or_output() {
    for name in ["bad-signature", "alias", "import-memory", "reexport-wasi"] {
        let graph = graph(&json(), name);
        let input = graph.input();
        let trace = fixture::numeric::Trace::default();
        let mut factory = fixture::numeric::TraceFactory(trace.clone());
        let mut bindings = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
        let mut empty: [NumericHostBinding<'_>; 0] = [];
        let hosts = if graph.profile.hosts.is_empty() {
            &mut empty[..]
        } else {
            &mut bindings[..]
        };
        let writes = Writes::default();
        assert!(
            load_numeric_environment_with_wasi(
                &input,
                &graph.profile,
                &[],
                hosts,
                &options(),
                Box::new(writes.clone())
            )
            .is_err(),
            "{name}"
        );
        assert!(writes.messages().is_empty(), "{name}");
        assert!(trace.environments.lock().unwrap().is_empty(), "{name}");
    }
    for invalid in ["service", "interface", "provider-export"] {
        let mut graph = graph(&json(), "dag");
        let mut policy = options();
        match invalid {
            "service" => policy
                .allowed
                .retain(|item| *item != NumericWasiService::FdWrite),
            "interface" => policy.interface.version = 2,
            "provider-export" => {
                let app = &mut graph.modules[0].0;
                let wasi = app
                    .requires
                    .iter_mut()
                    .find(|r| r.provider == "host.wasi")
                    .unwrap();
                wasi.imports
                    .iter_mut()
                    .find(|item| item.name == "environ_get")
                    .unwrap()
                    .provider_export = "environ_sizes_get".into();
            }
            _ => unreachable!(),
        }
        let input = graph.input();
        let writes = Writes::default();
        let mut hosts: [NumericHostBinding<'_>; 0] = [];
        assert!(
            preflight_numeric_graph_with_wasi(&input, &graph.profile, &[], &policy).is_err(),
            "{invalid}"
        );
        assert!(
            load_numeric_environment_with_wasi(
                &input,
                &graph.profile,
                &[],
                &mut hosts,
                &policy,
                Box::new(writes.clone())
            )
            .is_err(),
            "{invalid}"
        );
        assert!(writes.messages().is_empty());
    }
}

#[test]
fn close_and_rollback_use_the_correct_consumer_memory() {
    for (name, events) in [
        (
            "init-fail",
            expected(&[("lib", 2, "init"), ("app", 2, "init"), ("lib", 2, "done")]),
        ),
        (
            "data-fail",
            expected(&[("lib", 2, "init"), ("lib", 2, "done")]),
        ),
    ] {
        let graph = graph(&json(), name);
        let input = graph.input();
        let writes = Writes::default();
        let mut hosts: [NumericHostBinding<'_>; 0] = [];
        assert!(
            load_numeric_environment_with_wasi(
                &input,
                &graph.profile,
                &[],
                &mut hosts,
                &options(),
                Box::new(writes.clone())
            )
            .is_err(),
            "{name}"
        );
        assert_eq!(writes.messages(), events, "{name}");
    }
}

struct FailingOutput {
    writes: Writes,
    panic: bool,
}
impl NumericWasiOutput for FailingOutput {
    fn write(
        &mut self,
        id: &str,
        fd: u32,
        bytes: &[u8],
        env: NumericEnvironmentId,
    ) -> Result<(), String> {
        if fd == 1 {
            assert!(!self.panic, "sink panic");
            return Err("sink error".into());
        }
        self.writes.write(id, fd, bytes, env)
    }
}

#[test]
fn proc_exit_and_output_failure_poison_without_guest_close() {
    for mode in ["exit", "error", "panic"] {
        let graph = graph(&json(), "dag");
        let input = graph.input();
        let writes = Writes::default();
        let mut hosts: [NumericHostBinding<'_>; 0] = [];
        let sink: Box<dyn NumericWasiOutput> = if mode == "exit" {
            Box::new(writes.clone())
        } else {
            Box::new(FailingOutput {
                writes: writes.clone(),
                panic: mode == "panic",
            })
        };
        let mut environment = load_numeric_environment_with_wasi(
            &input,
            &graph.profile,
            &[],
            &mut hosts,
            &options(),
            sink,
        )
        .unwrap();
        let error = environment
            .run(if mode == "exit" { 14 } else { 0 })
            .unwrap_err();
        if mode == "exit" {
            assert_eq!(error.exit_code(), Some(42));
        } else {
            assert!(error.message().contains(if mode == "panic" {
                "sink panic"
            } else {
                "sink error"
            }));
        }
        assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
        assert!(environment.run(100).is_err());
        assert!(environment.close().is_err());
        assert_eq!(
            writes.messages(),
            expected(&[("lib", 2, "init"), ("app", 2, "init")])
        );
    }
}

#[test]
fn wasi_sdk_c_reactor_writes_via_libc() {
    let graph = graph(&json(), "c-app");
    let input = graph.input();
    let writes = Writes::default();
    let mut hosts: [NumericHostBinding<'_>; 0] = [];
    let mut environment = load_numeric_environment_with_wasi(
        &input,
        &graph.profile,
        &[],
        &mut hosts,
        &options(),
        Box::new(writes.clone()),
    )
    .unwrap();
    assert_eq!(environment.run(5).unwrap(), 6);
    environment.close().unwrap();
    assert_eq!(
        writes.messages(),
        expected(&[("app", 2, "ci"), ("app", 1, "C!"), ("app", 2, "ce")])
    );
}

#[test]
fn empty_wasi_requirement_does_not_require_a_memory_or_provider_slot() {
    let base = fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/validator/numeric-preflight.json"),
    )
    .unwrap();
    let cases: serde_json::Value = serde_json::from_slice(&base).unwrap();
    let mut case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "memoryless-core")
        .unwrap()
        .clone();
    case["name"] = serde_json::json!("dag");
    let mut numeric = fixture::numeric::Fixture::from_json(&serde_json::to_vec(&[case]).unwrap());
    let wasi_graph = graph(&json(), "dag");
    numeric.hosts.push(
        wasi_graph
            .hosts
            .into_iter()
            .find(|host| host.id == "host.wasi")
            .unwrap(),
    );
    let core = &mut numeric
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "core")
        .unwrap()
        .0;
    core.requires.push(liblvgl_wasm_host::ManifestRequirement {
        provider: "host.wasi".into(),
        interface: "wasi".into(),
        version: 1,
        imports: vec![],
    });
    let input = numeric.input();
    let writes = Writes::default();
    let trace = fixture::numeric::Trace::default();
    let mut factory = fixture::numeric::TraceFactory(trace.clone());
    let mut hosts = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let mut environment = load_numeric_environment_with_wasi(
        &input,
        &numeric.profile,
        &[],
        &mut hosts,
        &options(),
        Box::new(writes.clone()),
    )
    .unwrap();
    assert_eq!(environment.run(5).unwrap(), 30);
    environment.close().unwrap();
    assert!(writes.messages().is_empty());
}

struct SecondPayload;
impl Drop for SecondPayload {
    fn drop(&mut self) {
        panic!("second payload destructor");
    }
}
struct FirstPayload;
impl Drop for FirstPayload {
    fn drop(&mut self) {
        std::panic::panic_any(SecondPayload);
    }
}
struct DroppingOutput(Writes);
impl NumericWasiOutput for DroppingOutput {
    fn write(
        &mut self,
        id: &str,
        fd: u32,
        bytes: &[u8],
        env: NumericEnvironmentId,
    ) -> Result<(), String> {
        self.0.write(id, fd, bytes, env)
    }
}
impl Drop for DroppingOutput {
    fn drop(&mut self) {
        std::panic::panic_any(FirstPayload);
    }
}

#[test]
fn output_drop_panics_do_not_hide_primary_failure_or_interrupt_host_cleanup() {
    for mode in ["preflight", "exit", "close", "unwind"] {
        let graph = graph(&json(), "trace");
        let input = graph.input();
        let writes = Writes::default();
        let trace = fixture::numeric::Trace::default();
        let mut factory = fixture::numeric::TraceFactory(trace.clone());
        let mut hosts = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
        let mut policy = options();
        if mode == "preflight" {
            policy
                .allowed
                .retain(|item| *item != NumericWasiService::FdWrite);
        }
        let loaded = load_numeric_environment_with_wasi(
            &input,
            &graph.profile,
            &[],
            &mut hosts,
            &policy,
            Box::new(DroppingOutput(writes.clone())),
        );
        if mode == "preflight" {
            let error = loaded.err().unwrap();
            assert!(
                error
                    .cleanup_errors()
                    .iter()
                    .any(|error| error.contains("panic payload drop panicked"))
            );
            assert!(trace.environments.lock().unwrap().is_empty());
        } else {
            let mut environment = loaded.unwrap();
            if mode == "unwind" {
                let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _environment = environment;
                    panic!("outer panic");
                }))
                .unwrap_err();
                assert_eq!(panic.downcast_ref::<&str>(), Some(&"outer panic"));
            } else {
                let error = if mode == "exit" {
                    environment.run(14).unwrap_err()
                } else {
                    environment.close().unwrap_err()
                };
                if mode == "exit" {
                    assert_eq!(error.exit_code(), Some(42));
                }
                assert!(
                    error
                        .cleanup_errors()
                        .iter()
                        .any(|error| error.contains("panic payload drop panicked"))
                );
            }
            assert_eq!(*trace.events.lock().unwrap(), ["host:app", "host:lib"]);
        }
    }
}
