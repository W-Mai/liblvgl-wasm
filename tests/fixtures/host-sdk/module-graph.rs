use liblvgl_wasm_host::{
    ManifestCheck, ModuleArtifact, ModuleArtifactInput, ModuleDeclaration, ModuleGraph,
    ModuleInterface, ModuleManifest, ModuleManifestInput, ModuleRole, ModuleTarget, WasmCheck,
    inspect_module_manifests, inspect_wasm_facts, order_module_graph,
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

    let empty = b"\0asm\x01\0\0\0";
    let input = ModuleManifestInput {
        modules: vec![ModuleArtifactInput {
            manifest: ModuleManifest {
                schema_version: 1,
                kind: "wasm-module".into(),
                id: "app".into(),
                role: ModuleRole::App,
                artifact: ModuleArtifact {
                    path: "app.wasm".into(),
                    sha256: "93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476".into(),
                },
                target: ModuleTarget {
                    abi: "wasip1".into(),
                    features: Vec::new(),
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
            bytes: empty,
        }],
        hosts: Vec::new(),
    };
    let report = inspect_module_manifests(&input).unwrap();
    assert_eq!(report.order(), ["app"]);
    assert_eq!(
        report.modules()[0].checks().identity(),
        ManifestCheck::Passed
    );
    assert_eq!(
        report.modules()[0].checks().engine(),
        ManifestCheck::NotRun
    );
}
