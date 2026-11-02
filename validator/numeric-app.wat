(module
  (import "trace" "event" (func $event (param i32)))
  (import "a" "calc" (func $a (param i32) (result i32)))
  (import "b" "calc" (func $b (param i32) (result i32)))
  (import "core" "read" (func $read_core (result i32)))
  (import "b" "read" (func $read_b (result i32)))
  (import "a" "read" (func $read_a (result i32)))
  (memory 1 2)
  (func (export "_initialize") i32.const 42 call $event)
  (func (export "module_init") (result i32) i32.const 40 call $event i32.const 0)
  (func (export "module_close") (result i32) i32.const 0 call $a drop i32.const 41 call $event i32.const 0)
  (func (export "app_run") (param i32) (result i32)
    local.get 0 i32.const -1 i32.eq if unreachable end
    local.get 0 i32.const -2 i32.eq
    if (result i32)
      i32.const 0 i32.load call $read_core i32.add call $read_b i32.add call $read_a i32.add
    else
      i32.const 0 local.get 0 i32.const 40 i32.add i32.store
      local.get 0 call $a local.get 0 call $b i32.add
    end)
)
