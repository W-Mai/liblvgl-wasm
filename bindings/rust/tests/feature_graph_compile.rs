#[path = "../../../tests/fixtures/feature-graph/decode.rs"]
mod decode;

use liblvgl_wasm_host::{
    CompiledModuleGraphError, CompiledModuleGraphReport, FEATURE_POLICY, FEATURE_POLICY_VERSION,
    FeatureModuleGraphError, FeatureValidationCheck, IsolatedTopologyCheck, ManifestCheck,
    ManifestRequirement, ModuleArtifact, ModuleArtifactInput, ModuleHostProvider, ModuleInterface,
    ModuleManifest, ModuleManifestInput, ModuleRole, ModuleTarget, WasiEvidence, WasiImportCheck,
    WasmCheck, compile_feature_module_graph, inspect_feature_module_graph, validate_wasm_features,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

const CASES: &[(&str, &[&str])] = &[
    ("bulk-memory", &[]),
    ("reference-types", &[]),
    ("sign-extension", &[]),
    ("saturating-float-to-int", &[]),
    ("exceptions", &[]),
    ("simd", &[]),
    ("multi-value", &[]),
    ("threads", &[]),
    ("memory64", &[]),
    ("multi-memory", &[]),
    ("tail-call", &[]),
    ("extended-const", &[]),
    ("relaxed-simd", &["simd"]),
    ("legacy-exceptions", &[]),
    ("function-references", &["reference-types"]),
    ("gc", &["reference-types", "function-references"]),
];

fn fixture_path() -> PathBuf {
    env::var_os("LVW_TEST_FEATURE_GRAPH_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/fixtures/feature-graph/cases.json")
        })
}

fn input<'a>(value: &Value, binaries: &'a [Vec<u8>]) -> ModuleManifestInput<'a> {
    ModuleManifestInput {
        modules: value["modules"]
            .as_array()
            .unwrap()
            .iter()
            .zip(binaries)
            .map(|(item, bytes)| ModuleArtifactInput {
                manifest: decode::manifest(&item["manifest"]),
                bytes,
            })
            .collect(),
        hosts: value["hosts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|host| ModuleHostProvider {
                id: decode::string(&host["id"]),
                interface: decode::interface(&host["interface"]),
                exports: decode::exports(&host["exports"]),
            })
            .collect(),
    }
}

fn assert_checks(report: &CompiledModuleGraphReport, value: &Value) {
    assert_eq!(report.policy_version(), FEATURE_POLICY_VERSION);
    for item in report.modules() {
        let source = value["modules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|module| module["manifest"]["id"] == item.id())
            .unwrap();
        assert_eq!(
            item.sha256(),
            format!("{:x}", Sha256::digest(decode::hex(&source["hex"])))
        );
        assert_eq!(item.sha256(), item.wasi().sha256());
        assert_eq!(item.sha256(), item.isolated().sha256());
        let checks = item.checks();
        assert_eq!(checks.declaration(), ManifestCheck::Passed);
        assert_eq!(checks.identity(), ManifestCheck::Passed);
        assert_eq!(checks.interface(), ManifestCheck::Passed);
        assert_eq!(checks.feature(), FeatureValidationCheck::Passed);
        assert_eq!(checks.resource_topology(), IsolatedTopologyCheck::Passed);
        assert_eq!(
            checks.wasi_abi(),
            if item.wasi().evidence() == WasiEvidence::Present {
                WasiImportCheck::Passed
            } else {
                WasiImportCheck::NotObserved
            }
        );
        assert_eq!(checks.engine(), ManifestCheck::Passed);
        assert_eq!(checks.target_provenance(), WasmCheck::NotRun);
        assert_eq!(checks.pointer_contracts(), WasmCheck::NotRun);
        assert_eq!(checks.handle_isolation(), WasmCheck::NotRun);
        assert_eq!(checks.environment_isolation(), WasmCheck::NotRun);
        assert_eq!(checks.host_implementation(), WasmCheck::NotRun);
        assert_eq!(checks.lifecycle(), WasmCheck::NotRun);
        assert_eq!(checks.runtime(), WasmCheck::NotRun);
    }
}

#[test]
fn shared_graph_compilation_requires_every_precheck() {
    let cases: Value = serde_json::from_slice(&fs::read(fixture_path()).unwrap()).unwrap();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let value = &case["input"];
        let binaries: Vec<_> = value["modules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| decode::hex(&item["hex"]))
            .collect();
        let input = input(value, &binaries);
        let allowed: Vec<_> = case["allowedFeatures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        let result = compile_feature_module_graph(&input, &allowed);
        if !case["accepted"].as_bool().unwrap() {
            let error = result.expect_err(name);
            match (case["stage"].as_str().unwrap(), error) {
                (
                    "manifest",
                    CompiledModuleGraphError::Precheck(FeatureModuleGraphError::Manifest(_)),
                )
                | (
                    "policy",
                    CompiledModuleGraphError::Precheck(FeatureModuleGraphError::Policy(_)),
                ) => (),
                (
                    "feature",
                    CompiledModuleGraphError::Precheck(FeatureModuleGraphError::Feature {
                        module,
                        ..
                    }),
                )
                | (
                    "resource",
                    CompiledModuleGraphError::Precheck(FeatureModuleGraphError::Resource {
                        module,
                        ..
                    }),
                )
                | (
                    "wasi",
                    CompiledModuleGraphError::Precheck(FeatureModuleGraphError::Wasi {
                        module,
                        ..
                    }),
                ) => assert_eq!(module, case["module"].as_str().unwrap(), "{name}"),
                (_, error) => panic!("{name}: wrong error stage {error:?}"),
            }
            continue;
        }
        let report = result.unwrap_or_else(|error| panic!("{name}: {error}"));
        let expected: &[&str] = match binaries.len() {
            1 => &["app"],
            2 => &["lib", "app"],
            _ => &["core", "lib", "app"],
        };
        assert_eq!(report.order(), expected, "{name}");
        assert_checks(&report, value);
    }
}

fn plain_module<'a>(bytes: &'a [u8], declared: &[&str]) -> ModuleManifestInput<'a> {
    ModuleManifestInput {
        modules: vec![ModuleArtifactInput {
            manifest: ModuleManifest {
                schema_version: 1,
                kind: "wasm-module".into(),
                id: "app".into(),
                role: ModuleRole::App,
                artifact: ModuleArtifact {
                    path: "app.wasm".into(),
                    sha256: format!("{:x}", Sha256::digest(bytes)),
                },
                target: ModuleTarget {
                    abi: "wasip1".into(),
                    features: declared.iter().map(|name| (*name).into()).collect(),
                },
                interface: ModuleInterface {
                    name: "app".into(),
                    version: 1,
                },
                memory_model: "isolated".into(),
                requires: Vec::new(),
                exports: Vec::new(),
                runtime_verification: "not-run".into(),
            },
            bytes,
        }],
        hosts: Vec::new(),
    }
}

#[test]
fn real_feature_fixtures_use_validated_policy_and_engine_support() {
    let root = env::var_os("LVW_TEST_FEATURE_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/validator/fixtures")
        });
    assert_eq!(CASES.len(), 16);
    let allowed: Vec<_> = FEATURE_POLICY.iter().map(|entry| entry.name).collect();
    for (name, dependencies) in CASES {
        let bytes = fs::read(root.join(format!("{name}.wasm"))).unwrap();
        let mut declared = dependencies.to_vec();
        declared.push(name);
        assert!(
            validate_wasm_features(&bytes, &declared, &allowed).is_ok(),
            "{name}: validator must accept"
        );
        assert!(
            validate_wasm_features(&bytes, dependencies, &allowed).is_err(),
            "{name}: validator must reject undeclared feature"
        );
        let mask = lvw_feature_validator::policy_mask(&declared, &allowed).unwrap();
        let mut config = wasmtime::Config::new();
        config.wasm_features(wasmparser::WasmFeatures::all(), false);
        config.wasm_features(lvw_feature_validator::policy_features(mask).unwrap(), true);
        let engine = wasmtime::Engine::new(&config);
        let direct = engine
            .as_ref()
            .ok()
            .map(|engine| wasmtime::Module::from_binary(engine, &bytes).is_ok());
        let input = plain_module(&bytes, &declared);
        let precheck = inspect_feature_module_graph(&input, &allowed);
        let compiled = compile_feature_module_graph(&input, &allowed);
        eprintln!(
            "{name}: validator=passed, engine={}, graph_precheck={}",
            match direct {
                None => "configuration-rejected",
                Some(false) => "compile-rejected",
                Some(true) => "compiled",
            },
            if precheck.is_ok() {
                "passed"
            } else {
                "rejected"
            }
        );
        if let Err(error) = precheck {
            assert!(
                matches!(
                    error,
                    FeatureModuleGraphError::Manifest(_) | FeatureModuleGraphError::Resource { .. }
                ),
                "{name}: {error:?}"
            );
            assert!(
                matches!(compiled, Err(CompiledModuleGraphError::Precheck(_))),
                "{name}"
            );
        } else if engine.is_err() {
            assert!(
                matches!(compiled, Err(CompiledModuleGraphError::EngineConfig(_))),
                "{name}"
            );
        } else if direct == Some(false) {
            assert!(
                matches!(compiled, Err(CompiledModuleGraphError::EngineModule { .. })),
                "{name}"
            );
        } else {
            let report = compiled.unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(
                report.modules()[0].checks().engine(),
                ManifestCheck::Passed,
                "{name}"
            );
            assert_eq!(
                report.modules()[0].checks().runtime(),
                WasmCheck::NotRun,
                "{name}"
            );
        }
    }
    assert!(lvw_feature_validator::policy_features(u32::MAX).is_err());
}

#[test]
fn host_allowlist_does_not_enable_undeclared_engine_features() {
    let empty = b"\0asm\x01\0\0\0";
    let allowed: Vec<_> = FEATURE_POLICY.iter().map(|entry| entry.name).collect();
    let report = compile_feature_module_graph(&plain_module(empty, &[]), &allowed).unwrap();
    assert_eq!(report.modules()[0].checks().engine(), ManifestCheck::Passed);
    assert_eq!(
        report.modules()[0].checks().host_implementation(),
        WasmCheck::NotRun
    );
}

#[test]
fn compiled_report_is_independent_of_input_lifetime() {
    let mut bytes = b"\0asm\x01\0\0\0".to_vec();
    let expected = format!("{:x}", Sha256::digest(&bytes));
    let report = {
        let input = plain_module(&bytes, &[]);
        compile_feature_module_graph(&input, &[]).unwrap()
    };
    bytes.fill(0);
    assert_eq!(report.modules()[0].sha256(), expected);
    assert_eq!(report.modules()[0].checks().engine(), ManifestCheck::Passed);
    assert_eq!(report.modules()[0].checks().runtime(), WasmCheck::NotRun);
}

#[test]
fn unsupported_engine_feature_returns_no_partial_graph_report() {
    let root = env::var_os("LVW_TEST_FEATURE_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/validator/fixtures")
        });
    let legacy = fs::read(root.join("legacy-exceptions.wasm")).unwrap();
    let empty = b"\0asm\x01\0\0\0";
    let mut lib = plain_module(&legacy, &["legacy-exceptions"])
        .modules
        .remove(0);
    lib.manifest.id = "lib".into();
    lib.manifest.role = ModuleRole::Lib;
    lib.manifest.interface.name = "lib".into();
    let mut app = plain_module(empty, &[]).modules.remove(0);
    app.manifest.requires.push(ManifestRequirement {
        provider: "lib".into(),
        interface: "lib".into(),
        version: 1,
        imports: Vec::new(),
    });
    let input = ModuleManifestInput {
        modules: vec![app, lib],
        hosts: Vec::new(),
    };
    assert!(inspect_feature_module_graph(&input, &["legacy-exceptions"]).is_ok());
    assert!(matches!(
        compile_feature_module_graph(&input, &["legacy-exceptions"]),
        Err(CompiledModuleGraphError::EngineConfig(_))
    ));
}

#[test]
fn standalone_engine_compile_does_not_execute_start() {
    let bytes =
        b"\0asm\x01\0\0\0\x01\x04\x01\x60\0\0\x03\x02\x01\0\x08\x01\0\x0a\x05\x01\x03\0\0\x0b";
    let mut config = wasmtime::Config::new();
    config.wasm_features(wasmparser::WasmFeatures::all(), false);
    config.wasm_features(lvw_feature_validator::policy_features(0).unwrap(), true);
    let engine = wasmtime::Engine::new(&config).unwrap();
    let module = wasmtime::Module::from_binary(&engine, bytes).unwrap();
    let mut store = wasmtime::Store::new(&engine, ());
    assert!(wasmtime::Instance::new(&mut store, &module, &[]).is_err());
    assert!(matches!(
        compile_feature_module_graph(&plain_module(bytes, &[]), &[]),
        Err(CompiledModuleGraphError::Precheck(
            FeatureModuleGraphError::Resource { .. }
        ))
    ));
}

#[test]
fn real_compiled_graph() {
    let Some(path) = env::var_os("LVW_TEST_FEATURE_GRAPH_REAL") else {
        return;
    };
    let value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let graph = &value["input"];
    let binaries: Vec<_> = graph["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| decode::hex(&item["hex"]))
        .collect();
    let allowed: Vec<_> = value["allowedFeatures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap())
        .collect();
    let report = compile_feature_module_graph(&input(graph, &binaries), &allowed).unwrap();
    assert_eq!(report.order(), ["app"]);
    assert_eq!(
        report.modules()[0].sha256(),
        value["report"]["sha256"].as_str().unwrap()
    );
    let item = &report.modules()[0];
    let reference = &value["report"];
    assert_eq!(
        item.wasi().evidence(),
        if reference["wasi"]["evidence"] == "present" {
            WasiEvidence::Present
        } else {
            WasiEvidence::Absent
        }
    );
    let imports: Vec<_> = reference["wasi"]["imports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert_eq!(item.wasi().imports(), imports);
    assert_eq!(
        item.wasi().entrypoints().initialize(),
        reference["wasi"]["entrypoints"]["initialize"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(
        item.wasi().entrypoints().start(),
        reference["wasi"]["entrypoints"]["start"].as_bool().unwrap()
    );
    assert_eq!(
        item.wasi().entrypoints().start_section(),
        reference["wasi"]["entrypoints"]["startSection"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(
        item.isolated().memories(),
        reference["isolated"]["memories"].as_u64().unwrap() as usize
    );
    assert_eq!(
        item.isolated().tables(),
        reference["isolated"]["tables"].as_u64().unwrap() as usize
    );
    assert_eq!(
        item.isolated().uses_wasi(),
        reference["isolated"]["usesWasi"].as_bool().unwrap()
    );
    assert_checks(&report, graph);
}
