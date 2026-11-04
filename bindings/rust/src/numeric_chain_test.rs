use super::numeric_label_test::{features, lvgl_options, wasi_options};
use super::numeric_lvgl_test::{check_core_proof, interface, manifest, read_bounded, requirement};
use super::{LVGL_SHUTDOWN_OBSERVATIONS, NumericHostBinding, load_lvgl_core_environment};
use crate::{
    ModuleArtifactInput, ModuleExport, ModuleHostProvider, ModuleInterface, ModuleManifestInput,
    ModuleRole, NumericEnvironmentId, NumericFunctionContract, NumericHostContract,
    NumericHostFactory, NumericHostInstance, NumericLimits, NumericModuleContract, NumericProfile,
    NumericResult, NumericWasiOutput, inspect_wasm_facts,
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
        self.0.0.lock().unwrap().push(format!("create:{consumer}"));
        Ok(Box::new(Host(self.0.clone(), consumer.into())))
    }
}

impl NumericHostInstance for Host {
    fn call(&mut self, name: &str, args: &[i32]) -> Result<Option<i32>, String> {
        assert_eq!(name, "lifecycle");
        assert_eq!(args.len(), 1);
        self.0.0.lock().unwrap().push(format!("guest:{}", args[0]));
        Ok(None)
    }
    fn close(&mut self) -> Result<(), String> {
        self.0.0.lock().unwrap().push(format!("close:{}", self.1));
        Ok(())
    }
}

struct NoOutput;
impl NumericWasiOutput for NoOutput {
    fn write(&mut self, _: &str, _: u32, _: &[u8], _: NumericEnvironmentId) -> Result<(), String> {
        Err("unexpected WASI output".into())
    }
}

fn hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |byte| match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                _ => panic!("invalid chain bytes"),
            };
            digit(pair[0]) * 16 + digit(pair[1])
        })
        .collect()
}

#[test]
#[ignore = "requires the generated real LVGL chain and fixed-core proof"]
fn real_chain_closes_same_core_and_hosts() {
    let graph = read_bounded("LVW_TEST_CHAIN_GRAPH", 256 * 1024 * 1024);
    let core = read_bounded("LVW_TEST_LVGL_CORE", 64 * 1024 * 1024);
    let api = read_bounded("LVW_TEST_LVGL_API", 32 * 1024 * 1024);
    let proof = read_bounded("LVW_TEST_LVGL_PROOF", 1024 * 1024);
    check_core_proof(&core, &api, &proof);
    let cases: Value = serde_json::from_slice(&graph).unwrap();
    for (name, expected_guest, fails) in [
        (
            "real",
            vec!["guest:10", "guest:20", "guest:21", "guest:11"],
            false,
        ),
        ("middle-fail-init", vec!["guest:10"], true),
        (
            "app-fail-init",
            vec!["guest:10", "guest:20", "guest:11"],
            true,
        ),
    ] {
        let case = cases
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["name"] == name)
            .unwrap();
        let modules = case["input"]["modules"].as_array().unwrap();
        let read = |id: &str| {
            let item = modules
                .iter()
                .find(|item| item["manifest"]["id"] == id)
                .unwrap();
            let bytes = hex(item["hex"].as_str().unwrap());
            let facts = inspect_wasm_facts(&bytes).unwrap();
            assert_eq!(
                item["manifest"]["artifact"]["sha256"].as_str(),
                Some(facts.sha256.as_str())
            );
            (bytes, facts)
        };
        let (core_bytes, core_facts) = read("lvcore");
        let (middle_bytes, middle) = read("middle");
        let (app_bytes, app) = read("app");
        assert_eq!(core_bytes, core);
        let core_wasi = requirement(&core_facts, "wasi_snapshot_preview1", "host.wasi", "wasi");
        let core_lvw = requirement(&core_facts, "lvw", "host.lvw", "lvw");
        let middle_core = requirement(&middle, "lvcore", "lvcore", "lvcore");
        let middle_trace = requirement(&middle, "trace", "host.trace", "trace");
        let app_middle = requirement(&app, "middle", "middle", "middle");
        let app_trace = requirement(&app, "trace", "host.trace", "trace");
        assert_eq!(
            (
                core_wasi.imports.len(),
                core_lvw.imports.len(),
                middle_core.imports.len(),
                middle_trace.imports.len(),
                app_middle.imports.len(),
                app_trace.imports.len()
            ),
            (7, 14, 1, 1, 3, 1)
        );
        let host =
            |id: &str, iface: &str, imports: &crate::ManifestRequirement| ModuleHostProvider {
                id: id.into(),
                interface: interface(iface),
                exports: imports
                    .imports
                    .iter()
                    .map(|item| ModuleExport {
                        name: item.name.clone(),
                        ty: item.ty.clone(),
                    })
                    .collect(),
            };
        let hosts = vec![
            host("host.wasi", "wasi", &core_wasi),
            host("host.lvw", "lvw", &core_lvw),
            host("host.trace", "trace", &middle_trace),
        ];
        let core_manifest = manifest(
            "lvcore",
            ModuleRole::Lib,
            &core_facts,
            &features(),
            vec![core_wasi, core_lvw],
        );
        let middle_manifest = manifest(
            "middle",
            ModuleRole::Lib,
            &middle,
            &[],
            vec![middle_core, middle_trace],
        );
        let app_manifest = manifest(
            "app",
            ModuleRole::App,
            &app,
            &[],
            vec![app_middle, app_trace],
        );
        let input = ModuleManifestInput {
            modules: vec![
                ModuleArtifactInput {
                    manifest: app_manifest,
                    bytes: &app_bytes,
                },
                ModuleArtifactInput {
                    manifest: middle_manifest,
                    bytes: &middle_bytes,
                },
                ModuleArtifactInput {
                    manifest: core_manifest,
                    bytes: &core_bytes,
                },
            ],
            hosts,
        };
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
        let profile = NumericProfile {
            modules: vec![
                contract("app", &app.sha256, vec![]),
                contract(
                    "middle",
                    &middle.sha256,
                    vec![
                        function("middle_step", 1),
                        function("middle_count", 0),
                        function("middle_active", 0),
                    ],
                ),
                contract(
                    "lvcore",
                    &core_facts.sha256,
                    vec![function("lv_is_initialized", 0)],
                ),
            ],
            hosts: vec![NumericHostContract {
                id: "host.trace".into(),
                interface: ModuleInterface {
                    name: "trace".into(),
                    version: 1,
                },
                exports: vec![NumericFunctionContract {
                    name: "lifecycle".into(),
                    params: 1,
                    result: NumericResult::Void,
                }],
            }],
            limits: NumericLimits {
                max_memory_pages: 65536,
                max_total_memory_pages: 196608,
                max_table_elements: u64::from(u32::MAX),
                max_total_table_elements: u64::from(u32::MAX) * 3,
            },
        };
        let trace = Trace::default();
        let mut factory = Factory(trace.clone());
        let mut bindings = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
        LVGL_SHUTDOWN_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
        let result = load_lvgl_core_environment(
            &input,
            &profile,
            &features(),
            &mut bindings,
            &lvgl_options(),
            Some((&wasi_options(), Box::new(NoOutput))),
        );
        if fails {
            let error = result.unwrap_err();
            assert!(
                error.message().contains("module_init returned 7"),
                "{name}: {error}"
            );
            assert!(error.cleanup_errors().is_empty(), "{name}: {error}");
        } else {
            let mut environment = result.unwrap();
            assert_eq!(environment.run(5).unwrap(), 115);
            environment.close().unwrap();
        }
        let records =
            LVGL_SHUTDOWN_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
        assert_eq!(records, vec![("lvcore".into(), Some(0))], "{name}");
        let mut expected = vec!["create:middle".to_owned(), "create:app".to_owned()];
        expected.extend(expected_guest.into_iter().map(str::to_owned));
        expected.extend(["close:app".to_owned(), "close:middle".to_owned()]);
        assert_eq!(*trace.0.lock().unwrap(), expected, "{name}");
    }
}
