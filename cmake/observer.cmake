# Adapt the pinned observer deletion path without modifying the source checkout.
set(LVW_OBSERVER_SOURCE "${lvgl_SOURCE_DIR}/src/core/lv_observer.c")
set(LVW_OBSERVER_ADAPTED "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/lv_observer.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_OBSERVER_SOURCE}")
file(SHA256 "${LVW_OBSERVER_SOURCE}" LVW_OBSERVER_HASH)
if(NOT LVW_OBSERVER_HASH STREQUAL "2eb15b1668bf035e8850798cca03f365c7b36e1b1c58d53eb857ef696a3aa0ca")
    file(REMOVE "${LVW_OBSERVER_ADAPTED}")
    message(FATAL_ERROR "Unsupported LVGL observer source: ${LVW_OBSERVER_SOURCE}")
endif()
file(READ "${LVW_OBSERVER_SOURCE}" LVW_OBSERVER_CODE)
foreach(LVW_ANCHOR IN ITEMS "#if LV_USE_OBSERVER\n" "    lv_free(observer);\n")
    string(FIND "${LVW_OBSERVER_CODE}" "${LVW_ANCHOR}" LVW_FIRST)
    string(FIND "${LVW_OBSERVER_CODE}" "${LVW_ANCHOR}" LVW_LAST REVERSE)
    if(LVW_FIRST LESS 0 OR NOT LVW_FIRST EQUAL LVW_LAST)
        file(REMOVE "${LVW_OBSERVER_ADAPTED}")
        message(FATAL_ERROR "LVGL observer adaptation requires a unique source anchor")
    endif()
endforeach()
string(REPLACE "#if LV_USE_OBSERVER\n"
    "#if LV_USE_OBSERVER\n\nvoid lvw_observer_release_native(lv_observer_t * observer);\n"
    LVW_OBSERVER_CODE "${LVW_OBSERVER_CODE}")
string(REPLACE "    lv_free(observer);\n"
    "    lvw_observer_release_native(observer);\n    lv_free(observer);\n"
    LVW_OBSERVER_CODE "${LVW_OBSERVER_CODE}")
file(CONFIGURE OUTPUT "${LVW_OBSERVER_ADAPTED}" CONTENT "${LVW_OBSERVER_CODE}" @ONLY)

get_target_property(LVW_LVGL_SOURCES lvgl SOURCES)
list(FIND LVW_LVGL_SOURCES "${LVW_OBSERVER_SOURCE}" LVW_OBSERVER_INDEX)
list(LENGTH LVW_LVGL_SOURCES LVW_BEFORE)
list(REMOVE_ITEM LVW_LVGL_SOURCES "${LVW_OBSERVER_SOURCE}")
list(LENGTH LVW_LVGL_SOURCES LVW_AFTER)
math(EXPR LVW_REMOVED "${LVW_BEFORE} - ${LVW_AFTER}")
if(NOT LVW_REMOVED EQUAL 1)
    message(FATAL_ERROR "Expected one LVGL observer compilation unit")
endif()
list(INSERT LVW_LVGL_SOURCES ${LVW_OBSERVER_INDEX} "${LVW_OBSERVER_ADAPTED}")
set_property(TARGET lvgl PROPERTY SOURCES "${LVW_LVGL_SOURCES}")
set_source_files_properties("${LVW_OBSERVER_ADAPTED}" TARGET_DIRECTORY lvgl
    PROPERTIES INCLUDE_DIRECTORIES "${lvgl_SOURCE_DIR}/src/core")
