(module
  (import "middle" "middle_active" (func (result i32)))
  (import "middle" "middle_update" (func $update (param i32) (result i32)))
  (import "trace" "lifecycle" (func (param i32)))
  @EXTRA_IMPORT@
  (memory (export "memory") 1 2)
  @EXTRA@
  (func (export "module_init") (result i32) i32.const 0)
  (func (export "module_close") (result i32) i32.const 0)
  (func (export "app_run") (param i32) (result i32) local.get 0 call $update)
)
