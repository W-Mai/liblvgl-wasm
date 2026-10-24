# Adapt outline scaling without modifying the pinned source checkout.
set(LVW_OUTLINE_SOURCE "${lvgl_SOURCE_DIR}/src/draw/sw/lv_draw_sw_letter.c")
set(LVW_OUTLINE_ADAPTED "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/lv_draw_sw_letter.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_OUTLINE_SOURCE}")
file(SHA256 "${LVW_OUTLINE_SOURCE}" LVW_OUTLINE_HASH)
if(LVW_OUTLINE_HASH STREQUAL "8fcabdc31b361cf16885cfb89134cb243225d952ee7a227331d943bfefb056d5")
    # This renderer has no outline branch. Preserve its bitmap-only implementation.
    file(REMOVE "${LVW_OUTLINE_ADAPTED}")
    return()
endif()
if(NOT LVW_OUTLINE_HASH STREQUAL "c4878763e04747329064916fde0fbfcbc43af1b29961c38117aaeba720cf5631")
    file(REMOVE "${LVW_OUTLINE_ADAPTED}")
    message(FATAL_ERROR "Unsupported LVGL outline source: ${LVW_OUTLINE_SOURCE}")
endif()
file(READ "${LVW_OUTLINE_SOURCE}" LVW_OUTLINE_CODE)

function(lvw_outline_replace before after)
    string(FIND "${LVW_OUTLINE_CODE}" "${before}" LVW_FIRST)
    string(FIND "${LVW_OUTLINE_CODE}" "${before}" LVW_LAST REVERSE)
    if(LVW_FIRST LESS 0 OR NOT LVW_FIRST EQUAL LVW_LAST)
        file(REMOVE "${LVW_OUTLINE_ADAPTED}")
        message(FATAL_ERROR "LVGL outline adaptation requires a unique source anchor")
    endif()
    string(REPLACE "${before}" "${after}" LVW_OUTLINE_CODE "${LVW_OUTLINE_CODE}")
    set(LVW_OUTLINE_CODE "${LVW_OUTLINE_CODE}" PARENT_SCOPE)
endfunction()

lvw_outline_replace([=[        scale = LV_FREETYPE_F26DOT6_TO_FLOAT(lv_freetype_outline_get_scale(glyph_dsc->g->resolved_font));
]=] [=[        const lv_freetype_font_dsc_t * font_dsc = glyph_dsc->g->resolved_font->dsc;
        scale = (float)font_dsc->size / (float)font_dsc->cache_node->ref_size;
]=])

file(CONFIGURE OUTPUT "${LVW_OUTLINE_ADAPTED}" CONTENT "${LVW_OUTLINE_CODE}" @ONLY)

get_target_property(LVW_LVGL_SOURCES lvgl SOURCES)
list(FIND LVW_LVGL_SOURCES "${LVW_OUTLINE_SOURCE}" LVW_OUTLINE_INDEX)
list(LENGTH LVW_LVGL_SOURCES LVW_BEFORE)
list(REMOVE_ITEM LVW_LVGL_SOURCES "${LVW_OUTLINE_SOURCE}")
list(LENGTH LVW_LVGL_SOURCES LVW_AFTER)
math(EXPR LVW_REMOVED "${LVW_BEFORE} - ${LVW_AFTER}")
if(NOT LVW_REMOVED EQUAL 1)
    message(FATAL_ERROR "Expected one LVGL outline compilation unit")
endif()
list(INSERT LVW_LVGL_SOURCES ${LVW_OUTLINE_INDEX} "${LVW_OUTLINE_ADAPTED}")
set_property(TARGET lvgl PROPERTY SOURCES "${LVW_LVGL_SOURCES}")
set_source_files_properties("${LVW_OUTLINE_ADAPTED}" TARGET_DIRECTORY lvgl
    PROPERTIES INCLUDE_DIRECTORIES "${lvgl_SOURCE_DIR}/src/draw/sw")
