use liblvgl_wasm_host::{
    FEATURE_POLICY, FEATURE_POLICY_VERSION, FeatureValidationCheck, IsolatedTopologyCheck,
    ManifestCheck, ManifestRequirement, ModuleArtifact, ModuleArtifactInput, ModuleDeclaration,
    ModuleExport, ModuleExternalType, ModuleGraph, ModuleHostProvider, ModuleImport,
    ModuleInterface, ModuleManifest, ModuleManifestInput, ModuleRole, ModuleTarget, WasiEvidence,
    WasmCheck, WasmExternal, WasmFacts, inspect_feature_module_graph, inspect_isolated_resources,
    inspect_module_manifests, inspect_wasi_preview1, inspect_wasm_facts, order_module_graph,
    validate_wasm_features,
};
use std::collections::BTreeMap;

fn descriptor(facts: &WasmFacts, external: WasmExternal) -> ModuleExternalType {
    match external {
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

fn inspect_real_graph(bytes: &[u8], facts: &WasmFacts, expected_sha: &str) {
    let mut providers: BTreeMap<(String, String), (String, ModuleExternalType)> = BTreeMap::new();
    let mut imports = Vec::new();
    for item in &facts.imports {
        let key = (item.module.clone(), item.name.clone());
        let ty = descriptor(facts, item.external);
        let next = format!("export.{}", providers.len());
        let entry = providers.entry(key).or_insert_with(|| (next, ty.clone()));
        assert_eq!(entry.1, ty, "duplicate import has conflicting types");
        imports.push(ModuleImport {
            module: item.module.clone(),
            name: item.name.clone(),
            provider_export: entry.0.clone(),
            ty,
        });
    }
    let exports = facts
        .exports
        .iter()
        .map(|item| ModuleExport {
            name: item.name.clone(),
            ty: descriptor(facts, item.external),
        })
        .collect();
    let allowed: Vec<&str> = FEATURE_POLICY.iter().map(|feature| feature.name).collect();
    let host = ModuleHostProvider {
        id: "host.real".into(),
        interface: ModuleInterface {
            name: "real".into(),
            version: 1,
        },
        exports: providers
            .into_values()
            .map(|(name, ty)| ModuleExport { name, ty })
            .collect(),
    };
    let input = ModuleManifestInput {
        modules: vec![ModuleArtifactInput {
            manifest: ModuleManifest {
                schema_version: 1,
                kind: "wasm-module".into(),
                id: "core".into(),
                role: ModuleRole::App,
                artifact: ModuleArtifact {
                    path: "core.wasm".into(),
                    sha256: expected_sha.into(),
                },
                target: ModuleTarget {
                    abi: "wasip1".into(),
                    features: allowed.iter().map(|name| (*name).into()).collect(),
                },
                interface: ModuleInterface {
                    name: "core".into(),
                    version: 1,
                },
                memory_model: "isolated".into(),
                requires: vec![ManifestRequirement {
                    provider: "host.real".into(),
                    interface: "real".into(),
                    version: 1,
                    imports,
                }],
                exports,
                runtime_verification: "not-run".into(),
            },
            bytes,
        }],
        hosts: vec![host],
    };
    let report = inspect_feature_module_graph(&input, &allowed).unwrap();
    assert_eq!(report.order(), ["core"]);
    assert_eq!(report.policy_version(), FEATURE_POLICY_VERSION);
    let item = &report.modules()[0];
    assert_eq!(item.sha256(), expected_sha);
    assert_eq!(item.wasi().sha256(), expected_sha);
    assert_eq!(item.isolated().sha256(), expected_sha);
    assert_eq!(item.checks().declaration(), ManifestCheck::Passed);
    assert_eq!(item.checks().identity(), ManifestCheck::Passed);
    assert_eq!(item.checks().interface(), ManifestCheck::Passed);
    assert_eq!(item.checks().feature(), FeatureValidationCheck::Passed);
    assert_eq!(
        item.checks().resource_topology(),
        IsolatedTopologyCheck::Passed
    );
    assert_eq!(item.checks().engine(), WasmCheck::NotRun);
    assert_eq!(item.checks().runtime(), WasmCheck::NotRun);
}

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
    let wasi = inspect_wasi_preview1(&bytes).unwrap();
    assert_eq!(wasi.sha256(), expected_sha);
    assert_eq!(wasi.checks().engine(), WasmCheck::NotRun);
    assert_eq!(wasi.checks().runtime(), WasmCheck::NotRun);
    let isolated = inspect_isolated_resources(&bytes).unwrap();
    assert_eq!(isolated.sha256(), expected_sha);
    assert_eq!(
        isolated.checks().resource_topology(),
        IsolatedTopologyCheck::Passed
    );
    assert_eq!(isolated.checks().engine(), WasmCheck::NotRun);
    assert_eq!(isolated.checks().wasi_abi(), WasmCheck::NotRun);
    inspect_real_graph(&bytes, &facts, &expected_sha);

    let empty = b"\0asm\x01\0\0\0";
    let feature = validate_wasm_features(empty, &[], &[]).unwrap();
    assert_eq!(feature.policy_version(), FEATURE_POLICY_VERSION);
    assert_eq!(feature.checks().feature(), FeatureValidationCheck::Passed);
    assert_eq!(feature.checks().engine(), WasmCheck::NotRun);
    assert!(validate_wasm_features(empty, &["simd"], &[]).is_err());
    let simd = b"\0asm\x01\0\0\0\x01\x05\x01\x60\0\x01\x7b\x03\x02\x01\0\x0a\x16\x01\x14\0\xfd\x0c\x01\0\0\0\x02\0\0\0\x03\0\0\0\x04\0\0\0\x0b";
    assert!(validate_wasm_features(simd, &["simd"], &["simd"]).is_ok());
    assert!(validate_wasm_features(simd, &[], &["simd"]).is_err());
    assert_eq!(
        inspect_wasi_preview1(empty).unwrap().evidence(),
        WasiEvidence::Absent
    );
    let input = ModuleManifestInput {
        modules: vec![ModuleArtifactInput {
            manifest: ModuleManifest {
                schema_version: 1,
                kind: "wasm-module".into(),
                id: "app".into(),
                role: ModuleRole::App,
                artifact: ModuleArtifact {
                    path: "app.wasm".into(),
                    sha256: "93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476"
                        .into(),
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
    assert_eq!(report.modules()[0].checks().engine(), ManifestCheck::NotRun);
    let graph = inspect_feature_module_graph(&input, &[]).unwrap();
    assert_eq!(graph.order(), ["app"]);
    assert_eq!(
        graph.modules()[0].sha256(),
        input.modules[0].manifest.artifact.sha256
    );
    assert_eq!(graph.modules()[0].checks().engine(), WasmCheck::NotRun);
    assert_eq!(graph.modules()[0].checks().runtime(), WasmCheck::NotRun);
}
