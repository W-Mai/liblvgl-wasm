(module
  (import "trace" "event" (func $event (param i32)))
  (memory 1 2)
  (func (export "_initialize") i32.const 12 call $event)
  (func (export "module_init") (result i32) i32.const 10 call $event i32.const 0)
  (func (export "module_close") (result i32) i32.const 11 call $event i32.const 0)
  (func (export "read") (result i32) i32.const 0 i32.load)
  (func (export "calc") (param i32) (result i32)
    i32.const 0 local.get 0 i32.const 10 i32.add i32.store
    local.get 0 i32.const 1 i32.add)
)
