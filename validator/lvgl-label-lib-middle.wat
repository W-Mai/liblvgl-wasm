(module
  @CORE_IMPORT@
  (import "lvgl" "lv_screen_active" (func $screen (result i32)))
  (import "lvgl" "lv_label_create" (func $create (param i32) (result i32)))
  (import "lvgl" "lv_label_set_text" (func $set (param i32 i32)))
  (import "trace" "lifecycle" (func (param i32)))
  @MEMORY@
  (func (export "module_init") (result i32) i32.const 0)
  (func (export "module_close") (result i32) i32.const 0)
  (func (export "middle_active") (result i32) i32.const 1)
  (func (export "middle_update") (param i32) (result i32) local.get 0)
  @EXTRA@
)
