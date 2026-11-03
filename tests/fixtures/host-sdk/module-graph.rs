use liblvgl_wasm_host::{
    ModuleDeclaration, ModuleGraph, ModuleRole, WasmCheck, inspect_wasm_facts, order_module_graph,
};

fn main() {
    let graph = ModuleGraph {
        modules: vec![
            ModuleDeclaration {
                id: "app".into(),
                role: ModuleRole::App,
                requires: vec!["core".into()],
            },
            ModuleDeclaration {
                id: "core".into(),
                role: ModuleRole::Lib,
                requires: vec!["host".into()],
            },
        ],
        host_providers: vec!["host".into()],
    };
    assert_eq!(order_module_graph(&graph).unwrap(), ["core", "app"]);

    let mut args = std::env::args().skip(1);
    let bytes = std::fs::read(args.next().expect("core path")).unwrap();
    let expected_sha = args.next().expect("core SHA-256");
    let facts = inspect_wasm_facts(&bytes).unwrap();
    assert_eq!(facts.sha256, expected_sha);
    assert!(!facts.functions.is_empty());
    assert!(facts.exports.iter().any(|item| item.name == "lvw_init"));
    assert_eq!(facts.validation, WasmCheck::NotRun);
    assert_eq!(facts.feature_detection, WasmCheck::NotRun);
    assert_eq!(facts.abi_detection, WasmCheck::NotRun);
}
