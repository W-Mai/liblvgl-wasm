#[path = "../../../tests/fixtures/host-sdk/event-lib-preflight.rs"]
#[allow(dead_code)]
mod real;
use real::fixture;

use liblvgl_wasm_host::{
    ManifestCheck, ManifestRequirement, ModuleArtifact, ModuleExport, ModuleExternalType,
    ModuleImport, ModuleInterface, ModuleManifest, ModuleRole, ModuleTarget, NumericHostBinding,
    NumericModuleContract, NumericPreflightError, WasmCheck, WasmExternal, WasmValueType,
    inspect_wasm_facts, load_lvgl_event_environment, preflight_lvgl_event_graph_for_consumer,
};
use serde_json::Value;

type Graph = fixture::lvgl_fixture::wasi_fixture::numeric::Fixture;

fn leb(mut value: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        let next = (value & 127) as u8;
        value >>= 7;
        bytes.push(next | if value == 0 { 0 } else { 128 });
        if value == 0 {
            return bytes;
        }
    }
}
fn section(bytes: &mut Vec<u8>, id: u8, body: &[u8]) {
    bytes.push(id);
    bytes.extend(leb(body.len()));
    bytes.extend(body);
}

fn read_leb(bytes: &[u8], position: &mut usize) -> usize {
    let mut value = 0;
    let mut shift = 0;
    loop {
        let next = bytes[*position];
        *position += 1;
        value |= usize::from(next & 127) << shift;
        if next & 128 == 0 {
            return value;
        }
        shift += 7;
    }
}

fn alias_export(bytes: &[u8], index: u32) -> Vec<u8> {
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
            let mut body = [leb(count + 1), body[start..].to_vec()].concat();
            body.extend([13]);
            body.extend(b"managed_alias");
            body.push(0);
            body.extend(leb(index as usize));
            section(&mut output, id, &body);
        } else {
            section(&mut output, id, body);
        }
    }
    output
}

// Every lifecycle entry traps if executed; preflight must only compile it.
fn small_module(table: Option<u8>, import: Option<&str>) -> Vec<u8> {
    let mut bytes = b"\0asm\x01\0\0\0".to_vec();
    section(
        &mut bytes,
        1,
        &[
            3, 0x60, 0, 1, 0x7f, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 0,
        ],
    );
    if let Some(name) = import {
        let mut body = vec![1, 6];
        body.extend(b"middle");
        body.extend(leb(name.len()));
        body.extend(name.as_bytes());
        body.extend([0, 2]);
        section(&mut bytes, 2, &body);
    }
    section(
        &mut bytes,
        3,
        if table.is_some() {
            &[4, 0, 0, 1, 2]
        } else {
            &[3, 0, 0, 1]
        },
    );
    if let Some(element) = table {
        section(&mut bytes, 4, &[1, element, 1, 1, 1]);
    }
    section(&mut bytes, 5, &[1, 1, 1, 2]);
    let mut exports = vec![if table.is_some() { 5 } else { 4 }];
    for (index, name) in ["module_init", "module_close", "app_run"]
        .into_iter()
        .enumerate()
    {
        exports.extend(leb(name.len()));
        exports.extend(name.as_bytes());
        exports.extend([0, index as u8 + u8::from(import.is_some())]);
    }
    exports.extend([6]);
    exports.extend(b"memory");
    exports.extend([2, 0]);
    if table.is_some() {
        exports.extend([18]);
        exports.extend(b"app_event_dispatch");
        exports.extend([0, 3 + u8::from(import.is_some())]);
    }
    section(&mut bytes, 7, &exports);
    let mut code = vec![
        if table.is_some() { 4 } else { 3 },
        3,
        0,
        0,
        0x0b,
        3,
        0,
        0,
        0x0b,
        3,
        0,
        0,
        0x0b,
    ];
    if table.is_some() {
        code.extend([2, 0, 0x0b]);
    }
    section(&mut bytes, 10, &code);
    bytes
}

fn exports(bytes: &[u8]) -> Vec<ModuleExport> {
    let facts = inspect_wasm_facts(bytes).unwrap();
    facts
        .exports
        .iter()
        .map(|item| ModuleExport {
            name: item.name.clone(),
            ty: match item.external {
                WasmExternal::Function { type_index, .. } => ModuleExternalType::Function {
                    params: facts.types[type_index as usize].params.clone(),
                    results: facts.types[type_index as usize].results.clone(),
                },
                WasmExternal::Memory { ty, .. } => ModuleExternalType::Memory(ty),
                WasmExternal::Table { ty, .. } => ModuleExternalType::Table(ty),
                _ => panic!("unexpected test export"),
            },
        })
        .collect()
}

fn library_graph(json: &[u8], name: &str, import: Option<&str>) -> Graph {
    let mut graph = fixture::lvgl_fixture::graph(json, name);
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
        .find(|module| module.id == "app")
        .unwrap();
    contract.id = "middle".into();
    contract.interface.name = "middle".into();
    let bytes = small_module(None, import);
    let facts = inspect_wasm_facts(&bytes).unwrap();
    let interface = ModuleInterface {
        name: "app".into(),
        version: 1,
    };
    graph.modules.push((
        ModuleManifest {
            schema_version: 1,
            kind: "wasm-module".into(),
            id: "app".into(),
            role: ModuleRole::App,
            artifact: ModuleArtifact {
                path: "entry.wasm".into(),
                sha256: facts.sha256.clone(),
            },
            target: ModuleTarget {
                abi: "wasip1".into(),
                features: vec![],
            },
            interface: interface.clone(),
            memory_model: "isolated".into(),
            runtime_verification: "not-run".into(),
            requires: vec![ManifestRequirement {
                provider: "middle".into(),
                interface: "middle".into(),
                version: 1,
                imports: import
                    .map(|name| {
                        vec![ModuleImport {
                            module: "middle".into(),
                            name: name.into(),
                            provider_export: name.into(),
                            ty: ModuleExternalType::Function {
                                params: vec![WasmValueType::I32; 2],
                                results: vec![],
                            },
                        }]
                    })
                    .unwrap_or_default(),
            }],
            exports: exports(&bytes),
        },
        bytes,
    ));
    graph.profile.modules.push(NumericModuleContract {
        id: "app".into(),
        interface,
        sha256: facts.sha256,
        exports: vec![],
    });
    graph.profile.limits.max_total_memory_pages += 2;
    graph
}

fn check(
    graph: &Graph,
    case: &Value,
    consumer: &str,
) -> Result<liblvgl_wasm_host::NumericPreflightReport, NumericPreflightError> {
    let allowed: Vec<_> = case["allowedFeatures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap())
        .collect();
    let wasi = case["wasi"]
        .as_bool()
        .unwrap_or(false)
        .then(fixture::lvgl_fixture::wasi_fixture::options);
    preflight_lvgl_event_graph_for_consumer(
        &graph.input(),
        &graph.profile,
        &allowed,
        &fixture::lvgl_fixture::options(),
        wasi.as_ref(),
        &fixture::options(case),
        &real::options(case),
        consumer,
    )
}

#[test]
fn official_c_library_event_graph_is_compiled_without_guest_execution() {
    let bytes = std::fs::read(
        std::env::var_os("LVW_TEST_EVENT_LIB_GRAPH").expect("LVW_TEST_EVENT_LIB_GRAPH"),
    )
    .unwrap();
    real::preflight(&bytes);
}

#[test]
fn shared_event_cases_keep_their_boundaries_when_the_consumer_is_a_library() {
    let bytes =
        std::fs::read(std::env::var_os("LVW_TEST_EVENT_GRAPH").expect("LVW_TEST_EVENT_GRAPH"))
            .unwrap();
    let cases: Value = serde_json::from_slice(&bytes).unwrap();
    let mut observed = 0;
    for case in cases
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["name"] != "real")
    {
        let name = case["name"].as_str().unwrap();
        let graph = library_graph(&bytes, name, None);
        let result = check(&graph, case, "middle");
        if case["pass"].as_bool().unwrap() {
            let report = result.unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(report.app_id(), "app");
            assert_eq!(report.graph().order(), ["lvcore", "middle", "app"]);
            for module in report.graph().modules() {
                assert_eq!(module.checks().engine(), ManifestCheck::Passed);
                assert_eq!(module.checks().runtime(), WasmCheck::NotRun);
                assert_eq!(module.checks().lifecycle(), WasmCheck::NotRun);
                assert_eq!(module.checks().host_implementation(), WasmCheck::NotRun);
            }
        } else {
            assert!(result.is_err(), "{name}: rejection was lost");
        }
        observed += 1;
    }
    assert!(observed > 30);
}

#[test]
fn selected_owner_table_aliases_and_loading_are_checked_before_hosts() {
    let bytes =
        std::fs::read(std::env::var_os("LVW_TEST_EVENT_GRAPH").expect("LVW_TEST_EVENT_GRAPH"))
            .unwrap();
    let cases: Value = serde_json::from_slice(&bytes).unwrap();
    let case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "synthetic")
        .unwrap();
    let mut graph = library_graph(&bytes, "synthetic", None);
    assert!(check(&graph, case, "missing").is_err());
    assert!(check(&graph, case, "lvcore").is_err());
    assert!(check(&graph, case, "app").is_err());
    let mut reexport = library_graph(&bytes, "synthetic", None);
    let original = &reexport
        .modules
        .iter()
        .find(|(manifest, _)| manifest.id == "middle")
        .unwrap()
        .1;
    let facts = inspect_wasm_facts(original).unwrap();
    let getter = facts
        .imports
        .iter()
        .find(|item| item.module == "lvgl" && item.name == "lv_event_get_code")
        .unwrap();
    let WasmExternal::Function { index, .. } = getter.external else {
        panic!("event getter is not a function")
    };
    let aliased = alias_export(original, index);
    let declarations = exports(&aliased);
    reexport.replace("middle", aliased);
    reexport
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "middle")
        .unwrap()
        .0
        .exports = declarations;
    assert!(
        matches!(check(&reexport, case, "middle"), Err(NumericPreflightError::Numeric(message))
        if message == "LVGL label imports cannot be re-exported")
    );
    let mut alias = library_graph(&bytes, "dispatch-alias", Some("dispatch_alias"));
    alias
        .profile
        .modules
        .iter_mut()
        .find(|module| module.id == "middle")
        .unwrap()
        .exports
        .clear();
    assert!(
        matches!(check(&alias, case, "middle"), Err(NumericPreflightError::Numeric(message))
        if message == "LVGL event dispatcher cannot be imported")
    );
    let mut external = library_graph(&bytes, "synthetic", None);
    let module = small_module(Some(0x6f), None);
    external.replace("middle", module.clone());
    let manifest = &mut external
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "middle")
        .unwrap()
        .0;
    manifest.exports = exports(&module);
    for requirement in &mut manifest.requires {
        requirement.imports.clear();
    }
    assert!(
        matches!(check(&external, case, "middle"), Err(NumericPreflightError::Numeric(message))
        if message == "LVGL event consumer requires a function table")
    );
    let trace = fixture::lvgl_fixture::wasi_fixture::numeric::Trace::default();
    let mut factory = fixture::lvgl_fixture::wasi_fixture::numeric::TraceFactory(trace.clone());
    let mut hosts = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    graph
        .modules
        .iter_mut()
        .find(|(manifest, _)| manifest.id == "app")
        .unwrap()
        .0
        .requires
        .push(ManifestRequirement {
            provider: "lvcore".into(),
            interface: "lvcore".into(),
            version: 1,
            imports: vec![],
        });
    let error = load_lvgl_event_environment(
        &graph.input(),
        &graph.profile,
        &[],
        &mut hosts,
        &fixture::lvgl_fixture::options(),
        &fixture::options(case),
        &real::options(case),
        None,
    )
    .expect_err("default loader must keep the app contract");
    assert!(
        error.to_string().contains("missing app_event_dispatch"),
        "{error}"
    );
    assert!(trace.environments.lock().unwrap().is_empty());
    assert!(trace.events.lock().unwrap().is_empty());
}
