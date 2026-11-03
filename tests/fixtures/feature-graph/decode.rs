use liblvgl_wasm_host::{
    ManifestRequirement, ModuleArtifact, ModuleExport, ModuleExternalType, ModuleImport,
    ModuleInterface, ModuleManifest, ModuleRole, ModuleTarget, WasmGlobalType, WasmMemoryType,
    WasmReferenceType, WasmTableType, WasmValueType,
};
use serde_json::Value;

pub fn string(value: &Value) -> String {
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

pub fn interface(value: &Value) -> ModuleInterface {
    ModuleInterface {
        name: string(&value["name"]),
        version: number(&value["version"]),
    }
}

pub fn exports(value: &Value) -> Vec<ModuleExport> {
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

pub fn manifest(value: &Value) -> ModuleManifest {
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

pub fn hex(value: &Value) -> Vec<u8> {
    value
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
