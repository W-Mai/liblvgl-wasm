# Adapt decoder release paths without modifying the pinned source checkout.
set(LVW_DECODER_SOURCE "${lvgl_SOURCE_DIR}/src/image/lv_image_decoder.c")
if(NOT EXISTS "${LVW_DECODER_SOURCE}")
    set(LVW_DECODER_SOURCE "${lvgl_SOURCE_DIR}/src/draw/lv_image_decoder.c")
endif()
get_filename_component(LVW_DECODER_DIRECTORY "${LVW_DECODER_SOURCE}" DIRECTORY)
set(LVW_DECODER_ADAPTED "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/lv_image_decoder.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_DECODER_SOURCE}")
file(SHA256 "${LVW_DECODER_SOURCE}" LVW_DECODER_HASH)
set(LVW_DECODER_OWNED_SOURCE "08926fa53f119bc20bd074748e8dfca431197b77dddf8ad58c224ef1ebc7c5ae") # v9.0.0
set(LVW_DECODER_LEGACY_SOURCES "${LVW_DECODER_OWNED_SOURCE}"
    "7b31514277008aa87ab1f606ac36e05ed01a5f2e0652d762fcd0d28df042e894") # v9.1.0
set(LVW_DECODER_SESSION_SOURCES
    "4bb543d40d68d85069968153d51504d85d0709149a8127abb523e63f414348a0" # v9.2.2
    "d28dd17354e2732470c8c062b5b99f2f1517c39d3bccab56e648ae35bc6246d6" # v9.6.0
)
if(LVW_DECODER_HASH IN_LIST LVW_DECODER_LEGACY_SOURCES)
    set(LVW_DECODER_LEGACY ON)
    list(APPEND LVW_BRIDGE_DEFINITIONS LVW_DECODER_LEGACY=1)
    set(LVW_DECODER_HEADER "lv_image_decoder.h")
    set(LVW_LL_PREFIX "_lv")
elseif(LVW_DECODER_HASH IN_LIST LVW_DECODER_SESSION_SOURCES)
    set(LVW_DECODER_LEGACY OFF)
    list(APPEND LVW_BRIDGE_DEFINITIONS LVW_DECODER_LEGACY=0)
    set(LVW_DECODER_HEADER "lv_image_decoder_private.h")
    set(LVW_LL_PREFIX "lv")
    file(RELATIVE_PATH LVW_DECODER_PRIVATE_HEADER "${lvgl_SOURCE_DIR}/src"
        "${LVW_DECODER_DIRECTORY}/lv_image_decoder_private.h")
    set(LVW_DECODER_CACHE_HEADER "misc/cache/instance/lv_image_header_cache.h")
    if(LVW_DECODER_HASH STREQUAL "4bb543d40d68d85069968153d51504d85d0709149a8127abb523e63f414348a0")
        set(LVW_DECODER_CACHE_HEADER "misc/cache/lv_image_header_cache.h")
    endif()
    list(APPEND LVW_BRIDGE_DEFINITIONS
        "LVW_DECODER_PRIVATE_HEADER=\"${LVW_DECODER_PRIVATE_HEADER}\""
        "LVW_DECODER_CACHE_HEADER=\"${LVW_DECODER_CACHE_HEADER}\"")
else()
    file(REMOVE "${LVW_DECODER_ADAPTED}")
    message(FATAL_ERROR "Unsupported LVGL decoder source: ${LVW_DECODER_SOURCE}")
endif()
file(READ "${LVW_DECODER_SOURCE}" LVW_DECODER_CODE)
foreach(LVW_ANCHOR IN ITEMS "#include \"${LVW_DECODER_HEADER}\"\n"
                           "    lv_free(decoder);\n" "    ${LVW_LL_PREFIX}_ll_clear(img_decoder_ll_p);\n")
    string(FIND "${LVW_DECODER_CODE}" "${LVW_ANCHOR}" LVW_FIRST)
    string(FIND "${LVW_DECODER_CODE}" "${LVW_ANCHOR}" LVW_LAST REVERSE)
    if(LVW_FIRST LESS 0 OR NOT LVW_FIRST EQUAL LVW_LAST)
        file(REMOVE "${LVW_DECODER_ADAPTED}")
        message(FATAL_ERROR "LVGL decoder adaptation requires a unique source anchor")
    endif()
endforeach()
string(REPLACE "#include \"${LVW_DECODER_HEADER}\"\n"
    "#include \"${LVW_DECODER_HEADER}\"\n\nvoid lvw_decoder_release_native(lv_image_decoder_t * decoder);\n"
    LVW_DECODER_CODE "${LVW_DECODER_CODE}")
string(REPLACE "    lv_free(decoder);\n"
    "    lvw_decoder_release_native(decoder);\n    lv_free(decoder);\n"
    LVW_DECODER_CODE "${LVW_DECODER_CODE}")
string(REPLACE "    ${LVW_LL_PREFIX}_ll_clear(img_decoder_ll_p);\n"
    "    lv_image_decoder_t * decoder;\n    while((decoder = ${LVW_LL_PREFIX}_ll_get_head(img_decoder_ll_p)) != NULL) {\n        lv_image_decoder_delete(decoder);\n    }\n"
    LVW_DECODER_CODE "${LVW_DECODER_CODE}")
if(LVW_DECODER_HASH STREQUAL LVW_DECODER_OWNED_SOURCE)
    string(REPLACE "    if(dsc->src_type == LV_IMAGE_SRC_FILE) dsc->src = lv_strdup(dsc->src);\n"
        "    if(dsc->src_type == LV_IMAGE_SRC_FILE) {\n        dsc->src = lv_strdup(dsc->src);\n        if(dsc->src == NULL) return LV_RESULT_INVALID;\n    }\n"
        LVW_DECODER_CODE "${LVW_DECODER_CODE}")
    string(REPLACE "    lv_result_t res = dsc->decoder->open_cb(dsc->decoder, dsc);\n"
        "    lv_result_t res = dsc->decoder->open_cb(dsc->decoder, dsc);\n    if(res != LV_RESULT_OK && dsc->src_type == LV_IMAGE_SRC_FILE) {\n        lv_free((void *)dsc->src);\n        dsc->src = NULL;\n    }\n"
        LVW_DECODER_CODE "${LVW_DECODER_CODE}")
endif()
if(LVW_DECODER_LEGACY)
    string(APPEND LVW_DECODER_CODE [=[

/* Called only by managed cancellation while the runtime and cache are live. */
void lvw_decoder_drop_header_cache(void)
{
#if LV_IMAGE_HEADER_CACHE_DEF_CNT > 0
    lv_cache_drop_all(img_header_cache_p, NULL);
#endif
}
]=])
endif()
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
    PROPERTIES INCLUDE_DIRECTORIES "${LVW_DECODER_DIRECTORY}")
