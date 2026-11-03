//! Trusted label adapter configuration for isolated LVGL module graphs.

use crate::module_manifest::{ModuleExternalType, ModuleInterface};
use crate::wasm_facts::WasmValueType;

/// An owned RGBA copy of an LVGL display frame.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NumericFrame {
    pub width: u32,
    pub height: u32,
    pub frame_id: u32,
    pub rgba: Vec<u8>,
}

/// Identify the app-facing label adapter and its resource limits.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NumericLabelOptions {
    pub id: String,
    pub interface: ModuleInterface,
    pub width: u32,
    pub height: u32,
    pub max_labels: u32,
    pub max_text_bytes: u32,
}
impl NumericLabelOptions {
    pub(crate) fn valid(&self) -> bool {
        self.width > 0
            && self.width <= 4096
            && self.height > 0
            && self.height <= 4096
            && u64::from(self.width) * u64::from(self.height) * 4 <= 16 * 1024 * 1024
            && self.max_labels > 0
            && self.max_labels <= 4096
            && self.max_text_bytes > 0
            && self.max_text_bytes <= 1024 * 1024
    }
}

pub(crate) fn label_signature(name: &str, ty: &ModuleExternalType) -> bool {
    let (count, returns) = match name {
        "lv_screen_active" => (0, true),
        "lv_label_create" => (1, true),
        "lv_label_set_text" => (2, false),
        _ => return false,
    };
    matches!(ty, ModuleExternalType::Function { params, results }
        if params.len() == count && params.iter().all(|value| *value == WasmValueType::I32)
            && if returns { results.as_slice() == [WasmValueType::I32] } else { results.is_empty() })
}
