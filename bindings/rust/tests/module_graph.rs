use liblvgl_wasm_host::{
    ModuleDeclaration, ModuleGraph, ModuleGraphError, ModuleRole, order_module_graph,
};
use serde_json::Value;
use std::{env, fs, path::PathBuf};

fn fixture_path() -> PathBuf {
    env::var_os("LVW_TEST_MODULE_GRAPH_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/fixtures/module-graph/cases.json")
        })
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect()
}

fn error_category(error: &ModuleGraphError) -> &'static str {
    match error {
        ModuleGraphError::InvalidHostId => "Invalid host provider ID",
        ModuleGraphError::InvalidModuleId => "Invalid module ID",
        ModuleGraphError::InvalidProviderId { .. } => "Invalid provider ID",
        ModuleGraphError::DuplicateProvider { .. } => "Duplicate provider ID",
        ModuleGraphError::SelfDependency { .. } => "Self dependency",
        ModuleGraphError::MissingProvider { .. } => "Missing provider",
        ModuleGraphError::AppProvider { .. } => "App cannot be a provider",
        ModuleGraphError::Cycle { .. } => "Library dependency cycle",
        ModuleGraphError::Limit { .. } => "Resource limit",
    }
}

#[test]
fn shared_module_graph_cases() {
    let cases: Value = serde_json::from_slice(&fs::read(fixture_path()).unwrap()).unwrap();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let modules: Vec<ModuleDeclaration> = case["modules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|module| ModuleDeclaration {
                id: module["id"].as_str().unwrap().to_owned(),
                role: match module["role"].as_str().unwrap() {
                    "lib" => ModuleRole::Lib,
                    "app" => ModuleRole::App,
                    role => panic!("{name}: unknown fixture role {role:?}"),
                },
                requires: module["requires"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|requirement| requirement["provider"].as_str().unwrap().to_owned())
                    .collect(),
            })
            .collect();
        let mut inputs = vec![modules.clone()];
        if case["permutations"].as_bool().unwrap_or(false) {
            for offset in 0..modules.len() {
                let mut rotated = modules.clone();
                rotated.rotate_left(offset);
                inputs.push(rotated.clone());
                rotated.reverse();
                inputs.push(rotated);
            }
        }
        for modules in inputs {
            let graph = ModuleGraph {
                modules,
                host_providers: strings(&case["hostProviders"]),
            };
            let result = order_module_graph(&graph);
            if let Some(expected) = case["error"].as_str() {
                let error = result.expect_err(name);
                assert!(
                    expected.starts_with(error_category(&error)),
                    "{name}: {error:?}"
                );
                if let Some(cycle) = case.get("cycle") {
                    match error {
                        ModuleGraphError::Cycle { path } => {
                            assert_eq!(path, strings(cycle), "{name}")
                        }
                        other => panic!("{name}: expected a cycle, got {other:?}"),
                    }
                }
            } else {
                assert_eq!(result.unwrap(), strings(&case["order"]), "{name}");
            }
        }
    }
}

#[test]
fn errors_preserve_ids_and_escape_diagnostics() {
    let graph = ModuleGraph {
        modules: vec![ModuleDeclaration {
            id: "a -> b\nline".into(),
            role: ModuleRole::Lib,
            requires: vec!["missing\nnext".into()],
        }],
        host_providers: Vec::new(),
    };
    let error = order_module_graph(&graph).unwrap_err();
    assert_eq!(
        error,
        ModuleGraphError::MissingProvider {
            module: "a -> b\nline".into(),
            provider: "missing\nnext".into(),
        }
    );
    let message = error.to_string();
    assert!(!message.contains('\n'));
    assert!(message.contains("a -> b\\nline"));
    assert!(message.contains("missing\\nnext"));
}

#[test]
fn provider_count_limit_includes_hosts_and_modules() {
    let mut graph = ModuleGraph {
        modules: vec![ModuleDeclaration {
            id: "app".into(),
            role: ModuleRole::App,
            requires: Vec::new(),
        }],
        host_providers: (0..255).map(|index| format!("host.{index}")).collect(),
    };
    assert_eq!(order_module_graph(&graph).unwrap(), ["app"]);
    graph.host_providers.push("host.extra".into());
    assert_eq!(
        order_module_graph(&graph),
        Err(ModuleGraphError::Limit {
            resource: "providers"
        })
    );
}

#[test]
fn entry_limit_counts_repeated_host_requirements() {
    let mut graph = ModuleGraph {
        modules: vec![ModuleDeclaration {
            id: "app".into(),
            role: ModuleRole::App,
            requires: vec!["h".into(); 99_998],
        }],
        host_providers: vec!["h".into()],
    };
    assert_eq!(order_module_graph(&graph).unwrap(), ["app"]);
    graph.modules[0].requires.push("h".into());
    assert_eq!(
        order_module_graph(&graph),
        Err(ModuleGraphError::Limit {
            resource: "entries"
        })
    );
}

#[test]
fn string_limit_counts_utf16_units_across_all_ids() {
    let mut id = "😀".repeat(2_097_150);
    id.push_str("xy");
    let mut graph = ModuleGraph {
        modules: vec![ModuleDeclaration {
            id,
            role: ModuleRole::App,
            requires: vec!["h".into()],
        }],
        host_providers: vec!["h".into()],
    };
    let order = order_module_graph(&graph).unwrap();
    assert_eq!(order.len(), 1);
    assert_eq!(order[0], graph.modules[0].id);
    graph.modules[0].id.push('z');
    assert_eq!(
        order_module_graph(&graph),
        Err(ModuleGraphError::Limit {
            resource: "string units"
        })
    );
}
