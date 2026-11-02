(module
  (import "trace" "event" (func $trace (param i32)))
  (memory 1 2)
  (func (export "_initialize") i32.const 10 call $trace)
  (func (export "module_init") (result i32) i32.const 11 call $trace i32.const 0)
  (func (export "module_close") (result i32) i32.const 19 call $trace i32.const 0)
  (func (export "ping") (result i32) i32.const 1)
)
