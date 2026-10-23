# Bind copied descriptors before early exec and track every native release path.
set(LVW_ANIMATION_SOURCE "${lvgl_SOURCE_DIR}/src/misc/lv_anim.c")
set(LVW_ANIMATION_ADAPTED "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/lv_anim.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_ANIMATION_SOURCE}")
file(SHA256 "${LVW_ANIMATION_SOURCE}" LVW_ANIMATION_HASH)
set(LVW_ANIMATION_LEGACY
    "8ef1ad10a32d60f561dd083aa10538d589ede497cf155b655904d96746f04c9a" # v9.0.0
    "b2506083e4a2e8ca572852da3dab212451daee8be45887395d150ba9a7482b7a" # v9.1.0
)
set(LVW_ANIMATION_VERIFIED_SOURCES "${LVW_ANIMATION_LEGACY}"
    "5c4420396243f98d9deb4a74f0d777f3f4faea73defc6f9bb9fd919c4dcc48f4" # v9.2.2
    "ec818aab0220820cc4a88b77bfcde4aa96b19f716d08066af29ad48259bd608e" # v9.3.0
    "17fba4ce9d236db6bf208898dc632976b7196bfa06166d2c826123cc9c522eb6") # v9.6.0
if(NOT LVW_ANIMATION_HASH IN_LIST LVW_ANIMATION_VERIFIED_SOURCES)
    file(REMOVE "${LVW_ANIMATION_ADAPTED}")
    message(FATAL_ERROR "Unsupported LVGL animation source: ${LVW_ANIMATION_SOURCE}")
endif()
file(READ "${LVW_ANIMATION_SOURCE}" LVW_ANIMATION_CODE)
foreach(LVW_ANCHOR IN ITEMS "#include \"../core/lv_global.h\"\n"
                           "    new_anim->last_timer_run = lv_tick_get();\n")
    string(FIND "${LVW_ANIMATION_CODE}" "${LVW_ANCHOR}" LVW_FIRST)
    string(FIND "${LVW_ANIMATION_CODE}" "${LVW_ANCHOR}" LVW_LAST REVERSE)
    if(LVW_FIRST LESS 0 OR NOT LVW_FIRST EQUAL LVW_LAST)
        file(REMOVE "${LVW_ANIMATION_ADAPTED}")
        message(FATAL_ERROR "LVGL animation adaptation requires a unique source anchor")
    endif()
endforeach()
string(REGEX MATCHALL "lv_free\\(a\\)" LVW_ANIMATION_FREES "${LVW_ANIMATION_CODE}")
list(LENGTH LVW_ANIMATION_FREES LVW_ANIMATION_FREE_COUNT)
if(NOT LVW_ANIMATION_FREE_COUNT EQUAL 3)
    file(REMOVE "${LVW_ANIMATION_ADAPTED}")
    message(FATAL_ERROR "Expected three LVGL animation release paths")
endif()
string(REPLACE "#include \"../core/lv_global.h\"\n"
    "#include \"../core/lv_global.h\"\n\nvoid lvw_anim_bind_native(lv_anim_t * animation);\nvoid lvw_anim_release_native(lv_anim_t * animation);\nvoid lvw_anim_clear_native(lv_anim_t * animation);\n"
    LVW_ANIMATION_CODE "${LVW_ANIMATION_CODE}")
string(REPLACE "    new_anim->last_timer_run = lv_tick_get();\n"
    "    new_anim->last_timer_run = lv_tick_get();\n    lvw_anim_bind_native(new_anim);\n"
    LVW_ANIMATION_CODE "${LVW_ANIMATION_CODE}")
string(REGEX REPLACE "([ ]*)lv_free\\(a\\);"
    "\\1lvw_anim_release_native(a);\n\\1lv_free(a);" LVW_ANIMATION_CODE "${LVW_ANIMATION_CODE}")
if(LVW_ANIMATION_HASH IN_LIST LVW_ANIMATION_LEGACY)
    set(LVW_ANCHOR "void lv_anim_delete_all(void)\n{\n    _lv_ll_clear(anim_ll_p);\n    anim_mark_list_change();\n}")
    string(FIND "${LVW_ANIMATION_CODE}" "${LVW_ANCHOR}" LVW_FIRST)
    string(FIND "${LVW_ANIMATION_CODE}" "${LVW_ANCHOR}" LVW_LAST REVERSE)
    if(LVW_FIRST LESS 0 OR NOT LVW_FIRST EQUAL LVW_LAST)
        file(REMOVE "${LVW_ANIMATION_ADAPTED}")
        message(FATAL_ERROR "Expected one legacy LVGL animation clear path")
    endif()
    string(REPLACE "${LVW_ANCHOR}"
        "static void lvw_anim_clear(void * data)\n{\n    lv_anim_t * animation = data;\n    _lv_ll_remove(anim_ll_p, animation);\n    lvw_anim_clear_native(animation);\n    lv_free(animation);\n}\n\nvoid lv_anim_delete_all(void)\n{\n    _lv_ll_clear_custom(anim_ll_p, lvw_anim_clear);\n    anim_mark_list_change();\n}"
        LVW_ANIMATION_CODE "${LVW_ANIMATION_CODE}")
endif()
file(CONFIGURE OUTPUT "${LVW_ANIMATION_ADAPTED}" CONTENT "${LVW_ANIMATION_CODE}" @ONLY)

get_target_property(LVW_LVGL_SOURCES lvgl SOURCES)
list(FIND LVW_LVGL_SOURCES "${LVW_ANIMATION_SOURCE}" LVW_ANIMATION_INDEX)
list(LENGTH LVW_LVGL_SOURCES LVW_BEFORE)
list(REMOVE_ITEM LVW_LVGL_SOURCES "${LVW_ANIMATION_SOURCE}")
list(LENGTH LVW_LVGL_SOURCES LVW_AFTER)
math(EXPR LVW_REMOVED "${LVW_BEFORE} - ${LVW_AFTER}")
if(NOT LVW_REMOVED EQUAL 1)
    message(FATAL_ERROR "Expected one LVGL animation compilation unit")
endif()
list(INSERT LVW_LVGL_SOURCES ${LVW_ANIMATION_INDEX} "${LVW_ANIMATION_ADAPTED}")
set_property(TARGET lvgl PROPERTY SOURCES "${LVW_LVGL_SOURCES}")
set_source_files_properties("${LVW_ANIMATION_ADAPTED}" TARGET_DIRECTORY lvgl
    PROPERTIES INCLUDE_DIRECTORIES "${lvgl_SOURCE_DIR}/src/misc")
