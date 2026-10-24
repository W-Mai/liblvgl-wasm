# Keep the verified legacy font cache scoped to each font's native lifetime.
set(LVW_TTF_SOURCE "${lvgl_SOURCE_DIR}/src/font/tiny_ttf/lv_tiny_ttf.c")
if(NOT EXISTS "${LVW_TTF_SOURCE}")
    set(LVW_TTF_SOURCE "${lvgl_SOURCE_DIR}/src/libs/tiny_ttf/lv_tiny_ttf.c")
endif()
set(LVW_TTF_OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted")
set(LVW_TTF_OUTPUTS "${LVW_TTF_OUTPUT}/lv_tiny_ttf.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_TTF_SOURCE}")
file(SHA256 "${LVW_TTF_SOURCE}" hash)
if(hash STREQUAL "58a705903a1d7aa21c777c21cd853b17873c5ce9da91e1b6e2255fdc832937d5")
    return()
elseif(NOT hash STREQUAL "d312f88222657446d981c17e55cbda3ba38d0e6a900e02f03cbde56a677e3a4e")
    file(REMOVE ${LVW_TTF_OUTPUTS})
    message(FATAL_ERROR "Unsupported LVGL tinyttf source: ${LVW_TTF_SOURCE}")
endif()
lvw_config_flag(LV_TINY_TTF_FILE_SUPPORT)
if(LV_TINY_TTF_FILE_SUPPORT)
    file(REMOVE ${LVW_TTF_OUTPUTS})
    message(FATAL_ERROR "Legacy TinyTTF file streams require independent adaptation")
endif()

function(lvw_ttf_replace before after)
    string(FIND "${LVW_TTF_CODE}" "${before}" first)
    string(FIND "${LVW_TTF_CODE}" "${before}" last REVERSE)
    if(first LESS 0 OR NOT first EQUAL last)
        file(REMOVE ${LVW_TTF_OUTPUTS})
        message(FATAL_ERROR "LVGL tinyttf adaptation requires a unique source anchor")
    endif()
    string(REPLACE "${before}" "${after}" LVW_TTF_CODE "${LVW_TTF_CODE}")
    set(LVW_TTF_CODE "${LVW_TTF_CODE}" PARENT_SCOPE)
endfunction()

file(READ "${LVW_TTF_SOURCE}" LVW_TTF_CODE)
lvw_ttf_replace("    int descent;\n} ttf_font_desc_t;"
    "    int descent;\n    struct _tiny_ttf_cache_data_t * cached;\n} ttf_font_desc_t;")
lvw_ttf_replace("    lv_draw_buf_t * draw_buf;\n} tiny_ttf_cache_data_t;"
    "    lv_draw_buf_t * draw_buf;\n    struct _tiny_ttf_cache_data_t * next;\n} tiny_ttf_cache_data_t;")
lvw_ttf_replace("void lv_tiny_ttf_set_size(lv_font_t * font, int32_t font_size)" [=[static void tiny_ttf_drop_font(ttf_font_desc_t * dsc)
{
    while(dsc->cached) {
        tiny_ttf_cache_data_t * node = dsc->cached;
        dsc->cached = node->next;
        lv_cache_drop(tiny_ttf_cache, node, NULL);
    }
}

void lv_tiny_ttf_set_size(lv_font_t * font, int32_t font_size)]=])
lvw_ttf_replace("    dsc->scale = stbtt_ScaleForMappingEmToPixels(&dsc->info, font_size);"
    "    tiny_ttf_drop_font(dsc);\n    dsc->scale = stbtt_ScaleForMappingEmToPixels(&dsc->info, font_size);")
lvw_ttf_replace("        lv_cache_drop_all(tiny_ttf_cache, (void *)font->dsc);"
    "        tiny_ttf_drop_font(ttf);")
lvw_ttf_replace("    node->draw_buf = draw_buf;"
    "    node->draw_buf = draw_buf;\n    node->next = dsc->cached;\n    dsc->cached = node;")
lvw_ttf_replace("    lv_draw_buf_destroy(node->draw_buf);" [=[    ttf_font_desc_t * dsc = (ttf_font_desc_t *)node->font->dsc;
    tiny_ttf_cache_data_t ** link = &dsc->cached;
    while(*link && *link != node) link = &(*link)->next;
    if(*link) *link = node->next;
    lv_draw_buf_destroy(node->draw_buf);]=])
set(LVW_TTF_SOURCE_CODE "${LVW_TTF_CODE}")

foreach(kind SOURCE)
    set(source "${LVW_TTF_${kind}}")
    get_filename_component(filename "${source}" NAME)
    get_filename_component(directory "${source}" DIRECTORY)
    set(adapted "${LVW_TTF_OUTPUT}/${filename}")
    file(CONFIGURE OUTPUT "${adapted}"
        CONTENT "/* Adapted by liblvgl-wasm: preserve font cache ownership. */\n${LVW_TTF_${kind}_CODE}" @ONLY)
    get_target_property(sources lvgl SOURCES)
    list(FIND sources "${source}" index)
    if(index LESS 0)
        message(FATAL_ERROR "Expected LVGL tinyttf compilation unit: ${source}")
    endif()
    list(REMOVE_ITEM sources "${source}")
    list(INSERT sources ${index} "${adapted}")
    set_property(TARGET lvgl PROPERTY SOURCES "${sources}")
    set_source_files_properties("${adapted}" TARGET_DIRECTORY lvgl
        PROPERTIES INCLUDE_DIRECTORIES "${directory}")
endforeach()
