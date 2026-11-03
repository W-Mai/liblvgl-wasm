(module
  (import "trace" "event" (func $trace (param i32)))
  @LVW_IMPORT@
  @EXTRA_IMPORT@
  @MEMORY@
  (data (i32.const 1024) "\03\02\01\00\06\05\04\80")
  (func (export "_initialize") i32.const 10 call $trace)
  (func (export "lvw_abi_version") (result i32) i32.const 1)
  (func (export "lvw_init") (result i32) i32.const 11 call $trace i32.const 0)
  (func (export "lvw_shutdown") (result i32) i32.const 19 call $trace i32.const 0)
  (func (export "lvw_display_create") (param i32 i32 i32) (result i32) i32.const 40 call $trace @DISPLAY@)
  (func (export "lv_screen_active") (result i32) i32.const 41 call $trace @DEFAULT_SCREEN@)
  (func (export "lv_display_get_screen_active") (param i32) (result i32)
    i32.const 41 call $trace local.get 0 i32.const 100 i32.eq if (result i32) i32.const 200 else i32.const 0 end)
  (func (export "lv_label_create") (param i32) (result i32) i32.const 42 call $trace @PARENT_CHECK@ @CREATE@)
  (func (export "lv_label_set_text") (param i32 i32) i32.const 43 call $trace @SETTER@)
  (func (export "lvw_alloc") (param i32) (result i32) i32.const 50 call $trace @ALLOC@)
  (func (export "lvw_free") (param i32) i32.const 51 call $trace @FREE@)
  (func (export "lv_refr_now") (param i32) i32.const 52 call $trace @REFRESH@)
  (func (export "lvw_frame_get") (param i32 i32) (result i32) i32.const 53 call $trace @FRAME@ @FRAME_RESULT@)
  (func (export "lv_is_initialized") (result i32) i32.const 1)
  (func (export "lv_obj_create") (param i32) (result i32) local.get 0)
)
