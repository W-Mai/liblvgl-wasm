// Safety failures trap and are handled by the host's instance error policy.
pub const panic = @import("std").debug.no_panic;
const lv = @cImport({
    @cInclude("lvgl/lvgl.h");
});

fn onClick(event: ?*lv.lv_event_t) callconv(.c) void {
    const label: ?*lv.lv_obj_t = @ptrCast(@alignCast(lv.lv_event_get_user_data(event)));
    lv.lv_label_set_text(label, "Clicked");
}

export fn lvw_demo_create(display_handle: u32) void {
    const display: ?*lv.lv_display_t = @ptrFromInt(display_handle);
    const screen = lv.lv_display_get_screen_active(display);
    lv.lv_obj_set_style_bg_color(screen, lv.lv_color_hex(0x123456), lv.LV_PART_MAIN);
    const button = lv.lv_button_create(screen);
    lv.lv_obj_set_size(button, 180, 64);
    lv.lv_obj_center(button);

    const label = lv.lv_label_create(button);
    lv.lv_label_set_text(label, "Click me");
    lv.lv_obj_center(label);
    _ = lv.lv_obj_add_event_cb(button, onClick, lv.LV_EVENT_CLICKED, label);
}
