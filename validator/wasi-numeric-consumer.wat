(module
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_seek" (func $seek (param i32 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_get" (func $env (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_sizes_get" (func $sizes (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "clock_time_get" (func $clock (param i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  @@LIB_IMPORT@@
  (memory (export "memory") 1 2)
  (data (i32.const 128) "@@LABEL@@")
  (data (i32.const 132) "init")
  (data (i32.const 136) "done")
  (func $emit (param $ptr i32) (param $len i32) (param $fd i32) (result i32)
    i32.const 0 local.get $ptr i32.store
    i32.const 4 local.get $len i32.store
    local.get $fd i32.const 0 i32.const 1 i32.const 16 call $write)
  (func (export "_initialize") i32.const 132 i32.const 4 i32.const 2 call $emit drop)
  (func (export "module_init") (result i32) i32.const 0)
  (func (export "module_close") (result i32) i32.const 136 i32.const 4 i32.const 2 call $emit drop i32.const 0)
  (func $execute (param $op i32) (result i32)
    i32.const 0 i32.const 128 i32.store
    i32.const 4 i32.const 4 i32.store
    local.get $op i32.const 0 i32.eq if i32.const 1 i32.const 0 i32.const 1 i32.const 16 call $write return end
    local.get $op i32.const 1 i32.eq if i32.const 1 i32.const -1 i32.const 1 i32.const 16 call $write return end
    local.get $op i32.const 2 i32.eq if i32.const 1 i32.const 0 i32.const -1 i32.const 16 call $write return end
    local.get $op i32.const 3 i32.eq if i32.const 1 i32.const 0 i32.const 1 i32.const -1 call $write return end
    local.get $op i32.const 4 i32.eq if i32.const 0 i32.const -1 i32.store i32.const 1 i32.const 0 i32.const 1 i32.const 16 call $write return end
    local.get $op i32.const 5 i32.eq if i32.const 4 i32.const -1 i32.store i32.const 1 i32.const 0 i32.const 1 i32.const 16 call $write return end
    local.get $op i32.const 6 i32.eq if i32.const 9 i32.const 0 i32.const 1 i32.const 16 call $write return end
    local.get $op i32.const 7 i32.eq if i32.const 1 i32.const 0 i32.const 0 i32.const 16 call $write return end
    local.get $op i32.const 8 i32.eq if
      i32.const 1 memory.grow i32.const -1 i32.eq if i32.const -20 return end
      i32.const 65536 i32.const 0x574f5247 i32.store
      i32.const 65536 i32.const 4 i32.const 1 call $emit return end
    local.get $op i32.const 9 i32.eq if
      i32.const 32 i32.const -1 i32.store i32.const 36 i32.const -1 i32.store
      i32.const 32 i32.const 36 call $sizes if i32.const -21 return end
      i32.const 32 i32.load i32.const 36 i32.load i32.or return end
    local.get $op i32.const 10 i32.eq if i32.const 0 i32.const 0 call $env return end
    local.get $op i32.const 11 i32.eq if
      i32.const 0 i64.const 1 i32.const 40 call $clock if i32.const -22 return end
      i32.const 40 i64.load i32.wrap_i64 return end
    local.get $op i32.const 12 i32.eq if i32.const 1 i64.const 0 i32.const 0 i32.const 40 call $seek return end
    local.get $op i32.const 13 i32.eq if i32.const 1 call $close return end
    local.get $op i32.const 14 i32.eq if i32.const 42 call $exit unreachable end
    local.get $op i32.const 15 i32.eq if i32.const 2 i32.const 0 i32.const 1 i32.const 16 call $write return end
    local.get $op i32.const 16 i32.eq if i32.const 1 i32.const 0 i32.const 1 i32.const 128 call $write return end
    local.get $op i32.const 17 i32.eq if i32.const 2 i64.const 1 i32.const 40 call $clock return end
    i32.const -100)
  @@RUN_EXPORT@@
)
