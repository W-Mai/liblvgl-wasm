#include <stdbool.h>
#include <stdint.h>
#include "lvgl/lvgl.h"

__attribute__((import_module("lvcore"), import_name("lv_is_initialized"))) extern bool lv_is_initialized(void);
__attribute__((import_module("trace"), import_name("lifecycle"))) extern void trace_lifecycle(int32_t event);
__attribute__((import_module("lvgl"), import_name("lv_screen_active"))) extern lv_obj_t *lv_screen_active(void);
__attribute__((import_module("lvgl"), import_name("lv_label_create"))) extern lv_obj_t *lv_label_create(lv_obj_t *parent);
__attribute__((import_module("lvgl"), import_name("lv_label_set_text"))) extern void lv_label_set_text(lv_obj_t *label, const char *text);
__attribute__((import_module("lvgl"), import_name("lv_obj_add_event_cb"))) extern lv_event_dsc_t *lv_obj_add_event_cb(lv_obj_t *obj, lv_event_cb_t callback, lv_event_code_t filter, void *data);
__attribute__((import_module("lvgl"), import_name("lv_obj_remove_event_dsc"))) extern bool lv_obj_remove_event_dsc(lv_obj_t *obj, lv_event_dsc_t *descriptor);
__attribute__((import_module("lvgl"), import_name("lv_obj_send_event"))) extern lv_result_t lv_obj_send_event(lv_obj_t *obj, lv_event_code_t code, void *param);
__attribute__((import_module("lvgl"), import_name("lv_event_get_code"))) extern lv_event_code_t lv_event_get_code(lv_event_t *event);
__attribute__((import_module("lvgl"), import_name("lv_event_get_user_data"))) extern void *lv_event_get_user_data(lv_event_t *event);
__attribute__((import_module("lvgl"), import_name("lv_event_get_target_obj"))) extern lv_obj_t *lv_event_get_target_obj(lv_event_t *event);

static struct { lv_obj_t *label; int32_t count; bool live; } state;
static lv_event_dsc_t *descriptor;

static void clicked(lv_event_t *event) {
    if (lv_event_get_user_data(event) != &state || lv_event_get_code(event) != LV_EVENT_CLICKED
        || lv_event_get_target_obj(event) != state.label) __builtin_trap();
    ++state.count;
    lv_label_set_text(state.label, "CLICKED");
}

__attribute__((export_name("app_event_dispatch")))
void app_event_dispatch(uint32_t callback, uint32_t event) {
    ((lv_event_cb_t)(uintptr_t)callback)((lv_event_t *)(uintptr_t)event);
}

__attribute__((export_name("module_init"))) int32_t module_init(void) {
    trace_lifecycle(10);
    if (!lv_is_initialized()) return 1;
    state.label = lv_label_create(lv_screen_active());
    if (!state.label) return 1;
    lv_label_set_text(state.label, "READY");
    descriptor = lv_obj_add_event_cb(state.label, clicked, LV_EVENT_CLICKED, &state);
    if (!descriptor) return 2;
#ifdef LVW_LABEL_LIB_FAIL_INIT
    return 7;
#else
    state.live = true;
    return 0;
#endif
}

__attribute__((export_name("middle_active"))) int32_t middle_active(void) {
    return state.live && lv_is_initialized();
}

__attribute__((export_name("middle_update"))) int32_t middle_update(int32_t action) {
    if (!middle_active()) return -1;
    if (action == 0) return state.count;
    if (action != 1 || state.count >= 1000000) return -1;
    return lv_obj_send_event(state.label, LV_EVENT_CLICKED, NULL) == LV_RESULT_OK ? state.count : -1;
}

__attribute__((export_name("module_close"))) int32_t module_close(void) {
    if (!middle_active() || !lv_obj_remove_event_dsc(state.label, descriptor)) return 1;
    state.live = false;
    trace_lifecycle(11);
    return 0;
}
