use liblvgl_wasm_host::{
    ManifestCheck, ManifestRequirement, ModuleArtifact, ModuleArtifactInput, ModuleExport,
    ModuleExternalType, ModuleHostProvider, ModuleImport, ModuleInterface, ModuleManifest,
    ModuleManifestInput, ModuleRole, ModuleTarget, WasmGlobalType, WasmMemoryType,
    WasmReferenceType, WasmTableType, WasmValueType, inspect_module_manifests,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn string(value: &Value) -> String {
    value.as_str().unwrap().to_owned()
}

fn number(value: &Value) -> u32 {
    value.as_u64().unwrap().try_into().unwrap()
}

fn optional_number(value: &Value) -> Option<u32> {
    if value.is_null() {
        None
    } else {
        Some(number(value))
    }
}

fn value_type(value: &Value) -> WasmValueType {
    match value.as_str().unwrap() {
        "i32" => WasmValueType::I32,
        "i64" => WasmValueType::I64,
        "f32" => WasmValueType::F32,
        "f64" => WasmValueType::F64,
        "v128" => WasmValueType::V128,
        "funcref" => WasmValueType::FuncRef,
        "externref" => WasmValueType::ExternRef,
        value => panic!("invalid fixture value type {value:?}"),
    }
}

fn ty(value: &Value) -> ModuleExternalType {
    let values = |name: &str| {
        value[name]
            .as_array()
            .unwrap()
            .iter()
            .map(value_type)
            .collect()
    };
    match value["kind"].as_str().unwrap() {
        "function" => ModuleExternalType::Function {
            params: values("params"),
            results: values("results"),
        },
        "tag" => ModuleExternalType::Tag {
            params: values("params"),
            results: values("results"),
        },
        "table" => ModuleExternalType::Table(WasmTableType {
            element: match value["element"].as_str().unwrap() {
                "funcref" => WasmReferenceType::FuncRef,
                "externref" => WasmReferenceType::ExternRef,
                name => panic!("invalid fixture reference {name:?}"),
            },
            minimum: number(&value["minimum"]),
            maximum: optional_number(&value["maximum"]),
        }),
        "memory" => ModuleExternalType::Memory(WasmMemoryType {
            minimum_pages: number(&value["minimumPages"]),
            maximum_pages: optional_number(&value["maximumPages"]),
            shared: value["shared"].as_bool().unwrap(),
        }),
        "global" => ModuleExternalType::Global(WasmGlobalType {
            value: value_type(&value["value"]),
            mutable: value["mutable"].as_bool().unwrap(),
        }),
        kind => panic!("invalid fixture kind {kind:?}"),
    }
}

fn interface(value: &Value) -> ModuleInterface {
    ModuleInterface {
        name: string(&value["name"]),
        version: number(&value["version"]),
    }
}

fn exports(value: &Value) -> Vec<ModuleExport> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| ModuleExport {
            name: string(&item["name"]),
            ty: ty(item),
        })
        .collect()
}

fn manifest(value: &Value) -> ModuleManifest {
    ModuleManifest {
        schema_version: number(&value["schema_version"]),
        kind: string(&value["kind"]),
        id: string(&value["id"]),
        role: match value["role"].as_str().unwrap() {
            "lib" => ModuleRole::Lib,
            "app" => ModuleRole::App,
            role => panic!("invalid role {role:?}"),
        },
        artifact: ModuleArtifact {
            path: string(&value["artifact"]["path"]),
            sha256: string(&value["artifact"]["sha256"]),
        },
        target: ModuleTarget {
            abi: string(&value["target"]["abi"]),
            features: value["target"]["features"]
                .as_array()
                .unwrap()
                .iter()
                .map(string)
                .collect(),
        },
        interface: interface(&value["interface"]),
        memory_model: string(&value["memory_model"]),
        requires: value["requires"]
            .as_array()
            .unwrap()
            .iter()
            .map(|requirement| ManifestRequirement {
                provider: string(&requirement["provider"]),
                interface: string(&requirement["interface"]),
                version: number(&requirement["version"]),
                imports: requirement["imports"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| ModuleImport {
                        module: string(&item["module"]),
                        name: string(&item["name"]),
                        provider_export: string(&item["provider_export"]),
                        ty: ty(item),
                    })
                    .collect(),
            })
            .collect(),
        exports: exports(&value["exports"]),
        runtime_verification: string(&value["runtime_verification"]),
    }
}

fn hex(value: &Value) -> Vec<u8> {
    value
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn check_case(value: &Value, accepted: bool, name: &str) {
    let records = value["modules"].as_array().unwrap();
    let binaries: Vec<_> = records.iter().map(|item| hex(&item["hex"])).collect();
    let input = ModuleManifestInput {
        modules: records
            .iter()
            .zip(&binaries)
            .map(|(item, bytes)| ModuleArtifactInput {
                manifest: manifest(&item["manifest"]),
                bytes,
            })
            .collect(),
        hosts: value["hosts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|host| ModuleHostProvider {
                id: string(&host["id"]),
                interface: interface(&host["interface"]),
                exports: exports(&host["exports"]),
            })
            .collect(),
    };
    let result = inspect_module_manifests(&input);
    if !accepted {
        assert!(result.is_err(), "{name}: unexpectedly accepted");
        return;
    }
    let report = result.unwrap_or_else(|error| panic!("{name}: {error}"));
    let expected: &[&str] = if input.modules.len() == 1 {
        &["app"]
    } else {
        &["core", "widgets", "app"]
    };
    assert_eq!(report.order(), expected, "{name}");
    for module in report.modules() {
        let checks = module.checks();
        assert_eq!(checks.declaration(), ManifestCheck::Passed, "{name}");
        assert_eq!(checks.identity(), ManifestCheck::Passed, "{name}");
        assert_eq!(checks.interface(), ManifestCheck::Passed, "{name}");
        assert_eq!(checks.engine(), ManifestCheck::NotRun, "{name}");
        assert_eq!(checks.feature(), ManifestCheck::NotRun, "{name}");
        assert_eq!(checks.abi(), ManifestCheck::NotRun, "{name}");
        assert_eq!(checks.memory_isolation(), ManifestCheck::NotRun, "{name}");
        assert_eq!(
            checks.host_implementation(),
            ManifestCheck::NotRun,
            "{name}"
        );
        assert_eq!(checks.runtime(), ManifestCheck::NotRun, "{name}");
        assert_eq!(
            module.facts().sha256,
            input
                .modules
                .iter()
                .find(|item| item.manifest.id == module.id())
                .unwrap()
                .manifest
                .artifact
                .sha256,
            "{name}"
        );
    }
}

#[test]
fn shared_manifest_cases() {
    let directory = env::var_os("LVW_TEST_MODULE_MANIFEST_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/fixtures/module-manifest/cases.json")
        });
    let cases: Value = serde_json::from_slice(&fs::read(directory).unwrap()).unwrap();
    for case in cases.as_array().unwrap() {
        check_case(
            &case["input"],
            case["accepted"].as_bool().unwrap(),
            case["name"].as_str().unwrap(),
        );
    }
}

#[test]
fn real_manifest_case() {
    let Some(path) = env::var_os("LVW_TEST_MODULE_MANIFEST_REAL") else {
        return;
    };
    let input: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    check_case(&input, true, "real manifest");
}

fn empty_manifest(id: &str, bytes: &[u8]) -> ModuleManifest {
    ModuleManifest {
        schema_version: 1,
        kind: "wasm-module".into(),
        id: id.into(),
        role: ModuleRole::App,
        artifact: ModuleArtifact {
            path: "app.wasm".into(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
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
    }
}

fn empty_host(id: &str) -> ModuleHostProvider {
    ModuleHostProvider {
        id: id.into(),
        interface: ModuleInterface {
            name: "h".into(),
            version: 1,
        },
        exports: Vec::new(),
    }
}

fn limit_error(input: &ModuleManifestInput<'_>, resource: &str) {
    let error = inspect_module_manifests(input).unwrap_err().to_string();
    assert!(
        error.contains(&format!("inspection limit: {resource}")),
        "{error}"
    );
}

#[test]
fn manifest_declaration_budget_boundaries() {
    let binary = b"\0asm\x01\0\0\0";
    let mut input = ModuleManifestInput {
        modules: vec![ModuleArtifactInput {
            manifest: empty_manifest("app", binary),
            bytes: binary,
        }],
        hosts: (0..255)
            .map(|index| empty_host(&format!("host.{index}")))
            .collect(),
    };
    assert!(inspect_module_manifests(&input).is_ok());
    input.hosts.push(empty_host("host.extra"));
    limit_error(&input, "providers");

    input.hosts = vec![empty_host("h")];
    input.modules[0].manifest.requires = vec![
        ManifestRequirement {
            provider: "h".into(),
            interface: "h".into(),
            version: 1,
            imports: Vec::new()
        };
        99_998
    ];
    assert!(inspect_module_manifests(&input).is_ok());
    input.modules[0]
        .manifest
        .requires
        .push(ManifestRequirement {
            provider: "h".into(),
            interface: "h".into(),
            version: 1,
            imports: Vec::new(),
        });
    limit_error(&input, "entries");

    input.hosts.clear();
    input.modules[0].manifest.requires.clear();
    // The id, SHA-256 and interface account for 70 UTF-16 units.
    input.modules[0].manifest.artifact.path = "😀".repeat(2_097_117);
    assert!(inspect_module_manifests(&input).is_ok());
    input.modules[0].manifest.artifact.path.push('a');
    limit_error(&input, "string units");
}

fn leb(mut n: usize) -> Vec<u8> {
    let mut output = Vec::new();
    loop {
        let byte = (n & 127) as u8;
        n >>= 7;
        output.push(byte | if n == 0 { 0 } else { 128 });
        if n == 0 {
            return output;
        }
    }
}

fn types_module(count: usize) -> Vec<u8> {
    let mut section = leb(count);
    for _ in 0..count {
        section.extend([0x60, 0, 0]);
    }
    let mut bytes = b"\0asm\x01\0\0\0".to_vec();
    bytes.push(1);
    bytes.extend(leb(section.len()));
    bytes.extend(section);
    bytes
}

#[test]
fn manifest_fact_budget_is_separate_from_declaration_budget() {
    let binary = types_module(50_000);
    let mut first = empty_manifest("first", &binary);
    first.role = ModuleRole::Lib;
    let input = ModuleManifestInput {
        modules: vec![
            ModuleArtifactInput {
                manifest: first.clone(),
                bytes: &binary,
            },
            ModuleArtifactInput {
                manifest: empty_manifest("app", &binary),
                bytes: &binary,
            },
        ],
        hosts: Vec::new(),
    };
    assert!(inspect_module_manifests(&input).is_ok());
    let extra = types_module(1);
    let mut second = empty_manifest("second", &extra);
    second.role = ModuleRole::Lib;
    let over = ModuleManifestInput {
        modules: vec![
            ModuleArtifactInput {
                manifest: first,
                bytes: &binary,
            },
            ModuleArtifactInput {
                manifest: empty_manifest("app", &binary),
                bytes: &binary,
            },
            ModuleArtifactInput {
                manifest: second,
                bytes: &extra,
            },
        ],
        hosts: Vec::new(),
    };
    limit_error(&over, "total Wasm facts");
}

#[test]
fn manifest_byte_budget_boundaries() {
    let size = 64 * 1024 * 1024;
    let mut binary = vec![0; size];
    binary[..8].copy_from_slice(b"\0asm\x01\0\0\0");
    let mut payload = size - 9;
    while payload + leb(payload).len() != size - 9 {
        payload -= 1;
    }
    let length = leb(payload);
    binary[9..9 + length.len()].copy_from_slice(&length);
    let mut first = empty_manifest("first", &binary);
    first.role = ModuleRole::Lib;
    let app = empty_manifest("app", &binary);
    let input = ModuleManifestInput {
        modules: vec![
            ModuleArtifactInput {
                manifest: first.clone(),
                bytes: &binary,
            },
            ModuleArtifactInput {
                manifest: app.clone(),
                bytes: &binary,
            },
        ],
        hosts: Vec::new(),
    };
    assert!(inspect_module_manifests(&input).is_ok());
    let extra = b"\0asm\x01\0\0\0";
    let mut second = empty_manifest("second", extra);
    second.role = ModuleRole::Lib;
    let over = ModuleManifestInput {
        modules: vec![
            ModuleArtifactInput {
                manifest: first,
                bytes: &binary,
            },
            ModuleArtifactInput {
                manifest: app.clone(),
                bytes: &binary,
            },
            ModuleArtifactInput {
                manifest: second,
                bytes: extra,
            },
        ],
        hosts: Vec::new(),
    };
    limit_error(&over, "total bytes");
    let too_large = vec![0; size + 1];
    let over = ModuleManifestInput {
        modules: vec![ModuleArtifactInput {
            manifest: app,
            bytes: &too_large,
        }],
        hosts: Vec::new(),
    };
    limit_error(&over, "input bytes");
}

#[test]
fn report_retains_facts_after_input_is_dropped_and_bytes_change() {
    let mut bytes = b"\0asm\x01\0\0\0".to_vec();
    let expected = format!("{:x}", Sha256::digest(&bytes));
    let report = {
        let input = ModuleManifestInput {
            modules: vec![ModuleArtifactInput {
                manifest: empty_manifest("app", &bytes),
                bytes: &bytes,
            }],
            hosts: Vec::new(),
        };
        inspect_module_manifests(&input).unwrap()
    };
    bytes.fill(0);
    assert_eq!(report.modules()[0].facts().sha256, expected);
    assert!(report.modules()[0].facts().imports.is_empty());
    assert_eq!(report.modules()[0].checks().engine(), ManifestCheck::NotRun);
}

#[test]
fn many_repeated_imports_preserve_occurrences() {
    let count = 2_900;
    let width = 32;
    let mut types = vec![1, 0x60];
    types.extend(leb(width));
    types.resize(types.len() + width, 0x7f);
    types.push(0);
    let mut imports = leb(count);
    for _ in 0..count {
        imports.extend([3, b'e', b'n', b'v', 1, b'f', 0, 0]);
    }
    let mut bytes = b"\0asm\x01\0\0\0".to_vec();
    for (id, payload) in [(1, types), (2, imports)] {
        bytes.push(id);
        bytes.extend(leb(payload.len()));
        bytes.extend(payload);
    }
    let ty = ModuleExternalType::Function {
        params: vec![WasmValueType::I32; width],
        results: Vec::new(),
    };
    let declaration = ModuleImport {
        module: "env".into(),
        name: "f".into(),
        provider_export: "f".into(),
        ty: ty.clone(),
    };
    let mut manifest = empty_manifest("app", &bytes);
    manifest.requires.push(ManifestRequirement {
        provider: "host".into(),
        interface: "h".into(),
        version: 1,
        imports: vec![declaration; count],
    });
    let input = &mut ModuleManifestInput {
        modules: vec![ModuleArtifactInput {
            manifest,
            bytes: &bytes,
        }],
        hosts: vec![ModuleHostProvider {
            id: "host".into(),
            interface: ModuleInterface {
                name: "h".into(),
                version: 1,
            },
            exports: vec![ModuleExport {
                name: "f".into(),
                ty,
            }],
        }],
    };
    let report = inspect_module_manifests(input).unwrap();
    assert_eq!(report.modules()[0].facts().imports.len(), count);
    input.modules[0].manifest.requires[0].imports.pop();
    assert!(inspect_module_manifests(input).is_err());
}
