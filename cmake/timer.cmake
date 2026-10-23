# Notify the bridge when native timers without external data are freed.
set(LVW_TIMER_SOURCE "${lvgl_SOURCE_DIR}/src/misc/lv_timer.c")
set(LVW_TIMER_ADAPTED "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/lv_timer.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_TIMER_SOURCE}")
file(SHA256 "${LVW_TIMER_SOURCE}" LVW_TIMER_HASH)
set(LVW_TIMER_VERIFIED_SOURCES
    "c4b7f89045494f9a6221d8dcdf84e2f3503b7bd7c6d203c443791c8cff6fc8fd" # v9.0.0, v9.1.0
    "275ad69c8c971ddafa848f6c61a83d587862efe94092021a6cac4952750b8a8d" # v9.2.2
    "bcec8183d48745433cb744bb1ded8a6a1aff15d47d34664bc22072fcfdd062b2" # v9.3.0, v9.4.0
    "b02c9d2dc774ce5a3ab92774b8f2b1aa274c526afe4c00cf371b24b6663784f6" # v9.5.0
    "79836f02381fcf69c91c6bb945f9919c606a450e0989371a28ee152b0fd241d9" # v9.6.0
)
if(NOT LVW_TIMER_HASH IN_LIST LVW_TIMER_VERIFIED_SOURCES)
    file(REMOVE "${LVW_TIMER_ADAPTED}")
    message(FATAL_ERROR "Unsupported LVGL timer source: ${LVW_TIMER_SOURCE}")
endif()
file(READ "${LVW_TIMER_SOURCE}" LVW_TIMER_CODE)
foreach(LVW_ANCHOR IN ITEMS "#include \"../core/lv_global.h\"\n" "    lv_free(timer);\n")
    string(FIND "${LVW_TIMER_CODE}" "${LVW_ANCHOR}" LVW_FIRST)
    string(FIND "${LVW_TIMER_CODE}" "${LVW_ANCHOR}" LVW_LAST REVERSE)
    if(LVW_FIRST LESS 0 OR NOT LVW_FIRST EQUAL LVW_LAST)
        file(REMOVE "${LVW_TIMER_ADAPTED}")
        message(FATAL_ERROR "LVGL timer adaptation requires a unique source anchor")
    endif()
endforeach()
string(REPLACE "#include \"../core/lv_global.h\"\n"
    "#include \"../core/lv_global.h\"\n\nvoid lvw_timer_release_native(lv_timer_t * timer);\n"
    LVW_TIMER_CODE "${LVW_TIMER_CODE}")
string(REPLACE "    lv_free(timer);\n"
    "    lvw_timer_release_native(timer);\n    lv_free(timer);\n"
    LVW_TIMER_CODE "${LVW_TIMER_CODE}")
file(CONFIGURE OUTPUT "${LVW_TIMER_ADAPTED}" CONTENT "${LVW_TIMER_CODE}" @ONLY)

get_target_property(LVW_LVGL_SOURCES lvgl SOURCES)
list(FIND LVW_LVGL_SOURCES "${LVW_TIMER_SOURCE}" LVW_TIMER_INDEX)
list(LENGTH LVW_LVGL_SOURCES LVW_BEFORE)
list(REMOVE_ITEM LVW_LVGL_SOURCES "${LVW_TIMER_SOURCE}")
list(LENGTH LVW_LVGL_SOURCES LVW_AFTER)
math(EXPR LVW_REMOVED "${LVW_BEFORE} - ${LVW_AFTER}")
if(NOT LVW_REMOVED EQUAL 1)
    message(FATAL_ERROR "Expected one LVGL timer compilation unit")
endif()
list(INSERT LVW_LVGL_SOURCES ${LVW_TIMER_INDEX} "${LVW_TIMER_ADAPTED}")
set_property(TARGET lvgl PROPERTY SOURCES "${LVW_LVGL_SOURCES}")
set_source_files_properties("${LVW_TIMER_ADAPTED}" TARGET_DIRECTORY lvgl
    PROPERTIES INCLUDE_DIRECTORIES "${lvgl_SOURCE_DIR}/src/misc")
