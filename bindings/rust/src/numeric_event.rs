//! Trusted event adapter configuration for isolated LVGL module graphs.

use crate::module_manifest::ModuleExternalType;
use crate::wasm_facts::WasmValueType;

/// Bound the number of live event subscriptions and synchronous callback frames.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NumericEventOptions {
    pub max_registrations: u32,
    pub max_depth: u32,
}

impl NumericEventOptions {
    pub(crate) fn valid(&self) -> bool {
        (1..=4096).contains(&self.max_registrations) && (1..=64).contains(&self.max_depth)
    }
}

pub(crate) const EVENT_DISPATCH: &str = "app_event_dispatch";

pub(crate) fn event_signature(name: &str, ty: &ModuleExternalType) -> bool {
    let count = match name {
        "lv_obj_add_event_cb" => 4,
        "lv_obj_remove_event_dsc" => 2,
        "lv_obj_send_event" => 3,
        "lv_event_get_code" | "lv_event_get_user_data" | "lv_event_get_target_obj" => 1,
        _ => return false,
    };
    matches!(ty, ModuleExternalType::Function { params, results }
        if params.len() == count && params.iter().all(|value| *value == WasmValueType::I32)
            && results.as_slice() == [WasmValueType::I32])
}
