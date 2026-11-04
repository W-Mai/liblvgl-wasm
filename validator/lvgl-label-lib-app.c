#include <stdint.h>

__attribute__((import_module("middle"), import_name("middle_active")))
extern int32_t middle_active(void);
__attribute__((import_module("middle"), import_name("middle_update")))
extern int32_t middle_update(int32_t action);
__attribute__((import_module("trace"), import_name("lifecycle")))
extern void trace_lifecycle(int32_t event);

__attribute__((export_name("module_init"))) int32_t module_init(void) {
    trace_lifecycle(20);
    if (!middle_active()) return 1;
#ifdef LVW_LABEL_LIB_FAIL_INIT
    return 7;
#else
    return 0;
#endif
}

__attribute__((export_name("app_run"))) int32_t app_run(int32_t action) {
    return middle_update(action);
}

__attribute__((export_name("module_close"))) int32_t module_close(void) {
    if (!middle_active()) return 1;
    trace_lifecycle(21);
    return 0;
}
