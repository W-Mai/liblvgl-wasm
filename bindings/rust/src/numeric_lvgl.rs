//! Trusted standalone LVGL core configuration for numeric module graphs.

use crate::module_manifest::{ModuleExternalType, ModuleInterface};
use crate::wasm_facts::WasmValueType;

/// Identify the LVGL core and its built-in bridge host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NumericLvglCoreOptions {
    pub module: String,
    pub id: String,
    pub interface: ModuleInterface,
    pub abi_version: u32,
}

pub(crate) const LVGL_LIFECYCLE: [&str; 3] = ["lvw_abi_version", "lvw_init", "lvw_shutdown"];
pub(crate) fn bridge_signature(name: &str, ty: &ModuleExternalType) -> bool {
    let (count, returns): (usize, bool) = match name {
        "event" | "anim_exec" | "anim_notify" | "observer" => (3, false),
        "timer" => (2, false),
        "timer_release" | "anim_release" | "observer_release" | "decoder_release" => (1, false),
        "anim_query" | "decoder_open" => (3, true),
        "decoder_info" => (4, true),
        "decoder_area" => (5, true),
        "decoder_close" => (3, false),
        _ => return false,
    };
    matches!(ty, ModuleExternalType::Function { params, results }
        if params.len() == count && params.iter().all(|value| *value == WasmValueType::I32)
            && if returns { results.as_slice() == [WasmValueType::I32] } else { results.is_empty() })
}
