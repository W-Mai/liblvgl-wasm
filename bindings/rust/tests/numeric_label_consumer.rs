#[path = "../../../tests/fixtures/numeric-label/fixture.rs"]
#[allow(dead_code)]
mod fixture;

use liblvgl_wasm_host::{
    ManifestCheck, ManifestRequirement, ModuleArtifact, ModuleExport, ModuleExternalType,
    ModuleInterface, ModuleManifest, ModuleRole, ModuleTarget, NumericFunctionContract,
    NumericModuleContract, NumericPreflightError, WasmCheck, WasmExternal, WasmValueType,
    inspect_wasm_facts, preflight_lvgl_label_graph, preflight_lvgl_label_graph_for_consumer,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn leb(mut n: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        let value = (n & 127) as u8;
        n >>= 7;
        bytes.push(value | if n == 0 { 0 } else { 128 });
        if n == 0 {
            return bytes;
        }
    }
}

fn section(module: &mut Vec<u8>, id: u8, body: &[u8]) {
    module.push(id);
    module.extend(leb(body.len()));
    module.extend(body);
}

fn small_app(memory: bool) -> Vec<u8> {
    let mut bytes = b"\0asm\x01\0\0\0".to_vec();
    section(
        &mut bytes,
        1,
        &[2, 0x60, 0, 1, 0x7f, 0x60, 1, 0x7f, 1, 0x7f],
    );
    section(&mut bytes, 3, &[3, 0, 0, 1]);
    if memory {
        section(&mut bytes, 5, &[1, 1, 1, 2]);
    }
    let mut exports = vec![if memory { 4 } else { 3 }];
    for (name, index) in [("module_init", 0), ("module_close", 1), ("app_run", 2)] {
        exports.extend(leb(name.len()));
        exports.extend(name.as_bytes());
        exports.extend([0, index]);
    }
    if memory {
        exports.extend([6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 0]);
    }
    section(&mut bytes, 7, &exports);
    section(
        &mut bytes,
        10,
        &[3, 3, 0, 0, 0x0b, 4, 0, 0x41, 0, 0x0b, 4, 0, 0x41, 0, 0x0b],
    );
    bytes
}

fn read_leb(bytes: &[u8], index: &mut usize) -> usize {
    let mut value = 0usize;
    let mut shift = 0;
    loop {
        let byte = bytes[*index];
        *index += 1;
        value |= usize::from(byte & 127) << shift;
        if byte & 128 == 0 {
            return value;
        }
        shift += 7;
    }
}

fn add_export(bytes: &[u8], index: u32) -> Vec<u8> {
    let mut output = bytes[..8].to_vec();
    let mut position = 8;
    while position < bytes.len() {
        let id = bytes[position];
        position += 1;
        let size = read_leb(bytes, &mut position);
        let body = &bytes[position..position + size];
        position += size;
        if id == 7 {
            let mut start = 0;
            let count = read_leb(body, &mut start);
            let mut exports = leb(count + 1);
            exports.extend(&body[start..]);
            exports.extend([5, b'a', b'l', b'i', b'a', b's', 0]);
            exports.extend(leb(index as usize));
            section(&mut output, id, &exports);
        } else {
            section(&mut output, id, body);
        }
    }
    output
}

#[test]
fn real_three_module_label_consumer_graph_matches_shared_facts() {
    let bytes = std::fs::read(
        std::env::var_os("LVW_TEST_LABEL_LIB_GRAPH").expect("LVW_TEST_LABEL_LIB_GRAPH"),
    )
    .unwrap();
    let cases: Value = serde_json::from_slice(&bytes).unwrap();
    let case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "real")
        .unwrap();
    assert_eq!(case["label"]["consumer"], "middle");
    let graph = fixture::lvgl_fixture::graph(&bytes, "real");
    assert_eq!(
        graph
            .modules
            .iter()
            .map(|(manifest, _)| manifest.id.as_str())
            .collect::<Vec<_>>(),
        ["app", "middle", "lvcore"]
    );
    let allowed: Vec<_> = case["allowedFeatures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|feature| feature.as_str().unwrap())
        .collect();
    let wasi = fixture::lvgl_fixture::wasi_fixture::options();
    let report = preflight_lvgl_label_graph_for_consumer(
        &graph.input(),
        &graph.profile,
        &allowed,
        &fixture::lvgl_fixture::options(),
        Some(&wasi),
        &fixture::options(case),
        "middle",
    )
    .unwrap();
    assert_eq!(report.app_id(), "app");
    assert_eq!(report.graph().order(), ["lvcore", "middle", "app"]);
    assert_eq!(report.graph().modules().len(), 3);
    for module in report.graph().modules() {
        let (manifest, bytes) = graph
            .modules
            .iter()
            .find(|(manifest, _)| manifest.id == module.id())
            .unwrap();
        let hash = format!("{:x}", Sha256::digest(bytes));
        assert_eq!(module.sha256(), hash);
        assert_eq!(manifest.artifact.sha256, hash);
        let checks = module.checks();
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
fn trusted_middle_label_consumer_is_preflighted_without_running() {
    let json =
        std::fs::read(std::env::var_os("LVW_TEST_LABEL_GRAPH").expect("LVW_TEST_LABEL_GRAPH"))
            .unwrap();
    let cases: Value = serde_json::from_slice(&json).unwrap();
    let case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "real")
        .unwrap();
    let mut graph = fixture::lvgl_fixture::graph(&json, "real");
    let middle = graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "app")
        .unwrap();
    middle.0.id = "middle".into();
    middle.0.role = ModuleRole::Lib;
    middle.0.interface.name = "middle".into();
    let contract = graph
        .profile
        .modules
        .iter_mut()
        .find(|item| item.id == "app")
        .unwrap();
    contract.id = "middle".into();
    contract.interface.name = "middle".into();
    let app_bytes = small_app(false);
    let app = inspect_wasm_facts(&app_bytes).unwrap();
    let i32_export = |name: &str, params: Vec<WasmValueType>| ModuleExport {
        name: name.into(),
        ty: ModuleExternalType::Function {
            params,
            results: vec![WasmValueType::I32],
        },
    };
    graph.modules.insert(
        0,
        (
            ModuleManifest {
                schema_version: 1,
                kind: "wasm-module".into(),
                id: "app".into(),
                role: ModuleRole::App,
                artifact: ModuleArtifact {
                    path: "app.wasm".into(),
                    sha256: app.sha256.clone(),
                },
                target: ModuleTarget {
                    abi: "wasip1".into(),
                    features: vec![],
                },
                interface: ModuleInterface {
                    name: "app".into(),
                    version: 1,
                },
                memory_model: "isolated".into(),
                requires: vec![ManifestRequirement {
                    provider: "middle".into(),
                    interface: "middle".into(),
                    version: 1,
                    imports: vec![],
                }],
                exports: vec![
                    i32_export("module_init", vec![]),
                    i32_export("module_close", vec![]),
                    i32_export("app_run", vec![WasmValueType::I32]),
                ],
                runtime_verification: "not-run".into(),
            },
            app_bytes,
        ),
    );
    graph.profile.modules.push(NumericModuleContract {
        id: "app".into(),
        sha256: app.sha256,
        interface: ModuleInterface {
            name: "app".into(),
            version: 1,
        },
        exports: Vec::<NumericFunctionContract>::new(),
    });
    let lvgl = fixture::lvgl_fixture::options();
    let label = fixture::options(case);
    let mut wasi = fixture::lvgl_fixture::wasi_fixture::options();
    wasi.output_fds.clear();
    let allowed = fixture::lvgl_fixture::features();
    let check = |consumer| {
        preflight_lvgl_label_graph_for_consumer(
            &graph.input(),
            &graph.profile,
            &allowed,
            &lvgl,
            Some(&wasi),
            &label,
            consumer,
        )
    };
    let report = check("middle").unwrap();
    assert_eq!(report.app_id(), "app");
    assert_eq!(report.graph().order(), ["lvcore", "middle", "app"]);
    for module in report.graph().modules() {
        assert_eq!(module.checks().engine(), ManifestCheck::Passed);
        assert_eq!(module.checks().runtime(), WasmCheck::NotRun);
        assert_eq!(module.checks().lifecycle(), WasmCheck::NotRun);
    }
    assert!(
        matches!(check("missing"), Err(NumericPreflightError::Numeric(message)) if message.contains("consumer is missing"))
    );
    assert!(
        matches!(check("lvcore"), Err(NumericPreflightError::Numeric(message)) if message.contains("core cannot"))
    );
    assert!(
        matches!(check("app"), Err(NumericPreflightError::Numeric(message)) if message.contains("requires owned exported memory"))
    );
    assert!(
        preflight_lvgl_label_graph(
            &graph.input(),
            &graph.profile,
            &allowed,
            &lvgl,
            Some(&wasi),
            &label
        )
        .is_err()
    );
    let app = graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "app")
        .unwrap();
    app.0.requires.push(ManifestRequirement {
        provider: label.id.clone(),
        interface: label.interface.name.clone(),
        version: label.interface.version,
        imports: vec![],
    });
    assert!(
        matches!(preflight_lvgl_label_graph_for_consumer(&graph.input(), &graph.profile, &allowed, &lvgl, Some(&wasi), &label, "middle"), Err(NumericPreflightError::Numeric(message)) if message == "LVGL label host is reserved for its consumer")
    );
    graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "app")
        .unwrap()
        .0
        .requires
        .pop();
    let middle = graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "middle")
        .unwrap();
    let core_requirement = middle
        .0
        .requires
        .iter()
        .position(|requirement| requirement.provider == "lvcore")
        .unwrap();
    let removed = middle.0.requires.remove(core_requirement);
    assert!(
        matches!(preflight_lvgl_label_graph_for_consumer(&graph.input(), &graph.profile, &allowed, &lvgl, Some(&wasi), &label, "middle"), Err(NumericPreflightError::Numeric(message)) if message.contains("consumer must depend"))
    );
    graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "middle")
        .unwrap()
        .0
        .requires
        .insert(core_requirement, removed);
    let contract = graph
        .profile
        .modules
        .iter_mut()
        .find(|item| item.id == "middle")
        .unwrap();
    let trusted_sha = std::mem::replace(&mut contract.sha256, "0".repeat(64));
    assert!(
        matches!(preflight_lvgl_label_graph_for_consumer(&graph.input(), &graph.profile, &allowed, &lvgl, Some(&wasi), &label, "middle"), Err(NumericPreflightError::Numeric(message)) if message.contains("identity is not authorized"))
    );
    graph
        .profile
        .modules
        .iter_mut()
        .find(|item| item.id == "middle")
        .unwrap()
        .sha256 = trusted_sha;
    let middle = graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "middle")
        .unwrap();
    let facts = inspect_wasm_facts(&middle.1).unwrap();
    let import = facts
        .imports
        .iter()
        .find(|item| item.module == "lvgl")
        .unwrap();
    let WasmExternal::Function { index, .. } = import.external else {
        panic!("expected function")
    };
    let ty = middle
        .0
        .requires
        .iter()
        .flat_map(|req| &req.imports)
        .find(|item| item.module == "lvgl" && item.name == import.name)
        .unwrap()
        .ty
        .clone();
    middle.1 = add_export(&middle.1, index);
    let hash = inspect_wasm_facts(&middle.1).unwrap().sha256;
    middle.0.artifact.sha256 = hash.clone();
    middle.0.exports.push(ModuleExport {
        name: "alias".into(),
        ty,
    });
    graph
        .profile
        .modules
        .iter_mut()
        .find(|item| item.id == "middle")
        .unwrap()
        .sha256 = hash;
    assert!(
        matches!(preflight_lvgl_label_graph_for_consumer(&graph.input(), &graph.profile, &allowed, &lvgl, Some(&wasi), &label, "middle"), Err(NumericPreflightError::Numeric(message)) if message.contains("label imports cannot be re-exported"))
    );
    // Replace the middle module with a valid owned-memory reactor that has no
    // label imports. Its declaration and host inventory still match its bytes.
    let middle = graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "middle")
        .unwrap();
    middle.1 = small_app(true);
    let facts = inspect_wasm_facts(&middle.1).unwrap();
    middle.0.artifact.sha256 = facts.sha256.clone();
    middle.0.target.features.clear();
    middle
        .0
        .requires
        .retain(|requirement| requirement.provider == "lvcore");
    middle.0.exports = vec![
        i32_export("module_init", vec![]),
        i32_export("module_close", vec![]),
        i32_export("app_run", vec![WasmValueType::I32]),
        ModuleExport {
            name: "memory".into(),
            ty: ModuleExternalType::Memory(facts.memories[0].ty),
        },
    ];
    graph
        .profile
        .modules
        .iter_mut()
        .find(|item| item.id == "middle")
        .unwrap()
        .sha256 = facts.sha256;
    graph
        .hosts
        .iter_mut()
        .find(|host| host.id == label.id)
        .unwrap()
        .exports
        .clear();
    assert!(
        matches!(preflight_lvgl_label_graph_for_consumer(&graph.input(), &graph.profile, &allowed, &lvgl, Some(&wasi), &label, "middle"), Err(NumericPreflightError::Numeric(message)) if message.contains("consumer must depend on its label host"))
    );
    graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "middle")
        .unwrap()
        .0
        .requires
        .push(ManifestRequirement {
            provider: label.id.clone(),
            interface: label.interface.name.clone(),
            version: label.interface.version,
            imports: vec![],
        });
    assert!(
        preflight_lvgl_label_graph_for_consumer(
            &graph.input(),
            &graph.profile,
            &allowed,
            &lvgl,
            Some(&wasi),
            &label,
            "middle"
        )
        .is_ok()
    );
}
