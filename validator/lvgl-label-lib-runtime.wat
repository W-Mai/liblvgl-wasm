(module
  (import "lvcore" "lv_is_initialized" (func $core (result i32)))
  (import "lvgl" "lv_screen_active" (func $screen (result i32)))
  (import "lvgl" "lv_label_create" (func $create (param i32) (result i32)))
  (import "lvgl" "lv_label_set_text" (func $set (param i32 i32)))
  (import "trace" "lifecycle" (func $trace (param i32)))
  (memory (export "memory") 1 2)
  (data (i32.const 64) "ALPHA\00")
  (data (i32.const 65535) "x")
  (global $screen_id (mut i32) (i32.const 0))
  (global $label_id (mut i32) (i32.const 0))
  (global $live (mut i32) (i32.const 0))
  (func (export "module_init") (result i32)
    i32.const 10 call $trace
    call $core i32.eqz if i32.const 1 return end
    call $screen global.set $screen_id
    global.get $screen_id call $create global.set $label_id
    global.get $label_id i32.eqz if i32.const 1 return end
    global.get $label_id i32.const 64 call $set
    i32.const 1 global.set $live
    i32.const 0)
  (func (export "module_close") (result i32)
    global.get $label_id i32.const 0 call $set
    i32.const 0 global.set $live
    i32.const 11 call $trace
    i32.const 0)
  (func (export "middle_active") (result i32) global.get $live)
  (func (export "middle_update") (param $action i32) (result i32)
    local.get $action i32.const -7 i32.eq if global.get $label_id return end
    local.get $action i32.const 0 i32.gt_s
    if local.get $action i32.const 64 call $set end
    local.get $action i32.const -1 i32.eq if unreachable end
    local.get $action i32.const -2 i32.eq
    if global.get $screen_id i32.const 64 call $set end
    local.get $action i32.const -3 i32.eq
    if global.get $label_id i32.const -1 call $set end
    local.get $action i32.const -4 i32.eq
    if global.get $label_id i32.const 65535 call $set end
    local.get $action i32.const -5 i32.eq
    if global.get $screen_id call $create drop end
    local.get $action i32.const -6 i32.eq
    if
      i32.const 1 memory.grow i32.const -1 i32.eq if i32.const -1 return end
      i32.const 65536 i32.const 66 i32.store8
      i32.const 65537 i32.const 69 i32.store8
      i32.const 65538 i32.const 84 i32.store8
      i32.const 65539 i32.const 65 i32.store8
      i32.const 65540 i32.const 0 i32.store8
      global.get $label_id i32.const 65536 call $set
    end
    i32.const 0)
)
