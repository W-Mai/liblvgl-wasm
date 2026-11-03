#include <stdint.h>
#include "lvgl/lvgl.h"

__attribute__((import_module("lvgl"), import_name("lv_screen_active")))
extern lv_obj_t *lv_screen_active(void);
__attribute__((import_module("lvgl"), import_name("lv_label_create")))
extern lv_obj_t *lv_label_create(lv_obj_t *parent);
__attribute__((import_module("lvgl"), import_name("lv_label_set_text")))
extern void lv_label_set_text(lv_obj_t *label, const char *text);

static lv_obj_t *screen;
static lv_obj_t *label;
static char input[] = "ALPHA";

__attribute__((export_name("module_init")))
int32_t module_init(void) {
    screen = lv_screen_active();
    label = lv_label_create(screen);
    if (!label) return 1;
    lv_label_set_text(label, input);
    for (unsigned i = 0; i < sizeof(input) - 1; i++) input[i] = 'X';
#ifdef LVW_TEST_INIT_FAILURE
    return 7;
#else
    return 0;
#endif
}

__attribute__((export_name("app_run")))
int32_t app_run(int32_t value) {
    if (value == 0) return (int32_t)(uintptr_t)label;
    if (value == -1) { lv_label_set_text(label, "BETA"); return 0; }
    if (value == -2) { lv_label_set_text(label, (const char *)(uintptr_t)0xfffffff0u); return 0; }
    if (value == -3) { static const char bytes[] = { 'X', (char)0xc3, '(', 0 }; lv_label_set_text(label, bytes); return 0; }
    if (value == -4) { lv_label_set_text(label, NULL); return 0; }
    if (value == -5) {
        char *bytes = (char *)(uintptr_t)(__builtin_wasm_memory_size(0) * 65536u - 4u);
        for (unsigned i = 0; i < 4; i++) bytes[i] = 'X';
        lv_label_set_text(label, bytes);
        return 0;
    }
    if (value == -6) {
        if (__builtin_wasm_memory_grow(0, 1) == (size_t)-1) return -1;
        lv_label_set_text(label, "GROWN");
        return 0;
    }
    if (value == -7) {
        static char oversized[4098];
        for (unsigned i = 0; i < sizeof(oversized) - 1; i++) oversized[i] = 'X';
        lv_label_set_text(label, oversized);
        return 0;
    }
    if (value == -8) { lv_label_set_text(screen, "WRONG"); return 0; }
    if (value == -9) { return lv_label_create(screen) ? 0 : 1; }
    if (value == -10) {
        static char maximum[4097];
        for (unsigned i = 0; i < sizeof(maximum) - 1; i++) maximum[i] = 'A';
        lv_label_set_text(label, maximum);
        return 0;
    }
    if (value == -11) { return lv_label_create(NULL) ? 0 : 1; }
    lv_label_set_text((lv_obj_t *)(uintptr_t)(uint32_t)value, "OTHER");
    return 0;
}

__attribute__((export_name("module_close")))
int32_t module_close(void) {
    lv_label_set_text(label, NULL);
    label = NULL;
    screen = NULL;
    return 0;
}
