#include <stdint.h>

#include "lvgl/lvgl.h"

static void on_click(lv_event_t *event) {
    lv_obj_t *label = lv_event_get_user_data(event);
    lv_label_set_text(label, "Clicked");
}

__attribute__((export_name("lvw_demo_create")))
void lvw_demo_create(uint32_t display_handle) {
    lv_display_t *display = (lv_display_t *)(uintptr_t)display_handle;
    lv_obj_t *screen = lv_display_get_screen_active(display);
    lv_obj_t *button = lv_button_create(screen);
    lv_obj_set_size(button, 180, 64);
    lv_obj_center(button);

    lv_obj_t *label = lv_label_create(button);
    lv_label_set_text(label, "Click me");
    lv_obj_center(label);
    lv_obj_add_event_cb(button, on_click, LV_EVENT_CLICKED, label);
}
