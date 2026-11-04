#include <stdbool.h>
#include <stdint.h>
#include "lvgl/lvgl.h"

__attribute__((import_module("lvcore"), import_name("lv_is_initialized")))
extern bool lv_is_initialized(void);
__attribute__((import_module("lvgl"), import_name("lv_screen_active")))
extern lv_obj_t *lv_screen_active(void);
__attribute__((import_module("lvgl"), import_name("lv_label_create")))
extern lv_obj_t *lv_label_create(lv_obj_t *parent);
__attribute__((import_module("lvgl"), import_name("lv_label_set_text")))
extern void lv_label_set_text(lv_obj_t *label, const char *text);
__attribute__((import_module("trace"), import_name("lifecycle")))
extern void trace_lifecycle(int32_t event);

static lv_obj_t *label;
static int32_t count;
static bool live;

__attribute__((export_name("module_init"))) int32_t module_init(void) {
    trace_lifecycle(10);
    if (!lv_is_initialized()) return 1;
    label = lv_label_create(lv_screen_active());
    if (!label) return 1;
    lv_label_set_text(label, "ALPHA");
#ifdef LVW_LABEL_LIB_FAIL_INIT
    return 7;
#else
    live = true;
    return 0;
#endif
}

__attribute__((export_name("middle_active"))) int32_t middle_active(void) {
    return live && lv_is_initialized() ? 1 : 0;
}

__attribute__((export_name("middle_update"))) int32_t middle_update(int32_t action) {
    if (!middle_active()) return -1;
    if (action == 0) return count;
    if ((action != 1 && action != 2) || count >= 1000000) return -1;
    lv_label_set_text(label, action == 1 ? "BETA" : "ALPHA");
    return ++count;
}

__attribute__((export_name("module_close"))) int32_t module_close(void) {
    if (!middle_active()) return 1;
    lv_label_set_text(label, NULL);
    live = false;
    label = NULL;
    trace_lifecycle(11);
    return 0;
}
