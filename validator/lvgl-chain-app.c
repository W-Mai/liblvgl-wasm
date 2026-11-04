#include <stdint.h>

__attribute__((import_module("middle"), import_name("middle_step")))
extern int32_t middle_step(int32_t value);
__attribute__((import_module("middle"), import_name("middle_count")))
extern int32_t middle_count(void);
__attribute__((import_module("middle"), import_name("middle_active")))
extern int32_t middle_active(void);
__attribute__((import_module("trace"), import_name("lifecycle")))
extern void trace_lifecycle(int32_t event);

static int32_t count;

__attribute__((export_name("module_init"))) int32_t module_init(void) {
    trace_lifecycle(20);
    if (!middle_active()) return 1;
#ifdef LVW_CHAIN_FAIL_INIT
    return 7;
#else
    return 0;
#endif
}

__attribute__((export_name("module_close"))) int32_t module_close(void) {
    if (!middle_active()) return 1;
    trace_lifecycle(21);
    return 0;
}

__attribute__((export_name("app_run"))) int32_t app_run(int32_t value) {
    if (value == -10) return count;
    if (value == -11) return middle_count();
    if (value == -1) return middle_step(value);
    if (value < 0 || value > 1000 || count >= 1000000) return -1;
    int32_t result = middle_step(value);
    if (result < 0) return result;
    count++;
    return result + count * 100;
}
