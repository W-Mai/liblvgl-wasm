# Adapt decoder release paths without modifying the pinned source checkout.
set(LVW_DECODER_SOURCE "${lvgl_SOURCE_DIR}/src/image/lv_image_decoder.c")
set(LVW_DECODER_ADAPTED "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/lv_image_decoder.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_DECODER_SOURCE}")
file(SHA256 "${LVW_DECODER_SOURCE}" LVW_DECODER_HASH)
if(NOT LVW_DECODER_HASH STREQUAL "d28dd17354e2732470c8c062b5b99f2f1517c39d3bccab56e648ae35bc6246d6")
    file(REMOVE "${LVW_DECODER_ADAPTED}")
    message(FATAL_ERROR "Unsupported LVGL decoder source: ${LVW_DECODER_SOURCE}")
endif()
file(READ "${LVW_DECODER_SOURCE}" LVW_DECODER_CODE)
foreach(LVW_ANCHOR IN ITEMS "#include \"lv_image_decoder_private.h\"\n"
                           "    lv_free(decoder);\n" "    lv_ll_clear(img_decoder_ll_p);\n")
    string(FIND "${LVW_DECODER_CODE}" "${LVW_ANCHOR}" LVW_FIRST)
    string(FIND "${LVW_DECODER_CODE}" "${LVW_ANCHOR}" LVW_LAST REVERSE)
    if(LVW_FIRST LESS 0 OR NOT LVW_FIRST EQUAL LVW_LAST)
        file(REMOVE "${LVW_DECODER_ADAPTED}")
        message(FATAL_ERROR "LVGL decoder adaptation requires a unique source anchor")
    endif()
endforeach()
string(REPLACE "#include \"lv_image_decoder_private.h\"\n"
    "#include \"lv_image_decoder_private.h\"\n\nvoid lvw_decoder_release_native(lv_image_decoder_t * decoder);\n"
    LVW_DECODER_CODE "${LVW_DECODER_CODE}")
string(REPLACE "    lv_free(decoder);\n"
    "    lvw_decoder_release_native(decoder);\n    lv_free(decoder);\n"
    LVW_DECODER_CODE "${LVW_DECODER_CODE}")
string(REPLACE "    lv_ll_clear(img_decoder_ll_p);\n"
    "    lv_image_decoder_t * decoder;\n    while((decoder = lv_ll_get_head(img_decoder_ll_p)) != NULL) {\n        lv_image_decoder_delete(decoder);\n    }\n"
    LVW_DECODER_CODE "${LVW_DECODER_CODE}")
file(CONFIGURE OUTPUT "${LVW_DECODER_ADAPTED}" CONTENT "${LVW_DECODER_CODE}" @ONLY)

get_target_property(LVW_LVGL_SOURCES lvgl SOURCES)
list(FIND LVW_LVGL_SOURCES "${LVW_DECODER_SOURCE}" LVW_DECODER_INDEX)
list(LENGTH LVW_LVGL_SOURCES LVW_BEFORE)
list(REMOVE_ITEM LVW_LVGL_SOURCES "${LVW_DECODER_SOURCE}")
list(LENGTH LVW_LVGL_SOURCES LVW_AFTER)
math(EXPR LVW_REMOVED "${LVW_BEFORE} - ${LVW_AFTER}")
if(NOT LVW_REMOVED EQUAL 1)
    message(FATAL_ERROR "Expected one LVGL decoder compilation unit")
endif()
list(INSERT LVW_LVGL_SOURCES ${LVW_DECODER_INDEX} "${LVW_DECODER_ADAPTED}")
set_property(TARGET lvgl PROPERTY SOURCES "${LVW_LVGL_SOURCES}")
set_source_files_properties("${LVW_DECODER_ADAPTED}" TARGET_DIRECTORY lvgl
    PROPERTIES INCLUDE_DIRECTORIES "${lvgl_SOURCE_DIR}/src/image")
