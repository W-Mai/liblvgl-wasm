#include <stdint.h>

__attribute__((import_module("trace"), import_name("lifecycle"))) void trace_lifecycle(int32_t event);
__attribute__((import_module("lvcore"), import_name("bar_set"))) int32_t bar_set(int32_t value);
__attribute__((import_module("lvcore"), import_name("bar_get"))) int32_t bar_get(void);
__attribute__((import_module("lvcore"), import_name("frame_pixel"))) int32_t frame_pixel(void);
__attribute__((import_module("lvcore"), import_name("frame_green"))) int32_t frame_green(void);
__attribute__((export_name("module_init"))) int32_t module_init(void) { trace_lifecycle(20); return 0; }
__attribute__((export_name("module_close"))) int32_t module_close(void) { trace_lifecycle(21); return 0; }
__attribute__((export_name("app_run"))) int32_t app_run(int32_t value) {
    if (value == -100) return frame_pixel();
    if (value == -101) return bar_get();
    if (value == -102) return frame_green();
    int32_t status = bar_set(value);
    return status ? status : bar_get();
}
