(module
  (import "trace" "event" (func $event (param i32)))
  (import "core" "calc" (func $core (param i32) (result i32)))
  (memory 1 2)
  (func (export "_initialize") i32.const 22 call $event)
  (func (export "module_init") (result i32) i32.const 20 call $event i32.const 0)
  (func (export "module_close") (result i32) i32.const 0 call $core drop i32.const 21 call $event i32.const 0)
  (func (export "read") (result i32) i32.const 0 i32.load)
  (func (export "calc") (param i32) (result i32)
    i32.const 0 local.get 0 i32.const 20 i32.add i32.store
    local.get 0 call $core i32.const 2 i32.mul)
)
