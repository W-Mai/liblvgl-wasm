#include "lvw_app.h"

namespace {
uint32_t label;
}

uint32_t app_abi_version(void) { return LVW_APP_ABI_VERSION; }

void app_init(void) {
    const uint32_t button = lvw_app_button(lvw_app_screen());
    lvw_app_set_size(button, 180, 64);
    lvw_app_set_pos(button, 70, 88);
    label = lvw_app_label(button);
    lvw_app_text(label, "C++ application", 15);
    lvw_app_on_click(button, 1);
}

void app_event(uint32_t callback_id, uint32_t event_code) {
    (void)event_code;
    if (callback_id == 1) {
        lvw_app_text(label, "C++ clicked", 11);
        lvw_app_log((uint32_t)(uintptr_t)"C++ clicked", 11);
    }
}
