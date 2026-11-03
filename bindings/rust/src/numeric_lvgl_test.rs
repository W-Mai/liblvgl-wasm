use super::{LVGL_SHUTDOWN_OBSERVATIONS, NumericHostBinding, load_lvgl_core_environment};
use crate::{
    ManifestRequirement, ModuleArtifact, ModuleArtifactInput, ModuleExport, ModuleExternalType,
    ModuleHostProvider, ModuleImport, ModuleInterface, ModuleManifest, ModuleManifestInput,
    ModuleRole, ModuleTarget, NumericEnvironmentId, NumericFunctionContract, NumericLimits,
    NumericLvglCoreOptions, NumericModuleContract, NumericProfile, NumericResult, NumericWasiClock,
    NumericWasiOptions, NumericWasiOutput, NumericWasiService, WasmExternal, WasmFacts,
    inspect_wasm_facts,
};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;

pub(super) fn read_bounded(variable: &str, maximum: u64) -> Vec<u8> {
    let path = std::env::var_os(variable).unwrap_or_else(|| panic!("missing {variable}"));
    let file = std::fs::File::open(path).unwrap();
    assert!(
        file.metadata().unwrap().len() <= maximum,
        "{variable} exceeds limit"
    );
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes).unwrap();
    assert!(bytes.len() as u64 <= maximum, "{variable} exceeds limit");
    bytes
}

pub(super) fn check_core_proof(core: &[u8], api: &[u8], proof: &[u8]) {
    let api_sha = format!("{:x}", Sha256::digest(api));
    let core_sha = format!("{:x}", Sha256::digest(core));
    let api: serde_json::Value = serde_json::from_slice(api).expect("invalid API metadata");
    let proof: serde_json::Value = serde_json::from_slice(proof).expect("invalid core proof");
    let fields = proof.as_object().expect("invalid core proof object");
    let keys = [
        "schema_version",
        "api_sha256",
        "wasm_sha256",
        "expected_functions",
        "verified_functions",
    ];
    assert_eq!(fields.len(), keys.len(), "invalid core proof fields");
    assert!(
        keys.iter().all(|key| fields.contains_key(*key)),
        "invalid core proof fields"
    );
    assert_eq!(api["schema_version"].as_u64(), Some(1));
    assert_eq!(proof["schema_version"].as_u64(), Some(1));
    assert_eq!(proof["wasm_sha256"].as_str(), Some(core_sha.as_str()));
    assert_eq!(proof["api_sha256"].as_str(), Some(api_sha.as_str()));
    let mut names = HashSet::new();
    for declaration in api["declarations"]
        .as_array()
        .expect("invalid API declarations")
    {
        match declaration["category"].as_str() {
            Some("unsupported" | "compile_disabled") => continue,
            Some("direct_export" | "abi_shim") => (),
            _ => panic!("invalid API declaration category"),
        }
        let name = declaration["export_name"]
            .as_str()
            .filter(|name| !name.is_empty())
            .expect("invalid API export");
        assert!(names.insert(name), "duplicate API export");
    }
    let expected = proof["expected_functions"]
        .as_u64()
        .filter(|value| *value > 0)
        .expect("invalid core proof count");
    assert_eq!(proof["verified_functions"].as_u64(), Some(expected));
    assert_eq!(
        api["wasm_summary"]["expected_functions"].as_u64(),
        Some(expected)
    );
    assert_eq!(names.len() as u64, expected);
}

#[test]
fn bounded_core_proof_binds_core_api_and_unique_export_count() {
    let core = b"core";
    let api = br#"{"schema_version":1,"declarations":[{"category":"direct_export","export_name":"lv_test"}],"wasm_summary":{"expected_functions":1}}"#;
    let proof = serde_json::json!({"schema_version": 1, "api_sha256": format!("{:x}", Sha256::digest(api)),
        "wasm_sha256": format!("{:x}", Sha256::digest(core)), "expected_functions": 1, "verified_functions": 1});
    let proof_bytes = serde_json::to_vec(&proof).unwrap();
    check_core_proof(core, api, &proof_bytes);
    assert!(std::panic::catch_unwind(|| check_core_proof(b"other", api, &proof_bytes)).is_err());
    assert!(std::panic::catch_unwind(|| check_core_proof(core, b"{}", &proof_bytes)).is_err());
    let mut bad_count = proof;
    bad_count["verified_functions"] = 2.into();
    assert!(
        std::panic::catch_unwind(|| check_core_proof(
            core,
            api,
            &serde_json::to_vec(&bad_count).unwrap()
        ))
        .is_err()
    );
}

pub(super) fn interface(name: &str) -> ModuleInterface {
    ModuleInterface {
        name: name.into(),
        version: 1,
    }
}
fn external(facts: &WasmFacts, item: WasmExternal) -> ModuleExternalType {
    match item {
        WasmExternal::Function { type_index, .. } => {
            let ty = &facts.types[type_index as usize];
            ModuleExternalType::Function {
                params: ty.params.clone(),
                results: ty.results.clone(),
            }
        }
        WasmExternal::Tag { type_index, .. } => {
            let ty = &facts.types[type_index as usize];
            ModuleExternalType::Tag {
                params: ty.params.clone(),
                results: ty.results.clone(),
            }
        }
        WasmExternal::Table { ty, .. } => ModuleExternalType::Table(ty),
        WasmExternal::Memory { ty, .. } => ModuleExternalType::Memory(ty),
        WasmExternal::Global { ty, .. } => ModuleExternalType::Global(ty),
    }
}
pub(super) fn exports(facts: &WasmFacts) -> Vec<ModuleExport> {
    facts
        .exports
        .iter()
        .map(|item| ModuleExport {
            name: item.name.clone(),
            ty: external(facts, item.external),
        })
        .collect()
}
pub(super) fn requirement(
    facts: &WasmFacts,
    namespace: &str,
    provider: &str,
    interface: &str,
) -> ManifestRequirement {
    ManifestRequirement {
        provider: provider.into(),
        interface: interface.into(),
        version: 1,
        imports: facts
            .imports
            .iter()
            .filter(|item| item.module == namespace)
            .map(|item| ModuleImport {
                module: item.module.clone(),
                name: item.name.clone(),
                provider_export: item.name.clone(),
                ty: external(facts, item.external),
            })
            .collect(),
    }
}
pub(super) fn manifest(
    id: &str,
    role: ModuleRole,
    facts: &WasmFacts,
    features: &[&str],
    requires: Vec<ManifestRequirement>,
) -> ModuleManifest {
    ModuleManifest {
        schema_version: 1,
        kind: "wasm-module".into(),
        id: id.into(),
        role,
        artifact: ModuleArtifact {
            path: format!("{id}.wasm"),
            sha256: facts.sha256.clone(),
        },
        target: ModuleTarget {
            abi: "wasip1".into(),
            features: features.iter().map(|item| (*item).into()).collect(),
        },
        interface: interface(id),
        memory_model: "isolated".into(),
        requires,
        exports: exports(facts),
        runtime_verification: "not-run".into(),
    }
}
struct NoOutput;
impl NumericWasiOutput for NoOutput {
    fn write(&mut self, _: &str, _: u32, _: &[u8], _: NumericEnvironmentId) -> Result<(), String> {
        Err("unexpected WASI output".into())
    }
}

#[test]
#[ignore = "requires the generated fixed-table LVGL core and failing C app"]
fn real_lvgl_failed_app_rolls_back_same_core() {
    let core_bytes = read_bounded("LVW_TEST_LVGL_CORE", 64 * 1024 * 1024);
    let api_bytes = read_bounded("LVW_TEST_LVGL_API", 32 * 1024 * 1024);
    let proof_bytes = read_bounded("LVW_TEST_LVGL_PROOF", 1024 * 1024);
    let app_bytes = read_bounded("LVW_TEST_LVGL_FAIL_APP", 64 * 1024 * 1024);
    check_core_proof(&core_bytes, &api_bytes, &proof_bytes);
    let core = inspect_wasm_facts(&core_bytes).unwrap();
    let app = inspect_wasm_facts(&app_bytes).unwrap();
    let features = [
        "bulk-memory",
        "reference-types",
        "sign-extension",
        "saturating-float-to-int",
        "exceptions",
    ];
    let wasi_req = requirement(&core, "wasi_snapshot_preview1", "host.wasi", "wasi");
    let lvw_req = requirement(&core, "lvw", "host.lvw", "lvw");
    let app_req = requirement(&app, "lvcore", "lvcore", "lvcore");
    assert_eq!(
        (
            wasi_req.imports.len(),
            lvw_req.imports.len(),
            app_req.imports.len()
        ),
        (7, 14, 1)
    );
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
        host("host.wasi", "wasi", &wasi_req),
        host("host.lvw", "lvw", &lvw_req),
    ];
    let core_manifest = manifest(
        "lvcore",
        ModuleRole::Lib,
        &core,
        &features,
        vec![wasi_req, lvw_req],
    );
    let app_manifest = manifest("app", ModuleRole::App, &app, &[], vec![app_req]);
    let input = ModuleManifestInput {
        modules: vec![
            ModuleArtifactInput {
                manifest: app_manifest,
                bytes: &app_bytes,
            },
            ModuleArtifactInput {
                manifest: core_manifest,
                bytes: &core_bytes,
            },
        ],
        hosts,
    };
    let profile = NumericProfile {
        modules: vec![
            NumericModuleContract {
                id: "app".into(),
                sha256: app.sha256.clone(),
                interface: interface("app"),
                exports: vec![],
            },
            NumericModuleContract {
                id: "lvcore".into(),
                sha256: core.sha256.clone(),
                interface: interface("lvcore"),
                exports: vec![NumericFunctionContract {
                    name: "lv_is_initialized".into(),
                    params: 0,
                    result: NumericResult::I32,
                }],
            },
        ],
        hosts: vec![],
        limits: NumericLimits {
            max_memory_pages: 65536,
            max_total_memory_pages: 131072,
            max_table_elements: u64::from(u32::MAX),
            max_total_table_elements: u64::from(u32::MAX) * 2,
        },
    };
    let lvgl = NumericLvglCoreOptions {
        module: "lvcore".into(),
        id: "host.lvw".into(),
        interface: interface("lvw"),
        abi_version: 1,
    };
    use NumericWasiService::*;
    let wasi = NumericWasiOptions {
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
        max_iovecs: 16,
        max_write_bytes: 4096,
        max_output_bytes: 4096,
        clock: Some(NumericWasiClock {
            realtime_ns: 0,
            monotonic_ns: 0,
        }),
    };
    LVGL_SHUTDOWN_OBSERVATIONS.with(|records| *records.borrow_mut() = Some(Vec::new()));
    let result = load_lvgl_core_environment(
        &input,
        &profile,
        &features,
        &mut [] as &mut [NumericHostBinding<'_>],
        &lvgl,
        Some((&wasi, Box::new(NoOutput))),
    );
    let records = LVGL_SHUTDOWN_OBSERVATIONS.with(|records| records.borrow_mut().take().unwrap());
    let error = result.unwrap_err();
    assert!(
        error.message().contains("module_init returned 7"),
        "{error}"
    );
    assert!(error.cleanup_errors().is_empty(), "{error}");
    assert_eq!(records, vec![("lvcore".into(), Some(0))]);
}
