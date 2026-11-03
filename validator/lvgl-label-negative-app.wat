(module
  (import "trace" "event" (func $trace (param i32)))
  (import "@LABEL_MODULE@" "lv_screen_active" (func $screen (result i32)))
  (import "@LABEL_MODULE@" "lv_label_create" (func $create (param i32) (result i32)))
  (import "@LABEL_MODULE@" "lv_label_set_text" (func $set (param i32 i32)))
  @MEMORY@
  (data (i32.const 64) "TEST\00")
  (data (i32.const 80) "abcdefghijklmnopqrstuvwxyz\00")
  (data (i32.const 65535) "x")
  (func (export "_initialize"))
  (func (export "module_init") (result i32) i32.const 31 call $trace @APP_INIT@)
  (func (export "module_close") (result i32) i32.const 39 call $trace i32.const 0)
  (func (export "app_run") (param $action i32) (result i32) (local $screenId i32) (local $label i32)
    local.get $action i32.const 0 i32.gt_s
    if
      local.get $action i32.const 64 call $set
      local.get $action return
    end
    call $screen local.set $screenId
    local.get $screenId call $create local.set $label
    local.get $label i32.eqz
    if i32.const 0 return end
    local.get $action i32.const -6 i32.eq
    if i32.const 1 memory.grow drop end
    local.get $action i32.const -4 i32.eq
    if
      local.get $screenId call $create drop
    end
    local.get $action i32.const -3 i32.eq
    if
      local.get $screenId i32.const 64 call $set
      local.get $label return
    end
    local.get $label
    local.get $action i32.const -1 i32.eq
    if (result i32) i32.const -1 else
      local.get $action i32.const -2 i32.eq
      if (result i32) i32.const 65535 else
        local.get $action i32.const -5 i32.eq
        if (result i32) i32.const 80 else
          local.get $action i32.const -6 i32.eq
          if (result i32) i32.const 65535 else
            local.get $action i32.const -7 i32.eq
            if (result i32) i32.const 0 else i32.const 64 end
          end
        end
      end
    end
    call $set
    local.get $label
  )
)
