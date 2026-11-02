#include <stdint.h>
#include "lvgl/lvgl.h"

__attribute__((import_module("trace"), import_name("lifecycle")))
extern void trace_lifecycle(int32_t event);

static lv_display_t *display;
static lv_obj_t *bar;
static uint32_t pixels[16 * 16];

static void flush(lv_display_t *owner, const lv_area_t *area, uint8_t *data) {
    (void)area;
    (void)data;
    lv_display_flush_ready(owner);
}

__attribute__((export_name("module_init"))) int32_t module_init(void) {
    lv_init();
    display = lv_display_create(16, 16);
    if (!display) { lv_deinit(); return 1; }
    lv_display_set_color_format(display, LV_COLOR_FORMAT_XRGB8888);
    lv_display_set_buffers(display, pixels, NULL, sizeof(pixels), LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_flush_cb(display, flush);
    lv_obj_t *screen = lv_display_get_screen_active(display);
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x336699), 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
    bar = lv_bar_create(screen);
    if (!bar) { lv_display_delete(display); lv_deinit(); return 2; }
    lv_obj_remove_style_all(bar);
    lv_obj_set_style_bg_color(bar, lv_color_hex(0xff0000), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_radius(bar, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(bar, 0, LV_PART_MAIN);
    lv_obj_set_style_bg_color(bar, lv_color_hex(0x00ff00), LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, LV_PART_INDICATOR);
    lv_obj_set_style_radius(bar, 0, LV_PART_INDICATOR);
    lv_obj_set_pos(bar, 4, 4);
    lv_obj_set_size(bar, 8, 8);
    trace_lifecycle(10);
    return 0;
}

__attribute__((export_name("bar_set"))) int32_t bar_set(int32_t value) {
    if (!bar || value < 0 || value > 100) return -1;
    lv_bar_set_value(bar, value, LV_ANIM_OFF);
    return 0;
}

__attribute__((export_name("bar_get"))) int32_t bar_get(void) {
    return bar ? lv_bar_get_value(bar) : -1;
}

__attribute__((export_name("frame_pixel"))) int32_t frame_pixel(void) {
    if (!display) return -1;
    lv_refr_now(display);
    return (int32_t)(pixels[0] & 0x00ffffffu);
}

__attribute__((export_name("frame_green"))) int32_t frame_green(void) {
    if (!display) return -1;
    lv_refr_now(display);
    int32_t count = 0;
    for (uint32_t i = 0; i < 16 * 16; i++) if ((pixels[i] & 0x00ffffffu) == 0x00ff00u) count++;
    return count;
}

__attribute__((export_name("module_close"))) int32_t module_close(void) {
    if (!display) return -1;
    lv_display_delete(display);
    display = NULL;
    bar = NULL;
    lv_deinit();
    trace_lifecycle(11);
    return 0;
}
