(module
  (import "trace" "event" (func $trace (param i32)))
  (import "base" "ping" (func $ping (result i32)))
  (import "@LVW_MODULE@" "event" (func $event @LVW_SIGNATURE@))
  (memory 1 2)
  (func (export "_initialize") i32.const 20 call $trace @REACTOR@)
  (func (export "lvw_abi_version") (result @ABI_TYPE@) i32.const 21 call $trace @ABI@)
  (func @INIT_EXPORT@ (result i32) i32.const 22 call $trace call $ping drop @INIT@)
  @EXTRA_EXPORT@
  (func (export "lvw_shutdown") (result i32) i32.const 29 call $trace @CLOSE@)
  (func (export "lv_tick_get") (result i32) @TICK@)
  (func (export "lv_is_initialized") (result i32) i32.const 1)
  (func (export "lv_obj_create") (param i32) (result i32) local.get 0)
)
