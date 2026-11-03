use super::numeric_lvgl_test::{check_core_proof, interface, manifest, read_bounded, requirement};
use super::{
    LVGL_SHUTDOWN_OBSERVATIONS, NumericEnvironment, NumericEnvironmentState, NumericHostBinding,
    load_lvgl_label_environment,
};
use crate::{
    ManifestRequirement, ModuleArtifactInput, ModuleExport, ModuleHostProvider, ModuleManifest,
    ModuleManifestInput, ModuleRole, NumericEnvironmentId, NumericFunctionContract,
    NumericHostContract, NumericHostFactory, NumericHostInstance, NumericLabelOptions,
    NumericLimits, NumericLvglCoreOptions, NumericModuleContract, NumericProfile, NumericResult,
    NumericWasiClock, NumericWasiOptions, NumericWasiOutput, NumericWasiService,
    inspect_wasm_facts,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn graph_bytes() -> Vec<u8> {
    read_bounded("LVW_TEST_LABEL_GRAPH", 256 * 1024 * 1024)
}

pub(super) struct Fixture {
    pub(super) modules: Vec<(ModuleManifest, Vec<u8>)>,
    pub(super) hosts: Vec<ModuleHostProvider>,
    pub(super) profile: NumericProfile,
}
impl Fixture {
    pub(super) fn input(&self) -> ModuleManifestInput<'_> {
        ModuleManifestInput {
            modules: self
                .modules
                .iter()
                .map(|(manifest, bytes)| ModuleArtifactInput {
                    manifest: manifest.clone(),
                    bytes,
                })
                .collect(),
            hosts: self.hosts.clone(),
        }
    }
    pub(super) fn replace(&mut self, id: &str, bytes: Vec<u8>) {
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let (manifest, original) = self
            .modules
            .iter_mut()
            .find(|(manifest, _)| manifest.id == id)
            .unwrap();
        manifest.artifact.sha256 = hash.clone();
        *original = bytes;
        self.profile
            .modules
            .iter_mut()
            .find(|item| item.id == id)
            .unwrap()
            .sha256 = hash;
    }
}
fn case<'a>(cases: &'a Value, name: &str) -> &'a Value {
    cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap()
}
fn hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |v: u8| match v {
                b'0'..=b'9' => v - b'0',
                b'a'..=b'f' => v - b'a' + 10,
                _ => panic!("invalid fixture hex"),
            };
            digit(pair[0]) * 16 + digit(pair[1])
        })
        .collect()
}
pub(super) fn graph(bytes: &[u8], name: &str) -> Fixture {
    let cases: Value = serde_json::from_slice(bytes).unwrap();
    let value = case(&cases, name);
    let input = &value["input"];
    let raw = |id: &str| {
        let module = input["modules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["manifest"]["id"] == id)
            .unwrap();
        let bytes = hex(module["hex"].as_str().unwrap());
        let facts = inspect_wasm_facts(&bytes).unwrap();
        assert_eq!(
            module["manifest"]["artifact"]["sha256"].as_str().unwrap(),
            facts.sha256
        );
        let features: Vec<_> = module["manifest"]["target"]["features"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_owned())
            .collect();
        (bytes, facts, features)
    };
    let (core_bytes, core, core_features) = raw("lvcore");
    let (app_bytes, app, app_features) = raw("app");
    let mut hosts = Vec::new();
    let mut core_reqs = Vec::new();
    let mut app_reqs = Vec::new();
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
    for (namespace, id, name) in [
        ("wasi_snapshot_preview1", "host.wasi", "wasi"),
        ("lvw", "host.lvw", "lvw"),
    ] {
        let req = requirement(&core, namespace, id, name);
        if id == "host.lvw" || !req.imports.is_empty() {
            hosts.push(host(id, name, &req));
            core_reqs.push(req);
        }
    }
    let trace = requirement(&core, "trace", "host.trace", "trace");
    let app_trace = requirement(&app, "trace", "host.trace", "trace");
    if !trace.imports.is_empty() || !app_trace.imports.is_empty() {
        hosts.push(host(
            "host.trace",
            "trace",
            if trace.imports.is_empty() {
                &app_trace
            } else {
                &trace
            },
        ));
        if !trace.imports.is_empty() {
            core_reqs.push(trace);
        }
        if !app_trace.imports.is_empty() {
            app_reqs.push(app_trace);
        }
    }
    let label = requirement(&app, "lvgl", "host.label", "lvgl");
    hosts.push(host("host.label", "lvgl", &label));
    app_reqs.push(label);
    app_reqs.push(requirement(&app, "lvcore", "lvcore", "lvcore"));
    let app_feature_refs: Vec<_> = app_features.iter().map(String::as_str).collect();
    let core_feature_refs: Vec<_> = core_features.iter().map(String::as_str).collect();
    let modules = vec![
        (
            manifest("app", ModuleRole::App, &app, &app_feature_refs, app_reqs),
            app_bytes,
        ),
        (
            manifest(
                "lvcore",
                ModuleRole::Lib,
                &core,
                &core_feature_refs,
                core_reqs,
            ),
            core_bytes,
        ),
    ];
    let limits = &value["profile"]["limits"];
    let number = |key: &str| limits[key].as_u64().unwrap();
    let profile = NumericProfile {
        modules: modules
            .iter()
            .map(|(item, _)| NumericModuleContract {
                id: item.id.clone(),
                sha256: item.artifact.sha256.clone(),
                interface: item.interface.clone(),
                exports: vec![],
            })
            .collect(),
        hosts: hosts
            .iter()
            .filter(|item| item.id == "host.trace")
            .map(|item| NumericHostContract {
                id: item.id.clone(),
                interface: item.interface.clone(),
                exports: vec![NumericFunctionContract {
                    name: "event".into(),
                    params: 1,
                    result: NumericResult::Void,
                }],
            })
            .collect(),
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
pub(super) fn verify_real_core(graph: &Fixture) {
    let core = read_bounded("LVW_TEST_LVGL_CORE", 64 * 1024 * 1024);
    let api = read_bounded("LVW_TEST_LVGL_API", 32 * 1024 * 1024);
    let proof = read_bounded("LVW_TEST_LVGL_PROOF", 1024 * 1024);
    assert_eq!(
        graph
            .modules
            .iter()
            .find(|(m, _)| m.id == "lvcore")
            .unwrap()
            .1,
        core
    );
    check_core_proof(&core, &api, &proof);
}
pub(super) fn lvgl_options() -> NumericLvglCoreOptions {
    NumericLvglCoreOptions {
        module: "lvcore".into(),
        id: "host.lvw".into(),
        interface: interface("lvw"),
        abi_version: 1,
    }
}
pub(super) fn features() -> Vec<&'static str> {
    vec![
        "bulk-memory",
        "reference-types",
        "sign-extension",
        "saturating-float-to-int",
        "exceptions",
    ]
}
pub(super) fn wasi_options() -> NumericWasiOptions {
    use NumericWasiService::*;
    NumericWasiOptions {
        id: "host.wasi".into(),
        interface: interface("wasi"),
        allowed: vec![
            EnvironGet,
            EnvironSizesGet,
            FdClose,
            FdSeek,
            FdWrite,
            ProcExit,
            ClockTimeGet,
        ],
        output_fds: vec![],
        max_iovecs: 4,
        max_write_bytes: 32,
        max_output_bytes: 128,
        clock: Some(NumericWasiClock {
            realtime_ns: 0,
            monotonic_ns: 0,
        }),
    }
}
#[derive(Clone, Default)]
pub(super) struct Trace {
    pub(super) events: Arc<Mutex<Vec<String>>>,
}
pub(super) struct TraceFactory(pub(super) Trace);
struct TraceHost(Trace, String);
impl NumericHostFactory for TraceFactory {
    fn create(
        &mut self,
        consumer: &str,
        _: NumericEnvironmentId,
    ) -> Result<Box<dyn NumericHostInstance>, String> {
        Ok(Box::new(TraceHost(self.0.clone(), consumer.into())))
    }
}
impl NumericHostInstance for TraceHost {
    fn call(&mut self, name: &str, args: &[i32]) -> Result<Option<i32>, String> {
        assert_eq!(name, "event");
        assert_eq!(args.len(), 1);
        self.0.events.lock().unwrap().push(args[0].to_string());
        Ok(None)
    }
    fn close(&mut self) -> Result<(), String> {
        self.0
            .events
            .lock()
            .unwrap()
            .push(format!("host:{}", self.1));
        Ok(())
    }
}

struct NoOutput;
impl NumericWasiOutput for NoOutput {
    fn write(&mut self, _: &str, _: u32, _: &[u8], _: NumericEnvironmentId) -> Result<(), String> {
        Err("unexpected WASI output".into())
    }
}

pub(super) fn options(bytes: &[u8], name: &str) -> NumericLabelOptions {
    let cases: Value = serde_json::from_slice(bytes).unwrap();
    let label = &case(&cases, name)["label"];
    let number = |key: &str| label[key].as_u64().unwrap().try_into().unwrap();
    NumericLabelOptions {
        id: label["id"].as_str().unwrap().into(),
        interface: interface("lvgl"),
        width: number("width"),
        height: number("height"),
        max_labels: number("maxLabels"),
        max_text_bytes: number("maxTextBytes"),
    }
}

// Test-only access to the same instance used by the adapter; no guest pointer escapes the test.
pub(super) fn core_text(environment: &mut NumericEnvironment) -> Vec<u8> {
    let instance = environment
        .initialized
        .iter()
        .find(|module| module.id == "lvcore")
        .unwrap()
        .core_instance
        .unwrap();
    let store = environment.store.as_mut().unwrap();
    let screen = instance
        .get_typed_func::<(), i32>(&mut *store, "lv_screen_active")
        .unwrap()
        .call(&mut *store, ())
        .unwrap();
    let label = instance
        .get_typed_func::<(i32, i32), i32>(&mut *store, "lv_obj_get_child")
        .unwrap()
        .call(&mut *store, (screen, 0))
        .unwrap();
    assert_ne!(label, 0);
    let address = instance
        .get_typed_func::<i32, i32>(&mut *store, "lv_label_get_text")
        .unwrap()
        .call(&mut *store, label)
        .unwrap() as u32 as usize;
    assert_ne!(address, 0);
    let memory = instance.get_memory(&mut *store, "memory").unwrap();
    let data = memory.data(&*store);
    let tail = data.get(address..).unwrap();
    let end = tail
        .iter()
        .take(4097)
        .position(|byte| *byte == 0)
        .expect("unterminated core text");
    tail[..end].to_vec()
}

// Read the same core's XRGB buffer independently of the frame adapter.
fn core_frame_reference(environment: &mut NumericEnvironment) -> (u32, u32, u32, Vec<u8>) {
    let instance = environment
        .initialized
        .iter()
        .find(|module| module.id == "lvcore")
        .unwrap()
        .core_instance
        .unwrap();
    let store = environment.store.as_mut().unwrap();
    let display = instance
        .get_typed_func::<(), i32>(&mut *store, "lv_display_get_default")
        .unwrap()
        .call(&mut *store, ())
        .unwrap();
    assert_ne!(display, 0);
    let scratch = instance
        .get_typed_func::<i32, i32>(&mut *store, "lvw_alloc")
        .unwrap()
        .call(&mut *store, 48)
        .unwrap();
    assert_ne!(scratch, 0);
    let memory = instance.get_memory(&mut *store, "memory").unwrap();
    let mut descriptor = [0u8; 48];
    descriptor[0..4].copy_from_slice(&48u32.to_le_bytes());
    descriptor[4..8].copy_from_slice(&1u32.to_le_bytes());
    memory
        .write(&mut *store, scratch as u32 as usize, &descriptor)
        .unwrap();
    let status = instance
        .get_typed_func::<(i32, i32), i32>(&mut *store, "lvw_frame_get")
        .unwrap()
        .call(&mut *store, (display, scratch))
        .unwrap();
    assert_eq!(status, 0);
    memory
        .read(&*store, scratch as u32 as usize, &mut descriptor)
        .unwrap();
    let field =
        |offset: usize| u32::from_le_bytes(descriptor[offset..offset + 4].try_into().unwrap());
    assert_eq!((field(0), field(4), field(28), field(32)), (48, 1, 1, 0));
    let (width, height, length, stride) = (field(16), field(20), field(12), field(24));
    assert_eq!(stride, width * 4);
    assert_eq!(length, stride * height);
    let mut xrgb = vec![0; length as usize];
    memory.read(&*store, field(8) as usize, &mut xrgb).unwrap();
    let mut rgba = Vec::with_capacity(xrgb.len());
    for pixel in xrgb.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
    }
    instance
        .get_typed_func::<i32, ()>(&mut *store, "lvw_free")
        .unwrap()
        .call(&mut *store, scratch)
        .unwrap();
    (width, height, field(44), rgba)
}

#[test]
#[ignore = "requires generated label graph and fixed-table LVGL core"]
fn real_label_copy_isolation_and_close() {
    let bytes = graph_bytes();
    let graph = graph(&bytes, "real");
    verify_real_core(&graph);
    let input = graph.input();
    let label = options(&bytes, "real");
    let lvgl = lvgl_options();
    let features = features();
    let mut wasi = wasi_options();
    wasi.output_fds.clear();
    let mut a = load_lvgl_label_environment(
        &input,
        &graph.profile,
        &features,
        &mut [],
        &lvgl,
        &label,
        Some((&wasi, Box::new(NoOutput))),
    )
    .unwrap();
    let mut b = load_lvgl_label_environment(
        &input,
        &graph.profile,
        &features,
        &mut [],
        &lvgl,
        &label,
        Some((&wasi, Box::new(NoOutput))),
    )
    .unwrap();
    assert_eq!(core_text(&mut a), b"ALPHA");
    assert_eq!(core_text(&mut b), b"ALPHA");
    let mut first = a.read_frame().unwrap();
    let other = b.read_frame().unwrap();
    let reference = core_frame_reference(&mut a);
    assert_eq!(
        (first.width, first.height, first.frame_id),
        (reference.0, reference.1, reference.2)
    );
    assert_eq!(first.rgba, reference.3);
    assert_eq!(
        (first.width, first.height, first.rgba.len()),
        (120, 48, 120 * 48 * 4)
    );
    assert!(first.rgba.chunks_exact(4).all(|pixel| pixel[3] == 255));
    let original = first.rgba.clone();
    first.rgba[0] ^= 0xff;
    assert_eq!(a.read_frame().unwrap().rgba, original);
    let a_token = a.run(0).unwrap();
    let b_token = b.run(0).unwrap();
    assert_ne!(a_token, 0);
    assert_ne!(a_token, b_token);
    a.run(-1).unwrap();
    assert_eq!(core_text(&mut a), b"BETA");
    assert_eq!(core_text(&mut b), b"ALPHA");
    let changed = a.read_frame().unwrap();
    assert_ne!(changed.rgba, original);
    assert_eq!(b.read_frame().unwrap().rgba, other.rgba);
    a.run(-3).unwrap();
    assert_eq!(core_text(&mut a), [b'X', 0xc3, b'(']);
    a.run(-4).unwrap();
    assert_eq!(core_text(&mut a), [b'X', 0xc3, b'(']);
    a.run(-6).unwrap();
    assert_eq!(core_text(&mut a), b"GROWN");
    a.run(-10).unwrap();
    assert_eq!(core_text(&mut a), vec![b'A'; 4096]);
    a.close().unwrap();
    assert_eq!(a.state(), NumericEnvironmentState::Closed);
    assert_eq!(b.read_frame().unwrap().rgba, other.rgba);
    assert_eq!(core_text(&mut b), b"ALPHA");
    let error = b.run(a_token).unwrap_err();
    assert!(
        error.message().contains("invalid LVGL label handle"),
        "{error}"
    );
    assert_eq!(b.state(), NumericEnvironmentState::Poisoned);
    assert_eq!(b.close().unwrap_err().message(), error.message());
}

#[test]
#[ignore = "requires generated label graph and fixed-table LVGL core"]
fn real_label_failed_init_shuts_down_the_same_core() {
    let bytes = graph_bytes();
    let graph = graph(&bytes, "real-fail-init-not-run");
    verify_real_core(&graph);
    let input = graph.input();
    let mut wasi = wasi_options();
    wasi.output_fds.clear();
    LVGL_SHUTDOWN_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
    let result = load_lvgl_label_environment(
        &input,
        &graph.profile,
        &features(),
        &mut [],
        &lvgl_options(),
        &options(&bytes, "real-fail-init-not-run"),
        Some((&wasi, Box::new(NoOutput))),
    );
    let records = LVGL_SHUTDOWN_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
    let error = result.unwrap_err();
    assert!(
        error.message().contains("module_init returned 7"),
        "{error}"
    );
    assert!(error.cleanup_errors().is_empty());
    assert_eq!(records, vec![("lvcore".into(), Some(0))]);
}

fn synthetic(
    core: &str,
    app: &str,
) -> (
    Result<NumericEnvironment, super::NumericEnvironmentError>,
    Trace,
) {
    let bytes = graph_bytes();
    let mut graph = graph(&bytes, "synthetic");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/validator/lvgl-label-negative");
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
    let mut bindings = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let result = load_lvgl_label_environment(
        &graph.input(),
        &graph.profile,
        &[],
        &mut bindings,
        &lvgl_options(),
        &options(&bytes, "synthetic"),
        None,
    );
    (result, trace)
}

fn events(trace: &Trace) -> Vec<String> {
    trace.events.lock().unwrap().clone()
}

#[test]
#[ignore = "requires generated synthetic label fixtures"]
fn synthetic_label_lifecycle_and_null_refresh() {
    let (result, trace) = synthetic("core", "app");
    let mut environment = result.unwrap();
    assert_ne!(environment.run(-7).unwrap(), 0);
    let before = events(&trace);
    assert!(before.iter().any(|item| item == "43"));
    assert!(!before.iter().any(|item| item == "50" || item == "51"));
    environment.close().unwrap();
    let after = events(&trace);
    let pos = |value: &str| after.iter().position(|item| item == value).unwrap();
    assert!(pos("39") < pos("19"));
    assert!(pos("19") < pos("host:app"));
    assert!(pos("host:app") < pos("host:lvcore"));
}

#[test]
#[ignore = "requires generated synthetic label fixtures"]
fn synthetic_label_failures_poison_without_reentering_guest() {
    for (core, action, expected, last, forbidden) in [
        ("core-alloc-zero", 0, "alloc", "50", vec!["43", "51", "19"]),
        ("core-alloc-trap", 0, "guest", "50", vec!["43", "51", "19"]),
        ("core-alloc-oob", 0, "bounds", "50", vec!["43", "51", "19"]),
        ("core-set-trap", 0, "guest", "43", vec!["51", "19"]),
        ("core-free-trap", 0, "guest", "51", vec!["19"]),
    ] {
        let (result, trace) = synthetic(core, "app");
        let mut environment = result.unwrap();
        let error = environment.run(action).unwrap_err();
        assert!(error.message().contains(expected), "{core}: {error}");
        assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
        let trace = events(&trace);
        let index = trace.iter().rposition(|item| item == last).unwrap();
        assert!(
            trace[index + 1..]
                .iter()
                .all(|item| !forbidden.contains(&item.as_str())),
            "{core}: {trace:?}"
        );
        assert_eq!(
            environment.run(action).unwrap_err().message(),
            error.message()
        );
        assert_eq!(environment.close().unwrap_err().message(), error.message());
    }
}

#[test]
#[ignore = "requires generated synthetic label fixtures"]
fn synthetic_label_init_failure_rolls_back_and_reactor_can_use_adapter() {
    let (result, trace) = synthetic("core", "app-init-fail");
    let error = result.unwrap_err();
    assert!(
        error.message().contains("module_init returned 7"),
        "{error}"
    );
    let trace = events(&trace);
    let pos = |value: &str| trace.iter().position(|item| item == value).unwrap();
    assert!(pos("42") < pos("19"));
    assert!(!trace.iter().any(|item| item == "39"));
    let (result, trace) = synthetic("core", "app-reactor-use");
    let mut environment = result.unwrap();
    let trace = events(&trace);
    assert!(
        trace.iter().position(|item| item == "42").unwrap()
            < trace.iter().position(|item| item == "31").unwrap()
    );
    environment.close().unwrap();
}

#[test]
#[ignore = "requires generated synthetic label fixtures"]
fn synthetic_label_pointer_handle_and_quota_fail_closed() {
    for (action, expected) in [
        (-1, "out of bounds"),
        (-2, "unterminated"),
        (-3, "invalid LVGL label handle"),
        (-4, "quota"),
        (-5, "too long"),
    ] {
        let (result, trace) = synthetic("core", "app");
        let mut environment = result.unwrap();
        let error = environment.run(action).unwrap_err();
        assert!(
            error.message().contains(expected),
            "action {action}: {error}"
        );
        assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
        let trace = events(&trace);
        assert!(!trace.iter().any(|item| item == "19" || item == "39"));
        assert_eq!(environment.close().unwrap_err().message(), error.message());
    }
}

#[test]
#[ignore = "requires generated synthetic label fixtures"]
fn synthetic_label_uses_its_display_and_rejects_create_failure() {
    let (result, trace) = synthetic("core-foreign-default", "app");
    let mut environment = result.unwrap();
    assert_ne!(environment.run(0).unwrap(), 0);
    assert!(events(&trace).iter().any(|item| item == "43"));
    environment.close().unwrap();
    let (result, trace) = synthetic("core-create-zero", "app");
    let mut environment = result.unwrap();
    assert_eq!(environment.run(0).unwrap(), 0);
    let trace = events(&trace);
    assert!(trace.iter().any(|item| item == "42"));
    assert!(!trace.iter().any(|item| item == "43" || item == "50"));
    environment.close().unwrap();
}

#[test]
#[ignore = "requires generated synthetic label fixtures"]
fn synthetic_label_close_keeps_adapter_alive_until_app_returns() {
    let (result, trace) = synthetic("core", "app-close-use");
    let mut environment = result.unwrap();
    environment.close().unwrap();
    let trace = events(&trace);
    let pos = |value: &str| trace.iter().position(|item| item == value).unwrap();
    assert!(pos("39") < pos("42"), "{trace:?}");
    assert!(pos("42") < pos("43"), "{trace:?}");
    assert!(pos("43") < pos("38"), "{trace:?}");
    assert!(pos("38") < pos("19"), "{trace:?}");
    assert!(!trace.iter().any(|item| item == "50" || item == "51"));
}

struct FailDisplayFactory(Trace);
struct FailDisplayHost(Trace, String);
impl NumericHostFactory for FailDisplayFactory {
    fn create(
        &mut self,
        consumer_id: &str,
        _: NumericEnvironmentId,
    ) -> Result<Box<dyn NumericHostInstance>, String> {
        Ok(Box::new(FailDisplayHost(
            self.0.clone(),
            consumer_id.into(),
        )))
    }
}
impl NumericHostInstance for FailDisplayHost {
    fn call(&mut self, name: &str, args: &[i32]) -> Result<Option<i32>, String> {
        assert_eq!(name, "event");
        assert_eq!(args.len(), 1);
        self.0.events.lock().unwrap().push(args[0].to_string());
        if args[0] == 40 {
            Err("display callback failed".into())
        } else {
            Ok(None)
        }
    }
    fn close(&mut self) -> Result<(), String> {
        self.0
            .events
            .lock()
            .unwrap()
            .push(format!("host:{}", self.1));
        Ok(())
    }
}

#[test]
#[ignore = "requires generated synthetic label fixtures"]
fn synthetic_label_display_failure_rollback_and_callback_poison() {
    let (result, trace) = synthetic("core-display-zero", "app");
    let error = result.unwrap_err();
    assert!(error.message().contains("display"), "{error}");
    let trace = events(&trace);
    let pos = |value: &str| trace.iter().position(|item| item == value).unwrap();
    assert!(pos("40") < pos("19"), "{trace:?}");
    assert!(!trace.iter().any(|item| item == "31" || item == "39"));

    let (result, trace) = synthetic("core-display-trap", "app");
    let error = result.unwrap_err();
    assert!(error.message().contains("guest"), "{error}");
    let trace = events(&trace);
    assert!(trace.iter().any(|item| item == "40"), "{trace:?}");
    assert!(
        !trace
            .iter()
            .any(|item| item == "19" || item == "31" || item == "39"),
        "{trace:?}"
    );

    let bytes = graph_bytes();
    let graph = graph(&bytes, "synthetic");
    let trace = Trace::default();
    let mut factory = FailDisplayFactory(trace.clone());
    let mut bindings = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let result = load_lvgl_label_environment(
        &graph.input(),
        &graph.profile,
        &[],
        &mut bindings,
        &lvgl_options(),
        &options(&bytes, "synthetic"),
        None,
    );
    let error = result.unwrap_err();
    assert!(
        error.message().contains("display callback failed"),
        "{error}"
    );
    let trace = events(&trace);
    assert!(trace.iter().any(|item| item == "40"), "{trace:?}");
    assert!(
        !trace
            .iter()
            .any(|item| item == "19" || item == "31" || item == "39"),
        "{trace:?}"
    );
    assert!(trace.iter().any(|item| item == "host:lvcore"));
    assert!(trace.iter().any(|item| item == "host:app"));
}

#[test]
#[ignore = "requires generated synthetic label fixtures"]
fn synthetic_frame_pixels_are_copied_and_growth_is_observed() {
    for core in [
        "core-valid-frame",
        "core-frame-alloc-grow",
        "core-frame-get-grow",
    ] {
        let (result, trace) = synthetic(core, "app");
        let mut environment = result.unwrap();
        let mut frame = environment.read_frame().unwrap();
        assert_eq!(
            (frame.width, frame.height, frame.frame_id, frame.rgba.len()),
            (8, 8, 123, 256),
            "{core}"
        );
        assert_eq!(&frame.rgba[..8], &[1, 2, 3, 255, 4, 5, 6, 255], "{core}");
        assert!(
            frame.rgba[8..]
                .chunks_exact(4)
                .all(|pixel| pixel == [0, 0, 0, 255]),
            "{core}"
        );
        frame.rgba[0] = 99;
        assert_eq!(environment.read_frame().unwrap().rgba[0], 1, "{core}");
        let trace = events(&trace);
        let sequence: Vec<_> = trace
            .iter()
            .filter(|event| ["52", "50", "53", "51"].contains(&event.as_str()))
            .map(String::as_str)
            .collect();
        assert_eq!(
            sequence,
            ["52", "50", "53", "51", "52", "50", "53", "51"],
            "{core}"
        );
        environment.close().unwrap();
    }
}

#[test]
#[ignore = "requires generated synthetic label fixtures"]
fn synthetic_frame_rejects_bad_metadata_and_poison_sticks() {
    for core in [
        "core",
        "core-null-frame",
        "core-oob-frame",
        "core-frame-size",
        "core-frame-version",
        "core-frame-length",
        "core-frame-width",
        "core-frame-height",
        "core-frame-stride",
        "core-frame-format",
        "core-frame-alpha",
        "core-frame-overflow-length",
    ] {
        let (result, trace) = synthetic(core, "app");
        let mut environment = result.unwrap();
        let error = environment.read_frame().unwrap_err();
        assert!(error.message().contains("frame"), "{core}: {error}");
        assert_eq!(
            environment.state(),
            NumericEnvironmentState::Poisoned,
            "{core}"
        );
        let before = events(&trace);
        assert!(before.iter().any(|item| item == "53"), "{core}: {before:?}");
        assert!(
            !before.iter().any(|item| item == "51" || item == "19"),
            "{core}: {before:?}"
        );
        assert_eq!(
            environment.read_frame().unwrap_err().message(),
            error.message()
        );
        assert_eq!(environment.run(0).unwrap_err().message(), error.message());
        assert_eq!(environment.close().unwrap_err().message(), error.message());
        assert_eq!(
            events(&trace),
            before,
            "{core}: guest reentered after failure"
        );
    }
}

#[test]
#[ignore = "requires generated synthetic label fixtures"]
fn synthetic_frame_failures_stop_before_guest_cleanup() {
    for (core, last, expected) in [
        ("core-frame-refresh-trap", "52", "guest"),
        ("core-alloc-zero", "50", "allocation"),
        ("core-alloc-trap", "50", "guest"),
        ("core-frame-scratch-oob", "50", "bounds"),
        (
            "core-frame-scratch-unaligned",
            "50",
            "invalid LVGL frame allocation",
        ),
        ("core-frame-get-trap", "53", "guest"),
        ("core-frame-get-error", "53", "frame"),
        ("core-frame-free-trap", "51", "guest"),
    ] {
        let (result, trace) = synthetic(core, "app");
        let mut environment = result.unwrap();
        let error = environment.read_frame().unwrap_err();
        assert!(error.message().contains(expected), "{core}: {error}");
        assert_eq!(
            environment.state(),
            NumericEnvironmentState::Poisoned,
            "{core}"
        );
        let before = events(&trace);
        let pos = before.iter().rposition(|item| item == last).unwrap();
        assert!(
            !before[pos + 1..]
                .iter()
                .any(|item| ["50", "51", "52", "53", "19"].contains(&item.as_str())),
            "{core}: {before:?}"
        );
        assert!(
            !before.iter().any(|item| item == "19"),
            "{core}: {before:?}"
        );
        assert_eq!(
            environment.read_frame().unwrap_err().message(),
            error.message()
        );
        assert_eq!(environment.close().unwrap_err().message(), error.message());
        assert_eq!(
            events(&trace),
            before,
            "{core}: guest reentered after failure"
        );
    }
}

struct FailFrameFactory(Trace, i32);
struct FailFrameHost(Trace, i32, String);
impl NumericHostFactory for FailFrameFactory {
    fn create(
        &mut self,
        consumer: &str,
        _: NumericEnvironmentId,
    ) -> Result<Box<dyn NumericHostInstance>, String> {
        Ok(Box::new(FailFrameHost(
            self.0.clone(),
            self.1,
            consumer.into(),
        )))
    }
}
impl NumericHostInstance for FailFrameHost {
    fn call(&mut self, name: &str, args: &[i32]) -> Result<Option<i32>, String> {
        assert_eq!(name, "event");
        assert_eq!(args.len(), 1);
        self.0.events.lock().unwrap().push(args[0].to_string());
        if args[0] == self.1 {
            Err("frame callback failed".into())
        } else {
            Ok(None)
        }
    }
    fn close(&mut self) -> Result<(), String> {
        self.0
            .events
            .lock()
            .unwrap()
            .push(format!("host:{}", self.2));
        Ok(())
    }
}

#[test]
#[ignore = "requires generated synthetic label fixtures"]
fn synthetic_frame_callback_failure_is_sticky() {
    let bytes = graph_bytes();
    for event in [52, 53] {
        let mut graph = graph(&bytes, "synthetic");
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/validator/lvgl-label-negative");
        graph.replace(
            "lvcore",
            std::fs::read(root.join("core-valid-frame.wasm")).unwrap(),
        );
        let trace = Trace::default();
        let mut factory = FailFrameFactory(trace.clone(), event);
        let mut bindings = [NumericHostBinding {
            id: "host.trace".into(),
            factory: &mut factory,
        }];
        let mut environment = load_lvgl_label_environment(
            &graph.input(),
            &graph.profile,
            &[],
            &mut bindings,
            &lvgl_options(),
            &options(&bytes, "synthetic"),
            None,
        )
        .unwrap();
        let error = environment.read_frame().unwrap_err();
        assert!(
            error.message().contains("frame callback failed"),
            "event {event}: {error}"
        );
        assert_eq!(environment.state(), NumericEnvironmentState::Poisoned);
        let before = events(&trace);
        assert!(before.iter().any(|item| item == &event.to_string()));
        assert!(
            !before.iter().any(|item| item == "51" || item == "19"),
            "{before:?}"
        );
        assert_eq!(
            environment.read_frame().unwrap_err().message(),
            error.message()
        );
        assert_eq!(environment.close().unwrap_err().message(), error.message());
        assert_eq!(events(&trace), before);
    }
}

#[test]
#[ignore = "requires generated synthetic label fixtures"]
fn numeric_environment_frame_unavailable_preserves_ready_state() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/validator/lvgl-label-negative");
    let bytes = std::fs::read(root.join("app-numeric.wasm")).unwrap();
    let facts = inspect_wasm_facts(&bytes).unwrap();
    let app = manifest("app", ModuleRole::App, &facts, &[], vec![]);
    let input = ModuleManifestInput {
        modules: vec![ModuleArtifactInput {
            manifest: app.clone(),
            bytes: &bytes,
        }],
        hosts: vec![],
    };
    let profile = NumericProfile {
        modules: vec![NumericModuleContract {
            id: "app".into(),
            sha256: facts.sha256,
            interface: app.interface,
            exports: vec![],
        }],
        hosts: vec![],
        limits: NumericLimits {
            max_memory_pages: 0,
            max_total_memory_pages: 0,
            max_table_elements: 0,
            max_total_table_elements: 0,
        },
    };
    let mut environment = super::load_numeric_environment(&input, &profile, &[], &mut []).unwrap();
    let error = environment.read_frame().unwrap_err();
    assert!(
        error.message().contains("label adapter is unavailable"),
        "{error}"
    );
    assert_eq!(environment.state(), NumericEnvironmentState::Ready);
    assert_eq!(environment.run(7).unwrap(), 7);
    environment.close().unwrap();
    let closed = environment.read_frame().unwrap_err();
    assert!(closed.message().contains("not ready"), "{closed}");
    assert_eq!(
        environment.read_frame().unwrap_err().message(),
        closed.message()
    );

    let mut poisoned = super::load_numeric_environment(&input, &profile, &[], &mut []).unwrap();
    let failure = poisoned.run(-1).unwrap_err();
    assert_eq!(poisoned.state(), NumericEnvironmentState::Poisoned);
    assert_eq!(
        poisoned.read_frame().unwrap_err().message(),
        failure.message()
    );
    assert_eq!(
        poisoned.read_frame().unwrap_err().message(),
        failure.message()
    );
}
