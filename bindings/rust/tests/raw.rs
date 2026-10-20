use std::collections::BTreeMap;
use std::path::Path;

use liblvgl_wasm_host::{API_EXPORTS, BINDING_IDENTITY, Result, Runtime, UnsafePointer};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn artifact(name: &str) -> std::io::Result<Vec<u8>> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/wasm")
            .join(name),
    )
}

#[test]
fn generated_bindings_match_verified_metadata_and_execute_the_target_abi() -> Result<()> {
    let metadata = artifact("api.json")?;
    let report: Value = serde_json::from_slice(&metadata)?;
    let core = artifact("liblvgl.wasm")?;
    let proof: Value = serde_json::from_slice(&artifact("api-verification.json")?)?;
    let expected: BTreeMap<_, _> = report["declarations"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| Some((entry["name"].as_str()?, entry["export_name"].as_str()?)))
        .collect();
    assert_eq!(API_EXPORTS.len(), expected.len());
    assert_eq!(
        API_EXPORTS.iter().copied().collect::<BTreeMap<_, _>>(),
        expected
    );
    assert_eq!(
        BINDING_IDENTITY.schema_version,
        proof["schema_version"].as_u64().unwrap() as u32
    );
    assert_eq!(BINDING_IDENTITY.expected_functions, API_EXPORTS.len());
    assert_eq!(BINDING_IDENTITY.verified_functions, API_EXPORTS.len());
    assert_eq!(
        BINDING_IDENTITY.api_sha256,
        format!("{:x}", Sha256::digest(&metadata))
    );
    assert_eq!(
        BINDING_IDENTITY.wasm_sha256,
        format!("{:x}", Sha256::digest(&core))
    );
    assert_eq!(
        BINDING_IDENTITY.api_sha256,
        proof["api_sha256"].as_str().unwrap()
    );
    assert_eq!(
        BINDING_IDENTITY.wasm_sha256,
        proof["wasm_sha256"].as_str().unwrap()
    );

    let color_size = report["types"]
        .as_object()
        .unwrap()
        .values()
        .find(|node| node["kind"] == "alias" && node["name"] == "lv_color_t")
        .unwrap()["layout"]["size"]
        .as_u64()
        .unwrap() as u32;
    let selector: i32 = report["constants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "LV_PART_MAIN")
        .unwrap()["value"]
        .as_str()
        .unwrap()
        .parse()?;

    let mut runtime = Runtime::load(&core)?;
    let display: u32 = runtime.call_raw("lvw_display_create", (80u32, 60u32, 1u32))?;
    assert_ne!(display, 0);
    {
        let mut api = runtime.raw()?;
        let screen = api.lv_display_get_screen_active(UnsafePointer(display))?;
        let button = api.lv_button_create(screen)?;
        let label = api.lv_label_create(button)?;
        api.lv_obj_set_size(button, 40, 30)?;
        api.lv_obj_set_pos(button, 4, 6)?;
        let color = api.alloc(color_size)?;
        api.lv_color_hex(color, 0x123456)?;
        assert_eq!(api.lv_color_to_int(color)?, 0x123456);
        api.lv_obj_set_style_bg_color(button, color, selector)?;
        api.lv_obj_get_style_bg_color(color, button, selector)?;
        assert_eq!(api.lv_color_to_int(color)?, 0x123456);
        let text = b"Rust LVGL\0";
        let scratch = api.alloc(text.len() as u32)?;
        api.write_memory(scratch, text)?;
        api.lv_label_set_text(label, scratch)?;
        let stored = api.lv_label_get_text(label)?;
        let mut read = [0; 10];
        api.read_memory(stored, &mut read)?;
        assert_eq!(&read, text);
        assert_eq!(
            api.lv_pow(18_014_398_509_494_329, 1)?,
            18_014_398_509_494_329
        );
        api.free(scratch)?;
        api.free(color)?;
    }
    runtime.shutdown()?;
    assert!(runtime.raw().is_err());
    Ok(())
}

#[test]
fn a_different_core_preserves_bridge_access_and_rejects_generated_bindings() -> Result<()> {
    let mut core = artifact("liblvgl.wasm")?;
    core.extend([0, 2, 1, b'x']); // A valid custom section changes only the core identity.
    let mut runtime = Runtime::load(&core)?;
    let display: u32 = runtime.call_raw("lvw_display_create", (80u32, 60u32, 1u32))?;
    assert_ne!(display, 0);
    let error = runtime.raw().err().expect("mismatched core accepted");
    assert!(error.to_string().contains("bindings do not match"));
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_display_destroy", display)?,
        0
    );
    runtime.shutdown()?;
    Ok(())
}
