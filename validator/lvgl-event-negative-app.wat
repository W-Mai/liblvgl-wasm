(module
  (type $callback (func (param i32)))
  (import "trace" "event" (func $trace (param i32)))
  (import "@EVENT_MODULE@" "lv_screen_active" (func $screen (result i32)))
  (import "@EVENT_MODULE@" "lv_label_create" (func $label_create (param i32) (result i32)))
  (import "@EVENT_MODULE@" "lv_label_set_text" (func $label_text (param i32 i32)))
  (import "@EVENT_MODULE@" "lv_obj_add_event_cb" (func $add (param i32 i32 i32 i32) (result i32)))
  (import "@EVENT_MODULE@" "lv_obj_remove_event_dsc" (func $remove (param i32 i32) (result i32)))
  (import "@EVENT_MODULE@" "lv_obj_send_event" (func $send (param i32 i32 i32) (result i32)))
  (import "@EVENT_MODULE@" "lv_event_get_code" (func $code (param i32) (result i32)))
  (import "@EVENT_MODULE@" "lv_event_get_user_data" (func $userdata (param i32) (result i32)))
  (import "@EVENT_MODULE@" "lv_event_get_target_obj" (func $event_target (param i32) (result i32)))
  @EXTRA_IMPORT@
  (memory (export "memory") 1 2)
  (table 4 4 funcref)
  (elem (i32.const 1) $callback $wrong_signature)
  (global $label (mut i32) (i32.const 0))
  (global $secondLabel (mut i32) (i32.const 0))
  (global $descriptor (mut i32) (i32.const 0))
  (global $savedEvent (mut i32) (i32.const 0))
  (global $count (mut i32) (i32.const 0))
  (global $mode (mut i32) (i32.const 0))
  (data (i32.const 64) "updated\00")
  (data (i32.const 80) "J")
  (func $wrong_signature (result i32) i32.const 7)
  (func $callback (type $callback) (param $eventToken i32)
    i32.const 70 call $trace
    local.get $eventToken global.set $savedEvent
    global.get $count i32.const 1 i32.add global.set $count
    local.get $eventToken call $code i32.const 123 i32.ne if unreachable end
    local.get $eventToken call $userdata i32.const 80 i32.ne if unreachable end
    local.get $eventToken call $userdata i32.load8_u i32.const 74 i32.ne if unreachable end
    local.get $eventToken call $event_target global.get $label i32.ne if unreachable end
    global.get $mode i32.const 1 i32.eq global.get $count i32.const 1 i32.eq i32.and
    if global.get $label i32.const 123 i32.const 0 call $send drop end
    global.get $mode i32.const 4 i32.eq
    if global.get $label global.get $descriptor call $remove drop end
    local.get $eventToken call $code i32.const 123 i32.ne if unreachable end
    local.get $eventToken call $userdata i32.const 80 i32.ne if unreachable end
    global.get $label i32.const 64 call $label_text
    i32.const 71 call $trace)
  @DISPATCH_EXPORT@
  (func (export "_initialize"))
  (func (export "module_init") (result i32)
    i32.const 31 call $trace
    call $screen call $label_create global.set $label
    global.get $label @INDEX@ @CODE@ i32.const 80 call $add global.set $descriptor
    global.get $descriptor if (result i32) @INIT@ else i32.const 9 end)
  (func (export "module_close") (result i32) i32.const 39 call $trace i32.const 0)
  (func (export "app_run") (param $action i32) (result i32)
    local.get $action i32.const 3 i32.eq
    if global.get $savedEvent call $code return end
    local.get $action i32.const 5 i32.eq
    if global.get $label i32.const 124 i32.const 0 call $send return end
    local.get $action i32.const 6 i32.eq
    if global.get $label i32.const 123 i32.const 80 call $send return end
    local.get $action i32.const 7 i32.eq
    if global.get $label i32.const 1 i32.const 123 i32.const 80 call $add return end
    local.get $action i32.const 8 i32.eq
    if call $screen i32.const 123 i32.const 0 call $send return end
    local.get $action i32.const 9 i32.eq
    if global.get $label global.get $label call $remove return end
    local.get $action i32.const 10 i32.eq local.get $action i32.const 11 i32.eq i32.or
    if
      call $screen call $label_create global.set $secondLabel
      global.get $secondLabel i32.const 1 i32.const 123 i32.const 80 call $add drop
      local.get $action i32.const 11 i32.eq if (result i32) i32.const 1 else i32.const 2 end global.set $mode
      global.get $label i32.const 123 i32.const 0 call $send drop
      global.get $count return
    end
    local.get $action global.set $mode
    global.get $label i32.const 123 i32.const 0 call $send drop
    global.get $count)
)
