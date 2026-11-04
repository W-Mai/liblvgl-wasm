#[path = "../feature-graph/decode.rs"]
mod decode;

use liblvgl_wasm_host::{
    ModuleArtifactInput, ModuleHostProvider, ModuleManifest, ModuleManifestInput,
    NumericEnvironmentId, NumericEnvironmentState, NumericFunctionContract, NumericHostBinding,
    NumericHostContract, NumericHostFactory, NumericHostInstance, NumericLimits,
    NumericModuleContract, NumericProfile, NumericResult, inspect_wasm_facts,
    load_numeric_environment,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

pub struct Fixture {
    pub modules: Vec<(ModuleManifest, Vec<u8>)>,
    pub hosts: Vec<ModuleHostProvider>,
    pub profile: NumericProfile,
}

fn functions(value: &Value) -> Vec<NumericFunctionContract> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| NumericFunctionContract {
            name: decode::string(&item["name"]),
            params: item["params"].as_array().unwrap().len(),
            result: if item["results"].as_array().unwrap().is_empty() {
                NumericResult::Void
            } else {
                NumericResult::I32
            },
        })
        .collect()
}

impl Fixture {
    pub fn from_json(bytes: &[u8]) -> Self {
        let cases: Value = serde_json::from_slice(bytes).unwrap();
        let case = cases
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == "dag")
            .unwrap();
        let input = &case["input"];
        let profile = &case["profile"];
        let limit = |name: &str| profile["limits"][name].as_u64().unwrap();
        Self {
            modules: input["modules"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| {
                    (
                        decode::manifest(&item["manifest"]),
                        decode::hex(&item["hex"]),
                    )
                })
                .collect(),
            hosts: input["hosts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| ModuleHostProvider {
                    id: decode::string(&item["id"]),
                    interface: decode::interface(&item["interface"]),
                    exports: decode::exports(&item["exports"]),
                })
                .collect(),
            profile: NumericProfile {
                modules: profile["modules"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| NumericModuleContract {
                        id: decode::string(&item["id"]),
                        sha256: decode::string(&item["sha256"]),
                        interface: decode::interface(&item["interface"]),
                        exports: functions(&item["exports"]),
                    })
                    .collect(),
                hosts: profile["hosts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| NumericHostContract {
                        id: decode::string(&item["id"]),
                        interface: decode::interface(&item["interface"]),
                        exports: functions(&item["exports"]),
                    })
                    .collect(),
                limits: NumericLimits {
                    max_memory_pages: limit("maxMemoryPages"),
                    max_total_memory_pages: limit("maxTotalMemoryPages"),
                    max_table_elements: limit("maxTableElements"),
                    max_total_table_elements: limit("maxTotalTableElements"),
                },
            },
        }
    }
    pub fn input(&self) -> ModuleManifestInput<'_> {
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
    pub fn replace(&mut self, id: &str, bytes: Vec<u8>) {
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let (manifest, old) = self
            .modules
            .iter_mut()
            .find(|(manifest, _)| manifest.id == id)
            .unwrap();
        manifest.artifact.sha256 = hash.clone();
        *old = bytes;
        self.profile
            .modules
            .iter_mut()
            .find(|module| module.id == id)
            .unwrap()
            .sha256 = hash;
    }
}

#[derive(Default, Clone)]
pub struct Trace {
    pub events: Arc<Mutex<Vec<String>>>,
    pub environments: Arc<Mutex<Vec<NumericEnvironmentId>>>,
}
pub struct TraceFactory(pub Trace);
struct TraceHost {
    trace: Trace,
    consumer: String,
}
impl NumericHostFactory for TraceFactory {
    fn create(
        &mut self,
        consumer_id: &str,
        environment: NumericEnvironmentId,
    ) -> Result<Box<dyn NumericHostInstance>, String> {
        self.0.environments.lock().unwrap().push(environment);
        Ok(Box::new(TraceHost {
            trace: self.0.clone(),
            consumer: consumer_id.into(),
        }))
    }
}
impl NumericHostInstance for TraceHost {
    fn call(&mut self, name: &str, args: &[i32]) -> Result<Option<i32>, String> {
        assert_eq!(name, "event");
        assert_eq!(args.len(), 1);
        self.trace.events.lock().unwrap().push(args[0].to_string());
        Ok(None)
    }
    fn close(&mut self) -> Result<(), String> {
        self.trace
            .events
            .lock()
            .unwrap()
            .push(format!("host:{}", self.consumer));
        Ok(())
    }
}

pub fn run_positive(json: &[u8]) {
    let fixture = Fixture::from_json(json);
    let input = fixture.input();
    let trace = Trace::default();
    let mut factory = TraceFactory(trace.clone());
    let mut bindings = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let mut environment =
        load_numeric_environment(&input, &fixture.profile, &[], &mut bindings).unwrap();
    assert_eq!(environment.state(), NumericEnvironmentState::Ready);
    assert_eq!(environment.run(5).unwrap(), 30);
    environment.close().unwrap();
    assert_eq!(environment.state(), NumericEnvironmentState::Closed);
    environment.close().unwrap();
    assert!(environment.run(5).is_err());
    assert_eq!(
        *trace.events.lock().unwrap(),
        [
            "12",
            "10",
            "22",
            "20",
            "32",
            "30",
            "42",
            "40",
            "41",
            "31",
            "21",
            "11",
            "host:app",
            "host:a",
            "host:b",
            "host:core"
        ]
    );
}

#[allow(dead_code)]
pub fn run_instantiation_trap(json: &[u8]) {
    let mut fixture = Fixture::from_json(json);
    let mut bytes = fixture
        .modules
        .iter()
        .find(|(manifest, _)| manifest.id == "app")
        .expect("numeric app fixture")
        .1
        .clone();
    let facts = inspect_wasm_facts(&bytes).unwrap();
    assert_eq!(facts.memories.len(), 1);
    assert!(!facts.memories[0].imported);
    assert_eq!(facts.memories[0].ty.minimum_pages, 1);
    // One active data segment writes a byte immediately beyond the initial memory.
    bytes.extend_from_slice(&[
        0x0b, 0x09, 0x01, 0x00, 0x41, 0x80, 0x80, 0x04, 0x0b, 0x01, 0x58,
    ]);
    fixture.replace("app", bytes);
    let input = fixture.input();
    let trace = Trace::default();
    let mut factory = TraceFactory(trace.clone());
    let mut bindings = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    let error = load_numeric_environment(&input, &fixture.profile, &[], &mut bindings)
        .expect_err("active data segment must trap during instantiation");
    assert!(
        error.message().contains("\"app\": instantiation failed"),
        "{}",
        error.message()
    );
    assert!(
        error.message().contains("out of bounds memory access"),
        "{}",
        error.message()
    );
    assert!(error.cleanup_errors().is_empty());
    assert_eq!(
        *trace.events.lock().unwrap(),
        [
            "12",
            "10",
            "22",
            "20",
            "32",
            "30",
            "host:app",
            "host:a",
            "host:b",
            "host:core"
        ]
    );
}
