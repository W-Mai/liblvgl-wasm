#include <stdint.h>
#include "lvgl/lvgl.h"

__attribute__((import_module("lvgl"), import_name("lv_screen_active"))) extern lv_obj_t *lv_screen_active(void);
__attribute__((import_module("lvgl"), import_name("lv_label_create"))) extern lv_obj_t *lv_label_create(lv_obj_t *parent);
__attribute__((import_module("lvgl"), import_name("lv_label_set_text"))) extern void lv_label_set_text(lv_obj_t *label, const char *text);
__attribute__((import_module("lvgl"), import_name("lv_obj_add_event_cb"))) extern lv_event_dsc_t *lv_obj_add_event_cb(lv_obj_t *obj, lv_event_cb_t callback, lv_event_code_t filter, void *data);
__attribute__((import_module("lvgl"), import_name("lv_obj_remove_event_dsc"))) extern bool lv_obj_remove_event_dsc(lv_obj_t *obj, lv_event_dsc_t *descriptor);
__attribute__((import_module("lvgl"), import_name("lv_obj_send_event"))) extern lv_result_t lv_obj_send_event(lv_obj_t *obj, lv_event_code_t code, void *param);
__attribute__((import_module("lvgl"), import_name("lv_event_get_code"))) extern lv_event_code_t lv_event_get_code(lv_event_t *event);
__attribute__((import_module("lvgl"), import_name("lv_event_get_user_data"))) extern void *lv_event_get_user_data(lv_event_t *event);
__attribute__((import_module("lvgl"), import_name("lv_event_get_target_obj"))) extern lv_obj_t *lv_event_get_target_obj(lv_event_t *event);

struct callback_data { lv_obj_t *label; uint32_t calls; uint32_t nested_ok; };
static struct callback_data data;
static lv_event_dsc_t *descriptor;
static lv_event_dsc_t *removed;
static lv_event_t *stale;
static uint32_t event_order[4];
static uint32_t order_count;
static bool remove_on_inner;
static bool use_outer_in_inner;
static bool leave_registered_on_close;
static bool fire_on_close;
static bool foreign_target_next;
static lv_event_t *outer_event;

static void clicked(lv_event_t *event) {
    struct callback_data *context = lv_event_get_user_data(event);
    if (context != &data || lv_event_get_code(event) != LV_EVENT_CLICKED || lv_event_get_target_obj(event) != data.label) __builtin_trap();
    uint32_t call = ++context->calls;
    if (order_count < 4) event_order[order_count++] = 10 + call;
    stale = event;
    if (call == 2 && use_outer_in_inner) (void)lv_event_get_code(outer_event);
    if (call == 2 && remove_on_inner) {
        if (!lv_obj_remove_event_dsc(data.label, descriptor)) __builtin_trap();
        removed = descriptor;
        descriptor = NULL;
        if (lv_event_get_code(event) != LV_EVENT_CLICKED || lv_event_get_user_data(event) != &data
            || lv_event_get_target_obj(event) != data.label) __builtin_trap();
    }
    if (context->calls == 1) {
        outer_event = event;
        if (lv_obj_send_event(context->label, LV_EVENT_CLICKED, NULL) != LV_RESULT_OK) __builtin_trap();
        if (lv_event_get_code(event) != LV_EVENT_CLICKED || lv_event_get_user_data(event) != &data
            || lv_event_get_target_obj(event) != data.label) __builtin_trap();
        context->nested_ok = 1;
    }
    lv_label_set_text(context->label, "CLICKED");
    if (order_count < 4) event_order[order_count++] = 20 + call;
}

__attribute__((export_name("app_event_dispatch")))
void app_event_dispatch(uint32_t index, uint32_t event_token) {
    ((lv_event_cb_t)(uintptr_t)index)((lv_event_t *)(uintptr_t)event_token);
}

__attribute__((export_name("module_init")))
int32_t module_init(void) {
    data.label = lv_label_create(lv_screen_active());
    if (!data.label) return 1;
    lv_label_set_text(data.label, "READY");
    descriptor = lv_obj_add_event_cb(data.label, clicked, LV_EVENT_CLICKED, &data);
    if (!descriptor) return 2;
#ifdef LVW_TEST_INIT_FAILURE
    return 7;
#else
    return 0;
#endif
}

__attribute__((export_name("app_run")))
int32_t app_run(int32_t op) {
    if (foreign_target_next) {
        foreign_target_next = false;
        return (int32_t)lv_obj_send_event((lv_obj_t *)(uintptr_t)(uint32_t)op, LV_EVENT_CLICKED, NULL);
    }
    if (op == 0) return (int32_t)(uintptr_t)data.label;
    if (op == 1 || op == 3) return lv_obj_send_event(data.label, LV_EVENT_CLICKED, NULL) == LV_RESULT_OK ? (int32_t)data.calls : -1;
    if (op == 2) { bool result = lv_obj_remove_event_dsc(data.label, descriptor); removed = descriptor; descriptor = NULL; return result; }
    if (op == 4) return (int32_t)data.nested_ok;
    if (op >= 5 && op <= 8) return (int32_t)event_order[op - 5];
    if (op == 9) {
        remove_on_inner = true;
        return lv_obj_send_event(data.label, LV_EVENT_CLICKED, NULL) == LV_RESULT_OK ? (int32_t)data.calls : -1;
    }
    if (op == 10) {
        use_outer_in_inner = true;
        return lv_obj_send_event(data.label, LV_EVENT_CLICKED, NULL) == LV_RESULT_OK ? (int32_t)data.calls : -1;
    }
    if (op == 11) { leave_registered_on_close = true; return 0; }
    if (op == 12) { fire_on_close = true; return 0; }
    if (op == 13) { descriptor = lv_obj_add_event_cb(data.label, clicked, LV_EVENT_CLICKED, &data); return descriptor != NULL; }
    if (op == 14) return (int32_t)(uintptr_t)removed;
    if (op == 15) return (int32_t)(uintptr_t)descriptor;
    if (op == 16) { foreign_target_next = true; return 0; }
    if (op == -1) return (int32_t)lv_event_get_code(stale);
    if (op == -2) return lv_obj_remove_event_dsc(data.label, removed);
    if (op == -3) return (int32_t)lv_obj_send_event(data.label, LV_EVENT_CLICKED, (void *)(uintptr_t)1);
    if (op == -4) return lv_obj_add_event_cb(data.label, clicked, LV_EVENT_CLICKED, &data) != NULL;
    if (op == -5) return (int32_t)lv_obj_send_event(data.label, LV_EVENT_ALL, NULL);
    if (op == -6) return lv_obj_add_event_cb(data.label, NULL, LV_EVENT_CLICKED, &data) != NULL;
    return (int32_t)lv_obj_send_event((lv_obj_t *)(uintptr_t)(uint32_t)op, LV_EVENT_CLICKED, NULL);
}

__attribute__((export_name("module_close")))
int32_t module_close(void) {
    if (fire_on_close && lv_obj_send_event(data.label, LV_EVENT_CLICKED, NULL) != LV_RESULT_OK) return 2;
    if (!leave_registered_on_close && descriptor && !lv_obj_remove_event_dsc(data.label, descriptor)) return 1;
    descriptor = NULL;
    return 0;
}
