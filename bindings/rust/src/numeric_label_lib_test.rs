use super::numeric_label_test::{Fixture, features, lvgl_options, options, wasi_options};
use super::numeric_lvgl_test::{check_core_proof, interface, manifest, read_bounded, requirement};
use super::{
    LVGL_SHUTDOWN_OBSERVATIONS, NumericHostBinding, load_lvgl_label_environment_for_consumer,
};
use crate::{
    ManifestRequirement, ModuleExport, ModuleHostProvider, ModuleRole, NumericEnvironmentId,
    NumericFunctionContract, NumericHostContract, NumericHostFactory, NumericHostInstance,
    NumericLimits, NumericModuleContract, NumericProfile, NumericResult, NumericWasiOutput,
    inspect_wasm_facts,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Trace(Arc<Mutex<Vec<String>>>);
struct Factory(Trace);
struct Host(Trace, String);
impl NumericHostFactory for Factory {
    fn create(
        &mut self,
        consumer: &str,
        _: NumericEnvironmentId,
    ) -> Result<Box<dyn NumericHostInstance>, String> {
        Ok(Box::new(Host(self.0.clone(), consumer.into())))
    }
}
impl NumericHostInstance for Host {
    fn call(&mut self, name: &str, values: &[i32]) -> Result<Option<i32>, String> {
        assert_eq!(name, "lifecycle");
        self.0
            .0
            .lock()
            .unwrap()
            .push(format!("guest:{}", values[0]));
        Ok(None)
    }
    fn close(&mut self) -> Result<(), String> {
        self.0.0.lock().unwrap().push(format!("host:{}", self.1));
        Ok(())
    }
}
struct NoOutput;
impl NumericWasiOutput for NoOutput {
    fn write(&mut self, _: &str, _: u32, _: &[u8], _: NumericEnvironmentId) -> Result<(), String> {
        Err("unexpected WASI output".into())
    }
}

fn graph(case: &Value, core: &[u8], app_override: Option<Vec<u8>>) -> Fixture {
    let read = |id: &str| {
        let item = case["input"]["modules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["manifest"]["id"] == id)
            .unwrap();
        let hex = item["hex"].as_str().unwrap().as_bytes();
        assert_eq!(hex.len() % 2, 0);
        let bytes: Vec<u8> = hex
            .chunks_exact(2)
            .map(|pair| {
                let digit = |byte| match byte {
                    b'0'..=b'9' => byte - b'0',
                    b'a'..=b'f' => byte - b'a' + 10,
                    _ => panic!("invalid hex"),
                };
                digit(pair[0]) * 16 + digit(pair[1])
            })
            .collect();
        assert_eq!(
            inspect_wasm_facts(&bytes).unwrap().sha256,
            item["manifest"]["artifact"]["sha256"].as_str().unwrap()
        );
        bytes
    };
    let core_bytes = read("lvcore");
    assert_eq!(core_bytes, core);
    let middle_bytes = read("middle");
    let app_bytes = app_override.unwrap_or_else(|| read("app"));
    let cf = inspect_wasm_facts(&core_bytes).unwrap();
    let mf = inspect_wasm_facts(&middle_bytes).unwrap();
    let af = inspect_wasm_facts(&app_bytes).unwrap();
    let wasi = requirement(&cf, "wasi_snapshot_preview1", "host.wasi", "wasi");
    let lvw = requirement(&cf, "lvw", "host.lvw", "lvw");
    let label = requirement(&mf, "lvgl", "host.label", "lvgl");
    let trace = requirement(&mf, "trace", "host.trace", "trace");
    let host = |id: &str, name: &str, req: &ManifestRequirement| ModuleHostProvider {
        id: id.into(),
        interface: interface(name),
        exports: req
            .imports
            .iter()
            .map(|item| ModuleExport {
                name: item.name.clone(),
                ty: item.ty.clone(),
            })
            .collect(),
    };
    let hosts = vec![
        host("host.wasi", "wasi", &wasi),
        host("host.lvw", "lvw", &lvw),
        host("host.label", "lvgl", &label),
        host("host.trace", "trace", &trace),
    ];
    let modules = vec![
        (
            manifest(
                "app",
                ModuleRole::App,
                &af,
                &[],
                vec![
                    requirement(&af, "middle", "middle", "middle"),
                    requirement(&af, "trace", "host.trace", "trace"),
                ],
            ),
            app_bytes,
        ),
        (
            manifest(
                "middle",
                ModuleRole::Lib,
                &mf,
                &[],
                vec![requirement(&mf, "lvcore", "lvcore", "lvcore"), label, trace],
            ),
            middle_bytes,
        ),
        (
            manifest("lvcore", ModuleRole::Lib, &cf, &features(), vec![wasi, lvw]),
            core_bytes,
        ),
    ];
    let function = |name: &str, params| NumericFunctionContract {
        name: name.into(),
        params,
        result: NumericResult::I32,
    };
    let contract = |id: &str, sha: &str, exports| NumericModuleContract {
        id: id.into(),
        sha256: sha.into(),
        interface: interface(id),
        exports,
    };
    let limits = &case["profile"]["limits"];
    let number = |key: &str| limits[key].as_u64().unwrap();
    let profile = NumericProfile {
        modules: vec![
            contract("lvcore", &cf.sha256, vec![function("lv_is_initialized", 0)]),
            contract(
                "middle",
                &mf.sha256,
                vec![function("middle_active", 0), function("middle_update", 1)],
            ),
            contract("app", &af.sha256, vec![]),
        ],
        hosts: vec![NumericHostContract {
            id: "host.trace".into(),
            interface: interface("trace"),
            exports: vec![NumericFunctionContract {
                name: "lifecycle".into(),
                params: 1,
                result: NumericResult::Void,
            }],
        }],
        limits: NumericLimits {
            max_memory_pages: number("maxMemoryPages"),
            max_total_memory_pages: number("maxTotalMemoryPages"),
            max_table_elements: number("maxTableElements"),
            max_total_table_elements: number("maxTotalTableElements"),
        },
    };
    Fixture {
        modules,
        hosts,
        profile,
    }
}

#[test]
#[ignore = "requires the real LVGL label library graph and fixed-core proof"]
fn library_consumer_preserves_real_core_lifecycle() {
    let json = read_bounded("LVW_TEST_LABEL_LIB_GRAPH", 256 * 1024 * 1024);
    let cases: Value = serde_json::from_slice(&json).unwrap();
    let core = read_bounded("LVW_TEST_LVGL_CORE", 64 * 1024 * 1024);
    let api = read_bounded("LVW_TEST_LVGL_API", 32 * 1024 * 1024);
    let proof = read_bounded("LVW_TEST_LVGL_PROOF", 1024 * 1024);
    check_core_proof(&core, &api, &proof);

    for name in [
        "real",
        "middle-fail-init",
        "app-fail-init",
        "non-trap",
        "data-trap",
    ] {
        let source = match name {
            "non-trap" | "data-trap" => "real",
            _ => name,
        };
        let case = cases
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == source)
            .unwrap();
        let trap_app =
            (name == "data-trap").then(|| read_bounded("LVW_TEST_LABEL_LIB_APP_DATA", 1024 * 1024));
        let graph = graph(case, &core, trap_app);
        let trace = Trace::default();
        let mut factory = Factory(trace.clone());
        let mut hosts = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
        let mut wasi = wasi_options();
        wasi.output_fds.clear();
        let allowed: Vec<_> = case["allowedFeatures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        LVGL_SHUTDOWN_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
        if name == "non-trap" {
            super::numeric_instantiation_test::inject_error("app");
        }
        let result = load_lvgl_label_environment_for_consumer(
            &graph.input(),
            &graph.profile,
            &allowed,
            &mut hosts,
            &lvgl_options(),
            &options(&json, source),
            "middle",
            Some((&wasi, Box::new(NoOutput))),
        );
        match name {
            "real" => result.unwrap().close().unwrap(),
            "middle-fail-init" | "app-fail-init" => {
                let error = result.unwrap_err();
                assert!(
                    error.message().contains("module_init returned 7"),
                    "{name}: {error}"
                );
                assert!(error.cleanup_errors().is_empty(), "{name}: {error}");
            }
            "non-trap" => {
                let error = result.unwrap_err();
                assert!(
                    error
                        .message()
                        .contains("injected non-trap instantiation failure"),
                    "{error}"
                );
                assert!(error.cleanup_errors().is_empty(), "{error}");
            }
            _ => {
                let error = result.unwrap_err();
                assert!(
                    error.message().contains("out of bounds memory access"),
                    "{error}"
                );
                assert!(error.cleanup_errors().is_empty(), "{error}");
            }
        }
        let observations =
            LVGL_SHUTDOWN_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
        assert_eq!(
            observations,
            if name == "data-trap" {
                vec![]
            } else {
                vec![("lvcore".into(), Some(0))]
            },
            "{name}"
        );
        let guest = match name {
            "real" => vec!["guest:10", "guest:20", "guest:21", "guest:11"],
            "app-fail-init" => vec!["guest:10", "guest:20", "guest:11"],
            "non-trap" => vec!["guest:10", "guest:11"],
            _ => vec!["guest:10"],
        };
        let mut expected: Vec<String> = guest.into_iter().map(str::to_owned).collect();
        expected.extend(["host:app".into(), "host:middle".into()]);
        assert_eq!(*trace.0.lock().unwrap(), expected, "{name}");
    }
}
