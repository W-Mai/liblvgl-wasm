(module
  (import "trace" "event" (func $trace (param i32)))
  (import "core" "@IMPORT@" (func $core (result i32)))
  @EXTRA_IMPORT@
  (memory 1 2)
  (func (export "_initialize") i32.const 30 call $trace)
  (func (export "module_init") (result i32) i32.const 31 call $trace @APP_INIT@)
  (func (export "module_close") (result i32) i32.const 39 call $trace i32.const 0)
  (func (export "app_run") (param i32) (result i32) i32.const 32 call $trace call $core)
)
