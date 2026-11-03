(module
  (import "trace" "event" (func $trace (param i32)))
  (import "lvw" "event" (func $event (param i32 i32 i32)))
  @EXTRA_IMPORT@
  (memory (export "memory") 1 2)
  (global $registration (mut i32) (i32.const 0))
  (global $target (mut i32) (i32.const 0))
  (global $registration2 (mut i32) (i32.const 0))
  (global $target2 (mut i32) (i32.const 0))
  (global $eventTarget (mut i32) (i32.const 0))
  (global $nextLabel (mut i32) (i32.const 300))
  (func (export "_initialize") i32.const 10 call $trace)
  (func (export "lvw_abi_version") (result i32) i32.const 1)
  (func (export "lvw_init") (result i32) i32.const 11 call $trace i32.const 0)
  (func (export "lvw_shutdown") (result i32) i32.const 19 call $trace i32.const 0)
  (func (export "lvw_display_create") (param i32 i32 i32) (result i32) i32.const 40 call $trace i32.const 100)
  (func (export "lv_display_get_screen_active") (param i32) (result i32) i32.const 41 call $trace i32.const 200)
  (func (export "lv_label_create") (param i32) (result i32) (local $created i32)
    i32.const 42 call $trace global.get $nextLabel local.tee $created i32.const 1 i32.add global.set $nextLabel local.get $created)
  (func (export "lv_label_set_text") (param i32 i32) i32.const 43 call $trace)
  (func (export "lvw_alloc") (param i32) (result i32) i32.const 60 call $trace i32.const 128)
  (func (export "lvw_free") (param i32) i32.const 61 call $trace)
  (func (export "lv_refr_now") (param i32))
  (func (export "lvw_frame_get") (param i32 i32) (result i32) i32.const 0)
  (func (export "lvw_event_clicked") (result i32) i32.const 45 call $trace i32.const 123)
  (func (export "lvw_event_add") (param i32 i32 i32) (result i32) (local $status i32)
    i32.const 50 call $trace
    @ADD@ local.set $status
    local.get $status i32.eqz
    if
      global.get $registration i32.eqz
      if local.get 0 global.set $target local.get 2 global.set $registration
      else local.get 0 global.set $target2 local.get 2 global.set $registration2 end
    end
    local.get $status)
  (func (export "lvw_event_remove") (param i32 i32) (result i32) (local $status i32)
    i32.const 51 call $trace @REMOVE@ local.set $status
    local.get $status i32.eqz
    if
      local.get 1 global.get $registration i32.eq
      if i32.const 0 global.set $registration else
        local.get 1 global.get $registration2 i32.eq if i32.const 0 global.set $registration2 end
      end
    end
    local.get $status)
  (func (export "lvw_event_current") (result i32) i32.const 53 call $trace @EVENT_POINTER@)
  (func (export "lv_event_get_target_obj") (param i32) (result i32) i32.const 54 call $trace @ORIGINAL_TARGET@)
  (func (export "lv_obj_send_event") (param i32 i32 i32) (result i32)
    i32.const 52 call $trace
    @SEND_TARGET@ global.set $eventTarget
    global.get $registration i32.eqz if else @DISPATCH@ end
    i32.const 0)
)
