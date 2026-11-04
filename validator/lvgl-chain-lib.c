#include <stdbool.h>
#include <stdint.h>
#include "lvgl/lvgl.h"

__attribute__((import_module("lvcore"), import_name("lv_is_initialized")))
extern bool lv_is_initialized(void);
__attribute__((import_module("trace"), import_name("lifecycle")))
extern void trace_lifecycle(int32_t event);

static int32_t count;
static bool live;

__attribute__((export_name("module_init"))) int32_t module_init(void) {
    trace_lifecycle(10);
    if (!lv_is_initialized()) return 1;
#ifdef LVW_CHAIN_FAIL_INIT
    return 7;
#else
    live = true;
    return 0;
#endif
}

__attribute__((export_name("module_close"))) int32_t module_close(void) {
    if (!live || !lv_is_initialized()) return 1;
    live = false;
    trace_lifecycle(11);
    return 0;
}

__attribute__((export_name("middle_active"))) int32_t middle_active(void) {
    return live && lv_is_initialized() ? 1 : 0;
}

__attribute__((export_name("middle_count"))) int32_t middle_count(void) {
    return count;
}

__attribute__((export_name("middle_step"))) int32_t middle_step(int32_t value) {
    if (value == -1) __builtin_trap();
    if (value < 0 || value > 1000 || count >= 1000000 || !live || !lv_is_initialized()) return -1;
    count++;
    return value + count * 10;
}
