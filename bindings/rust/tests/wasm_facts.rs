use liblvgl_wasm_host::{
    WasmCheck, WasmExternal, WasmFacts, WasmGlobalType, WasmMemoryType, WasmReferenceType,
    WasmTableType, WasmValueType, inspect_wasm_facts,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn fixture_dir() -> PathBuf {
    env::var_os("LVW_TEST_WASM_FACTS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/wasm-facts")
        })
}

fn leb(mut value: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        bytes.push(byte | if value == 0 { 0 } else { 0x80 });
        if value == 0 {
            return bytes;
        }
    }
}

fn section(id: u8, payload: &[u8]) -> Vec<u8> {
    let mut result = b"\0asm\x01\0\0\0".to_vec();
    result.push(id);
    result.extend(leb(payload.len()));
    result.extend(payload);
    result
}

fn bytes(case: &Value) -> Vec<u8> {
    if let Some(hex) = case["hex"].as_str() {
        return hex
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect();
    }
    let count = case["count"].as_u64().unwrap() as usize;
    match case["recipe"].as_str().unwrap() {
        "parameters" => {
            let mut payload = vec![1, 0x60];
            payload.extend(leb(count));
            payload.resize(payload.len() + count, 0x7f);
            payload.push(0);
            section(1, &payload)
        }
        "cumulative-parameters" => {
            let mut payload = vec![2];
            for _ in 0..2 {
                payload.push(0x60);
                payload.extend(leb(count));
                payload.resize(payload.len() + count, 0x7f);
                payload.push(0);
            }
            section(1, &payload)
        }
        "name" => {
            let mut payload = leb(count);
            payload.resize(payload.len() + count, b'a');
            section(0, &payload)
        }
        "sections" => {
            let mut result = b"\0asm\x01\0\0\0".to_vec();
            for _ in 0..count {
                result.extend([0, 1, 0]);
            }
            result
        }
        "cumulative-names" => {
            let mut result = b"\0asm\x01\0\0\0".to_vec();
            for _ in 0..2 {
                let length = leb(count);
                result.push(0);
                result.extend(leb(length.len() + count));
                result.extend(length);
                result.resize(result.len() + count, b'a');
            }
            result
        }
        "input" => {
            let mut result = vec![0; count];
            result[..8].copy_from_slice(b"\0asm\x01\0\0\0");
            let mut size = count - 9;
            while size + leb(size).len() != count - 9 {
                size -= 1;
            }
            let length = leb(size);
            result[9..9 + length.len()].copy_from_slice(&length);
            result
        }
        recipe => panic!("unknown fixture recipe {recipe:?}"),
    }
}

fn value_type(value: WasmValueType) -> &'static str {
    match value {
        WasmValueType::I32 => "i32",
        WasmValueType::I64 => "i64",
        WasmValueType::F32 => "f32",
        WasmValueType::F64 => "f64",
        WasmValueType::V128 => "v128",
        WasmValueType::FuncRef => "funcref",
        WasmValueType::ExternRef => "externref",
    }
}

fn table(ty: &WasmTableType) -> Value {
    let element = match ty.element {
        WasmReferenceType::FuncRef => "funcref",
        WasmReferenceType::ExternRef => "externref",
    };
    json!({ "element": element, "minimum": ty.minimum, "maximum": ty.maximum })
}

fn memory(ty: &WasmMemoryType) -> Value {
    json!({ "minimumPages": ty.minimum_pages, "maximumPages": ty.maximum_pages, "shared": ty.shared })
}

fn global(ty: &WasmGlobalType) -> Value {
    json!({ "value": value_type(ty.value), "mutable": ty.mutable })
}

fn external(value: &WasmExternal) -> Value {
    match value {
        WasmExternal::Function { index, type_index } => {
            json!({ "kind": "function", "index": index, "typeIndex": type_index })
        }
        WasmExternal::Table { index, ty } => {
            json!({ "kind": "table", "index": index, "type": table(ty) })
        }
        WasmExternal::Memory { index, ty } => {
            json!({ "kind": "memory", "index": index, "type": memory(ty) })
        }
        WasmExternal::Global { index, ty } => {
            json!({ "kind": "global", "index": index, "type": global(ty) })
        }
        WasmExternal::Tag { index, type_index } => {
            json!({ "kind": "tag", "index": index, "typeIndex": type_index })
        }
    }
}

fn as_json(facts: &WasmFacts) -> Value {
    let imports: Vec<_> = facts
        .imports
        .iter()
        .map(|item| {
            let mut value = external(&item.external);
            let object = value.as_object_mut().unwrap();
            object.insert("module".into(), json!(item.module));
            object.insert("name".into(), json!(item.name));
            value
        })
        .collect();
    let exports: Vec<_> = facts
        .exports
        .iter()
        .map(|item| {
            let mut value = external(&item.external);
            value
                .as_object_mut()
                .unwrap()
                .insert("name".into(), json!(item.name));
            value
        })
        .collect();
    let functions = |items: &[liblvgl_wasm_host::WasmIndexedFunction]| -> Vec<Value> {
        items.iter().map(|item| json!({ "index": item.index, "imported": item.imported, "typeIndex": item.type_index })).collect()
    };
    json!({
        "sha256": facts.sha256,
        "types": facts.types.iter().map(|ty| json!({ "params": ty.params.iter().copied().map(value_type).collect::<Vec<_>>(), "results": ty.results.iter().copied().map(value_type).collect::<Vec<_>>() })).collect::<Vec<_>>(),
        "imports": imports,
        "exports": exports,
        "functions": functions(&facts.functions),
        "tables": facts.tables.iter().map(|item| json!({ "index": item.index, "imported": item.imported, "type": table(&item.ty) })).collect::<Vec<_>>(),
        "memories": facts.memories.iter().map(|item| json!({ "index": item.index, "imported": item.imported, "type": memory(&item.ty) })).collect::<Vec<_>>(),
        "globals": facts.globals.iter().map(|item| json!({ "index": item.index, "imported": item.imported, "type": global(&item.ty) })).collect::<Vec<_>>(),
        "tags": functions(&facts.tags),
        "start": facts.start.as_ref().map(|item| json!({ "index": item.index, "typeIndex": item.type_index })),
        "validation": "not-run", "featureDetection": "not-run", "abiDetection": "not-run"
    })
}

#[test]
fn shared_wasm_fact_cases() {
    let directory = fixture_dir();
    let cases: Value =
        serde_json::from_slice(&fs::read(directory.join("cases.json")).unwrap()).unwrap();
    let expected: Value =
        serde_json::from_slice(&fs::read(directory.join("expected.json")).unwrap()).unwrap();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let data = bytes(case);
        let result = inspect_wasm_facts(&data);
        if !case["accepted"].as_bool().unwrap() {
            let error = result.expect_err(name);
            if let Some(limit) = case["limit"].as_str() {
                assert_eq!(
                    error.to_string(),
                    format!("Wasm facts inspection limit: {limit}"),
                    "{name}"
                );
            }
            continue;
        }
        let facts = result.unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(
            facts.sha256,
            format!("{:x}", Sha256::digest(&data)),
            "{name}"
        );
        assert_eq!(facts.validation, WasmCheck::NotRun, "{name}");
        assert_eq!(facts.feature_detection, WasmCheck::NotRun, "{name}");
        assert_eq!(facts.abi_detection, WasmCheck::NotRun, "{name}");
        if let Some(reference) = expected.get(name) {
            assert_eq!(as_json(&facts), *reference, "{name}");
        }
        if case["recipe"] == "parameters" {
            assert_eq!(
                facts.types[0].params.len(),
                case["count"].as_u64().unwrap() as usize,
                "{name}"
            );
        }
    }
}

#[test]
fn real_wasm_fact_comparison() {
    let input = env::var_os("LVW_TEST_WASM_FACTS_REAL_INPUT");
    let reference = env::var_os("LVW_TEST_WASM_FACTS_REAL_REFERENCE");
    match (input, reference) {
        (None, None) => (),
        (Some(input), Some(reference)) => {
            let bytes = fs::read(input).unwrap();
            let expected: Value = serde_json::from_slice(&fs::read(reference).unwrap()).unwrap();
            let facts = inspect_wasm_facts(&bytes).unwrap();
            assert_eq!(facts.validation, WasmCheck::NotRun);
            assert_eq!(facts.feature_detection, WasmCheck::NotRun);
            assert_eq!(facts.abi_detection, WasmCheck::NotRun);
            assert_eq!(as_json(&facts), expected);
        }
        _ => panic!("real Wasm comparison requires both input and reference paths"),
    }
}
