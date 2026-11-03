#[path = "../../../tests/fixtures/feature-graph/decode.rs"]
mod decode;

use liblvgl_wasm_host::{
    ManifestCheck, ModuleArtifactInput, ModuleHostProvider, ModuleManifestInput, ModuleRole,
    NumericFunctionContract, NumericHostContract, NumericLimits, NumericModuleContract,
    NumericPreflightError, NumericProfile, NumericResult, WasmCheck, preflight_numeric_graph,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

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

fn profile(value: &Value) -> NumericProfile {
    let limit = |name: &str| value["limits"][name].as_u64().unwrap();
    NumericProfile {
        modules: value["modules"]
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
        hosts: value["hosts"]
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
    }
}

#[test]
fn shared_numeric_preflight_real_graphs() {
    let path = env::var_os("LVW_TEST_NUMERIC_PREFLIGHT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/validator/numeric-preflight.json")
        });
    let cases: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert!(cases.as_array().unwrap().len() > 15);
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let source = &case["input"];
        let binaries: Vec<_> = source["modules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| decode::hex(&item["hex"]))
            .collect();
        let mut input = ModuleManifestInput {
            modules: source["modules"]
                .as_array()
                .unwrap()
                .iter()
                .zip(&binaries)
                .map(|(item, bytes)| ModuleArtifactInput {
                    manifest: decode::manifest(&item["manifest"]),
                    bytes,
                })
                .collect(),
            hosts: source["hosts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| ModuleHostProvider {
                    id: decode::string(&item["id"]),
                    interface: decode::interface(&item["interface"]),
                    exports: decode::exports(&item["exports"]),
                })
                .collect(),
        };
        let allowed: Vec<_> = case["allowedFeatures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        let outcome = preflight_numeric_graph(&input, &profile(&case["profile"]), &allowed);
        if case["pass"].as_bool().unwrap() {
            let report = outcome.unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(report.app_id(), "app", "{name}");
            assert_eq!(report.graph().order(), ["core", "b", "a", "app"], "{name}");
            for module in report.graph().modules() {
                let index = input
                    .modules
                    .iter()
                    .position(|item| item.manifest.id == module.id())
                    .unwrap();
                assert_eq!(
                    module.sha256(),
                    format!("{:x}", Sha256::digest(&binaries[index])),
                    "{name}"
                );
                assert_eq!(module.checks().engine(), ManifestCheck::Passed);
                assert_eq!(module.checks().host_implementation(), WasmCheck::NotRun);
                assert_eq!(module.checks().lifecycle(), WasmCheck::NotRun);
                assert_eq!(module.checks().runtime(), WasmCheck::NotRun);
            }
            if name == "dag" {
                for module in &mut input.modules {
                    module
                        .manifest
                        .target
                        .features
                        .push("legacy-exceptions".into());
                }
                let mut trusted = profile(&case["profile"]);
                let allowed = ["legacy-exceptions"];
                assert!(
                    matches!(
                        preflight_numeric_graph(&input, &trusted, &allowed),
                        Err(NumericPreflightError::Engine(_))
                    ),
                    "unsupported engine feature must fail"
                );
                trusted.limits.max_total_memory_pages = 7;
                assert!(
                    matches!(preflight_numeric_graph(&input, &trusted, &allowed),
                    Err(NumericPreflightError::Numeric(message)) if message.contains("resource limit")),
                    "resource rejection must precede engine construction"
                );
                trusted.limits.max_total_memory_pages = 8;
                trusted.modules[0].sha256 = "0".repeat(64);
                assert!(
                    matches!(preflight_numeric_graph(&input, &trusted, &allowed),
                    Err(NumericPreflightError::Numeric(message)) if message.contains("not authorized")),
                    "identity rejection must precede engine construction"
                );
                let mut trusted = profile(&case["profile"]);
                let duplicate = trusted.hosts[0].exports[0].clone();
                trusted.hosts[0].exports.push(duplicate);
                assert!(
                    matches!(preflight_numeric_graph(&input, &trusted, &allowed),
                    Err(NumericPreflightError::Numeric(message)) if message.contains("invalid numeric function contract"))
                );
                trusted = profile(&case["profile"]);
                trusted.hosts[0].exports[0].params = 65;
                assert!(
                    matches!(preflight_numeric_graph(&input, &trusted, &allowed),
                    Err(NumericPreflightError::Numeric(message)) if message.contains("invalid numeric function contract"))
                );
                let trusted = profile(&case["profile"]);
                input.modules[0].manifest.role = ModuleRole::Lib;
                assert!(
                    matches!(preflight_numeric_graph(&input, &trusted, &allowed),
                    Err(NumericPreflightError::Numeric(message)) if message.contains("exactly one app"))
                );
                input.modules[0].manifest.role = ModuleRole::App;
                let mut extra = input.modules[0].manifest.clone();
                extra.id = "app2".into();
                extra.interface.name = "app2".into();
                let bytes = input.modules[0].bytes;
                input.modules.push(ModuleArtifactInput {
                    manifest: extra,
                    bytes,
                });
                let mut trusted = trusted;
                let mut extra = trusted.modules[0].clone();
                extra.id = "app2".into();
                extra.interface.name = "app2".into();
                trusted.modules.push(extra);
                trusted.limits.max_total_memory_pages = 10;
                assert!(
                    matches!(preflight_numeric_graph(&input, &trusted, &allowed),
                    Err(NumericPreflightError::Numeric(message)) if message.contains("exactly one app"))
                );
            }
        } else {
            let expected = match name {
                "memory-unbounded" => "memory maximum is required",
                "table-unbounded" => "table maximum is required",
                "memory-import" => "numeric memory limit exceeded",
                "table-import" => "numeric table limit exceeded",
                "float-import" | "v128-import" | "unauthorized-export" => {
                    "numeric import is not authorized"
                }
                "wasi" => "WASI is unsupported",
                "reserved-import" => "lifecycle import is unsupported",
                "identity" | "interface" => "module identity is not authorized",
                _ => case["error"].as_str().unwrap(),
            };
            match outcome {
                Err(NumericPreflightError::Numeric(message)) => {
                    assert!(message.contains(expected), "{name}: {message}")
                }
                other => panic!("{name}: unexpected result {other:?}"),
            }
        }
    }
}
