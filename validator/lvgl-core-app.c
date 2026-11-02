#include <stdint.h>
#include <stdbool.h>

__attribute__((import_module("lvcore"), import_name("lv_is_initialized")))
extern bool lv_is_initialized(void);

__attribute__((export_name("module_init")))
int32_t module_init(void) {
    if (!lv_is_initialized()) return 1;
#ifdef LVW_TEST_INIT_FAILURE
    return 7;
#else
    return 0;
#endif
}

__attribute__((export_name("app_run")))
int32_t app_run(int32_t value) { return lv_is_initialized() ? value : -1; }

__attribute__((export_name("module_close")))
int32_t module_close(void) { return lv_is_initialized() ? 0 : 1; }
