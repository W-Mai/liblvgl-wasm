#ifndef LVW_APP_H
#define LVW_APP_H

#include <stdint.h>

#define LVW_APP_ABI_VERSION 1u
#define LVW_APP_IMPORT(name) __attribute__((import_module("lvw_app"), import_name(#name)))
#define LVW_APP_EXPORT(name) __attribute__((export_name(#name)))

#ifdef __cplusplus
extern "C" {
#endif

LVW_APP_IMPORT(screen) uint32_t lvw_app_screen(void);
LVW_APP_IMPORT(button) uint32_t lvw_app_button(uint32_t parent);
LVW_APP_IMPORT(label) uint32_t lvw_app_label(uint32_t parent);
LVW_APP_IMPORT(set_size) void lvw_app_set_size(uint32_t object, int32_t width, int32_t height);
LVW_APP_IMPORT(set_pos) void lvw_app_set_pos(uint32_t object, int32_t x, int32_t y);
LVW_APP_IMPORT(set_text) int32_t lvw_app_set_text(uint32_t object, uint32_t utf8_ptr,
                                                 uint32_t utf8_len);
LVW_APP_IMPORT(on_click) int32_t lvw_app_on_click(uint32_t object, uint32_t callback_id);
LVW_APP_IMPORT(log) void lvw_app_log(uint32_t utf8_ptr, uint32_t utf8_len);

LVW_APP_EXPORT(app_abi_version) uint32_t app_abi_version(void);
LVW_APP_EXPORT(app_init) void app_init(void);
LVW_APP_EXPORT(app_event) void app_event(uint32_t callback_id, uint32_t event_code);

static inline int32_t lvw_app_text(uint32_t object, const char *bytes, uint32_t length) {
    return lvw_app_set_text(object, (uint32_t)(uintptr_t)bytes, length);
}

#ifdef __cplusplus
}
#endif

#endif
